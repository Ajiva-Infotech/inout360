const express = require("express");
const multer = require("multer");
const { Types } = require("mongoose");
const bcrypt = require("bcryptjs");
const { randomBytes, randomUUID } = require("node:crypto");
const { createCustomFields, fieldsStore } = require("./custom-fields");

const builtInRoles = {
  admin: "Client Admin",
  hr: "HR",
  incharge: "Production Incharge",
  contractor_manager: "Contractor Manager",
};
const workspaceFeatures = ["directory", "setup", "reports", "activity"];
const roleFeatures = { hr: workspaceFeatures, incharge: ["setup"], contractor_manager: ["setup"] };
const managedKinds = { departments: "Department", areas: "Area", shifts: "Shift", contractors: "Contractor", roles: "Role" };
const time24 = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const idOf = (record) => String(record?._id || "");
const objectId = /^[a-f0-9]{24}$/i;
const setupId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const pageSize = 30;
const maxImportRows = 300;
const manageForm = multer({ limits: { fields: 1, files: 0, parts: 2, fieldSize: 512 * 1024 } }).none();

function createManagementRouter(store, { fail, catchAsync }) {
  const router = express.Router();
  const text = (body, field, label, max, required = false) => {
    const raw = body?.[field];
    const value = typeof raw === "string" ? raw.trim() : "";
    if ((raw !== undefined && typeof raw !== "string") || (required && !value) || value.length > max) {
      throw fail(400, `Enter ${required ? "a" : "an optional"} ${label} up to ${max} characters.`);
    }
    return value;
  };
  const details = (req, action, detail) => {
    const { vendorId, plantId } = req.plantOpsScope;
    const actor = req.plantOpsUser;
    return store.addEvent({ vendorId, plantId, actorId: idOf(actor), actorName: actor.name, action, detail });
  };
  const customFields = createCustomFields(store, { fail, catchAsync, details, readForm });
  const employeeView = ({ _id, name, employeeId, designation, email, phone, department, status, archived }) => ({
    id: String(_id), name, employeeId, designation, email, phone, department, status, archived,
  });
  function pageOptions(req) {
    const page = Number(req.query.page ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw fail(400, "Choose a valid page.");
    const input = text(req.query, "search", "search term", 100);
    const search = input ? new RegExp(input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : undefined;
    return { search, offset: (page - 1) * pageSize, limit: pageSize + 1 };
  }
  const pageResult = (rows, map) => ({ items: rows.slice(0, pageSize).map(map), hasMore: rows.length > pageSize });

  function contractorValues(body) {
    const name = text(body, "name", "contractor name", 80, true).replace(/\s+/g, " ");
    return {
      name, nameKey: name.toLowerCase(), active: true,
      code: text(body, "code", "contractor code", 40, true).toUpperCase(),
      contactPerson: text(body, "contactPerson", "contact name", 80),
      contactPhone: text(body, "contactPhone", "contact phone number", 40),
    };
  }
  function shiftValues(body) {
    const name = text(body, "name", "shift name", 80, true).replace(/\s+/g, " ");
    const code = text(body, "code", "shift code", 20, true).toUpperCase();
    const startTime = text(body, "startTime", "start time", 5, true);
    const endTime = text(body, "endTime", "end time", 5, true);
    if (!time24.test(startTime) || !time24.test(endTime)) {
      throw fail(400, "Enter valid 24-hour start and end times (HH:MM).");
    }
    return { name, nameKey: name.toLowerCase(), code, startTime, endTime, active: true };
  }
  async function addContractor({ vendorId, plantId }, id, value) {
    if (!await store.saveSetupItem(vendorId, plantId, "contractors", { _id: id, ...value })) {
      throw fail(409, "The contractor name or code is already in use at this plant.");
    }
    return id;
  }

  function readNewRecord(req, res, next) {
    if (!req.is("multipart/form-data")) return next();
    return readForm(req, res, (err) => {
      if (err) return next(err);
      try {
        const data = JSON.parse(req.body.record);
        if (!data?.core || typeof data.core !== "object" || Array.isArray(data.core) || data.custom === undefined) {
          throw new Error("Invalid record");
        }
        req.body = data.core;
        req.customFieldsOnAdd = data.custom;
        next();
      } catch {
        next(fail(400, "Could not read the new record."));
      }
    });
  }

  router.get("/", catchAsync(async (req, res) => {
    const { vendorId, vendorCode, plantId } = req.plantOpsScope;
    const [setup, config, members] = await Promise.all([
      store.setup(vendorId, plantId),
      fieldsStore.config(req.plantOpsScope),
      store.opsMembers(vendorId, vendorCode, plantId),
    ]);
    const visible = {};
    for (const kind of Object.keys(managedKinds)) {
      visible[kind] = (setup[kind] || []).filter((item) => item.active).map(({ _id, nameKey, active, ...item }) => ({
        id: _id, ...item,
      }));
    }
    const approvers = members
      .filter((m) => m.role && m.role !== "contractor_manager")
      .map((m) => ({ id: idOf(m), name: m.name || m.email || idOf(m), email: m.email || "", role: m.role }));
    const customFieldEntities = [...new Set(config.fields.map((field) => field.entity))];
    res.json({ ...visible, approvers, builtInRoles, workspaceFeatures, roleFeatures, customFieldEntities });
  }));

  for (const [kind, label] of Object.entries(managedKinds)) {
    function setupValues(body) {
      if (kind === "contractors") return contractorValues(body);
      if (kind === "shifts") return shiftValues(body);
      const name = text(body, "name", "name", 80, true).replace(/\s+/g, " ");
      const value = { name, nameKey: name.toLowerCase(), active: true };
      if (kind === "departments") {
        const rawApprover = body?.approverId;
        if (rawApprover === undefined || rawApprover === null || rawApprover === "") {
          value.approverId = null;
        } else if (typeof rawApprover !== "string" || !objectId.test(rawApprover)) {
          throw fail(400, "Choose a valid approver for this department.");
        } else {
          value.approverId = rawApprover;
        }
      }
      if (kind === "areas") {
        if (typeof body?.departmentId !== "string" || !setupId.test(body.departmentId)) {
          throw fail(400, "Choose a department for this area.");
        }
        value.departmentId = body.departmentId;
        const rawCap = body?.manpowerNeeded;
        if (rawCap === undefined || rawCap === null || rawCap === "") {
          value.manpowerNeeded = null;
        } else {
          const parsed = Number(rawCap);
          if (!Number.isInteger(parsed) || parsed < 0 || parsed > 99999) {
            throw fail(400, "Enter a whole number between 0 and 99,999 for manpower needed.");
          }
          value.manpowerNeeded = parsed;
        }
      }
      if (kind === "roles") {
        if (Object.values(builtInRoles).some((role) => role.toLowerCase() === value.nameKey)) {
          throw fail(400, "Choose a different name. This role is built in.");
        }
        const features = body?.features;
        if (!Array.isArray(features) || features.length > workspaceFeatures.length ||
            !features.every((feature) => workspaceFeatures.includes(feature))) {
          throw fail(400, "Choose valid workspace permissions.");
        }
        value.features = [...new Set(features)];
      }
      return value;
    }

    async function save(req, res, editing) {
      const { vendorId, plantId } = req.plantOpsScope;
      const id = editing ? req.params.id : randomUUID();
      if (!setupId.test(id)) throw fail(404, label + " not found.");
      const value = setupValues(req.body);
      const persist = async () => {
        if (kind === "contractors" && !editing) return addContractor(req.plantOpsScope, id, value);
        if (!await store.saveSetupItem(vendorId, plantId, kind, { _id: id, ...value }, { editing })) {
          const setup = await store.setup(vendorId, plantId);
          if (editing && !setup[kind].some((row) => row.active && row._id === id)) {
            throw fail(404, label + " is no longer available in this plant.");
          }
          if (kind === "areas" && !setup.departments.some((row) => row.active && row._id === value.departmentId)) {
            throw fail(409, "The selected department is no longer available in this plant.");
          }
          if (kind === "contractors") throw fail(409, "The contractor name or code is already in use at this plant.");
          if (kind === "shifts") throw fail(409, "The shift name or code is already in use at this plant.");
          if (setup[kind].some((row) => row.active && row._id !== id && row.nameKey === value.nameKey &&
              (kind !== "areas" || row.departmentId === value.departmentId))) {
            const scope = kind === "areas" ? "this department" : "this plant";
            throw fail(409, label + " \"" + value.name + "\" already exists in " + scope + ".");
          }
          throw fail(409, "This plant’s setup changed while saving. Try again.");
        }
      };
      if (editing) await persist();
      else await customFields.addRecord(req.plantOpsScope, kind, id, req.customFieldsOnAdd, persist);
      await details(req, label + (editing ? " updated" : " created"), { id, name: value.name });
      res.status(editing ? 200 : 201).json({ id, name: value.name });
    }
    router.post("/" + kind, readNewRecord, catchAsync((req, res) => save(req, res, false)));
    router.patch("/" + kind + "/:id", catchAsync((req, res) => save(req, res, true)));
    router.delete("/" + kind + "/:id", catchAsync(async (req, res) => {
      const { vendorId, plantId } = req.plantOpsScope;
      const { id } = req.params;
      if (!setupId.test(id)) throw fail(404, label + " not found.");
      const item = (await store.setup(vendorId, plantId))[kind].find((row) => row._id === id && row.active);
      if (!item) throw fail(404, label + " not found.");
      if (!await store.archive(vendorId, plantId, kind, id)) {
        throw fail(409, kind === "departments" ? "Move or delete this department’s areas first." : label + " has already been deleted.");
      }
      await details(req, label + " deleted", { id, name: item.name });
      res.status(204).end();
    }));
  }

  router.get("/employees", catchAsync(async (req, res) => {
    res.json(pageResult(await store.managedEmployees(req.plantOpsScope, pageOptions(req)), employeeView));
  }));
  function employeeValues(body, editing = false) {
    const values = {
      name: text(body, "name", "name", 120, true),
    };
    if (!editing || body?.designation !== undefined) values.designation = text(body, "designation", "designation", 100);
    if (!editing || body?.phone !== undefined) values.phone = text(body, "phone", "phone number", 40);
    return values;
  }
  function newEmployeeValues(body) {
    const value = employeeValues(body);
    value.employeeId = text(body, "employeeId", "employee ID", 64, true);
    value.email = text(body, "email", "email address", 254).toLowerCase();
    if (value.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) throw fail(400, "Enter a valid email address.");
    return value;
  }
  async function addEmployee(scope, value, id) {
    try {
      return await store.addEmployee(scope, value, id);
    } catch (error) {
      if (error.code === 11000) throw fail(409, "The employee ID or email address is already in use.");
      throw error;
    }
  }
  async function employeeRecord(req) {
    const id = req.params.id;
    const record = objectId.test(id) && await store.managedEmployee(req.plantOpsScope, id);
    if (!record) throw fail(404, "Employee not found in this plant.");
    return record;
  }
  router.post("/employees", readNewRecord, catchAsync(async (req, res) => {
    const value = newEmployeeValues(req.body);
    const scope = req.plantOpsScope;
    const id = new Types.ObjectId().toString();
    await customFields.addRecord(scope, "employees", id, req.customFieldsOnAdd, () => addEmployee(scope, value, id));
    await details(req, "Employee created", { id, name: value.name });
    res.status(201).json({ id, name: value.name });
  }));

  // Use multipart for submitted record data so it bypasses the shared JSON request logger.
  function readForm(req, res, next) {
    if (!req.is("multipart/form-data")) return next(fail(415, "Submit this form from Plant-OPS."));
    manageForm(req, res, (error) => {
      if (error?.code === "LIMIT_FIELD_VALUE") return next(fail(413, "This submission has too much data. Use fewer rows or shorter values."));
      next(error ? fail(400, "Could not read the submitted data.") : undefined);
    });
  }
  router.use("/custom-fields", customFields.router);
  for (const kind of ["employees", "contractors"]) {
    router.post("/" + kind + "/import", readForm, catchAsync(async (req, res) => {
      let rows;
      try {
        rows = JSON.parse(req.body.rows);
      } catch {
        throw fail(400, "Could not read the submitted rows.");
      }
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > maxImportRows) {
        throw fail(400, `Submit between 1 and ${maxImportRows} rows at a time.`);
      }
      if (rows.some((record) => !Number.isSafeInteger(record?.row) || record.row < 2 ||
          !record.values || typeof record.values !== "object" || Array.isArray(record.values))) {
        throw fail(400, "The import contains an invalid row.");
      }
      const issues = [];
      let imported = 0;
      try {
        for (const { row, values } of rows) {
          try {
            if (kind === "employees") {
              await addEmployee(req.plantOpsScope, newEmployeeValues(values));
            } else {
              await addContractor(req.plantOpsScope, randomUUID(), contractorValues(values));
            }
            imported++;
          } catch (error) {
            if (![400, 409].includes(error.status)) throw error;
            issues.push({ row, message: error.message });
          }
        }
      } finally {
        if (imported) {
          await details(req, kind === "employees" ? "Employee import" : "Contractor import", {
            name: `${imported} added · ${issues.length} skipped`,
            imported,
            skipped: issues.length,
            submitted: rows.length,
          });
        }
      }
      res.json({ imported, skipped: issues.length, issues });
    }));
  }
  router.patch("/employees/:id", catchAsync(async (req, res) => {
    const scope = req.plantOpsScope;
    const record = await employeeRecord(req);
    const id = idOf(record);
    const value = employeeValues(req.body, true);
    if (await store.isEmployeeArchived(scope.vendorId, scope.plantId, id)) throw fail(409, "Restore this employee before editing.");
    if (!await store.editEmployee(scope, id, value)) throw fail(404, "Employee not found in this plant.");
    await details(req, "Employee updated", { id, name: value.name });
    res.json({ id, name: value.name });
  }));
  async function setEmployeeArchive(req, res, archived) {
    const scope = req.plantOpsScope;
    const record = await employeeRecord(req);
    const id = idOf(record);
    if (archived && record.userId) {
      const membership = await store.membership(scope.vendorId, scope.plantId, String(record.userId));
      if (membership?.role === "admin") throw fail(409, "A Super Admin must remove this employee’s Client Admin role first.");
    }
    if (await store.setEmployeeArchived(scope, id, archived)) {
      await details(req, archived ? "Employee removed from Plant-OPS" : "Employee restored to Plant-OPS", { id, name: record.name });
    }
    res.status(204).end();
  }
  router.delete("/employees/:id", catchAsync((req, res) => setEmployeeArchive(req, res, true)));
  router.post("/employees/:id/restore", catchAsync((req, res) => setEmployeeArchive(req, res, false)));

  function chosenItems(value, available, message) {
    if (!Array.isArray(value) || value.length > available.size || value.some((item) => !available.has(item))) {
      throw fail(400, message);
    }
    return [...new Set(value)];
  }
  async function accessFor(scope, body, current) {
    const { vendorId, plantId } = scope;
    const role = body?.role;
    if (role === "") return { role, areaIds: null, menus: null, contractorId: null };
    const custom = typeof role === "string" && setupId.test(role) ? await store.customRole(vendorId, plantId, role) : null;
    const allowed = Object.hasOwn(roleFeatures, role) ? roleFeatures[role] : custom?.features;
    if (!allowed) throw fail(400, "Choose an active Plant-OPS role. A Super Admin assigns Client Admin access.");
    const companyRole = role === "contractor_manager";
    const setup = await store.setup(vendorId, plantId);
    const contractorId = companyRole ? body.contractorId ?? (current?.role === role ? current.contractorId : null) : null;
    if (companyRole && !setup.contractors.some((item) => item.active && item._id === contractorId)) {
      throw fail(400, "Choose an active contractor company for this account.");
    }
    const oldAreas = current?.areaIds ?? (companyRole ? [] : null);
    const activeAreas = new Set(setup.areas.filter((item) => item.active).map((item) => item._id));
    let areaIds = body.areaIds === undefined
      ? Array.isArray(oldAreas) ? oldAreas.filter((id) => activeAreas.has(id)) : oldAreas
      : body.areaIds === null ? null : chosenItems(body.areaIds, activeAreas, "Choose only active areas in this plant.");
    if (companyRole && areaIds === null) areaIds = [];
    const permittedMenus = new Set(allowed.filter((item) => !Array.isArray(areaIds) || !["directory", "activity"].includes(item)));
    const oldMenus = current?.menus;
    const menus = body.menus === undefined
      ? Array.isArray(oldMenus) ? oldMenus.filter((item) => permittedMenus.has(item)) : null
      : body.menus === null ? null : chosenItems(body.menus, permittedMenus, "Choose menus available to this role and area access.");
    return { role, areaIds, menus, contractorId };
  }
  async function scopedAccount(scope, id) {
    const user = objectId.test(id) && (await store.userById(id) || await store.portalAccountById(id));
    if (!user || user.vendorCode !== scope.vendorCode || String(user.locationId) !== scope.plantId ||
        ["superadmin", "visitor"].includes(user.role)) {
      throw fail(404, "Account not found in this plant.");
    }
    return user;
  }
  const generatePassword = () => randomBytes(18).toString("base64url");
  function validateCustomPassword(raw) {
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string") throw fail(400, "Enter a valid password between 8 and 72 characters.");
    const value = raw;
    if (value.length < 8 || Buffer.byteLength(value, "utf8") > 72) {
      throw fail(400, "Password must be between 8 and 72 characters.");
    }
    return value;
  }

  router.get("/accounts", catchAsync(async (req, res) => {
    const { vendorId, vendorCode, plantId } = req.plantOpsScope;
    const [users, members] = await Promise.all([
      store.accounts(vendorCode, plantId, pageOptions(req)), store.memberships(vendorId, plantId),
    ]);
    const byUser = new Map(members.map((member) => [member.userId, member]));
    res.json(pageResult(users, (user) => {
      const { _id, name, employeeId, email, source } = user;
      const access = source === "plant_ops" ? user : byUser.get(String(_id));
      return {
        id: String(_id), name, employeeId, email, source: source || "pil",
        role: access?.role || "", areaIds: access?.areaIds ?? null, menus: access?.menus ?? null,
        contractorId: access?.contractorId ?? null,
      };
    }));
  }));
  router.post("/accounts", catchAsync(async (req, res) => {
    const scope = req.plantOpsScope;
    const name = text(req.body, "name", "name", 120, true);
    const email = text(req.body, "email", "email address", 254, true).toLowerCase();
    if (!/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(email)) throw fail(400, "Enter a valid email address.");
    const access = await accessFor(scope, req.body);
    if (!access.role) throw fail(400, "Choose a role for this account.");
    if (await store.userByEmail(email)) throw fail(409, "An account already uses this email. Assign access to the existing account if it is in this plant.");
    const customPassword = validateCustomPassword(req.body?.password);
    const password = customPassword || generatePassword();
    const mustChangePassword = req.body?.mustChangePassword !== false;
    let account;
    try {
      account = await store.addPortalAccount(scope, {
        ...access,
        name,
        email,
        password: await bcrypt.hash(password, 10),
        mustChangePassword,
      });
    } catch (error) {
      if (error.code === 11000) throw fail(409, "An account already uses this email.");
      throw error;
    }
    const id = idOf(account);
    await details(req, "Plant-OPS account created", { id, name, role: access.role });
    res.status(201).json({ id, name, email, password, mustChangePassword });
  }));
  router.put("/accounts/:id/role", catchAsync(async (req, res) => {
    const scope = req.plantOpsScope;
    const { vendorId, plantId } = scope;
    const user = await scopedAccount(scope, req.params.id);
    const userId = idOf(user);
    const native = user.source === "plant_ops";
    const current = native ? user : await store.membership(vendorId, plantId, userId);
    const { role, ...access } = await accessFor(scope, req.body, current);
    if (current?.role === "admin") throw fail(403, "A Super Admin manages Client Admin access.");
    if (role || current?.role) {
      const saved = native ? await store.updatePortalAccount(scope, userId, { role, ...access })
        : await store.saveMemberRole(vendorId, plantId, userId, role, idOf(req.plantOpsUser), access);
      if (!saved) {
        throw fail(409, "Account access changed. Refresh the list and try again.");
      }
      await details(req, role ? "Plant-OPS access updated" : "Plant-OPS role removed", {
        userId, name: user.name, role,
      });
    }
    res.json({ id: userId, role, ...access });
  }));
  router.post("/accounts/:id/password", catchAsync(async (req, res) => {
    const scope = req.plantOpsScope;
    const { vendorId, plantId } = scope;
    const user = await scopedAccount(scope, req.params.id);
    const userId = idOf(user);
    const isPortal = user.source === "plant_ops";
    const current = isPortal ? user : await store.membership(vendorId, plantId, userId);
    if (current?.role === "admin") {
      throw fail(403, "A Super Admin manages Client Admin accounts.");
    }
    const customPassword = validateCustomPassword(req.body?.password);
    const password = customPassword || generatePassword();
    const mustChangePassword = req.body?.mustChangePassword !== false;
    const hashed = await bcrypt.hash(password, 10);
    const saved = isPortal
      ? await store.rotatePortalPassword(scope, userId, hashed, { mustChangePassword })
      : await store.rotateUserPassword(scope, userId, hashed, { mustChangePassword });
    if (!saved) {
      throw fail(409, "Account access changed. Refresh the list and try again.");
    }
    await details(req, "Plant-OPS password reset", { userId, name: user.name });
    res.json({ name: user.name, email: user.email, password, mustChangePassword });
  }));
  return router;
}

module.exports = { builtInRoles, workspaceFeatures, roleFeatures, createManagementRouter };
