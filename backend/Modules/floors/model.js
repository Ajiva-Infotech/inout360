const { ajModel, mongoose } = require("../../common/classes/Model");

const floorSchemaDefinition = {
  name: {
    type: String,
    required: true,
    trim: true,
    index: true,
  },
  code: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
    unique: true,
    index: true,
  },
  floorNumber: {
    type: String,
    trim: true,
    default: "",
  },
  department: {
    type: String,
    trim: true,
    default: "",
    index: true,
  },
  departmentRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Department",
    default: null,
  },
  location: {
    type: String,
    trim: true,
    default: "",
    index: true,
  },
  capacity: {
    type: Number,
    default: 0,
    min: 0,
  },
  description: {
    type: String,
    trim: true,
    default: "",
  },
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active",
    index: true,
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
};

const floorTransform = (ret) => ({
  id: ret._id?.toString?.() || ret._id,
  _id: ret._id,
  name: ret.name,
  code: ret.code,
  floorNumber: ret.floorNumber || "",
  department: ret.department || "",
  departmentRef: ret.departmentRef || null,
  location: ret.location || "",
  capacity: ret.capacity ?? 0,
  description: ret.description || "",
  status: ret.status || "Active",
  metadata: ret.metadata || {},
  createdAt: ret.createdAt,
  updatedAt: ret.updatedAt,
});

const FloorModel = new ajModel(
  "Floor",
  floorSchemaDefinition,
  floorTransform
).getModel();

module.exports = FloorModel;

