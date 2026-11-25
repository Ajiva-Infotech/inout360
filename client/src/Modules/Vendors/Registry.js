import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Cookies from "js-cookie";
import "../PlantOps/access.css";
import "./registry.css";

const base = (process.env.REACT_APP_API_DOMAIN_ENDPOINT || "/api").replace(/\/$/, "") + "/vendors";
const fields = [
  ["name", "Client name", 120],
  ["contactPerson", "Contact person", 100],
  ["email", "Email", 254, "email"],
  ["phone", "Phone", 40, "tel"],
  ["gstNumber", "GST number", 32],
  ["address", "Address", 400],
];
const allowedFields = ["id", "vendorCode", "status", "verified", ...fields.map(([key]) => key)];
const publicRecord = (record) => Object.fromEntries(allowedFields.map((key) => [
  key, key === "id" ? record.id || record._id : record[key],
]));

async function request(path, { method = "GET", body, signal } = {}) {
  const token = localStorage.getItem("accesstoken") || Cookies.get("accesstoken");
  if (!token) throw new Error("Sign in to PIL as Super Admin.");
  const headers = { Authorization: "Bearer " + token };
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status === false) {
    throw new Error(result.message || (response.status === 401 ? "Your PIL session expired. Sign in again."
      : response.status === 404 && method === "PATCH" ? "The backend is still using the previous version. Reload the local backend and try again."
      : "Unable to reach the client registry."));
  }
  return result;
}

function Editor({ record, onSave, onClose }) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const create = !record;
  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const details = Object.fromEntries(fields.map(([key]) => [key, String(form.get(key) || "").trim()]));
    if (!details.name) return setError("Enter a client name.");
    const code = String(form.get("vendorCode") || "").trim().toUpperCase();
    if (create && code && !/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code)) {
      return setError("Vendor Code can contain up to 32 letters, numbers, hyphens, or underscores.");
    }
    setSaving(true);
    setError("");
    try {
      const result = create
        ? await request("", { method: "POST", body: { ...details, ...(code ? { vendorCode: code } : {}) } })
        : await request("/" + encodeURIComponent(record.id) + "/profile", { method: "PATCH", body: details });
      onSave(publicRecord(result.data), create);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
  return <section className="plant-admin-panel" aria-labelledby="registry-editor">
    <h2 id="registry-editor">{create ? "Add Client" : "View / Edit Client"}</h2>
    {!create && <p><strong>{record.vendorCode}</strong> · {record.status || "Active"} · {record.verified ? "Verified" : "Not verified"}</p>}
    <form onSubmit={submit}>
      <div className="plant-admin-grid">
        <label>Vendor Code<input name="vendorCode" defaultValue={record?.vendorCode || ""} readOnly={!create} maxLength={32}
          placeholder={create ? "Leave blank to generate a code" : undefined} disabled={saving} /></label>
        {fields.map(([key, label, maxLength, type]) => <label key={key}>{label}
          <input name={key} type={type || "text"} defaultValue={record?.[key] || ""} maxLength={maxLength}
            required={key === "name"} disabled={saving} />
        </label>)}
      </div>
      {error && <p role="alert" className="plant-admin-error">{error}</p>}
      <div className="client-registry-actions">
        <button disabled={saving}>{saving ? "Saving…" : create ? "Create Client" : "Save Client Details"}</button>
        <button type="button" className="plant-admin-secondary" disabled={saving} onClick={onClose}>Cancel</button>
      </div>
    </form>
  </section>;
}

export default function ClientRegistry() {
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    request("", { signal: controller.signal }).then((result) => {
      setRows((result.vendors || result.data || []).map(publicRecord));
      setState("ready");
    }).catch((err) => {
      if (err.name !== "AbortError") {
        setError(err.message);
        setState("error");
      }
    });
    return () => controller.abort();
  }, [revision]);
  const query = search.trim().toLowerCase();
  const visible = rows.filter((item) => [item.name, item.vendorCode, item.contactPerson, item.email]
    .some((value) => String(value || "").toLowerCase().includes(query)));
  function save(record, create) {
    setRows((previous) => create ? [record, ...previous] : previous.map((item) => item.id === record.id ? record : item));
    setSuccess(create ? "Client created. Plant-OPS access is off until you enable it." : "Client details saved.");
    setEditor(null);
    if (create) setSearch("");
  }
  return <section className="plant-admin client-registry">
    <h1>Clients / Vendors</h1>
    <p>Manage the shared client records used by PIL and Plant-OPS.</p>
    <div className="plant-admin-row">
      <label>Search clients<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or Vendor Code" /></label>
      <button type="button" disabled={state !== "ready" || editor !== null}
        onClick={() => { setSuccess(""); setEditor({ record: null }); }}>Add Client</button>
    </div>
    {success && <p role="status">{success}</p>}
    {state === "loading" && <p role="status">Loading clients…</p>}
    {state === "error" && <><p role="alert" className="plant-admin-error">{error}</p>
      <button type="button" onClick={() => { setState("loading"); setError(""); setRevision((n) => n + 1); }}>Retry</button></>}
    {editor && <Editor key={editor.record?.id || "new"} record={editor.record} onSave={save} onClose={() => setEditor(null)} />}
    {state === "ready" && (visible.length ? <div className="client-registry-table">
      <table>
        <thead><tr>{["Client", "Vendor Code", "Contact", "Status", "Actions"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{visible.map((item) => <tr key={item.id}>
          <td>{item.name}</td><td>{item.vendorCode}</td><td>{item.contactPerson || item.email || "—"}</td>
          <td>{item.status || "Active"}</td><td><div className="client-registry-actions">
            <button type="button" className="plant-admin-secondary" disabled={editor !== null}
              aria-label={"View or edit " + item.name}
              onClick={() => { setSuccess(""); setEditor({ record: item }); }}>View / Edit</button>
            <Link to={"/dashboard/plant-ops?client=" + encodeURIComponent(item.id)}
              aria-label={"Manage Plant-OPS access for " + item.name}>Plant-OPS Access</Link>
          </div></td>
        </tr>)}</tbody>
      </table>
    </div> : <p>{query ? "No clients match this search." : "No clients have been added yet."}</p>)}
  </section>;
}
