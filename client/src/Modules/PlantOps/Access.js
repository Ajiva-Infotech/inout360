import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import "./access.css";

const root = (process.env.REACT_APP_API_DOMAIN_ENDPOINT || "/api").replace(/\/$/, "") + "/plant-ops/v1/control";
const features = { setup: "Departments & Areas", directory: "Employee Directory", reports: "Setup Report", activity: "Activity", management: "Administration" };
const roles = { "": "No Plant-OPS access", admin: "Client Admin", hr: "HR", incharge: "Production Incharge", contractor_manager: "Contractor Manager" };
const idPath = (value) => encodeURIComponent(value);
const utc = (createdAt) => createdAt ? new Date(createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "";

async function api(path, { token, credentials, body, method = "GET", signal } = {}) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (credentials) {
    headers.Authorization = "Basic " + btoa(String.fromCharCode(...new TextEncoder().encode(credentials)));
  }
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(root + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.message || "Unable to reach the Plant-OPS API."), { status: response.status });
  return result;
}

function PlantManagement({ plants, vendor, token, inactive }) {
  const [plant, setPlant] = useState("");
  const [data, setData] = useState(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState("");
  const [newRole, setNewRole] = useState("");
  const [department, setDepartment] = useState("");
  const path = "/vendors/" + idPath(vendor) + "/plants/" + idPath(plant);
  useEffect(() => {
    if (!plant) return;
    const controller = new AbortController();
    api(path, { token, signal: controller.signal }).then(setData).catch((err) => {
      if (err.name !== "AbortError") setError(err.message);
    });
    return () => controller.abort();
  }, [path, plant, revision, token]);
  async function save(route, body, label, method = "POST") {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await api(path + route, { token, body, method });
      setSuccess(label);
      setRevision((n) => n + 1);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function createItem(event, kind) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = new FormData(form).get("name");
    const requested = kind === "areas" ? { name, departmentId: department } : { name };
    if (await save("/" + kind, requested, kind === "areas" ? "Area created." : "Department created.")) form.reset();
  }
  const activeDepartments = data?.departments.filter((item) => item.active) || [];
  const additionalPlantAdmin = data?.people.find((user) => user.id === account)?.additionalPlantAdmin;
  return <section className="plant-admin-panel">
    <h2>Plant setup and user access</h2>
    {inactive && <p>You can prepare this workspace while access is off or suspended.</p>}
    <label><span id="plant-ops-plant-label">Plant</span><select aria-labelledby="plant-ops-plant-label" value={plant} disabled={busy} onChange={(event) => {
      setData(null);
      setError("");
      setSuccess("");
      setDepartment("");
      setAccount("");
      setNewRole("");
      setPlant(event.target.value);
    }}>
      <option value="">Select a plant</option>
      {plants.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    {error && <p role="alert" className="plant-admin-error">{error}</p>}
    {success && <p role="status">{success}</p>}
    {plant && !data && !error && <p role="status">Loading plant settings…</p>}
    {data && <div className="plant-admin-grid">
      <section className="plant-admin-block">
        <h3>Employee access</h3>
        <label>Existing account<select value={account} disabled={busy} onChange={(event) => {
          const checked = data.people.find((user) => user.id === event.target.value);
          setAccount(event.target.value);
          setNewRole(checked?.role || "");
        }}>
          <option value="">Select an employee account</option>
          {data.people.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.employeeId || user.email}{user.additionalPlantAdmin && " · Client Admin from another plant"}</option>)}
        </select></label>
        <label>Plant-OPS role<select value={newRole} disabled={busy || !account} onChange={(event) => setNewRole(event.target.value)}>
          {Object.entries(roles).filter(([id]) => !additionalPlantAdmin || id === "" || id === "admin")
            .map(([id, name]) => <option value={id} key={id}>{name}</option>)}
          {(data.customRoles || []).filter((role) => !additionalPlantAdmin && (role.active || role.id === newRole)).map(({ id, name, active }) =>
            <option value={id} key={id} disabled={!active}>{name}{!active && " (Deleted)"}</option>)}
        </select></label>
        <button type="button" disabled={busy || !account}
          onClick={() => save("/members/" + idPath(account), { role: newRole }, "Employee access saved.", "PUT")}>Save Employee Access</button>
        <p>Roles apply only to Plant-OPS. Employee records and PIL roles are shared as they already exist.</p>
        {data.people.filter((user) => user.role).length > 0 && <ul>{data.people.filter((user) => user.role).map((user) =>
          <li key={user.id}>{user.name} · {roles[user.role] || data.customRoles?.find((role) => role.id === user.role)?.name || "Custom role"}</li>)}</ul>}
      </section>
      <section className="plant-admin-block">
        <h3>Departments</h3>
        <form onSubmit={(event) => createItem(event, "departments")}>
          <label>Department name<input name="name" maxLength={80} required disabled={busy} /></label>
          <button disabled={busy}>Add Department</button>
        </form>
        <ul>{data.departments.map((item) => <li key={item.id}>{item.name} {item.active
          ? <button className="plant-admin-secondary" disabled={busy || data.areas.some((area) => area.active && area.departmentId === item.id)}
              onClick={() => save("/departments/" + idPath(item.id) + "/archive", null, "Department archived.", "PATCH")}>Archive</button>
          : <small>Archived</small>}</li>)}</ul>
      </section>
      <section className="plant-admin-block">
        <h3>Areas</h3>
        <form onSubmit={(event) => createItem(event, "areas")}>
          <label>Department<select value={department} onChange={(event) => setDepartment(event.target.value)} required disabled={busy}>
            <option value="">Select a department</option>
            {activeDepartments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
          </select></label>
          <label>Area name<input name="name" maxLength={80} required disabled={busy} /></label>
          <button disabled={busy || !activeDepartments.some((item) => item.id === department)}>Add Area</button>
        </form>
        <ul>{data.areas.map((item) => <li key={item.id}>{item.name} · {data.departments.find((dept) => dept.id === item.departmentId)?.name}
          {item.active
            ? <button className="plant-admin-secondary" disabled={busy}
                onClick={() => save("/areas/" + idPath(item.id) + "/archive", null, "Area archived.", "PATCH")}>Archive</button>
            : <small> Archived</small>}</li>)}</ul>
      </section>
      <section className="plant-admin-block">
        <h3>Activity</h3>
        {data.activity.length ? <ul>{data.activity.map((item) =>
          <li key={item._id}>{item.action} · {utc(item.createdAt)} IST</li>)}</ul> : <p>No activity yet.</p>}
      </section>
    </div>}
  </section>;
}

export default function PlantOpsAccess() {
  const [parameters] = useSearchParams();
  const linkedClient = parameters.get("client");
  const [token, setToken] = useState("");
  const [vendors, setVendors] = useState([]);
  const [selected, setSelected] = useState("");
  const [panel, setPanel] = useState(null);
  const [status, setStatus] = useState("off");
  const [plants, setPlants] = useState([]);
  const [grants, setGrants] = useState([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  async function signIn(event) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setError("");
    setBusy(true);
    try {
      const session = await api("/session", { method: "POST", credentials: fields.get("email") + ":" + fields.get("password") });
      const clients = await api("/vendors", { token: session.token });
      setVendors(clients);
      setToken(session.token);
      if (linkedClient && clients.some((client) => client.id === linkedClient)) setSelected(linkedClient);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!selected || !token) return;
    const controller = new AbortController();
    api("/vendors/" + idPath(selected), { token, signal: controller.signal }).then((client) => {
      setPanel(client);
      setStatus(client.grant.status);
      setPlants(client.grant.plantIds);
      setGrants(client.grant.features);
    }).catch((err) => {
      if (err.name !== "AbortError") setError(err.message);
    });
    return () => controller.abort();
  }, [selected, token]);
  const toggle = (set, value) => set((items) => items.includes(value) ? items.filter((item) => item !== value) : [...items, value]);
  async function saveGrant(event) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setBusy(true);
    try {
      const grant = await api("/vendors/" + idPath(selected) + "/grant", {
        token, method: "PUT", body: { status, features: grants, plantIds: plants },
      });
      setPanel({ ...panel, grant });
      setSuccess("Plant-OPS access saved for " + panel.name + ".");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return <main className="plant-admin">
    <h1>Plant-OPS Applications</h1>
    <p>Grant Plant-OPS to a client and choose its plants and menus. PIL access stays as configured.</p>
    {error && <p role="alert" className="plant-admin-error">{error}</p>}
    {success && <p role="status">{success}</p>}
    {!token ? <form className="plant-admin-panel plant-admin-login" onSubmit={signIn}>
      <h2>Confirm Super Admin sign-in</h2>
      <label>Email<input name="email" type="email" autoComplete="username" maxLength={254} required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={72} required /></label>
      <button disabled={busy}>{busy ? "Signing in…" : "Continue"}</button>
    </form> : <>
      <div className="plant-admin-row">
        <label>Existing client<select value={selected} disabled={busy} onChange={(event) => {
          setPanel(null);
          setError("");
          setSuccess("");
          setSelected(event.target.value);
        }}><option value="">Select a client</option>
          {vendors.map((vendor) => <option key={vendor.id} value={vendor.id}>{vendor.name} · {vendor.vendorCode}</option>)}
        </select></label>
        <button type="button" className="plant-admin-secondary" disabled={busy} onClick={() => {
          setToken(""); setSelected(""); setPanel(null); setError(""); setSuccess("");
        }}>Close Plant-OPS session</button>
      </div>
      {selected && !panel && !error && <p role="status">Loading client settings…</p>}
      {panel && <>
        <form className="plant-admin-panel" onSubmit={saveGrant}>
          <h2>{panel.name}</h2>
          <p><strong>PIL:</strong> Existing access</p>
          <label>Plant-OPS access<select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="off">Off</option><option value="enabled">Enabled</option><option value="suspended">Suspended</option>
          </select></label>
          <div className="plant-admin-grid">
            <fieldset><legend>Allowed plants</legend>
              {panel.plants.map((item) => <label className="plant-admin-check" key={item.id}>
                <input type="checkbox" checked={plants.includes(item.id)} onChange={() => toggle(setPlants, item.id)} />{item.name}
              </label>)}
              {!panel.plants.length && <p>No plants are linked to this client.</p>}
            </fieldset>
            <fieldset><legend>Available menus</legend>
              {Object.entries(features).map(([id, name]) => <label className="plant-admin-check" key={id}>
                <input type="checkbox" checked={grants.includes(id)} onChange={() => toggle(setGrants, id)} />{name}
              </label>)}
            </fieldset>
          </div>
          <button disabled={busy || (status === "enabled" && !plants.length)}>Save Application Access</button>
        </form>
        <PlantManagement key={selected} vendor={selected} plants={panel.plants} token={token} inactive={panel.grant.status !== "enabled"} />
      </>}
    </>}
  </main>;
}
