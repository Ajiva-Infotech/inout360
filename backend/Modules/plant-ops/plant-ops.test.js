const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const { createServer } = require("node:net");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { createPlantOpsRouter } = require("./router");
const store = require("./store");

const drainPort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
const id = (n) => n.toString(16).padStart(24, "0");
const [vendorA, vendorB, plantA, plantB, plantA2, root, userA, userB, incharge] = [1,2,3,4,5,6,7,8,9].map(id);
const secret = "test-only:plant-ops-signing-key-separate-from-pil";
const legacySecret = "test-only:legacy-pil-signer";

test("Plant-OPS shares master records, isolates roles and customers, and preserves PIL data", { timeout: 45_000 }, async () => {
  const executable = process.env.PLANT_OPS_TEST_MONGOD;
  assert.ok(executable, "Point PLANT_OPS_TEST_MONGOD at a local mongod executable.");
  const tempRoot = await fs.realpath(os.tmpdir());
  const temp = await fs.mkdtemp(path.join(tempRoot, "plant-ops-mongo-test-"));
  const port = await drainPort();
  const dbName = "plantops_test";
  const log = path.join(temp, "mongod.log");
  const child = spawn(executable, ["--bind_ip", "127.0.0.1", "--port", String(port), "--dbpath", temp, "--logpath", log, "--quiet"], { windowsHide: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("close", resolve));
  let startupError;
  child.once("error", (error) => { startupError = error; });
  let server;
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (startupError) throw startupError;
      try {
        await mongoose.connect("mongodb://127.0.0.1:" + port + "/" + dbName, {
          serverSelectionTimeoutMS: 400, autoIndex: false, autoCreate: false,
        });
        break;
      } catch (error) {
        if (child.exitCode !== null || Date.now() >= deadline) {
          const startupLog = await fs.readFile(log, "utf8").catch(() => "");
          throw new Error("Could not start the test database. " + startupLog.split(/\r?\n/).slice(-10).join("\n"), { cause: error });
        }
      }
    }
    const obj = (value) => new mongoose.Types.ObjectId(value);
    const db = mongoose.connection.db;
    await db.collection("vendors").insertMany([
      { _id: obj(vendorA), vendorCode: "ALPHA", name: "Alpha test client" },
      { _id: obj(vendorB), vendorCode: "BETA", name: "Beta test client" },
    ]);
    await db.collection("locations").insertMany([
      { _id: obj(plantA), vendorCode: "ALPHA", name: "Alpha plant" },
      { _id: obj(plantA2), vendorCode: "ALPHA", name: "Alpha second plant" },
      { _id: obj(plantB), vendorCode: "BETA", name: "Beta plant" },
    ]);
    const password = await bcrypt.hash("fixture-password", 4);
    await db.collection("users").insertMany([
      { _id: obj(root), role: "superadmin", email: "root@example.test", password, name: "Root", sessionStatus: "Logout" },
      { _id: obj(userA), role: "employee", email: "alpha@example.test", password, name: "Alpha Employee", vendorCode: "ALPHA", locationId: obj(plantA), sessionStatus: "Logout" },
      { _id: obj(userB), role: "hr", email: "beta@example.test", password, name: "Beta Employee", vendorCode: "BETA", locationId: obj(plantB), sessionStatus: "Logged In" },
      { _id: obj(incharge), role: "supervisor", email: "incharge@example.test", password, name: "Line Lead", vendorCode: "ALPHA", locationId: obj(plantA), sessionStatus: "Logout" },
    ]);
    await db.collection("employees").insertMany([
      { _id: obj(id(10)), name: "Alpha Employee", employeeId: "ALPHA-1", userId: obj(userA), vendorCode: "ALPHA", locationId: obj(plantA), status: "Active", bankDetails: { accountNumber: "fixture" } },
      { _id: obj(id(11)), name: "Beta Employee", employeeId: "BETA-1", vendorCode: "BETA", locationId: obj(plantB), status: "Active" },
      { _id: obj(id(12)), name: "Other plant", employeeId: "ALPHA-2", vendorCode: "ALPHA", locationId: obj(plantA2), status: "Active" },
    ]);
    const snapshot = async () => {
      const result = {};
      for (const name of ["vendors", "locations", "users", "employees"]) {
        result[name] = JSON.stringify(await db.collection(name).find().sort({ _id: 1 }).toArray());
      }
      return result;
    };
    const before = await snapshot();
    let available = false;
    const app = express();
    app.use(express.json());
    app.get("/api/pil-compatibility-sentinel", (req, res) => res.json({ ok: true }));
    app.use("/api/plant-ops", createPlantOpsRouter(store, { secret: () => secret, enabled: () => available }));
    server = await new Promise((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const origin = "http://127.0.0.1:" + server.address().port;
    async function call(route, status, options = {}) {
      const multipart = options.body instanceof FormData;
      const headers = { ...(options.body && !multipart ? { "Content-Type": "application/json" } : {}) };
      if (options.token) headers.Authorization = "Bearer " + options.token;
      if (options.email) headers.Authorization = "Basic " + Buffer.from(options.email + ":" + (options.password ?? "fixture-password")).toString("base64");
      const response = await fetch(origin + "/api/plant-ops/v1" + route, {
        method: options.method || (options.email ? "POST" : "GET"), headers,
        body: multipart ? options.body : options.body ? JSON.stringify(options.body) : undefined,
      });
      const body = response.status === 204 ? null : await response.json();
      assert.equal(response.status, status, route + " " + JSON.stringify(body));
      return body;
    }
    await call("/session", 503, { email: "alpha@example.test" });
    assert.deepEqual(await (await fetch(origin + "/api/pil-compatibility-sentinel")).json(), { ok: true });
    available = true;
    await call("/session", 403, { email: "alpha@example.test" });
    await call("/control/session", 403, { email: "alpha@example.test" });
    const { token } = await call("/control/session", 200, { email: "root@example.test" });
    const legacyToken = jwt.sign({ userId: root, role: "superadmin" }, legacySecret);
    await call("/control/vendors", 401, { token: legacyToken });
    assert.equal((await call("/control/vendors", 200, { token })).length, 2);
    const client = "/control/vendors/" + vendorA;
    const plant = client + "/plants/" + plantA;
    assert.equal((await call(client, 200, { token })).grant.status, "off");
    await call(plant + "/members/" + userB, 404, { token, method: "PUT", body: { role: "hr" } });
    await call(client + "/plants/" + plantB, 404, { token });
    await call(client + "/grant", 400, { token, method: "PUT", body: { status: "enabled", plantIds: [plantB], features: [] } });
    const grant = { status: "enabled", plantIds: [plantA], features: ["directory", "setup", "reports", "activity"] };
    const saveGrant = (body) => call(client + "/grant", 200, { token, method: "PUT", body });
    await saveGrant(grant);
    await call("/session", 403, { email: "alpha@example.test" });
    await call(plant + "/members/" + userA, 200, { token, method: "PUT", body: { role: "hr" } });
    await call(plant + "/members/" + incharge, 200, { token, method: "PUT", body: { role: "incharge" } });
    const dept = await call(plant + "/departments", 201, { token, method: "POST", body: { name: "Production" } });
    await call(plant + "/departments", 409, { token, method: "POST", body: { name: " production " } });
    const area = await call(plant + "/areas", 201, { token, method: "POST", body: { name: "Line 1", departmentId: dept.id } });
    await call(plant + "/departments/" + dept.id + "/archive", 409, { token, method: "PATCH" });
    await call(plant + "/areas", 409, { token, method: "POST", body: { name: "line 1", departmentId: dept.id } });
    await call("/session", 403, { email: "beta@example.test" });
    const { token: access } = await call("/session", 200, { email: "alpha@example.test" });
    const { token: lead } = await call("/session", 200, { email: "incharge@example.test" });
    await call("/control/vendors", 401, { token: access });
    await call("/workspace/employees", 403, { token: lead });
    await call("/workspace/reports/setup-summary", 403, { token: lead });
    const workspace = "/workspace";
    const people = await call(workspace + "/employees?plantId=" + plantB, 200, { token: access });
    assert.equal(people.length, 1);
    assert.equal(people[0].employeeId, "ALPHA-1");
    assert.equal(people[0].bankDetails, undefined);
    const report = await call(workspace + "/reports/setup-summary", 200, { token: access });
    assert.deepEqual(report, { employeeCount: 1, departments: [{ name: "Production", areaCount: 1 }] });
    assert.equal((await call(workspace + "/setup", 200, { token: access })).areas[0].id, area.id);
    assert.ok((await call(workspace + "/activity", 200, { token: access })).some((row) => row.action === "Area created"));
    await call(plant + "/areas/" + area.id + "/archive", 204, { token, method: "PATCH" });
    await call(plant + "/departments/" + dept.id + "/archive", 204, { token, method: "PATCH" });
    assert.equal((await call(workspace + "/setup", 200, { token: access })).departments.length, 0);
    await saveGrant({ ...grant, features: ["setup"] });
    await call(workspace + "/employees", 403, { token: access });
    await saveGrant({ ...grant, status: "suspended" });
    await call(workspace + "/me", 403, { token: access });
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await (await fetch(origin + "/api/pil-compatibility-sentinel")).json(), { ok: true });

    const manage = workspace + "/manage";
    await call(manage, 401);
    await saveGrant(grant);
    await call(plant + "/members/" + userA, 200, { token, method: "PUT", body: { role: "admin" } });
    await call(manage, 403, { token: access });
    const enabledGrant = { ...grant, features: [...grant.features, "management"] };
    await saveGrant(enabledGrant);
    const admin = (route, status, method, body) => call(manage + route, status, { token: access, method, body });
    assert.ok((await call(workspace + "/me", 200, { token: access })).features.includes("management"));
    await call(manage, 403, { token: lead });

    const department = await admin("/departments", 201, "POST", { name: "Quality" });
    await admin("/departments/" + department.id, 200, "PATCH", { name: "Quality Control" });
    const lab = await admin("/areas", 201, "POST", { name: "Lab", departmentId: department.id });
    await admin("/areas/" + lab.id, 200, "PATCH", { name: "QA Lab", departmentId: department.id });
    assert.equal((await admin("", 200)).areas[0].name, "QA Lab");
    await admin("/departments/" + department.id, 409, "DELETE");
    await admin("/areas/" + lab.id, 204, "DELETE");
    await admin("/departments/" + department.id, 204, "DELETE");
    assert.equal((await admin("", 200)).departments.length, 0);

    const contractor = await admin("/contractors", 201, "POST", { name: "Atlas Labour", code: "atl" });
    await admin("/contractors", 409, "POST", { name: "Other agency", code: "ATL" });
    await admin("/contractors/" + contractor.id, 200, "PATCH", { name: "Atlas Team", code: "atl", contactPerson: "Mira" });
    assert.equal((await admin("", 200)).contractors[0].contactPerson, "Mira");
    await admin("/contractors/" + contractor.id, 204, "DELETE");
    assert.equal((await admin("", 200)).contractors.length, 0);
    await admin("/contractors", 201, "POST", { name: "Atlas Team", code: "ATL" });
    assert.deepEqual(await snapshot(), before);

    await admin("/roles", 400, "POST", { name: "Admin copy", features: ["management"] });
    const custom = await admin("/roles", 201, "POST", { name: "Planner", features: ["setup"] });
    await admin("/accounts/" + incharge + "/role", 400, "PUT", { role: "admin" });
    await admin("/accounts/" + userA + "/role", 403, "PUT", { role: "" });
    await admin("/accounts/" + userB + "/role", 404, "PUT", { role: custom.id });
    await admin("/accounts/" + incharge + "/role", 200, "PUT", { role: custom.id });
    assert.equal((await admin("/accounts?search=Line", 200)).items[0].role, custom.id);
    assert.deepEqual((await call(workspace + "/me", 200, { token: lead })).features, ["setup"]);
    await admin("/roles/" + custom.id, 200, "PATCH", { name: "Planning Reports", features: ["reports"] });
    await call(workspace + "/setup", 403, { token: lead });
    await call(workspace + "/reports/setup-summary", 200, { token: lead });
    await admin("/roles/" + custom.id, 204, "DELETE");
    await call(workspace + "/me", 403, { token: lead });
    await admin("/accounts/" + incharge + "/role", 200, "PUT", { role: "hr" });
    await call(manage, 403, { token: lead });
    await call(plant + "/members/" + incharge, 400, { token, method: "PUT", body: { role: custom.id } });
    assert.deepEqual(await snapshot(), before);

    const employees = db.collection("employees");
    await employees.createIndex({ employeeId: 1 }, { unique: true });
    await employees.createIndex({ email: 1 }, { unique: true, sparse: true });
    await employees.createIndex({ rfid: 1 }, { unique: true, sparse: true });
    assert.equal((await admin("/employees", 200)).items.length, 1);
    assert.equal((await admin("/employees?search=%5B", 200)).items.length, 0);
    const worker = await admin("/employees", 201, "POST", { name: "New Worker", employeeId: "ALPHA-NEW", vendorCode: "BETA", locationId: plantB });
    await admin("/employees", 201, "POST", { name: "Another Worker", employeeId: "ALPHA-NEW2" });
    await admin("/employees", 409, "POST", { name: "Duplicate Worker", employeeId: "ALPHA-NEW" });
    await admin("/employees/" + worker.id, 200, "PATCH", { name: "New Worker", designation: "Technician", status: "Inactive" });
    const stored = await employees.findOne({ _id: obj(worker.id) });
    assert.equal(stored.designation, "Technician");
    assert.equal(stored.vendorCode, "ALPHA");
    assert.equal(String(stored.locationId), plantA);
    assert.equal(stored.status, "Active");
    assert.equal(stored.userId, undefined);
    await admin("/employees/" + id(10), 409, "DELETE");
    await admin("/employees/" + id(11), 404, "DELETE");
    await admin("/employees/" + id(12), 404, "PATCH", { name: "Other plant changed" });
    await employees.updateOne({ _id: obj(worker.id) }, { $set: { userId: obj(incharge) } });
    const preArchive = await snapshot();
    await admin("/employees/" + worker.id, 204, "DELETE");
    await call(workspace + "/me", 403, { token: lead });
    assert.equal((await admin("/employees?search=ALPHA-NEW", 200)).items.find((row) => row.id === worker.id).archived, true);
    assert.equal((await call(workspace + "/reports/setup-summary", 200, { token: access })).employeeCount, 2);
    assert.deepEqual(await snapshot(), preArchive);
    await admin("/employees/" + worker.id + "/restore", 204, "POST");
    await call(workspace + "/me", 200, { token: lead });
    assert.equal((await call(workspace + "/reports/setup-summary", 200, { token: access })).employeeCount, 3);
    assert.ok((await call(workspace + "/activity", 200, { token: access }))
      .some((item) => item.action === "Employee restored to Plant-OPS" && item.actorName === "Alpha Employee"));

    function importPayload(rows) {
      const form = new FormData();
      form.set("rows", JSON.stringify(rows.map((values, index) => ({ row: index + 2, values }))));
      return form;
    }
    const employeeImport = [
      { name: "Imported Worker", employeeId: "00042", email: "worker@example.test", vendorCode: "BETA", locationId: plantB },
      { name: "Would overwrite", employeeId: "ALPHA-NEW" },
      { name: "Duplicate work email", employeeId: "00043", email: "WORKER@example.test" },
      { name: "Missing employee ID" },
      { name: "Invalid email", employeeId: "00044", email: "bad-email" },
    ];
    await call(manage + "/employees/import", 403, { token: lead, method: "POST", body: importPayload(employeeImport) });
    await admin("/employees/import", 415, "POST", { rows: [] });
    await admin("/employees/import", 400, "POST", importPayload([]));
    await admin("/employees/import", 400, "POST", importPayload(Array(301).fill(employeeImport[0])));
    const employeeResult = await admin("/employees/import", 200, "POST", importPayload(employeeImport));
    assert.deepEqual([employeeResult.imported, employeeResult.skipped], [1, 4]);
    assert.deepEqual(employeeResult.issues.map(({ row }) => row), [3, 4, 5, 6]);
    const importedWorker = await employees.findOne({ employeeId: "00042" });
    assert.equal(importedWorker.vendorCode, "ALPHA");
    assert.equal(String(importedWorker.locationId), plantA);
    assert.equal(importedWorker.userId, undefined);
    assert.equal((await employees.findOne({ employeeId: "ALPHA-NEW" })).name, "New Worker");
    assert.equal((await admin("/employees/import", 200, "POST", importPayload(employeeImport))).imported, 0);

    const contractorResult = await admin("/contractors/import", 200, "POST", importPayload([
      { name: "Test Staffing", code: "000st", contactPerson: "Sample", contactPhone: "01234" },
      { name: "Different Company", code: "000ST" },
      { name: "test staffing", code: "DIFFERENT" },
      { name: "Missing code" },
    ]));
    assert.deepEqual([contractorResult.imported, contractorResult.skipped], [1, 3]);
    const importedContractor = (await admin("", 200)).contractors.find((item) => item.name === "Test Staffing");
    assert.equal(importedContractor.code, "000ST");
    assert.equal(importedContractor.contactPhone, "01234");
    assert.equal(await db.collection("contractors").countDocuments(), 0);
    assert.ok((await call(workspace + "/activity", 200, { token: access }))
      .some((item) => item.action === "Contractor import" && item.detail.submitted === 4));

    const sharedBeforeFields = await snapshot();
    const fieldsPath = "/custom-fields";
    await call(manage + fieldsPath, 403, { token: lead });
    let config = await admin(fieldsPath, 200);
    assert.deepEqual(config, { version: 0, fields: [], groups: [] });
    async function createField(values) {
      config = await admin(fieldsPath, 201, "POST", { version: config.version, ...values });
      return config.fields.at(-1);
    }
    const engagement = await createField({ entity: "employees", type: "select", label: "Engagement",
      options: [{ label: "Permanent" }, { label: "Contract" }] });
    const [permanent, contract] = engagement.options;
    const agency = await createField({ entity: "employees", type: "contractor", label: "Agency",
      condition: { fieldId: engagement.id, value: contract.id } });
    const orientation = await createField({ entity: "employees", type: "yes_no", label: "Orientation needed",
      condition: { fieldId: engagement.id, value: contract.id } });
    const startDate = await createField({ entity: "employees", type: "date", label: "Orientation date",
      condition: { fieldId: orientation.id, value: "yes" } });
    const departmentForLink = await admin("/departments", 201, "POST", { name: "Warehouse" });
    const departmentLink = await createField({ entity: "contractors", type: "department", label: "Assigned department" });
    const cappedHours = await createField({ entity: "departments", type: "number", label: "Maximum hours" });

    await admin(fieldsPath, 409, "POST", { version: 0, entity: "employees", type: "text", label: "Stale form" });
    await admin(fieldsPath + "/" + engagement.id, 409, "DELETE", { version: config.version });
    await admin(fieldsPath + "/" + engagement.id, 409, "PUT", {
      ...engagement, options: [permanent], version: config.version,
    });
    await admin(fieldsPath + "/" + engagement.id, 400, "PUT", {
      ...engagement, visibility: "show_when", condition: { fieldId: orientation.id, value: "yes" }, version: config.version,
    });
    config = await admin(fieldsPath + "/" + engagement.id, 200, "PUT", {
      ...engagement, options: [permanent, { ...contract, label: "Contract labour" }], version: config.version,
    });
    assert.equal(config.fields.find(({ id }) => id === engagement.id).options[1].id, contract.id);
    assert.deepEqual((await admin("", 200)).customFieldEntities, ["employees", "contractors", "departments"]);
    assert.ok((await admin(fieldsPath + "/lookup/employees?search=Imported", 200)).some((item) => item.label.endsWith("00042")));
    assert.deepEqual(await admin(fieldsPath + "/lookup/employees?search=Other%20plant", 200), []);
    await admin(fieldsPath + "/records/employees/" + id(12), 404);
    await admin(fieldsPath + "/records/employees/" + id(11), 404);
    const employeeFields = fieldsPath + "/records/employees/" + importedWorker._id;
    const contractorFields = fieldsPath + "/records/contractors/" + importedContractor.id;
    const departmentFields = fieldsPath + "/records/departments/" + departmentForLink.id;
    function customValues(version, values, configVersion = config.version) {
      const form = new FormData();
      form.set("values", JSON.stringify({ version, configVersion, values }));
      return form;
    }
    const initial = await admin(employeeFields, 200);
    assert.equal(initial.version, 0);
    assert.equal(initial.fields.length, 4);
    await admin(employeeFields, 409, "PUT", customValues(0, { [engagement.id]: contract.id }, config.version - 1));
    await admin(employeeFields, 400, "PUT", customValues(0, { [departmentLink.id]: departmentForLink.id }));
    await admin(employeeFields, 400, "PUT", customValues(0, { [engagement.id]: contract.id, [agency.id]: engagement.id }));
    await admin(employeeFields, 400, "PUT", customValues(0, {
      [engagement.id]: contract.id, [orientation.id]: "yes", [startDate.id]: "2026-02-31",
    }));
    const hidden = await admin(employeeFields, 200, "PUT", customValues(0, {
      [engagement.id]: permanent.id, [agency.id]: "ignored while hidden", [orientation.id]: "yes", [startDate.id]: "2026-11-25",
    }));
    assert.deepEqual(hidden.values, { [engagement.id]: permanent.id });
    const linked = await admin(employeeFields, 200, "PUT", customValues(1, {
      [engagement.id]: contract.id, [agency.id]: importedContractor.id, [orientation.id]: "yes", [startDate.id]: "2026-11-25",
    }));
    assert.equal(linked.referenceLabels[agency.id], "Test Staffing · 000ST");
    assert.equal(linked.values[startDate.id], "2026-11-25");
    await admin(employeeFields, 409, "PUT", customValues(1, { [engagement.id]: permanent.id }));
    const toggled = await admin(employeeFields, 200, "PUT", customValues(2, {
      [engagement.id]: permanent.id, [agency.id]: "",
    }));
    assert.equal(toggled.values[agency.id], importedContractor.id);
    assert.equal((await admin(contractorFields, 200, "PUT", customValues(0, {
      [departmentLink.id]: departmentForLink.id,
    }))).referenceLabels[departmentLink.id], "Warehouse");
    await admin(departmentFields, 400, "PUT", customValues(0, { [cappedHours.id]: "not a number" }));
    assert.equal((await admin(departmentFields, 200, "PUT", customValues(0, { [cappedHours.id]: "12.5" }))).values[cappedHours.id], "12.5");
    config = await admin(fieldsPath + "/" + startDate.id, 200, "DELETE", { version: config.version });
    assert.equal((await admin(employeeFields, 200)).values[startDate.id], undefined);
    assert.deepEqual(await snapshot(), sharedBeforeFields);
    assert.ok((await call(workspace + "/activity", 200, { token: access }))
      .some((item) => item.action === "Additional fields updated" && item.detail.entity === "employees"));

    const definitions = db.collection("plantops_custom_field_definitions");
    await definitions.updateOne({ "fields.id": engagement.id }, {
      $unset: { "fields.$.screens": "", "fields.$.visibility": "", "fields.$.groupId": "" },
    });
    await definitions.updateOne({ "fields.id": engagement.id }, { $unset: { groups: "" } });
    const legacyConfig = await admin(fieldsPath, 200);
    assert.deepEqual(legacyConfig.fields.find(({ id }) => id === engagement.id).screens, ["edit"]);
    assert.equal(legacyConfig.fields.find(({ id }) => id === engagement.id).visibility, "always");
    assert.deepEqual(legacyConfig.groups, []);
    await admin(fieldsPath, 400, "POST", {
      version: config.version, entity: "employees", label: "Invalid visibility", type: "text", screens: ["delete"],
    });
    config = await admin(fieldsPath + "/" + engagement.id, 200, "PUT", {
      ...legacyConfig.fields.find(({ id }) => id === engagement.id), screens: ["add", "edit"], version: config.version,
    });
    const reportingTo = await createField({ entity: "employees", type: "employee", label: "Reporting To",
      screens: ["add", "view"], condition: { fieldId: engagement.id, value: contract.id } });
    const addForm = await admin(fieldsPath + "/forms/employees/add", 200);
    assert.equal(addForm.configVersion, config.version);
    assert.deepEqual(addForm.fields.find(({ id }) => id === reportingTo.id).screens, ["add", "view"]);
    function createWithFields(core, values, configVersion = config.version) {
      const form = new FormData();
      form.set("record", JSON.stringify({ core, custom: { configVersion, values } }));
      return form;
    }
    const pendingEmployee = { name: "New hire", employeeId: "NEW-WITH-FIELDS" };
    const addValues = { [engagement.id]: contract.id, [reportingTo.id]: id(10) };
    await admin("/employees", 409, "POST", createWithFields(pendingEmployee, addValues, config.version - 1));
    await admin("/employees", 400, "POST", createWithFields(pendingEmployee, { [engagement.id]: contract.id, [reportingTo.id]: id(12) }));
    await admin("/employees", 400, "POST", createWithFields(pendingEmployee, { ...addValues, [orientation.id]: "yes" }));
    assert.equal(await employees.countDocuments({ employeeId: pendingEmployee.employeeId }), 0);
    const extraValues = db.collection("plantops_custom_field_values");
    const savedCount = await extraValues.countDocuments();
    await admin("/employees", 409, "POST", createWithFields({ ...pendingEmployee, employeeId: "ALPHA-NEW" }, addValues));
    assert.equal(await extraValues.countDocuments(), savedCount);
    const newHire = await admin("/employees", 201, "POST", createWithFields(pendingEmployee, addValues));
    const newHireFields = fieldsPath + "/records/employees/" + newHire.id;
    const viewHire = await admin(newHireFields + "?screen=view", 200);
    assert.deepEqual(viewHire.fields.map(({ id }) => id), [reportingTo.id]);
    assert.deepEqual(viewHire.values, { [reportingTo.id]: id(10) });
    assert.equal(viewHire.referenceLabels[reportingTo.id], "Alpha Employee · ALPHA-1");
    await admin(newHireFields, 400, "PUT", customValues(1, { [reportingTo.id]: "" }));
    await admin(newHireFields, 200, "PUT", customValues(1, { [engagement.id]: permanent.id }));
    assert.deepEqual((await admin(newHireFields + "?screen=view", 200)).fields, []);
    const workNote = await createField({ entity: "contractors", type: "text", label: "Registration notes", screens: ["view", "add"] });
    const newContractor = await admin("/contractors", 201, "POST", createWithFields({
      name: "Onboarding Contractor", code: "OC",
    }, { [workNote.id]: "Verified" }));
    assert.equal((await admin(fieldsPath + "/records/contractors/" + newContractor.id + "?screen=view", 200)).values[workNote.id], "Verified");
    config = await admin(fieldsPath + "/" + cappedHours.id, 200, "PUT", {
      ...cappedHours, screens: ["view", "add"], version: config.version,
    });
    const newDepartment = await admin("/departments", 201, "POST", createWithFields({ name: "Planning" }, { [cappedHours.id]: "24" }));
    assert.equal((await admin(fieldsPath + "/records/departments/" + newDepartment.id + "?screen=view", 200)).values[cappedHours.id], "24");

    const groupsPath = fieldsPath + "/groups";
    await call(manage + groupsPath, 403, { token: lead, method: "POST", body: {
      version: config.version, entity: "employees", label: "Blocked",
    } });
    config = await admin(groupsPath, 201, "POST", {
      version: config.version, entity: "employees", label: "Employment Details",
    });
    const employmentGroup = config.groups[0];
    await admin(groupsPath, 409, "POST", { version: config.version, entity: "employees", label: "employment details" });
    config = await admin(groupsPath, 201, "POST", { version: config.version, entity: "departments", label: "Planning Details" });
    const planningGroup = config.groups[1];
    await admin(fieldsPath + "/" + reportingTo.id, 400, "PUT", {
      ...reportingTo, version: config.version, groupId: planningGroup.id,
    });
    config = await admin(fieldsPath + "/" + reportingTo.id, 200, "PUT", {
      ...reportingTo, version: config.version, groupId: employmentGroup.id,
    });
    await admin(groupsPath + "/" + employmentGroup.id, 409, "PUT", { version: config.version - 1, label: "Stale name" });
    config = await admin(groupsPath + "/" + employmentGroup.id, 200, "PUT", {
      version: config.version, label: "People Details",
    });
    const addEmployeeForm = await admin(fieldsPath + "/forms/employees/add", 200);
    assert.deepEqual(addEmployeeForm.groups.map(({ label }) => label), ["People Details"]);
    assert.equal(addEmployeeForm.fields.find(({ id }) => id === reportingTo.id).groupId, employmentGroup.id);
    await admin(fieldsPath, 400, "POST", {
      version: config.version, entity: "employees", type: "text", label: "Incomplete rule", visibility: "hide_when",
    });
    const internalNote = await createField({
      entity: "employees", type: "text", label: "Internal note", screens: ["view", "edit"], groupId: employmentGroup.id,
      visibility: "hide_when", condition: { fieldId: engagement.id, value: contract.id },
    });
    const noteText = "Scheduled follow-up";
    await admin(newHireFields, 200, "PUT", customValues(2, { [internalNote.id]: noteText }));
    let view = await admin(newHireFields + "?screen=view", 200);
    assert.equal(view.values[internalNote.id], noteText);
    const usersBeforeProvision = (await snapshot()).users;
    const allowedArea = await admin("/areas", 201, "POST", { name: "Assigned line", departmentId: newDepartment.id });
    const otherArea = await admin("/areas", 201, "POST", { name: "Other line", departmentId: newDepartment.id });
    const roleRows = [
      { name: "Production Test", email: "new-production@example.test", role: "incharge", areaIds: [allowedArea.id] },
      { name: "HR Test", email: "new-hr@example.test", role: "hr", areaIds: [otherArea.id], menus: ["setup", "reports"] },
      { name: "Contractor Test", email: "new-contractor@example.test", role: "contractor_manager", contractorId: importedContractor.id, areaIds: [allowedArea.id] },
    ];
    await call(manage + "/accounts", 403, { token: lead, method: "POST", body: roleRows[0] });
    await admin("/accounts", 400, "POST", { ...roleRows[0], role: "admin" });
    await admin("/accounts", 400, "POST", { ...roleRows[1], menus: ["directory"] });
    await admin("/accounts", 400, "POST", { ...roleRows[0], areaIds: [departmentForLink.id] });
    await admin("/accounts", 400, "POST", { ...roleRows[2], contractorId: null });
    await admin("/accounts", 409, "POST", { ...roleRows[0], email: "alpha@example.test" });
    const created = [];
    for (const row of roleRows) created.push(await admin("/accounts", 201, "POST", row));
    await admin("/accounts", 409, "POST", { ...roleRows[0], email: roleRows[0].email.toUpperCase() });
    const listed = await admin("/accounts?search=new-", 200);
    assert.equal(listed.items.length, 3);
    assert.ok(listed.items.every((account) => account.source === "plant_ops" && !Object.hasOwn(account, "password")));
    assert.equal((await snapshot()).users, usersBeforeProvision);
    const signed = [];
    for (const [index, row] of roleRows.entries()) {
      const login = { email: row.email, password: created[index].password };
      const { token: accountToken } = await call("/session", 200, login);
      signed.push(accountToken);
      const me = await call(workspace + "/me", 200, { token: accountToken });
      assert.equal(me.role, row.role);
      assert.equal(me.contractorName, row.contractorId ? "Test Staffing" : undefined);
      assert.deepEqual(me.features, index === 1 ? ["setup", "reports"] : ["setup"]);
      assert.deepEqual((await call(workspace + "/setup", 200, { token: accountToken })).areas.map(({ id }) => id), row.areaIds);
      await call(workspace + "/employees", 403, { token: accountToken });
      await call(workspace + "/activity", 403, { token: accountToken });
      await call(manage + "/accounts", 403, { token: accountToken });
    }
    const scopedReport = await call(workspace + "/reports/setup-summary", 200, { token: signed[1] });
    assert.deepEqual(scopedReport, { employeeCount: null, departments: [{ name: "Planning", areaCount: 1 }] });
    await admin("/accounts/" + incharge + "/role", 200, "PUT", {
      role: "incharge", areaIds: [otherArea.id], menus: ["setup"],
    });
    assert.deepEqual((await call(workspace + "/setup", 200, { token: lead })).areas.map(({ id }) => id), [otherArea.id]);
    await admin("/accounts/" + userA + "/password", 403, "POST");
    await admin("/accounts/" + created[0].id + "/role", 200, "PUT", { role: "incharge", areaIds: [otherArea.id], menus: [] });
    assert.deepEqual((await call(workspace + "/me", 200, { token: signed[0] })).features, []);
    await call(workspace + "/setup", 403, { token: signed[0] });
    const reset = await admin("/accounts/" + created[0].id + "/password", 200, "POST");
    assert.notEqual(reset.password, created[0].password);
    await call(workspace + "/me", 401, { token: signed[0] });
    await call("/session", 401, { email: created[0].email, password: created[0].password });
    await call("/session", 200, { email: created[0].email, password: reset.password });
    await admin("/accounts/" + created[2].id + "/role", 200, "PUT", { role: "" });
    await call(workspace + "/me", 403, { token: signed[2] });
    assert.equal(view.values[reportingTo.id], undefined);
    assert.equal(view.groups[0].label, "People Details");
    await admin(newHireFields, 200, "PUT", customValues(3, {
      [engagement.id]: contract.id, [internalNote.id]: "Ignore while hidden",
    }));
    view = await admin(newHireFields + "?screen=view", 200);
    assert.equal(view.values[internalNote.id], undefined);
    assert.equal(view.values[reportingTo.id], id(10));
    config = await admin(fieldsPath + "/" + internalNote.id, 200, "PUT", {
      ...internalNote, version: config.version, visibility: "never", condition: null,
    });
    await admin(newHireFields, 200, "PUT", customValues(4, {
      [engagement.id]: permanent.id, [internalNote.id]: "Ignore while always hidden",
    }));
    assert.deepEqual((await admin(newHireFields + "?screen=view", 200)).values, {});
    config = await admin(fieldsPath + "/" + internalNote.id, 200, "PUT", {
      ...internalNote, version: config.version, visibility: "always", condition: null,
    });
    assert.equal((await admin(newHireFields + "?screen=view", 200)).values[internalNote.id], noteText);
    config = await admin(groupsPath + "/" + employmentGroup.id, 200, "DELETE", { version: config.version });
    view = await admin(newHireFields + "?screen=view", 200);
    assert.deepEqual(view.groups, []);
    assert.equal(view.fields.find(({ id }) => id === internalNote.id).groupId, null);
    assert.equal(view.values[internalNote.id], noteText);

    const secondPlant = client + "/plants/" + plantA2;
    const select = (route, id) => route + (route.includes("?") ? "&" : "?") + "workspacePlantId=" + id;
    await saveGrant({ ...enabledGrant, plantIds: [plantA, plantA2] });
    await call(select(manage, plantA2), 403, { token: access });
    await call(select(manage, plantB), 403, { token: access });
    await call(select(manage, "invalid"), 400, { token: access });
    assert.ok((await call(secondPlant, 200, { token })).people.some((person) =>
      person.id === userA && person.additionalPlantAdmin));
    await call(secondPlant + "/members/" + userA, 404, { token, method: "PUT", body: { role: "hr" } });
    await call(secondPlant + "/members/" + userA, 200, { token, method: "PUT", body: { role: "admin" } });
    const secondAdmin = (route, status, method, body) => call(select(manage + route, plantA2), status,
      { token: access, method, body });
    const meAtSecond = await call(select(workspace + "/me", plantA2), 200, { token: access });
    assert.equal(meAtSecond.plantId, plantA2);
    assert.deepEqual(new Set(meAtSecond.plants.map((item) => item.id)), new Set([plantA, plantA2]));
    await call(select(manage, plantA2), 403, { token: lead });
    await call(select(workspace + "/me", plantB), 403, { token: access });

    assert.deepEqual((await secondAdmin("", 200)).departments, []);
    const secondaryDepartment = await secondAdmin("/departments", 201, "POST", { name: "Planning" });
    const conflict = await secondAdmin("/departments", 409, "POST", { name: " planning " });
    assert.match(conflict.message, /already exists in this plant/);
    const missingParent = await secondAdmin("/areas", 409, "POST", { name: "Assigned line", departmentId: newDepartment.id });
    assert.match(missingParent.message, /selected department is no longer available/);
    const secondaryArea = await secondAdmin("/areas", 201, "POST", { name: "Assigned line", departmentId: secondaryDepartment.id });
    const secondaryRole = await secondAdmin("/roles", 201, "POST", { name: "Planner", features: ["setup"] });
    const secondaryWorker = await secondAdmin("/employees", 201, "POST", { name: "Secondary Worker", employeeId: "ALPHA-SECONDARY" });
    assert.equal(String((await employees.findOne({ _id: obj(secondaryWorker.id) })).locationId), plantA2);
    const primarySetup = await admin("", 200);
    assert.equal(primarySetup.departments.some((row) => row.id === secondaryDepartment.id), false);
    assert.equal(primarySetup.areas.some((row) => row.id === secondaryArea.id), false);
    assert.equal(primarySetup.roles.some((row) => row.id === secondaryRole.id), false);
    await admin("/employees/" + secondaryWorker.id, 404, "PATCH", { name: "Wrong plant" });
    await saveGrant({ ...enabledGrant, plantIds: [plantA2] });
    const { token: secondaryLogin } = await call("/session", 200, { email: "alpha@example.test" });
    assert.equal((await call(workspace + "/me", 200, { token: secondaryLogin })).plantId, plantA2);
    await call(select(manage, plantA), 403, { token: secondaryLogin });
    await saveGrant(enabledGrant);
    await secondAdmin("", 403);
    await saveGrant({ ...enabledGrant, plantIds: [plantA, plantA2] });
    await call(secondPlant + "/members/" + userA, 200, { token, method: "PUT", body: { role: "" } });
    await secondAdmin("", 403);
    assert.equal((await call(workspace + "/me", 200, { token: access })).plantId, plantA);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (child.exitCode === null && child.pid) child.kill();
    await exited;
    // This is a unique temporary directory created above, not an existing DB.
    const absolute = path.resolve(temp);
    assert.equal(path.dirname(absolute), path.resolve(tempRoot));
    assert.ok(path.basename(absolute).startsWith("plant-ops-mongo-test-"));
    await fs.rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
});
