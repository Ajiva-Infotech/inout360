const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");
const { builtInRoles, workspaceFeatures, roleFeatures, createManagementRouter } = require("./management");
const { createOpsRouter } = require("./ops");

const featureNames = [...workspaceFeatures, "management"];
const roles = Object.keys(builtInRoles);
const actions = { admin: featureNames, ...roleFeatures };
const issuer = "inout360:plant-ops";
const audience = "plant-ops";
const identity = (record) => String(record?._id || "");
const validId = (id) => typeof id === "string" && /^[a-f\d]{24}$/i.test(id);
const fail = (status, message) => Object.assign(new Error(message), { status });
const catchAsync = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};
const listOf = (values, allowed) =>
  Array.isArray(values) && values.length <= allowed.length && values.every((value) => allowed.includes(value));
const visibleSetup = (value, { includeInactive = false } = {}) => ({
  departments: value.departments.filter((item) => includeInactive || item.active).map(({ _id, name, approverId, active }) => ({
    id: _id, name, approverId: approverId ?? null, active,
  })),
  areas: value.areas.filter((item) => includeInactive || item.active).map(({ _id, name, departmentId, manpowerNeeded, active }) => ({
    id: _id, name, departmentId, manpowerNeeded: manpowerNeeded ?? null, active,
  })),
});
function scopedSetup(value, areaIds) {
  const setup = visibleSetup(value);
  if (!Array.isArray(areaIds)) return setup;
  const allowed = new Set(areaIds);
  const areas = setup.areas.filter((area) => allowed.has(area.id));
  const departments = new Set(areas.map((area) => area.departmentId));
  return { departments: setup.departments.filter((item) => departments.has(item.id)), areas };
}

// Fixed-window throttle for the pilot. Put a shared rate limiter in front of
// this route before scaling it across multiple backend instances.
function throttleLogin() {
  const attempts = new Map();
  const window = 15 * 60_000;
  return (req, res, next) => {
    const now = Date.now();
    for (const [ip, entry] of attempts) {
      if (entry.until <= now) attempts.delete(ip);
    }
    const ip = req.ip;
    if (!attempts.has(ip) && attempts.size >= 5000) return next(fail(429, "Try signing in again later."));
    const entry = attempts.get(ip) || { until: now + window, count: 0 };
    attempts.set(ip, entry);
    entry.count++;
    if (entry.count > 25) return next(fail(429, "Too many sign-in attempts. Try again later."));
    next();
  };
}

