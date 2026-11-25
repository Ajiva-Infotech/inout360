const mongoose = require("mongoose");

const { Schema } = mongoose;
const settings = { _id: false };
const condition = new Schema({ fieldId: String, value: String }, settings);
const option = new Schema({ id: String, label: String }, settings);
const group = new Schema({ id: String, entity: String, label: String }, settings);
const definition = new Schema({
  id: String,
  entity: String,
  label: String,
  type: String,
  options: [option],
  condition: { type: condition, default: null },
  screens: { type: [String], default: undefined },
  groupId: String,
  visibility: String,
}, settings);
const options = { autoCreate: false, autoIndex: false, timestamps: true, versionKey: false };
const schema = new Schema({
  _id: String,
  version: Number,
  fields: [definition],
  groups: [group],
}, { ...options, collection: "plantops_custom_field_definitions" });
const record = new Schema({
  _id: String,
  version: Number,
  values: Schema.Types.Mixed,
}, { ...options, collection: "plantops_custom_field_values" });
const Definitions = mongoose.model("PlantOpsCustomFieldDefinitions", schema);
const Values = mongoose.model("PlantOpsCustomFieldValues", record);

const key = ({ vendorId, plantId }, ...rest) => [vendorId, plantId, ...rest].join(":");

async function save(model, id, version, value) {
  try {
    const result = await model.updateOne({ _id: id, version }, { $set: value, $inc: { version: 1 } }, {
      upsert: version === 0,
    });
    return result.matchedCount === 1 || result.upsertedCount === 1;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
}

module.exports = {
  async config(scope) {
    const config = await Definitions.findById(key(scope)).select("-_id version fields groups").lean();
    if (!config) return { version: 0, fields: [], groups: [] };
    const fields = config.fields.map((field) => ({
      ...field,
      screens: field.screens ?? ["edit"],
      groupId: field.groupId ?? null,
      visibility: field.visibility ?? (field.condition ? "show_when" : "always"),
    }));
    return { version: config.version, fields, groups: config.groups || [] };
  },
  saveConfig(scope, version, fields, groups) {
    return save(Definitions, key(scope), version, { fields, groups });
  },
  async record(scope, entity, id) {
    return await Values.findById(key(scope, entity, id)).select("-_id version values").lean() || { version: 0, values: {} };
  },
  saveRecord(scope, entity, id, version, values) {
    return save(Values, key(scope, entity, id), version, { values });
  },
  discardNewRecord(scope, entity, id) {
    return Values.deleteOne({ _id: key(scope, entity, id), version: 1 });
  },
};
