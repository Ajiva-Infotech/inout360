const mongoose = require("mongoose");
const FloorModel = require("./model");
const paginate = require("../../helpers/limitoffset");

const normalizeCode = (name, code) => {
  const raw = String(code || "").trim().toUpperCase();
  if (raw) return raw.replace(/\s+/g, "-");
  const prefix = String(name || "FLR")
    .trim()
    .replace(/[^a-zA-Z0-9]/g, "")
    .substring(0, 4)
    .toUpperCase() || "FLR";
  return `${prefix}-${Math.floor(100 + Math.random() * 900)}`;
};

exports.add = async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return res
        .status(400)
        .json({ status: false, message: "Floor / Area name is required" });
    }

    const code = normalizeCode(name, req.body?.code);
    const exists = await FloorModel.findOne({ code }).select("_id").lean();
    if (exists) {
      return res.status(400).json({
        status: false,
        message: "Floor code already exists",
      });
    }

    const deptRef = req.body?.departmentRef;
    const floor = await FloorModel.create({
      name,
      code,
      floorNumber: String(req.body?.floorNumber || "").trim(),
      department: String(req.body?.department || "").trim(),
      departmentRef: mongoose.isValidObjectId(deptRef) ? deptRef : null,
      location: String(req.body?.location || "").trim(),
      capacity: Math.max(0, Number(req.body?.capacity) || 0),
      description: String(req.body?.description || "").trim(),
      status: req.body?.status === "Inactive" ? "Inactive" : "Active",
      metadata: req.body?.metadata || {},
    });

    return res.status(201).json({
      status: true,
      message: "Floor created successfully",
      data: floor,
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

exports.getAll = async (req, res) => {
  try {
    const { status, department, location, page, limit, search } = req.query;
    const pageNumber = Math.max(0, (parseInt(page, 10) || 1) - 1);
    const filter = {};
    if (status) filter.status = status;
    if (department) filter.department = department;
    if (location) filter.location = location;

    const result = await paginate(
      FloorModel,
      filter,
      pageNumber,
      limit,
      [],
      ["name", "code", "floorNumber", "department", "location", "description"],
      search,
      { name: 1 }
    );

    return res.status(200).json({
      status: true,
      message: "Floors fetched successfully",
      floors: result.data,
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
    if (req.query?.department) filter.department = req.query.department;
    if (req.query?.location) filter.location = req.query.location;
    const floors = await FloorModel.find(filter).sort({ name: 1 });
    return res.status(200).json({
      status: true,
      message: "Floors fetched successfully",
      floors,
      data: floors,
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

exports.getById = async (req, res) => {
  try {
    const floor = await FloorModel.findById(req.params.id);
    if (!floor) {
      return res.status(404).json({ status: false, message: "Floor not found" });
    }
    return res.status(200).json({ status: true, data: floor });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const updates = {};
    if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
    if (req.body?.code !== undefined) updates.code = String(req.body.code).trim().toUpperCase();
    if (req.body?.floorNumber !== undefined) updates.floorNumber = String(req.body.floorNumber).trim();
    if (req.body?.department !== undefined) updates.department = String(req.body.department).trim();
    if (req.body?.departmentRef !== undefined) {
      updates.departmentRef = mongoose.isValidObjectId(req.body.departmentRef)
        ? req.body.departmentRef
        : null;
    }
    if (req.body?.location !== undefined) updates.location = String(req.body.location).trim();
    if (req.body?.capacity !== undefined) updates.capacity = Math.max(0, Number(req.body.capacity) || 0);
    if (req.body?.description !== undefined) updates.description = String(req.body.description).trim();
    if (req.body?.status !== undefined) updates.status = req.body.status === "Inactive" ? "Inactive" : "Active";

    const updated = await FloorModel.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!updated) {
      return res.status(404).json({ status: false, message: "Floor not found" });
    }
    return res.status(200).json({
      status: true,
      message: "Floor updated successfully",
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

    const result = await FloorModel.deleteMany({ _id: { $in: recordIds } });
    if (result.deletedCount === 0) {
      return res.status(404).json({ status: false, message: "Floor not found" });
    }
    return res.status(200).json({
      status: true,
      message: `${result.deletedCount} floor(s) deleted successfully`,
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