function createPlantOpsRouter(store, options = {}) {
  const router = express.Router();
  const enabled = options.enabled || (() => process.env.PLANT_OPS_ENABLED === "true");
  const secret = options.secret || (() => process.env.PLANT_OPS_SESSION_SECRET);
  const legacySigner = () => process.env.SECRET_KEY || process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
  function isAvailable() {
    const value = secret();
    return enabled() && typeof value === "string" && value.length >= 32 && value !== legacySigner();
  }

  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!isAvailable()) return next(fail(503, "Plant-OPS is not available in this environment."));
    next();
  });

  async function scopeFor(user, selectedPlantId) {
    if (selectedPlantId !== undefined && !validId(selectedPlantId)) throw fail(400, "Choose a valid plant.");
    selectedPlantId = selectedPlantId?.toLowerCase();
    const nativeAccount = user.source === "plant_ops";
    const [vendor, homePlant, employee] = await Promise.all([
      store.vendorForUser(user), store.plantForUser(user), nativeAccount ? null : store.linkedEmployee(user),
    ]);
    if (!vendor || !homePlant || vendor.vendorCode !== homePlant.vendorCode ||
        (employee && (employee.status === "Inactive" || employee.systemAccess?.loginEnabled === false))) {
      throw fail(403, "Your account is not assigned to an eligible Plant-OPS plant.");
    }
    const vendorId = identity(vendor);
    const homePlantId = identity(homePlant);
    let plant = homePlant;
    const [grant, homeMembership] = await Promise.all([
      store.grant(vendorId), nativeAccount ? user : store.membership(vendorId, homePlantId, identity(user)),
    ]);
    if (!selectedPlantId && !nativeAccount && homeMembership?.role === "admin" &&
        grant?.status === "enabled" && !grant.plantIds.includes(homePlantId)) {
      const assigned = await store.adminMemberships(vendorId, identity(user));
      selectedPlantId = assigned.find((item) => grant.plantIds.includes(item.plantId))?.plantId;
    }
    let membership = homeMembership;
    if (selectedPlantId && selectedPlantId !== homePlantId) {
      if (nativeAccount || homeMembership?.role !== "admin" ||
          grant?.status !== "enabled" || !grant.plantIds.includes(selectedPlantId)) {
        throw fail(403, "Plant-OPS access has not been enabled for this plant.");
      }
      [plant, membership] = await Promise.all([
        store.plantForUser({ vendorCode: vendor.vendorCode, locationId: selectedPlantId }),
        store.membership(vendorId, selectedPlantId, identity(user)),
      ]);
      if (!plant || membership?.role !== "admin") throw fail(403, "Plant-OPS access has not been enabled for this plant.");
    }
    const plantId = identity(plant);
    if (grant?.status !== "enabled" || !grant.plantIds.includes(plantId) || !membership?.role) {
      throw fail(403, "Plant-OPS access has not been enabled for this account.");
    }
    const [customRole, archived] = await Promise.all([
      roles.includes(membership.role) ? null : store.customRole(vendorId, plantId, membership.role),
      employee ? store.isEmployeeArchived(vendorId, homePlantId, identity(employee)) : false,
    ]);
    if (archived || (!roles.includes(membership.role) && !customRole)) {
      throw fail(403, "Plant-OPS access has not been enabled for this account.");
    }
    const allowed = customRole ? customRole.features.filter((item) => workspaceFeatures.includes(item)) : actions[membership.role];
    const isAdmin = membership.role === "admin";
    const isContractor = membership.role === "contractor_manager";
    const areaIds = isAdmin ? null : membership.areaIds ?? (isContractor ? [] : null);
    const contractor = isContractor && membership.contractorId
      ? (await store.setup(vendorId, plantId)).contractors.find((item) => item.active && item._id === membership.contractorId)
      : null;
    const features = grant.features.filter((item) => allowed.includes(item) &&
      (isAdmin || !Array.isArray(membership.menus) || membership.menus.includes(item)) &&
      (!Array.isArray(areaIds) || !["directory", "activity"].includes(item)) &&
      (!isContractor || contractor));
    return {
      vendorId, plantId, vendorCode: vendor.vendorCode, vendorName: vendor.name, plantName: plant.name,
      features, role: membership.role, areaIds, contractorName: contractor?.name,
      enabledPlantIds: grant.plantIds,
    };
  }

  function signIn(kind) {
    return catchAsync(async (req, res) => {
      // Existing PIL request logging prints bodies; credentials only travel in
      // the Authorization header of this HTTPS sign-in request.
      const header = req.get("Authorization") || "";
      if (!/^Basic [A-Za-z0-9+/=]+$/.test(header) || header.length > 4096) throw fail(401, "Invalid sign-in.");
      const raw = Buffer.from(header.slice(6), "base64").toString("utf8");
      const separator = raw.indexOf(":");
      if (separator < 1) throw fail(401, "Invalid sign-in.");
      const email = raw.slice(0, separator).toLowerCase().trim();
      const password = raw.slice(separator + 1);
      if (!email || email.length > 254 || !password || Buffer.byteLength(password) > 72) throw fail(401, "Invalid sign-in.");
      const sharedUser = await store.userByEmail(email);
      const user = sharedUser || (kind === "employee" ? await store.portalAccountByEmail(email) : null);
      // Fixed bcrypt hash for an unknown user, so missing accounts still take
      // roughly the same verification path as a mismatch.
      const hash = user?.password || "$2b$10$7qO0FbF7TYIeH9nOyspX5.2J6twiFVlVqbyN0O/OFm7CIRjzV.HVS";
      const matches = await bcrypt.compare(password, hash);
      if (!user?.password || !matches) throw fail(401, "Invalid sign-in.");
      if (kind === "superadmin") {
        if (user.role !== "superadmin") throw fail(403, "Super Admin access is required.");
      } else {
        if (["superadmin", "visitor"].includes(user.role)) throw fail(403, "Use an assigned Plant-OPS employee account.");
        await scopeFor(user);
      }
      const accountClaims = user.source === "plant_ops" ? { source: "plant_ops", credentialVersion: user.credentialVersion } : {};
      const token = jwt.sign({ kind, ...accountClaims }, secret(), {
        subject: identity(user), issuer, audience, algorithm: "HS256", expiresIn: "2h",
      });
      res.json({ token, name: user.name });
    });
  }

  const loginThrottle = throttleLogin();
  router.post("/v1/session", loginThrottle, signIn("employee"));
  router.post("/v1/control/session", loginThrottle, signIn("superadmin"));

  function authenticate(kind) {
    return catchAsync(async (req, res, next) => {
      const header = req.get("Authorization") || "";
      let token;
      try {
        if (!header.startsWith("Bearer ")) throw new Error("Missing bearer");
        token = jwt.verify(header.slice(7), secret(), { algorithms: ["HS256"], issuer, audience });
        if (token.kind !== kind || !validId(token.sub)) throw new Error("Wrong token kind");
      } catch {
        throw fail(401, "Sign in to Plant-OPS again.");
      }
      const user = kind === "employee" && token.source === "plant_ops"
        ? await store.portalAccountById(token.sub) : await store.userById(token.sub);
      if (!user || (user.source === "plant_ops" && user.credentialVersion !== token.credentialVersion)) {
        throw fail(401, "Sign in to Plant-OPS again.");
      }
      req.plantOpsUser = user;
      if (kind === "superadmin") {
        if (user.role !== "superadmin") throw fail(403, "Super Admin access is required.");
      } else {
        if (["superadmin", "visitor"].includes(user.role)) throw fail(403, "Your account no longer has Plant-OPS access.");
        req.plantOpsScope = await scopeFor(user, req.query.workspacePlantId);
      }
      next();
    });
  }

  const employee = express.Router();
  employee.use(authenticate("employee"));
  const feature = (name) => (req, res, next) => req.plantOpsScope.features.includes(name)
    ? next()
    : next(fail(403, "This Plant-OPS feature is not enabled for your account."));
  employee.get("/me", catchAsync(async (req, res) => {
    const { vendorId, vendorCode, vendorName, plantId, plantName, role, features, contractorName, enabledPlantIds } = req.plantOpsScope;
    let plants = [{ id: plantId, name: plantName }];
    if (role === "admin" && req.plantOpsUser.source !== "plant_ops") {
      const [assigned, organizationPlants] = await Promise.all([
        store.adminMemberships(vendorId, identity(req.plantOpsUser)), store.plants(vendorCode),
      ]);
      const assignedIds = new Set(assigned.map((item) => item.plantId));
      plants = organizationPlants.filter((item) => assignedIds.has(identity(item)) && enabledPlantIds.includes(identity(item)))
        .map((item) => ({ id: identity(item), name: item.name }));
    }
    res.json({
      id: identity(req.plantOpsUser),
      name: req.plantOpsUser.name,
      email: req.plantOpsUser.email || "",
      employeeId: req.plantOpsUser.employeeId || "",
      vendorName,
      plantId,
      plantName,
      plants,
      role,
      features,
      contractorName,
      mustChangePassword: Boolean(req.plantOpsUser.mustChangePassword),
    });
  }));
  employee.put("/password", catchAsync(async (req, res) => {
    const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
    if (!currentPassword || !newPassword) {
      throw fail(400, "Enter your current password and a new password.");
    }
    if (newPassword.length < 8 || Buffer.byteLength(newPassword, "utf8") > 72) {
      throw fail(400, "New password must be between 8 and 72 characters.");
    }
    if (currentPassword === newPassword) {
      throw fail(400, "Choose a new password different from your current password.");
    }
    const userId = identity(req.plantOpsUser);
    const isPortal = req.plantOpsUser.source === "plant_ops";
    const record = isPortal
      ? await store.portalAccountWithPasswordById(userId)
      : await store.userWithPasswordById(userId);
    if (!record?.password || !await bcrypt.compare(currentPassword, record.password)) {
      throw fail(400, "Current password is incorrect.");
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    let accountClaims = {};
    if (isPortal) {
      const updated = await store.updateOwnPortalPassword(userId, hashed);
      if (!updated) throw fail(404, "Account not found.");
      accountClaims = { source: "plant_ops", credentialVersion: updated.credentialVersion };
    } else {
      const ok = await store.updateOwnUserPassword(userId, hashed);
      if (!ok) throw fail(404, "Account not found.");
    }
    const { vendorId, plantId } = req.plantOpsScope;
    await store.addEvent({
      vendorId,
      plantId,
      actorId: userId,
      actorName: req.plantOpsUser.name,
      action: "Password updated",
      detail: { name: req.plantOpsUser.name },
    });
    const token = jwt.sign({ kind: "employee", ...accountClaims }, secret(), {
      subject: userId,
      issuer,
      audience,
      algorithm: "HS256",
      expiresIn: "2h",
    });
    res.json({ token, mustChangePassword: false });
  }));
  employee.get("/employees", feature("directory"), catchAsync(async (req, res) => {
    const { vendorId, vendorCode, plantId } = req.plantOpsScope;
    // The database query projects these fields, and this response allowlist
    // also protects the API if the data source is changed.
    const found = await store.employees(vendorCode, plantId, vendorId);
    res.json(found.map(({ _id, name, employeeId, designation, department, section }) => ({
      id: String(_id), name, employeeId, designation, department, section,
    })));
  }));
  employee.get("/setup", feature("setup"), catchAsync(async (req, res) => {
    const { vendorId, plantId, areaIds } = req.plantOpsScope;
    res.json(scopedSetup(await store.setup(vendorId, plantId), areaIds));
  }));
  employee.get("/reports/setup-summary", feature("reports"), catchAsync(async (req, res) => {
    const { vendorId, vendorCode, plantId, areaIds } = req.plantOpsScope;
    const [data, employeeCount] = await Promise.all([
      store.setup(vendorId, plantId),
      Array.isArray(areaIds) ? null : store.employeeCount(vendorCode, plantId, vendorId),
    ]);
    const setup = scopedSetup(data, areaIds);
    res.json({
      employeeCount,
      departments: setup.departments.map((item) => ({
        name: item.name, areaCount: setup.areas.filter((area) => area.departmentId === item.id).length,
      })),
    });
  }));
  employee.get("/activity", feature("activity"), catchAsync(async (req, res) => {
    const { vendorId, plantId } = req.plantOpsScope;
    res.json(await store.events(vendorId, plantId));
  }));
  employee.use("/manage", feature("management"), (req, res, next) => {
    if (req.plantOpsScope.role !== "admin") return next(fail(403, "Client Admin access is required."));
    next();
  }, createManagementRouter(store, { fail, catchAsync }));
  employee.use("/ops", createOpsRouter(store, { fail, catchAsync }));
  router.use("/v1/workspace", employee);

  const control = express.Router();
  control.use(authenticate("superadmin"));
  control.param("vendorId", (req, res, next, id) => {
    Promise.resolve(store.vendor(id)).then((vendor) => {
      if (!vendor) throw fail(404, "Client not found.");
      req.plantOpsVendor = vendor;
      next();
    }).catch(next);
  });
  control.param("plantId", (req, res, next, id) => {
    Promise.resolve(store.plants(req.plantOpsVendor.vendorCode)).then((plants) => {
      if (!plants.some((plant) => identity(plant) === id)) throw fail(404, "Plant not found for this client.");
      next();
    }).catch(next);
  });
  const event = (req, action, detail) => store.addEvent({
    actorId: identity(req.plantOpsUser), actorName: req.plantOpsUser.name, vendorId: req.params.vendorId,
    plantId: req.params.plantId || "", action, detail,
  });
  control.get("/vendors", catchAsync(async (req, res) => {
    res.json((await store.vendors()).map((vendor) => ({ id: identity(vendor), name: vendor.name, vendorCode: vendor.vendorCode })));
  }));
  control.get("/vendors/:vendorId", catchAsync(async (req, res) => {
    const vendor = req.plantOpsVendor;
    const [plants, grant] = await Promise.all([store.plants(vendor.vendorCode), store.grant(req.params.vendorId)]);
    res.json({
      id: identity(vendor), name: vendor.name,
      plants: plants.map((plant) => ({ id: identity(plant), name: plant.name })),
      grant: grant || { status: "off", features: [], plantIds: [] },
    });
  }));
  control.put("/vendors/:vendorId/grant", catchAsync(async (req, res) => {
    const { status, features, plantIds } = req.body || {};
    const plants = (await store.plants(req.plantOpsVendor.vendorCode)).map(identity);
    if (!["off", "enabled", "suspended"].includes(status) ||
        !listOf(features, featureNames) || !listOf(plantIds, plants) || (status === "enabled" && !plantIds.length)) {
      throw fail(400, "Choose a valid status, plants from this client, and available features.");
    }
    const value = { status, features: [...new Set(features)], plantIds: [...new Set(plantIds)] };
    const result = await store.saveGrant(req.params.vendorId, { ...value, updatedBy: identity(req.plantOpsUser) });
    await event(req, "Application access updated", value);
    res.json(result);
  }));
  const plantPath = "/vendors/:vendorId/plants/:plantId";
  control.get(plantPath, catchAsync(async (req, res) => {
    const { vendorId, plantId } = req.params;
    const vendorCode = req.plantOpsVendor.vendorCode;
    const [users, members, setup, activity, admins] = await Promise.all([
      store.users(vendorCode, plantId), store.memberships(vendorId, plantId),
      store.setup(vendorId, plantId), store.events(vendorId, plantId), store.adminAccounts(vendorId, vendorCode, plantId),
    ]);
    const visibleIds = new Set(users.map(identity));
    const people = [...users, ...admins.filter((user) => !visibleIds.has(identity(user)))].map((user) => ({
      id: identity(user), name: user.name, email: user.email, employeeId: user.employeeId,
      role: members.find((member) => member.userId === identity(user))?.role || "",
      additionalPlantAdmin: Boolean(user.locationId && String(user.locationId) !== plantId),
    }));
    const customRoles = setup.roles.map(({ _id, name, active }) => ({ id: _id, name, active }));
    res.json({ people, ...visibleSetup(setup, { includeInactive: true }), customRoles, activity });
  }));
  control.put(plantPath + "/members/:userId", catchAsync(async (req, res) => {
    const { vendorId, plantId, userId } = req.params;
    const { role } = req.body || {};
    const user = await store.userById(userId);
    if (!user || user.vendorCode !== req.plantOpsVendor.vendorCode ||
        ["superadmin", "visitor"].includes(user.role)) throw fail(404, "Employee account not found in this client.");
    if (String(user.locationId) !== plantId) {
      const [home, target] = await Promise.all([
        store.membership(vendorId, String(user.locationId), userId), store.membership(vendorId, plantId, userId),
      ]);
      const mayGrant = role === "admin" && home?.role === "admin" && await store.plantForUser(user);
      if (!mayGrant && !(role === "" && target?.role === "admin")) {
        throw fail(404, "Employee account not found in this plant.");
      }
    }
    if (role !== "" && !roles.includes(role) &&
        !(typeof role === "string" && role.length === 36 && await store.customRole(vendorId, plantId, role))) {
      throw fail(400, "Choose a valid Plant-OPS role.");
    }
    await store.saveMembership(vendorId, plantId, userId, role, identity(req.plantOpsUser));
    await event(req, role ? "Plant-OPS role assigned" : "Plant-OPS role removed", { userId, role });
    res.json({ userId, role });
  }));
  for (const kind of ["departments", "areas"]) {
    control.post(plantPath + "/" + kind, catchAsync(async (req, res) => {
      const name = typeof req.body?.name === "string" ? req.body.name.trim().replace(/\s+/g, " ") : "";
      if (!name || name.length > 80) throw fail(400, "Enter a name up to 80 characters.");
      const { vendorId, plantId } = req.params;
      const item = { _id: randomUUID(), name, nameKey: name.toLowerCase(), active: true };
      let created;
      if (kind === "departments") {
        created = await store.addDepartment(vendorId, plantId, item);
      } else {
        const id = req.body?.departmentId;
        if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw fail(400, "Choose a department.");
        item.departmentId = id;
        created = await store.addArea(vendorId, plantId, item);
      }
      if (!created) throw fail(409, "That name is already used, or the selected department is inactive.");
      await event(req, kind === "areas" ? "Area created" : "Department created", { name, id: item._id });
      res.status(201).json({ id: item._id, name });
    }));
    control.patch(plantPath + "/" + kind + "/:id/archive", catchAsync(async (req, res) => {
      if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw fail(404, "Record not found.");
      if (!await store.archive(req.params.vendorId, req.params.plantId, kind, req.params.id)) {
        throw fail(409, "Record is already archived, not found, or has active areas.");
      }
      await event(req, kind === "areas" ? "Area archived" : "Department archived", { id: req.params.id });
      res.status(204).end();
    }));
  }
  router.use("/v1/control", control);
  router.use((req, res) => res.status(404).json({ message: "Plant-OPS endpoint not found." }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (!error.status) console.error("Plant-OPS request failed:", error.name, error.code || "");
    res.status(error.status || 500).json({ message: error.status ? error.message : "Plant-OPS could not complete the request." });
  });
  return router;
}

module.exports = { createPlantOpsRouter };
