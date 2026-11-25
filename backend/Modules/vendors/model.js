const { ajModel } = require("../../common/classes/Model");

const vendorSchemaDefinition = {
  name: { type: String, required: true, trim: true },
  contactPerson: { type: String, trim: true, default: "" },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  address: { type: String, trim: true },
  gstNumber: { type: String, trim: true, uppercase: true, default: "" },
  status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
  latitude: { type: Number },
  longitude: { type: Number },
  radius: { type: Number, default: 500 },
  vendorCode: {
    type: String,
    required: true,
    trim: true,
    uppercase: true,
    unique: true,
    index: true,
  },
  verified: { type: Boolean, default: false },
  otp: { type: String, trim: true },
  otpExpiry: { type: Date },
  raw: { type: Object, default: {} },
};

const vendorModel = new ajModel("Vendor", vendorSchemaDefinition);

module.exports = vendorModel.getModel();

