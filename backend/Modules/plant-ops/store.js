const mongoose = require("mongoose");
const Vendor = require("../vendors/model");
const Location = require("../location/model");
const User = require("../user/model");
const Employee = require("../employees/model");

const { Schema } = mongoose;
const options = { autoCreate: false, autoIndex: false, timestamps: true, versionKey: false };
const accessFields = {
  areaIds: { type: [String], default: undefined },
  menus: { type: [String], default: undefined },
  contractorId: String,
};
const grant = new Schema({
  _id: String,
  status: { type: String, enum: ["off", "enabled", "suspended"], required: true },
  plantIds: [String],
  features: [String],
  updatedBy: String,
}, { ...options, collection: "plantops_grants" });
const membership = new Schema({
  _id: String,
  vendorId: String,
  plantId: String,
  userId: String,
  role: String,
  updatedBy: String,
  ...accessFields,
}, { ...options, collection: "plantops_memberships" });
const account = new Schema({
  name: String,
  email: String,
  password: { type: String, select: false },
  credentialVersion: { type: Number, default: 1 },
  mustChangePassword: { type: Boolean, default: false },
  vendorCode: String,
  locationId: Schema.Types.ObjectId,
  role: String,
  ...accessFields,
}, { ...options, collection: "plantops_accounts" });
const setup = new Schema({
  _id: String,
  vendorId: String,
  plantId: String,
  departments: [{ _id: String, name: String, nameKey: String, approverId: { type: String, default: null }, active: Boolean }],
  areas: [{ _id: String, departmentId: String, name: String, nameKey: String, manpowerNeeded: { type: Number, default: null }, active: Boolean }],
  shifts: [{ _id: String, name: String, nameKey: String, code: String, startTime: String, endTime: String, active: Boolean }],
  contractors: [{ _id: String, name: String, nameKey: String, code: String, contactPerson: String, contactPhone: String, active: Boolean }],
  roles: [{ _id: String, name: String, nameKey: String, features: [String], active: Boolean }],
}, { ...options, collection: "plantops_setup" });
const employeeArchive = new Schema({
  _id: String,
  vendorId: String,
  plantId: String,
  employeeId: String,
}, { ...options, collection: "plantops_employee_archives" });
const activity = new Schema({
  vendorId: String,
  plantId: String,
  actorId: String,
  actorName: String,
  action: String,
  detail: Schema.Types.Mixed,
}, { ...options, collection: "plantops_activity" });
const Grant = mongoose.model("PlantOpsGrant", grant);
const Membership = mongoose.model("PlantOpsMembership", membership);
const Account = mongoose.model("PlantOpsAccount", account);
const Setup = mongoose.model("PlantOpsSetup", setup);
const EmployeeArchive = mongoose.model("PlantOpsEmployeeArchive", employeeArchive);
const Activity = mongoose.model("PlantOpsActivity", activity);
const key = (...parts) => parts.join(":");
const isId = (id) => typeof id === "string" && /^[a-f\d]{24}$/i.test(id);
const safeUserFields = "_id name email employeeId role vendorCode locationId mustChangePassword";
const safeAccountFields = "_id name email role vendorCode locationId areaIds menus contractorId credentialVersion mustChangePassword";
const managedEmployeeFields = "_id userId name employeeId email phone designation department section status";
const portalAccount = (account) => account && { ...account, source: "plant_ops" };
let accountIndex;

