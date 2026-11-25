const express = require("express");
const { randomUUID } = require("node:crypto");
const fieldsStore = require("./custom-fields-store");

const entities = ["employees", "contractors", "departments"];
const referenceTypes = { employee: "employees", contractor: "contractors", department: "departments" };
const types = ["text", "number", "date", "yes_no", "select", ...Object.keys(referenceTypes)];
const objectId = /^[a-f0-9]{24}$/;
const setupId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const maxFields = 30;
const maxGroups = 30;
const screens = ["view", "add", "edit"];
const visibilityModes = ["always", "never", "show_when", "hide_when"];
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const validVersion = (version) => Number.isSafeInteger(version) && version >= 0;

function visible(field, byId, values, depth = 0) {
  if (field.visibility === "never" || depth >= byId.size) return false;
  if (!field.condition) return true;
  const { fieldId, value } = field.condition;
  const parent = byId.get(fieldId);
  if (!parent) return false;
  const matches = values[fieldId] === value && visible(parent, byId, values, depth + 1);
  return field.visibility === "hide_when" ? !matches : matches;
}

function createCustomFields(store, { fail, catchAsync, details, readForm }) {
  const router = express.Router();
  const invalidSetup = () => fail(409, "The custom field setup changed. Close and reopen this form to load the latest fields.");

  function label(raw) {
    const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 80) throw fail(400, "Enter a label up to 80 characters.");
    return name;
  }

  function fieldOptions(body, previous) {
    if (!Array.isArray(body) || !body.length || body.length > 30) throw fail(400, "Enter between 1 and 30 options.");
    const priorIds = new Set(previous?.options.map((option) => option.id));
    const options = body.map((option) => {
      if (!plainObject(option) || (option.id && !priorIds.has(option.id))) throw fail(400, "An option is invalid. Reopen the field and try again.");
      return { id: option.id || randomUUID(), label: label(option.label) };
    });
    if (new Set(options.map((option) => option.label.toLowerCase())).size !== options.length ||
        new Set(options.map((option) => option.id)).size !== options.length) {
      throw fail(400, "Use a different label for each option.");
    }
    return options;
  }

  function validateRules(fields) {
    const byId = new Map(fields.map((field) => [field.id, field]));
    for (const field of fields) {
      const seen = new Set();
      let current = field;
      while (current.condition) {
        if (seen.has(current.id)) throw fail(400, "Visibility rules cannot depend on each other in a cycle.");
        seen.add(current.id);
        const parent = byId.get(current.condition.fieldId);
        if (!parent || parent.entity !== current.entity) throw fail(409, "Update dependent visibility rules before removing a field.");
        const allowed = parent.type === "select" ? parent.options.map((option) => option.id)
          : parent.type === "yes_no" ? ["yes", "no"] : [];
        if (!allowed.includes(current.condition.value)) throw fail(409, "Choose an existing option. Update any visibility rules that use an option before removing it.");
        current = parent;
      }
    }
  }

  router.get("/", catchAsync(async (req, res) => {
    res.json(await fieldsStore.config(req.plantOpsScope));
  }));

  async function configForEdit(req) {
    const config = await fieldsStore.config(req.plantOpsScope);
    const { version } = req.body || {};
    if (!validVersion(version)) throw fail(400, "Reload the custom field setup and try again.");
    if (version !== config.version) throw invalidSetup();
    return config;
  }

  async function commitConfig(req, res, { version, fields, groups }, action, item, status) {
    if (!await fieldsStore.saveConfig(req.plantOpsScope, version, fields, groups)) throw invalidSetup();
    await details(req, action, { id: item.id, name: item.label, entity: item.entity });
    res.status(status).json({ version: version + 1, fields, groups });
  }

  async function saveDefinition(req, res, mode) {
    const config = await configForEdit(req);
    const id = mode === "create" ? randomUUID() : req.params.id;
    const previous = config.fields.find((field) => field.id === id);
    if (mode !== "create" && !previous) throw fail(404, "Custom field not found.");
    let field = previous;
    if (mode !== "delete") {
      const { entity, type, condition: rule } = req.body;
      if (!entities.includes(entity) || !types.includes(type)) throw fail(400, "Choose a supported record and field type.");
      if (previous && (previous.entity !== entity || previous.type !== type)) throw fail(400, "Create a new field to use a different record or field type.");
      if (!previous && config.fields.filter((item) => item.entity === entity).length >= maxFields) {
        throw fail(400, `Use up to ${maxFields} custom fields per record type.`);
      }
      const name = label(req.body.label);
      if (config.fields.some((item) => item.id !== id && item.entity === entity && item.label.toLowerCase() === name.toLowerCase())) {
        throw fail(409, "A custom field already uses this label.");
      }
      const visibility = req.body.visibility ?? (rule ? "show_when" : "always");
      if (!visibilityModes.includes(visibility)) throw fail(400, "Choose a valid visibility option.");
      const conditional = visibility === "show_when" || visibility === "hide_when";
      if (conditional && (!plainObject(rule) || typeof rule.fieldId !== "string" ||
          !setupId.test(rule.fieldId) || typeof rule.value !== "string" || !rule.value)) {
        throw fail(400, "Choose a field and option for the visibility rule.");
      }
      const groupId = req.body.groupId === undefined ? previous?.groupId ?? null : req.body.groupId;
      if (groupId !== null && !config.groups.some((group) => group.id === groupId && group.entity === entity)) {
        throw fail(400, "Choose a group for this record type.");
      }
      const selected = req.body.screens ?? previous?.screens ?? ["edit"];
      if (!Array.isArray(selected) || selected.length > screens.length ||
          new Set(selected).size !== selected.length || selected.some((screen) => !screens.includes(screen))) {
        throw fail(400, "Choose valid screens for this field.");
      }
      field = {
        id, entity, label: name, type,
        options: type === "select" ? fieldOptions(req.body.options, previous) : [],
        condition: conditional ? { fieldId: rule.fieldId, value: rule.value } : null,
        screens: selected,
        groupId, visibility,
      };
    }
    const fields = mode === "create" ? [...config.fields, field]
      : mode === "update" ? config.fields.map((item) => item.id === id ? field : item)
      : config.fields.filter((item) => item.id !== id);
    validateRules(fields);
    const action = { create: "Custom field created", update: "Custom field updated", delete: "Custom field deleted" }[mode];
    await commitConfig(req, res, { ...config, fields }, action, field, mode === "create" ? 201 : 200);
  }
  router.post("/", catchAsync((req, res) => saveDefinition(req, res, "create")));
  router.put("/:id", catchAsync((req, res) => saveDefinition(req, res, "update")));
  router.delete("/:id", catchAsync((req, res) => saveDefinition(req, res, "delete")));

  async function saveGroup(req, res, mode) {
    const config = await configForEdit(req);
    const id = mode === "create" ? randomUUID() : req.params.id;
    const previous = config.groups.find((item) => item.id === id);
    if (mode !== "create" && !previous) throw fail(404, "Field group not found.");
    let group = previous;
    if (mode !== "delete") {
      const entity = previous?.entity ?? req.body.entity;
      if (!entities.includes(entity) || (previous && req.body.entity !== undefined && req.body.entity !== entity)) {
        throw fail(400, "Choose a supported record type.");
      }
      const name = label(req.body.label);
      const sameEntity = config.groups.filter((item) => item.entity === entity);
      if (!previous && sameEntity.length >= maxGroups) throw fail(400, `Use up to ${maxGroups} groups per record type.`);
      if (sameEntity.some((item) => item.id !== id && item.label.toLowerCase() === name.toLowerCase())) {
        throw fail(409, "A group already uses this name for this record type.");
      }
      group = { id, entity, label: name };
    }
    const groups = mode === "create" ? [...config.groups, group]
      : mode === "update" ? config.groups.map((item) => item.id === id ? group : item)
      : config.groups.filter((item) => item.id !== id);
    const fields = mode === "delete"
      ? config.fields.map((field) => field.groupId === id ? { ...field, groupId: null } : field)
      : config.fields;
    const action = { create: "Field group created", update: "Field group updated", delete: "Field group deleted" }[mode];
    await commitConfig(req, res, { ...config, fields, groups }, action, group, mode === "create" ? 201 : 200);
  }
  router.post("/groups", catchAsync((req, res) => saveGroup(req, res, "create")));
  router.put("/groups/:id", catchAsync((req, res) => saveGroup(req, res, "update")));
  router.delete("/groups/:id", catchAsync((req, res) => saveGroup(req, res, "delete")));

  async function findRecord(scope, entity, id, { activeOnly = false } = {}) {
    if (entity === "employees") {
      if (!objectId.test(id)) return null;
      const [row, archived] = await Promise.all([
        store.managedEmployee(scope, id), store.isEmployeeArchived(scope.vendorId, scope.plantId, id),
      ]);
      if (!row || archived || (activeOnly && row.status !== "Active")) return null;
      return { id, label: row.name + (row.employeeId ? " · " + row.employeeId : ""), name: row.name };
    }
    if (!entities.includes(entity) || !setupId.test(id)) return null;
    const data = await store.setup(scope.vendorId, scope.plantId);
    const row = data[entity].find((item) => item._id === id && item.active);
    return row ? { id, label: row.name + (row.code ? " · " + row.code : ""), name: row.name } : null;
  }

  router.get("/lookup/:entity", catchAsync(async (req, res) => {
    const { entity } = req.params;
    const query = req.query.search ?? "";
    if (!entities.includes(entity)) throw fail(404, "Record type not found.");
    if (typeof query !== "string" || query.length > 100) throw fail(400, "Enter a shorter search term.");
    const scope = req.plantOpsScope;
    const search = query.trim();
    if (entity === "employees") {
      const rows = await store.lookupEmployees(scope, search);
      return res.json(rows.map(({ _id, name, employeeId }) => ({
        id: String(_id), label: name + (employeeId ? " · " + employeeId : ""),
      })));
    }
    const data = await store.setup(scope.vendorId, scope.plantId);
    const matches = (row) => (row.name + " " + (row.code || "")).toLowerCase().includes(search.toLowerCase());
    res.json(data[entity].filter((row) => row.active && matches(row)).slice(0, 30)
      .map((row) => ({ id: row._id, label: row.name + (row.code ? " · " + row.code : "") })));
  }));

  async function recordContext(req) {
    const { entity, id } = req.params;
    const scope = req.plantOpsScope;
    const target = await findRecord(scope, entity, id);
    if (!target) throw fail(404, "Record not found in this plant.");
    const [config, record] = await Promise.all([fieldsStore.config(scope), fieldsStore.record(scope, entity, id)]);
    return { scope, entity, id, config, record, target, fields: config.fields.filter((item) => item.entity === entity) };
  }

  async function recordView({ scope, entity, config, record, fields }, screen = "edit") {
    if (screen === "view") {
      const byId = new Map(fields.map((field) => [field.id, field]));
      fields = fields.filter((field) => field.screens.includes(screen) && visible(field, byId, record.values));
    }
    const values = Object.fromEntries(fields.filter((field) => Object.hasOwn(record.values, field.id))
      .map((field) => [field.id, record.values[field.id]]));
    const lookups = fields.filter((field) => Object.hasOwn(referenceTypes, field.type) && values[field.id]);
    const labels = await Promise.all(lookups.map(async (field) => {
      const choice = await findRecord(scope, referenceTypes[field.type], values[field.id], { activeOnly: true });
      return [field.id, choice?.label || "Record unavailable"];
    }));
    const groups = config.groups.filter((group) => group.entity === entity);
    return { configVersion: config.version, version: record.version, fields, groups, values, referenceLabels: Object.fromEntries(labels) };
  }

  router.get("/records/:entity/:id", catchAsync(async (req, res) => {
    res.json(await recordView(await recordContext(req), req.query.screen === "view" ? "view" : "edit"));
  }));

  router.get("/forms/:entity/add", catchAsync(async (req, res) => {
    const { entity } = req.params;
    if (!entities.includes(entity)) throw fail(404, "Record type not found.");
    const config = await fieldsStore.config(req.plantOpsScope);
    res.json({
      configVersion: config.version,
      fields: config.fields.filter((field) => field.entity === entity),
      groups: config.groups.filter((group) => group.entity === entity),
    });
  }));

  async function validateValue(scope, field, value) {
    const bad = (message) => fail(400, field.label + " — " + message);
    if (typeof value !== "string" || value.length > 2000) throw bad("Enter text up to 2,000 characters.");
    const entry = value.trim();
    if (!entry) return "";
    if (field.type === "number" && (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(entry) || !Number.isFinite(Number(entry)))) {
      throw bad("Enter a valid number.");
    }
    if (field.type === "date") {
      const parsed = new Date(entry);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== entry) throw bad("Choose a valid date.");
    }
    if ((field.type === "yes_no" && !["yes", "no"].includes(entry)) ||
        (field.type === "select" && !field.options.some((option) => option.id === entry))) {
      throw bad("Choose an available option.");
    }
    if (Object.hasOwn(referenceTypes, field.type) && !await findRecord(scope, referenceTypes[field.type], entry, { activeOnly: true })) {
      throw bad("Choose an available record from this plant.");
    }
    return entry;
  }

  async function collectChanges(scope, fields, previous, values, screen) {
    const byId = new Map(fields.map((field) => [field.id, field]));
    const changes = Object.entries(values);
    if (changes.some(([id, value]) => !byId.get(id)?.screens.includes(screen) || typeof value !== "string" || value.length > 2000)) {
      throw fail(400, "One or more fields cannot be saved on this screen or have invalid values.");
    }
    const draft = { ...previous, ...Object.fromEntries(changes.map(([id, value]) => [id, value.trim()])) };
    const next = { ...previous };
    let changed = 0;
    for (const [fieldId] of changes) {
      const field = byId.get(fieldId);
      if (!visible(field, byId, draft) || (previous[fieldId] || "") === draft[fieldId]) continue;
      const value = await validateValue(scope, field, draft[fieldId]);
      if (value === "") delete next[fieldId];
      else next[fieldId] = value;
      changed++;
    }
    return { next, changed };
  }

  router.put("/records/:entity/:id", readForm, catchAsync(async (req, res) => {
    let input;
    try {
      input = JSON.parse(req.body.values);
    } catch {
      throw fail(400, "Could not read the submitted field values.");
    }
    if (!validVersion(input?.version) || !validVersion(input.configVersion) || !plainObject(input.values)) {
      throw fail(400, "Submit valid field values.");
    }
    const context = await recordContext(req);
    const { scope, entity, id, config, record, fields, target } = context;
    if (input.configVersion !== config.version) throw invalidSetup();
    const staleRecord = () => fail(409, "These values were updated. Close and reopen this form to load the latest values.");
    if (input.version !== record.version) throw staleRecord();
    const { next, changed } = await collectChanges(scope, fields, record.values, input.values, "edit");
    if (changed) {
      if (!await fieldsStore.saveRecord(scope, entity, id, record.version, next)) throw staleRecord();
      await details(req, "Additional fields updated", { id, name: target.name, entity, changed });
      context.record = { values: next, version: record.version + 1 };
    }
    res.json(await recordView(context));
  }));

  async function addRecord(scope, entity, id, custom, create) {
    if (custom === undefined) return create();
    if (!entities.includes(entity) || !plainObject(custom) || !validVersion(custom.configVersion) || !plainObject(custom.values)) {
      throw fail(400, "Submit valid field values for this record.");
    }
    const config = await fieldsStore.config(scope);
    if (config.version !== custom.configVersion) throw invalidSetup();
    const fields = config.fields.filter((field) => field.entity === entity);
    const { next, changed } = await collectChanges(scope, fields, {}, custom.values, "add");
    if (!changed) return create();
    // The fields are reachable only after the record with this reserved ID exists.
    if (!await fieldsStore.saveRecord(scope, entity, id, 0, next)) throw fail(409, "Try adding this record again.");
    try {
      return await create();
    } catch (error) {
      // A known rejection proves the record was not created. An ambiguous
      // database error may already have committed the record, so retain its fields.
      if ([400, 409].includes(error.status)) await fieldsStore.discardNewRecord(scope, entity, id);
      throw error;
    }
  }

  return { router, addRecord };
}

module.exports = { createCustomFields, fieldsStore };
