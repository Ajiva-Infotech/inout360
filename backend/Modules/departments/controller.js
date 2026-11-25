const DepartmentModel = require("./model");
const paginate = require("../../helpers/limitoffset");

const normalizeCode = (name, code) => {
  const raw = String(code || "").trim().toUpperCase();
  if (raw) return raw.replace(/\s+/g, "-");
  const prefix = String(name || "DEPT")
    .trim()
    .replace(/[^a-zA-Z0-9]/g, "")
    .substring(0, 4)
    .toUpperCase() || "DEPT";
  return `${prefix}-${Math.floor(100 + Math.random() * 900)}`;
};

exports.add = async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return res
        .status(400)
        .json({ status: false, message: "Department name is required" });
    }

    const code = normalizeCode(name, req.body?.code);

    const existing = await DepartmentModel.findOne({
      $or: [
        { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
        { code },
      ],
    }).lean();

    if (existing) {
      return res.status(400).json({
        status: false,
        message:
          existing.code === code
            ? "Department code already exists"
            : "Department name already exists",
      });
    }

    const department = await DepartmentModel.create({
      name,
      code,
      description: String(req.body?.description || "").trim(),
      headName: String(req.body?.headName || "").trim(),
      location: String(req.body?.location || "").trim(),
      vendorCode: String(req.body?.vendorCode || "").trim().toUpperCase(),
      status: req.body?.status === "Inactive" ? "Inactive" : "Active",
      metadata: req.body?.metadata || {},
    });

    return res.status(201).json({
      status: true,
      message: "Department created successfully",
      data: department,
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

exports.getAll = async (req, res) => {
  try {
    const { status, location, vendorCode, page, limit, search } = req.query;
    const pageNumber = Math.max(0, (parseInt(page, 10) || 1) - 1);
    const filter = {};
    if (status) filter.status = status;
    if (location) filter.location = location;
    if (vendorCode) filter.vendorCode = String(vendorCode).trim().toUpperCase();

    const result = await paginate(
      DepartmentModel,
      filter,
      pageNumber,
      limit,
      [],
      ["name", "code", "description", "headName", "location"],
      search,
      { name: 1 }
    );

    return res.status(200).json({
      status: true,
      message: "Departments fetched successfully",
      departments: result.data,
      data: result.data,
      total: result.pagination?.totalrecords ?? result.data.length,
      pagination: result.pagination,
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

exports.getList = async (req, res) => {
  try {
    const filter = {};
    if (req.query?.status) filter.status = req.query.status;
    if (req.query?.location) filter.location = req.query.location;
    const departments = await DepartmentModel.find(filter).sort({ name: 1 });
    return res.status(200).json({
      status: true,
      message: "Departments fetched successfully",
      departments,
      data: departments,
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const department = await DepartmentModel.findById(req.params.id);
    if (!department) {
      return res.status(404).json({ status: false, message: "Department not found" });
    }
    return res.status(200).json({ status: true, data: department });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const updates = {};
    if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
    if (req.body?.code !== undefined) updates.code = String(req.body.code).trim().toUpperCase();
    if (req.body?.description !== undefined) updates.description = String(req.body.description).trim();
    if (req.body?.headName !== undefined) updates.headName = String(req.body.headName).trim();
    if (req.body?.location !== undefined) updates.location = String(req.body.location).trim();
    if (req.body?.vendorCode !== undefined) updates.vendorCode = String(req.body.vendorCode).trim().toUpperCase();
    if (req.body?.status !== undefined) updates.status = req.body.status === "Inactive" ? "Inactive" : "Active";

    const updated = await DepartmentModel.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!updated) {
      return res.status(404).json({ status: false, message: "Department not found" });
    }
    return res.status(200).json({
      status: true,
      message: "Department updated successfully",
      data: updated,
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

exports.remove = async (req, res) => {
  try {
    let recordIds = req.body?.recordId || req.params?.id;
    if (!recordIds) {
      return res.status(400).json({ status: false, message: "Record ID(s) required" });
    }
    if (typeof recordIds === "string") recordIds = [recordIds];

    const result = await DepartmentModel.deleteMany({ _id: { $in: recordIds } });
    if (result.deletedCount === 0) {
      return res.status(404).json({ status: false, message: "Department not found" });
    }
    return res.status(200).json({
      status: true,
      message: `${result.deletedCount} department(s) deleted successfully`,
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

