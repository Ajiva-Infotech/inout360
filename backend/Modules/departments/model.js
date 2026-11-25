const { ajModel, mongoose } = require("../../common/classes/Model");

const departmentSchemaDefinition = {
  name: {
    type: String,
    required: true,
    trim: true,
    unique: true,
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
  description: {
    type: String,
    trim: true,
    default: "",
  },
  headName: {
    type: String,
    trim: true,
    default: "",
  },
  location: {
    type: String,
    trim: true,
    default: "",
    index: true,
  },
  vendorCode: {
    type: String,
    trim: true,
    uppercase: true,
    default: "",
    index: true,
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

const departmentTransform = (ret) => ({
  id: ret._id?.toString?.() || ret._id,
  _id: ret._id,
  name: ret.name,
  code: ret.code,
  description: ret.description || "",
  headName: ret.headName || "",
  location: ret.location || "",
  vendorCode: ret.vendorCode || "",
  status: ret.status || "Active",
  metadata: ret.metadata || {},
  createdAt: ret.createdAt,
  updatedAt: ret.updatedAt,
});

const DepartmentModel = new ajModel(
  "Department",
  departmentSchemaDefinition,
  departmentTransform
).getModel();

module.exports = DepartmentModel;