async function ensureSetup(vendorId, plantId) {
  const id = key(vendorId, plantId);
  try {
    await Setup.updateOne({ _id: id }, { $setOnInsert: { vendorId, plantId } }, { upsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  return id;
}

async function visibleEmployeeFilter(vendorId, vendorCode, plantId) {
  const archives = await EmployeeArchive.find({ vendorId, plantId }).select("employeeId -_id").lean();
  return { vendorCode, locationId: plantId, status: "Active", _id: { $nin: archives.map((entry) => entry.employeeId) } };
}

module.exports = {
  async vendors() {
    return Vendor.find().select("name vendorCode").sort({ name: 1 }).lean();
  },
  async vendor(id) {
    return isId(id) ? Vendor.findById(id).select("name vendorCode").lean() : null;
  },
  async plants(vendorCode) {
    if (!vendorCode) return [];
    return Location.find({ vendorCode }).select("name").sort({ name: 1 }).lean();
  },
  async plantForUser(user) {
    if (!user.vendorCode || !user.locationId) return null;
    return Location.findOne({ _id: user.locationId, vendorCode: user.vendorCode }).select("name vendorCode").lean();
  },
  async vendorForUser(user) {
    if (!user.vendorCode) return null;
    return Vendor.findOne({ vendorCode: user.vendorCode }).select("name vendorCode").lean();
  },
  async userByEmail(email) {
    return User.findOne({ email }).select(safeUserFields + " +password").lean();
  },
  async userById(id) {
    return isId(id) ? User.findById(id).select(safeUserFields).lean() : null;
  },
  async userWithPasswordById(id) {
    return isId(id) ? User.findById(id).select(safeUserFields + " +password").lean() : null;
  },
  async portalAccountByEmail(email) {
    return portalAccount(await Account.findOne({ email }).select(safeAccountFields + " +password").lean());
  },
  async portalAccountById(id) {
    return isId(id) ? portalAccount(await Account.findById(id).select(safeAccountFields).lean()) : null;
  },
  async portalAccountWithPasswordById(id) {
    return isId(id) ? portalAccount(await Account.findById(id).select(safeAccountFields + " +password").lean()) : null;
  },
  async addPortalAccount({ vendorCode, plantId }, value) {
    accountIndex ||= Account.collection.createIndex({ email: 1 }, { unique: true }).catch((error) => {
      accountIndex = undefined;
      throw error;
    });
    await accountIndex;
    return Account.create({ vendorCode, locationId: plantId, ...value });
  },
  async updatePortalAccount({ vendorCode, plantId }, id, access) {
    const result = await Account.updateOne({ _id: id, vendorCode, locationId: plantId, role: { $ne: "admin" } }, { $set: access });
    return result.matchedCount === 1;
  },
  async rotatePortalPassword({ vendorCode, plantId }, id, password, { mustChangePassword = true } = {}) {
    const result = await Account.updateOne({ _id: id, vendorCode, locationId: plantId, role: { $ne: "admin" } }, {
      $set: { password, mustChangePassword: Boolean(mustChangePassword) }, $inc: { credentialVersion: 1 },
    });
    return result.matchedCount === 1;
  },
  async rotateUserPassword({ vendorCode, plantId }, id, password, { mustChangePassword = true } = {}) {
    if (!isId(id)) return false;
    const result = await User.updateOne(
      { _id: id, vendorCode, locationId: plantId, role: { $nin: ["superadmin", "visitor"] } },
      { $set: { password, mustChangePassword: Boolean(mustChangePassword) } }
    );
    return result.matchedCount === 1;
  },
  async updateOwnPortalPassword(id, password) {
    if (!isId(id)) return null;
    return portalAccount(
      await Account.findByIdAndUpdate(
        id,
        { $set: { password, mustChangePassword: false }, $inc: { credentialVersion: 1 } },
        { new: true }
      ).select(safeAccountFields).lean()
    );
  },
  async updateOwnUserPassword(id, password) {
    if (!isId(id)) return false;
    const result = await User.updateOne({ _id: id }, { $set: { password, mustChangePassword: false } });
    return result.matchedCount === 1;
  },
  async linkedEmployee(user) {
    if (!user.vendorCode || !user.locationId) return null;
    return Employee.findOne({ userId: user._id, vendorCode: user.vendorCode, locationId: user.locationId })
      .select("_id name employeeId status systemAccess.loginEnabled").lean();
  },
  async users(vendorCode, plantId, { search, offset = 0, limit = 500 } = {}) {
    const filter = { vendorCode, locationId: plantId, role: { $nin: ["superadmin", "visitor"] } };
    if (search) filter.$or = [{ name: search }, { employeeId: search }, { email: search }];
    return User.find(filter).select("_id name email employeeId").sort({ name: 1, _id: 1 }).skip(offset).limit(limit).lean();
  },
  async accounts(vendorCode, plantId, { search, offset, limit }) {
    const filter = { vendorCode, locationId: new mongoose.Types.ObjectId(plantId) };
    if (search) filter.$or = [{ name: search }, { employeeId: search }, { email: search }];
    return User.aggregate([
      { $match: { ...filter, role: { $nin: ["superadmin", "visitor"] } } },
      { $project: { name: 1, email: 1, employeeId: 1 } },
      { $unionWith: { coll: Account.collection.name, pipeline: [
        { $match: filter },
        { $project: { name: 1, email: 1, role: 1, areaIds: 1, menus: 1, contractorId: 1, source: { $literal: "plant_ops" } } },
      ] } },
      { $sort: { name: 1, _id: 1 } }, { $skip: offset }, { $limit: limit },
    ]);
  },
  async employees(vendorCode, plantId, vendorId) {
    return Employee.find(await visibleEmployeeFilter(vendorId, vendorCode, plantId))
      .select("_id name employeeId designation department section").sort({ name: 1 }).limit(500).lean();
  },
  async employeeCount(vendorCode, plantId, vendorId) {
    return Employee.countDocuments(await visibleEmployeeFilter(vendorId, vendorCode, plantId));
  },
  async lookupEmployees({ vendorId, vendorCode, plantId }, term) {
    const filter = await visibleEmployeeFilter(vendorId, vendorCode, plantId);
    if (term) {
      const search = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: search }, { employeeId: search }];
    }
    return Employee.find(filter).select("_id name employeeId").sort({ name: 1, _id: 1 }).limit(30).lean();
  },
  async managedEmployees(scope, { search, offset, limit }) {
    const { vendorId, vendorCode, plantId } = scope;
    const filter = { vendorCode, locationId: plantId };
    if (search) filter.$or = [{ name: search }, { employeeId: search }, { email: search }];
    const rows = await Employee.find(filter).select(managedEmployeeFields).sort({ name: 1, _id: 1 }).skip(offset).limit(limit).lean();
    const archives = await EmployeeArchive.find({ vendorId, plantId, employeeId: { $in: rows.map((row) => String(row._id)) } })
      .select("employeeId -_id").lean();
    const hidden = new Set(archives.map((entry) => entry.employeeId));
    return rows.map((row) => ({ ...row, archived: hidden.has(String(row._id)) }));
  },
  async managedEmployee({ vendorCode, plantId }, id) {
    return Employee.findOne({ _id: id, vendorCode, locationId: plantId }).select(managedEmployeeFields).lean();
  },
  async addEmployee({ vendorCode, vendorName, plantId, plantName }, value, id) {
    const employee = new Employee({ ...value, ...(id ? { _id: id } : {}), vendorCode, vendorName, locationId: plantId, location: plantName });
    employee.set("rfid", undefined);
    if (!value.email) employee.set("email", undefined);
    await employee.save();
    return String(employee._id);
  },
  async editEmployee({ vendorCode, plantId }, id, value) {
    const result = await Employee.updateOne({ _id: id, vendorCode, locationId: plantId }, { $set: value }, { runValidators: true });
    return result.matchedCount === 1;
  },
  async isEmployeeArchived(vendorId, plantId, employeeId) {
    return Boolean(await EmployeeArchive.exists({ _id: key(vendorId, plantId, employeeId) }));
  },
  async setEmployeeArchived({ vendorId, plantId }, employeeId, archived) {
    const _id = key(vendorId, plantId, employeeId);
    if (!archived) return (await EmployeeArchive.deleteOne({ _id })).deletedCount === 1;
    try {
      const result = await EmployeeArchive.updateOne({ _id }, { $setOnInsert: { vendorId, plantId, employeeId } }, { upsert: true });
      return result.upsertedCount === 1;
    } catch (error) {
      if (error.code !== 11000) throw error;
      return false;
    }
  },
  async grant(vendorId) {
    return Grant.findById(vendorId).lean();
  },
  async saveGrant(vendorId, value) {
    return Grant.findByIdAndUpdate(vendorId, { $set: value }, { upsert: true, new: true, runValidators: true }).lean();
  },
  async membership(vendorId, plantId, userId) {
    return Membership.findById(key(vendorId, plantId, userId)).lean();
  },
  async memberships(vendorId, plantId) {
    return Membership.find({ vendorId, plantId }).select("userId role areaIds menus contractorId").lean();
  },
  async opsMembers(vendorId, vendorCode, plantId) {
    const [memberships, portalAccounts] = await Promise.all([
      Membership.find({ vendorId, plantId }).select("userId role areaIds menus contractorId").lean(),
      Account.find({ vendorCode, locationId: plantId }).select(safeAccountFields).lean(),
    ]);
    const userIds = memberships.map((m) => m.userId).filter(isId);
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds }, role: { $nin: ["superadmin", "visitor"] } })
          .select(safeUserFields)
          .lean()
      : [];
    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const shared = memberships
      .map((m) => {
        const u = userMap.get(String(m.userId));
        if (!u) return null;
        return {
          _id: u._id,
          name: u.name,
          email: u.email,
          employeeId: u.employeeId,
          role: m.role,
          areaIds: m.areaIds,
          menus: m.menus,
          contractorId: m.contractorId,
          source: "user",
        };
      })
      .filter(Boolean);
    const native = portalAccounts.map((a) => ({ ...a, source: "plant_ops" }));
    return [...shared, ...native].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  },
  async saveMemberAreaIds(vendorId, vendorCode, plantId, memberId, areaIds, actorId) {
    if (!isId(memberId)) return false;
    const portalResult = await Account.updateOne(
      { _id: memberId, vendorCode, locationId: plantId, role: { $nin: ["admin", "hr"] } },
      { $set: { areaIds } }
    );
    if (portalResult.matchedCount === 1) return true;
    const memberResult = await Membership.updateOne(
      { _id: key(vendorId, plantId, memberId), role: { $nin: ["admin", "hr"] } },
      { $set: { areaIds, updatedBy: actorId } }
    );
    return memberResult.matchedCount === 1;
  },
  async adminMemberships(vendorId, userId) {
    const filter = { vendorId, role: "admin" };
    if (userId) filter.userId = userId;
    return Membership.find(filter).select("plantId userId -_id").lean();
  },
  async adminAccounts(vendorId, vendorCode, plantId) {
    const memberships = await this.adminMemberships(vendorId);
    const ids = [...new Set(memberships.map((item) => item.userId).filter(isId))];
    const users = await User.find({ _id: { $in: ids }, vendorCode, role: { $nin: ["superadmin", "visitor"] } })
      .select("_id name email employeeId locationId").sort({ name: 1, _id: 1 }).lean();
    const assignments = new Set(memberships.map((item) => key(item.userId, item.plantId)));
    return users.filter((user) => assignments.has(key(user._id, user.locationId)) || assignments.has(key(user._id, plantId)));
  },
  async saveMembership(vendorId, plantId, userId, role, actorId) {
    const id = key(vendorId, plantId, userId);
    if (!role) return Membership.deleteOne({ _id: id });
    return Membership.findByIdAndUpdate(id, { $set: { vendorId, plantId, userId, role, updatedBy: actorId } }, { upsert: true, new: true });
  },
  async saveMemberRole(vendorId, plantId, userId, role, actorId, access = {}) {
    const filter = { _id: key(vendorId, plantId, userId), role: { $ne: "admin" } };
    if (!role) return (await Membership.deleteOne(filter)).deletedCount === 1;
    try {
      const result = await Membership.updateOne(filter, { $set: { vendorId, plantId, userId, role, updatedBy: actorId, ...access } }, { upsert: true });
      return result.matchedCount === 1 || result.upsertedCount === 1;
    } catch (error) {
      if (error.code !== 11000) throw error;
      return false;
    }
  },
  async setup(vendorId, plantId) {
    const value = await Setup.findById(key(vendorId, plantId)).lean();
    return { departments: [], areas: [], shifts: [], contractors: [], roles: [], ...value };
  },
  async customRole(vendorId, plantId, id) {
    const value = await Setup.findOne({ _id: key(vendorId, plantId), roles: { $elemMatch: { _id: id, active: true } } })
      .select("roles.$ -_id").lean();
    return value?.roles?.[0] || null;
  },
  async addDepartment(vendorId, plantId, item) {
    return this.saveSetupItem(vendorId, plantId, "departments", item);
  },
  async addArea(vendorId, plantId, item) {
    return this.saveSetupItem(vendorId, plantId, "areas", item);
  },
  async saveSetupItem(vendorId, plantId, kind, item, { editing = false } = {}) {
    const _id = editing || kind === "areas" ? key(vendorId, plantId) : await ensureSetup(vendorId, plantId);
    const duplicate = { nameKey: item.nameKey, active: true };
    if (editing) duplicate._id = { $ne: item._id };
    const filter = { _id, [kind]: { $not: { $elemMatch: duplicate } } };
    if (kind === "areas") {
      duplicate.departmentId = item.departmentId;
      filter.departments = { $elemMatch: { _id: item.departmentId, active: true } };
    }
    if (kind === "contractors" || kind === "shifts") {
      const codeMatch = { code: item.code, active: true };
      if (editing) codeMatch._id = { $ne: item._id };
      filter.$nor = [{ [kind]: { $elemMatch: codeMatch } }];
    }
    if (!editing) {
      const result = await Setup.updateOne(filter, { $push: { [kind]: item } });
      return result.modifiedCount === 1;
    }
    filter[kind].$elemMatch = { _id: item._id, active: true };
    const result = await Setup.updateOne(filter, { $set: { [kind + ".$[record]"]: item } }, {
      arrayFilters: [{ "record._id": item._id }],
    });
    return result.matchedCount === 1;
  },
  async archive(vendorId, plantId, kind, id) {
    const filter = { _id: key(vendorId, plantId), [kind]: { $elemMatch: { _id: id, active: true } } };
    if (kind === "departments") filter.areas = { $not: { $elemMatch: { departmentId: id, active: true } } };
    const result = await Setup.updateOne(filter, { $set: { [kind + ".$.active"]: false } });
    return result.modifiedCount === 1;
  },
  async addEvent(event) {
    await Activity.create(event);
  },
  async events(vendorId, plantId) {
    return Activity.find({ vendorId, plantId: { $in: [plantId, ""] } })
      .select("action actorId actorName detail createdAt").sort({ createdAt: -1 }).limit(100).lean();
  },
};
