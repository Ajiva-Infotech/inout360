const express = require("express");
const mongoose = require("mongoose");
const {
  registerPushDevice,
  unregisterPushDevice,
  sendPlantOpsPush,
} = require("./notifications");

const { Schema } = mongoose;
const DEFAULT_SHIFTS = [
  { id: "default-0", name: "Shift A", code: "STD-A", startTime: "06:00", endTime: "14:00", time: "06:00–14:00", hour: 6, minute: 0 },
  { id: "default-1", name: "General", code: "Gen", startTime: "09:00", endTime: "17:30", time: "09:00–17:30", hour: 9, minute: 0 },
  { id: "default-2", name: "Shift B", code: "STD-B", startTime: "14:00", endTime: "22:00", time: "14:00–22:00", hour: 14, minute: 0 },
  { id: "default-3", name: "Shift C", code: "STD-C", startTime: "22:00", endTime: "06:00", time: "22:00–06:00", hour: 22, minute: 0 },
];
const RECORD_KEY_RE = /^(\d{4}-\d{2}-\d{2})\|(\d+)$/;

const operationSchema = new Schema(
  {
    _id: String,
    vendorId: String,
    plantId: String,
    records: { type: Schema.Types.Mixed, default: () => ({}) },
    profiles: { type: Schema.Types.Mixed, default: () => ({}) },
    rooms: { type: Schema.Types.Mixed, default: () => ({}) },
    notifications: { type: [Schema.Types.Mixed], default: () => [] },
    notificationSeen: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { autoCreate: false, autoIndex: false, timestamps: true, versionKey: false, collection: "plantops_operations" }
);

const Operation = mongoose.models.PlantOpsOperation || mongoose.model("PlantOpsOperation", operationSchema);

const opKey = (vendorId, plantId) => `${vendorId}:${plantId}`;
const idOf = (doc) => String(doc?._id || doc?.id || "");

function parseRecordKey(recordKey, fail, shiftList = DEFAULT_SHIFTS) {
  const match = RECORD_KEY_RE.exec(String(recordKey || ""));
  if (!match) throw fail(400, "Invalid shift record key.");
  const shift = Number(match[2]);
  if (!Number.isInteger(shift) || shift < 0 || shift >= shiftList.length) {
    throw fail(400, "Invalid shift record key.");
  }
  return { dateStr: match[1], shift };
}

function editWindow(dateStr, shift, shiftList = DEFAULT_SHIFTS, now = new Date()) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const spec = shiftList[shift] || DEFAULT_SHIFTS[0];
  const startUtcMs = Date.UTC(y, m - 1, d, spec.hour || 0, spec.minute || 0, 0) - (5 * 60 + 30) * 60_000;
  const leftMs = startUtcMs - now.getTime();
  if (leftMs <= 6 * 3600_000) return "locked";
  return leftMs < 24 * 3600_000 ? "approval" : "open";
}

function emptyRecord() {
  return {
    requirement: {},
    manualActual: {},
    submitted: false,
    version: 0,
    pending: null,
    drafts: {},
    allocations: [],
    activity: [],
    messages: [],
  };
}

function normalizeRecord(raw) {
  const base = emptyRecord();
  if (!raw || typeof raw !== "object") return base;
  return {
    requirement: raw.requirement && typeof raw.requirement === "object" ? { ...raw.requirement } : {},
    manualActual: raw.manualActual && typeof raw.manualActual === "object" ? { ...raw.manualActual } : {},
    submitted: Boolean(raw.submitted),
    version: Number.isInteger(raw.version) ? raw.version : 0,
    pending: raw.pending && typeof raw.pending === "object" ? raw.pending : null,
    drafts: raw.drafts && typeof raw.drafts === "object" ? { ...raw.drafts } : {},
    allocations: Array.isArray(raw.allocations) ? raw.allocations.map((row) => ({ ...row })) : [],
    activity: Array.isArray(raw.activity) ? raw.activity.slice(-200) : [],
    messages: Array.isArray(raw.messages) ? raw.messages.slice(-300) : [],
  };
}

function validateCountMap(values, allowedAreaIds, fail) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw fail(400, "Enter whole numbers from 0 to 99,999 for your assigned areas.");
  }
  const entries = Object.entries(values);
  if (entries.length === 0) {
    throw fail(400, "Enter whole numbers from 0 to 99,999 for your assigned areas.");
  }
  const allowedSet = new Set(allowedAreaIds);
  const cleaned = {};
  for (const [areaId, rawValue] of entries) {
    const n = Number(rawValue);
    if (!allowedSet.has(areaId) || !Number.isInteger(n) || n < 0 || n > 99999) {
      throw fail(400, "Enter whole numbers from 0 to 99,999 for your assigned areas.");
    }
    cleaned[areaId] = n;
  }
  return cleaned;
}

async function loadOrCreateOperation(vendorId, plantId) {
  const _id = opKey(vendorId, plantId);
  let doc = await Operation.findById(_id).lean();
  if (!doc) {
    try {
      await Operation.updateOne(
        { _id },
        { $setOnInsert: { vendorId, plantId, records: {}, profiles: {}, rooms: {}, notifications: [], notificationSeen: {} } },
        { upsert: true }
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
    doc = await Operation.findById(_id).lean();
  }
  return {
    _id,
    records: doc?.records && typeof doc.records === "object" ? doc.records : {},
    profiles: doc?.profiles && typeof doc.profiles === "object" ? doc.profiles : {},
    rooms: doc?.rooms && typeof doc.rooms === "object" ? doc.rooms : {},
    notifications: Array.isArray(doc?.notifications) ? doc.notifications : [],
    notificationSeen: doc?.notificationSeen && typeof doc.notificationSeen === "object" ? doc.notificationSeen : {},
  };
}

function createOpsRouter(store, { fail, catchAsync }) {
  const router = express.Router();

  async function loadContext(req) {
    const { vendorId, vendorCode, vendorName, plantId, plantName, role, areaIds, contractorName, features } = req.plantOpsScope;
    const meId = idOf(req.plantOpsUser);
    const [setup, members, op] = await Promise.all([
      store.setup(vendorId, plantId),
      store.opsMembers(vendorId, vendorCode, plantId),
      loadOrCreateOperation(vendorId, plantId),
    ]);

    const activeDepartments = setup.departments
      .filter((d) => d.active)
      .map((d) => ({ id: d._id, name: d.name, approverId: d.approverId || null }));
    const deptById = new Map(activeDepartments.map((d) => [d.id, d]));
    const activeAreas = setup.areas
      .filter((a) => a.active && deptById.has(a.departmentId))
      .map((a) => {
        const dept = deptById.get(a.departmentId);
        return {
          id: a._id,
          name: a.name,
          departmentId: a.departmentId,
          departmentName: dept.name,
          manpowerNeeded: Number.isInteger(a.manpowerNeeded) ? a.manpowerNeeded : null,
          approverId: dept.approverId || null,
        };
      });
    const activeAreaIds = activeAreas.map((a) => a.id);
    const activeAreaSet = new Set(activeAreaIds);
    const activeContractors = setup.contractors
      .filter((c) => c.active)
      .map((c) => ({ id: c._id, name: c.name, code: c.code }));
    const contractorById = new Map(activeContractors.map((c) => [c.id, c]));
    const configuredShifts = (setup.shifts || [])
      .filter((s) => s.active)
      .map((s) => {
        const [hh = "6", mm = "0"] = String(s.startTime || "06:00").split(":");
        return {
          id: s._id,
          name: s.name,
          code: s.code,
          startTime: s.startTime,
          endTime: s.endTime,
          time: `${s.startTime}–${s.endTime}`,
          hour: Number(hh) || 0,
          minute: Number(mm) || 0,
        };
      });
    const activeShifts = configuredShifts.length ? configuredShifts : DEFAULT_SHIFTS;

    const access = {};
    const people = members.map((m) => {
      const id = idOf(m);
      const isHrOrAdmin = m.role === "admin" || m.role === "hr";
      const isContractor = m.role === "contractor_manager";
      const resolvedAreas = isHrOrAdmin
        ? [...activeAreaIds]
        : Array.isArray(m.areaIds)
        ? m.areaIds.filter((aid) => activeAreaSet.has(aid))
        : isContractor
        ? []
        : [...activeAreaIds];
      access[id] = resolvedAreas;
      const contractor = m.contractorId ? contractorById.get(m.contractorId) : null;
      return {
        id,
        name: m.name || m.email || id,
        email: m.email || "",
        employeeId: m.employeeId || "",
        role: m.role,
        company: isContractor ? contractor?.name || contractorName || vendorName : vendorName,
        contractorId: m.contractorId || null,
        location: plantName,
        source: m.source || "user",
      };
    });

    // Guarantee current authenticated user is represented in people + access
    if (!people.some((p) => p.id === meId)) {
      const isHrOrAdmin = role === "admin" || role === "hr";
      const isContractor = role === "contractor_manager";
      access[meId] = isHrOrAdmin
        ? [...activeAreaIds]
        : Array.isArray(areaIds)
        ? areaIds.filter((aid) => activeAreaSet.has(aid))
        : isContractor
        ? []
        : [...activeAreaIds];
      people.push({
        id: meId,
        name: req.plantOpsUser.name || req.plantOpsUser.email || meId,
        email: req.plantOpsUser.email || "",
        employeeId: req.plantOpsUser.employeeId || "",
        role,
        company: isContractor ? contractorName || vendorName : vendorName,
        contractorId: req.plantOpsUser.contractorId || null,
        location: plantName,
        source: req.plantOpsUser.source || "user",
      });
    }

    const myVisibleAreaIds = access[meId] || [];
    const displayName = (userId) => {
      const prof = op.profiles?.[userId];
      if (prof?.name) return prof.name;
      const found = people.find((p) => p.id === userId);
      return found?.name || userId;
    };
    const departmentsWithApprover = activeDepartments.map((d) => ({
      ...d,
      approverName: d.approverId ? displayName(d.approverId) : null,
    }));
    const areasWithApprover = activeAreas.map((a) => ({
      ...a,
      approverName: a.approverId ? displayName(a.approverId) : null,
    }));

    return {
      vendorId,
      vendorCode,
      vendorName,
      plantId,
      plantName,
      role,
      features,
      meId,
      meName: displayName(meId),
      canHr: role === "hr" || role === "admin",
      canIncharge: role === "incharge" || role === "admin",
      isContractor: role === "contractor_manager",
      departments: departmentsWithApprover,
      areas: areasWithApprover,
      activeAreaIds,
      shifts: activeShifts,
      contractors: activeContractors,
      people,
      access,
      myVisibleAreaIds,
      op,
      displayName,
    };
  }

  function appendNotifications(op, entries, ctx = null) {
    const stamped = (entries || []).map((entry, idx) => ({
      id: entry.id || `${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}`,
      ...entry,
    }));
    const next = [...(op.notifications || []), ...stamped].slice(-200);
    op.notifications = next;
    if (ctx && stamped.length > 0) {
      const byMessage = new Map();
      for (const item of stamped) {
        const recipients = item.to === "__HR__" ? hrRecipients(ctx) : [item.to];
        const filtered = recipients.filter((id) => id && id !== ctx.meId);
        if (!filtered.length) continue;
        const groupKey = `${item.title || ""}|${item.text || ""}|${item.date || ""}|${item.shift ?? ""}|${item.roomId || ""}`;
        const existing = byMessage.get(groupKey) || {
          recipientIds: new Set(),
          title: item.title || "Plant-OPS",
          body: item.text || "",
          data: {
            plantId: ctx.plantId,
            plantName: ctx.plantName,
            type: item.roomId ? "chat" : item.date ? "shift" : "alert",
            date: item.date,
            shift: item.shift,
            roomId: item.roomId,
          },
        };
        for (const id of filtered) existing.recipientIds.add(id);
        byMessage.set(groupKey, existing);
      }
      for (const payload of byMessage.values()) {
        sendPlantOpsPush({
          recipientIds: [...payload.recipientIds],
          title: payload.title,
          body: payload.body,
          data: payload.data,
        }).catch(() => {});
      }
    }
    return next;
  }

  function notificationsForUser(ctx) {
    return (ctx.op.notifications || []).filter(
      (n) => n?.to === ctx.meId || (ctx.canHr && n?.to === "__HR__")
    );
  }

  function unreadCountForUser(ctx, visible) {
    const seenAt = ctx.op.notificationSeen?.[ctx.meId] || "";
    if (!seenAt) return visible.length;
    return visible.filter((n) => String(n?.at || "") > String(seenAt)).length;
  }

  function hrRecipients(ctx) {
    return ctx.people.filter((p) => p.role === "hr" || p.role === "admin").map((p) => p.id);
  }

  async function saveOperationFields(vendorId, plantId, patch) {
    await Operation.updateOne({ _id: opKey(vendorId, plantId) }, { $set: patch }, { upsert: true });
  }

  router.get(
    "/bootstrap",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      let deliveredChanged = false;
      if (!ctx.isContractor && ctx.op.rooms) {
        for (const room of Object.values(ctx.op.rooms)) {
          if (!room || !Array.isArray(room.members) || !room.members.includes(ctx.meId)) continue;
          for (const msg of room.messages || []) {
            if (msg.by === ctx.meId) continue;
            if (!Array.isArray(msg.delivered)) msg.delivered = [];
            if (!msg.delivered.includes(ctx.meId)) {
              msg.delivered.push(ctx.meId);
              deliveredChanged = true;
            }
          }
        }
        if (deliveredChanged) {
          await saveOperationFields(ctx.vendorId, ctx.plantId, { rooms: ctx.op.rooms });
        }
      }

      const visibleRooms = {};
      if (!ctx.isContractor) {
        for (const [roomId, room] of Object.entries(ctx.op.rooms || {})) {
          if (Array.isArray(room?.members) && room.members.includes(ctx.meId)) {
            visibleRooms[roomId] = room;
          }
        }
      }

      const visibleNotifications = notificationsForUser(ctx);
      const seenAt = ctx.op.notificationSeen?.[ctx.meId] || null;

      res.json({
        me: {
          id: ctx.meId,
          name: req.plantOpsUser.name || req.plantOpsUser.email || ctx.meId,
          email: req.plantOpsUser.email || "",
          employeeId: req.plantOpsUser.employeeId || "",
          role: ctx.role,
          features: ctx.features,
          company: ctx.isContractor ? req.plantOpsScope.contractorName || ctx.vendorName : ctx.vendorName,
          plantId: ctx.plantId,
          plantName: ctx.plantName,
          vendorId: ctx.vendorId,
          vendorName: ctx.vendorName,
          vendorCode: ctx.vendorCode,
        },
        departments: ctx.departments,
        areas: ctx.areas,
        shifts: ctx.shifts,
        contractors: ctx.contractors,
        people: ctx.people,
        state: {
          records: ctx.op.records || {},
          access: ctx.access,
          profiles: ctx.op.profiles || {},
          rooms: visibleRooms,
          notifications: visibleNotifications,
          notificationSeenAt: seenAt,
        },
      });
    })
  );

  router.get(
    "/notifications",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      const visible = notificationsForUser(ctx);
      const seenAt = ctx.op.notificationSeen?.[ctx.meId] || null;
      res.json({
        notifications: visible,
        unreadCount: unreadCountForUser(ctx, visible),
        seenAt,
      });
    })
  );

  router.post(
    "/notifications/read",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      const nowIso = new Date().toISOString();
      ctx.op.notificationSeen[ctx.meId] = nowIso;
      await saveOperationFields(ctx.vendorId, ctx.plantId, {
        [`notificationSeen.${ctx.meId}`]: nowIso,
      });
      res.json({ seenAt: nowIso });
    })
  );

  router.post(
    "/notifications/device",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
      if (!token || token.length > 4096) {
        throw fail(400, "A valid push notification token is required.");
      }
      const registered = await registerPushDevice({
        userId: ctx.meId,
        vendorId: ctx.vendorId,
        plantId: ctx.plantId,
        token,
        platform: req.body?.platform,
        deviceName: req.body?.deviceName,
      });
      res.status(201).json({ registered });
    })
  );

  router.delete(
    "/notifications/device",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
      if (token) {
        await unregisterPushDevice(ctx.meId, token);
      }
      res.status(204).end();
    })
  );

  router.put(
    "/access/:memberId",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      if (!ctx.canHr) throw fail(403, "Only HR or Client Admin can manage area access.");
      const { memberId } = req.params;
      const target = ctx.people.find((p) => p.id === memberId);
      if (!target) throw fail(404, "Member not found in this plant.");
      if (target.role === "hr" || target.role === "admin") {
        throw fail(400, "This account already has access to all areas.");
      }
      const requested = Array.isArray(req.body?.areaIds) ? req.body.areaIds : [];
      const activeSet = new Set(ctx.activeAreaIds);
      const areaIds = [...new Set(requested.filter((aid) => activeSet.has(aid)))];
      const ok = await store.saveMemberAreaIds(
        ctx.vendorId,
        ctx.vendorCode,
        ctx.plantId,
        memberId,
        areaIds,
        ctx.meId
      );
      if (!ok) throw fail(404, "Could not update member area access.");

      const notifications = appendNotifications(ctx.op, [
        {
          to: memberId,
          title: "Area access updated",
          text: `${ctx.meName} updated your assigned areas (${areaIds.length}).`,
          at: new Date().toISOString(),
        },
      ], ctx);
      await saveOperationFields(ctx.vendorId, ctx.plantId, { notifications });
      res.json({ memberId, areaIds });
    })
  );

  router.put(
    "/records/:recordKey/draft",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      if (!ctx.canIncharge) throw fail(403, "This action is not available for your account.");
      const { dateStr, shift } = parseRecordKey(req.params.recordKey, fail, ctx.shifts);
      if (editWindow(dateStr, shift, ctx.shifts) === "locked") {
        throw fail(409, "This shift is locked.");
      }
      const cleaned = validateCountMap(req.body?.values, ctx.myVisibleAreaIds, fail);
      const record = normalizeRecord(ctx.op.records?.[req.params.recordKey]);
      const base = Number.isInteger(req.body?.base) ? req.body.base : record.version;
      record.drafts[ctx.meId] = {
        values: cleaned,
        reason: String(req.body?.reason || "").trim().slice(0, 300),
        base,
      };
      ctx.op.records[req.params.recordKey] = record;
      await saveOperationFields(ctx.vendorId, ctx.plantId, {
        [`records.${req.params.recordKey}`]: record,
      });
      res.json({ recordKey: req.params.recordKey, record });
    })
  );

  router.post(
    "/records/:recordKey/requirement",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      if (!ctx.canIncharge) throw fail(403, "This action is not available for your account.");
      const { dateStr, shift } = parseRecordKey(req.params.recordKey, fail, ctx.shifts);
      const cleaned = validateCountMap(req.body?.values, ctx.myVisibleAreaIds, fail);
      const record = normalizeRecord(ctx.op.records?.[req.params.recordKey]);
      const window = editWindow(dateStr, shift, ctx.shifts);
      if (window === "locked") throw fail(409, "The requirement is locked.");
      if (record.pending) throw fail(409, "A requirement change is already awaiting HR approval.");
      const base = Number.isInteger(req.body?.base) ? req.body.base : record.version;
      if (base !== record.version) {
        throw fail(409, "The requirement changed. Use Last Submitted and review again.");
      }

      const reason = String(req.body?.reason || "").trim().slice(0, 300);
      const nowIso = new Date().toISOString();
      const areaById = new Map(ctx.areas.map((a) => [a.id, a]));
      const exceededAreas = Object.entries(cleaned)
        .filter(([areaId, count]) => {
          const cap = areaById.get(areaId)?.manpowerNeeded;
          return Number.isInteger(cap) && count > cap;
        })
        .map(([areaId]) => areaId);
      const needsApproval = window === "approval" || exceededAreas.length > 0;
      const recipients = hrRecipients(ctx).filter((id) => id !== ctx.meId);
      const notifyTargets = recipients.length ? recipients : ["__HR__"];

      if (needsApproval) {
        if (!reason) {
          throw fail(
            400,
            exceededAreas.length > 0
              ? "Enter a reason to request approval for manpower exceeding the configured limit."
              : "Enter a reason for HR approval."
          );
        }
        const assignedApprovers = new Set();
        const fallbackHr = hrRecipients(ctx);
        for (const areaId of exceededAreas) {
          const assigned = areaById.get(areaId)?.approverId;
          if (assigned && ctx.people.some((p) => p.id === assigned)) {
            assignedApprovers.add(assigned);
          } else {
            for (const id of fallbackHr) assignedApprovers.add(id);
          }
        }
        if (window === "approval" || assignedApprovers.size === 0) {
          for (const id of fallbackHr) assignedApprovers.add(id);
        }
        const approverIds = [...assignedApprovers];
        record.pending = {
          values: cleaned,
          reason,
          author: ctx.meId,
          exceededAreas,
          approverIds,
        };
        const title = exceededAreas.length > 0
          ? "Excess manpower approval requested"
          : "Requirement approval requested";
        record.activity.push({ title, text: reason, by: ctx.meName, at: nowIso });
        record.messages.push({ text: `${title} · ${reason}`, by: ctx.meId, at: nowIso, system: true });
        const approvalTargets = approverIds.filter((id) => id !== ctx.meId);
        appendNotifications(
          ctx.op,
          (approvalTargets.length ? approvalTargets : notifyTargets).map((to) => ({
            to,
            title: "Approval requested",
            text: exceededAreas.length > 0
              ? `${dateStr} · ${ctx.shifts[shift].code} · Exceeds manpower limit`
              : `${dateStr} · ${ctx.shifts[shift].code}`,
            at: nowIso,
            date: dateStr,
            shift,
          })),
          ctx
        );
      } else {
        Object.assign(record.requirement, cleaned);
        record.version += 1;
        record.submitted = true;
        record.activity.push({ title: "Requirement submitted", text: reason, by: ctx.meName, at: nowIso });
        record.messages.push({
          text: reason ? `Requirement submitted · ${reason}` : "Requirement submitted",
          by: ctx.meId,
          at: nowIso,
          system: true,
        });
        appendNotifications(
          ctx.op,
          notifyTargets.map((to) => ({
            to,
            title: "Requirement submitted",
            text: `${dateStr} · ${ctx.shifts[shift].code}`,
            at: nowIso,
          })),
          ctx
        );
      }
      delete record.drafts[ctx.meId];
      ctx.op.records[req.params.recordKey] = record;
      await saveOperationFields(ctx.vendorId, ctx.plantId, {
        [`records.${req.params.recordKey}`]: record,
        notifications: ctx.op.notifications,
      });
      res.json({ recordKey: req.params.recordKey, record, approvalRequested: needsApproval });
    })
  );

  router.post(
    "/records/:recordKey/decision",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      const { dateStr, shift } = parseRecordKey(req.params.recordKey, fail, ctx.shifts);
      const record = normalizeRecord(ctx.op.records?.[req.params.recordKey]);
      const assignedApprover = Array.isArray(record.pending?.approverIds) && record.pending.approverIds.includes(ctx.meId);
      if (!ctx.canHr && !assignedApprover) {
        throw fail(403, "Only an assigned approver, HR, or Client Admin can approve or reject requests.");
      }
      if (!record.pending || editWindow(dateStr, shift, ctx.shifts) === "locked") {
        throw fail(409, "This request is no longer open.");
      }
      const approve = Boolean(req.body?.approve);
      const remarks = String(req.body?.remarks || "").trim().slice(0, 300);
      if (!approve && !remarks) throw fail(400, "Enter a reason to reject the request.");

      const pending = record.pending;
      if (approve && pending.values && typeof pending.values === "object") {
        Object.assign(record.requirement, pending.values);
        record.version += 1;
        record.submitted = true;
      }
      record.pending = null;
      const nowIso = new Date().toISOString();
      const eventTitle = approve ? "Requirement approved" : "Requirement rejected";
      record.activity.push({ title: eventTitle, text: remarks, by: ctx.meName, at: nowIso });
      record.messages.push({
        text: remarks ? `${eventTitle} · ${remarks}` : eventTitle,
        by: ctx.meId,
        at: nowIso,
        system: true,
      });
      if (pending.author) {
        appendNotifications(ctx.op, [{ to: pending.author, title: eventTitle, text: remarks || `${dateStr} · ${ctx.shifts[shift].code}`, at: nowIso, date: dateStr, shift }], ctx);
      }
      ctx.op.records[req.params.recordKey] = record;
      await saveOperationFields(ctx.vendorId, ctx.plantId, {
        [`records.${req.params.recordKey}`]: record,
        notifications: ctx.op.notifications,
      });
      res.json({ recordKey: req.params.recordKey, record });
    })
  );

  router.put(
    "/records/:recordKey/actual",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      if (!ctx.canHr) throw fail(403, "Only HR or Client Admin can update shift actuals.");
      parseRecordKey(req.params.recordKey, fail, ctx.shifts);
      const record = normalizeRecord(ctx.op.records?.[req.params.recordKey]);
      const allocatedAreas = new Set(record.allocations.map((row) => row.areaId));
      const allowed = ctx.activeAreaIds.filter((aid) => !allocatedAreas.has(aid));
      const cleaned = validateCountMap(req.body?.values, allowed, fail);
      const reason = String(req.body?.reason || "").trim().slice(0, 300);
      Object.assign(record.manualActual, cleaned);
      const nowIso = new Date().toISOString();
      record.activity.push({ title: "HR Actual saved", text: reason, by: ctx.meName, at: nowIso });
      record.messages.push({
        text: reason ? `HR Actual saved · ${reason}` : "HR Actual saved",
        by: ctx.meId,
        at: nowIso,
        system: true,
      });
      ctx.op.records[req.params.recordKey] = record;
      await saveOperationFields(ctx.vendorId, ctx.plantId, {
        [`records.${req.params.recordKey}`]: record,
      });
      res.json({ recordKey: req.params.recordKey, record });
    })
  );

  router.put(
    "/records/:recordKey/allocations",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      if (!ctx.canHr) throw fail(403, "Only HR or Client Admin can allocate contractors.");
      const { dateStr, shift } = parseRecordKey(req.params.recordKey, fail, ctx.shifts);
      const areaId = String(req.body?.areaId || "");
      const managerId = String(req.body?.managerId || "");
      const count = Number(req.body?.count);
      const manager = ctx.people.find((p) => p.id === managerId && p.role === "contractor_manager");
      if (!manager) throw fail(400, "Choose a Contractor Manager.");
      const managerAreas = ctx.access[managerId] || [];
      validateCountMap({ [areaId]: count }, managerAreas, fail);

      const record = normalizeRecord(ctx.op.records?.[req.params.recordKey]);
      const idx = record.allocations.findIndex((row) => row.areaId === areaId && row.managerId === managerId);
      if (idx < 0) {
        record.allocations.push({ areaId, managerId, required: count, actual: null });
      } else {
        record.allocations[idx].required = count;
      }
      const areaName = ctx.areas.find((a) => a.id === areaId)?.name || areaId;
      const nowIso = new Date().toISOString();
      const summary = `${areaName} · ${manager.company} · ${count} required`;
      record.activity.push({ title: "Contractor requirement saved", text: summary, by: ctx.meName, at: nowIso });
      record.messages.push({ text: `Contractor requirement saved · ${summary}`, by: ctx.meId, at: nowIso, system: true });
      appendNotifications(ctx.op, [
        {
          to: managerId,
          title: "New contractor requirement",
          text: `${dateStr} · ${ctx.shifts[shift].code} · ${areaName}: ${count}`,
          at: nowIso,
          date: dateStr,
          shift,
        },
      ], ctx);
      ctx.op.records[req.params.recordKey] = record;
      await saveOperationFields(ctx.vendorId, ctx.plantId, {
        [`records.${req.params.recordKey}`]: record,
        notifications: ctx.op.notifications,
      });
      res.json({ recordKey: req.params.recordKey, record });
    })
  );

  router.delete(
    "/records/:recordKey/allocations",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      if (!ctx.canHr) throw fail(403, "Only HR or Client Admin can remove contractor allocations.");
      parseRecordKey(req.params.recordKey, fail, ctx.shifts);
      const areaId = String(req.body?.areaId || "");
      const managerId = String(req.body?.managerId || "");
      const record = normalizeRecord(ctx.op.records?.[req.params.recordKey]);
      record.allocations = record.allocations.filter(
        (row) => !(row.areaId === areaId && row.managerId === managerId && row.actual == null)
      );
      const areaName = ctx.areas.find((a) => a.id === areaId)?.name || areaId;
      const nowIso = new Date().toISOString();
      record.activity.push({ title: "Contractor allocation removed", text: areaName, by: ctx.meName, at: nowIso });
      record.messages.push({ text: `Contractor allocation removed · ${areaName}`, by: ctx.meId, at: nowIso, system: true });
      ctx.op.records[req.params.recordKey] = record;
      await saveOperationFields(ctx.vendorId, ctx.plantId, {
        [`records.${req.params.recordKey}`]: record,
      });
      res.json({ recordKey: req.params.recordKey, record });
    })
  );

  router.put(
    "/records/:recordKey/contractor-actual",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      if (!ctx.isContractor) throw fail(403, "Only Contractor Managers can report contractor actuals.");
      parseRecordKey(req.params.recordKey, fail, ctx.shifts);
      const record = normalizeRecord(ctx.op.records?.[req.params.recordKey]);
      const allowedSet = new Set(ctx.myVisibleAreaIds);
      const myRows = record.allocations.filter(
        (row) => row.managerId === ctx.meId && allowedSet.has(row.areaId)
      );
      const cleaned = validateCountMap(req.body?.values, myRows.map((r) => r.areaId), fail);
      for (const row of myRows) {
        if (Object.prototype.hasOwnProperty.call(cleaned, row.areaId)) {
          row.actual = cleaned[row.areaId];
        }
      }
      const company = req.plantOpsScope.contractorName || ctx.vendorName;
      const nowIso = new Date().toISOString();
      record.activity.push({ title: "Contractor Actual reported", text: company, by: ctx.meName, at: nowIso });
      record.messages.push({ text: `Contractor Actual reported · ${company}`, by: ctx.meId, at: nowIso, system: true });
      const recipients = hrRecipients(ctx);
      appendNotifications(
        ctx.op,
        (recipients.length ? recipients : ["__HR__"]).map((to) => ({
          to,
          title: "Contractor Actual reported",
          text: company,
          at: nowIso,
        })),
        ctx
      );
      ctx.op.records[req.params.recordKey] = record;
      await saveOperationFields(ctx.vendorId, ctx.plantId, {
        [`records.${req.params.recordKey}`]: record,
        notifications: ctx.op.notifications,
      });
      res.json({ recordKey: req.params.recordKey, record });
    })
  );

  router.post(
    "/records/:recordKey/messages",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      if (ctx.isContractor || ctx.myVisibleAreaIds.length === 0) {
        throw fail(403, "Shift chat is not available for your account.");
      }
      const { dateStr, shift } = parseRecordKey(req.params.recordKey, fail, ctx.shifts);
      const text = String(req.body?.text || "").trim().slice(0, 1000);
      if (!text) throw fail(400, "Enter a message.");
      const nowIso = new Date().toISOString();
      const record = normalizeRecord(ctx.op.records?.[req.params.recordKey]);
      record.messages.push({ by: ctx.meId, at: nowIso, text });
      const recipients = hrRecipients(ctx).filter((id) => id !== ctx.meId);
      if (recipients.length) {
        appendNotifications(
          ctx.op,
          recipients.map((to) => ({
            to,
            title: `Shift message · ${ctx.shifts[shift].code}`,
            text: `${ctx.meName}: ${text.slice(0, 120)}`,
            at: nowIso,
            date: dateStr,
            shift,
          })),
          ctx
        );
      }
      ctx.op.records[req.params.recordKey] = record;
      await saveOperationFields(ctx.vendorId, ctx.plantId, {
        [`records.${req.params.recordKey}`]: record,
        notifications: ctx.op.notifications,
      });
      res.status(201).json({ recordKey: req.params.recordKey, record });
    })
  );

  router.put(
    "/profile",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      const name = String(req.body?.name || "").trim().slice(0, 60);
      if (!name) throw fail(400, "Enter a display name.");
      const profile = {
        name,
        title: String(req.body?.title || "").trim().slice(0, 80),
        about: String(req.body?.about || "").trim().slice(0, 240),
        photo: typeof req.body?.photo === "string" && req.body.photo.length <= 750_000 ? req.body.photo : null,
      };
      ctx.op.profiles[ctx.meId] = profile;
      await saveOperationFields(ctx.vendorId, ctx.plantId, {
        [`profiles.${ctx.meId}`]: profile,
      });
      res.json({ profile });
    })
  );

  router.post(
    "/rooms/direct",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      if (ctx.isContractor) throw fail(403, "Direct chat is unavailable for contractor managers.");
      const peerId = String(req.body?.peerId || "");
      const peer = ctx.people.find((p) => p.id === peerId && p.role !== "contractor_manager");
      if (!peer || peerId === ctx.meId) throw fail(400, "This chat is unavailable.");
      const roomId = [ctx.meId, peerId].sort().join(":");
      if (!ctx.op.rooms[roomId]) {
        ctx.op.rooms[roomId] = {
          id: roomId,
          members: [ctx.meId, peerId],
          messages: [],
          updated: new Date().toISOString(),
        };
        await saveOperationFields(ctx.vendorId, ctx.plantId, { [`rooms.${roomId}`]: ctx.op.rooms[roomId] });
      }
      res.json({ room: ctx.op.rooms[roomId] });
    })
  );

  router.post(
    "/rooms/group",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      if (ctx.isContractor) throw fail(403, "Group chat is unavailable for contractor managers.");
      const name = String(req.body?.name || "").trim().slice(0, 60);
      const requested = Array.isArray(req.body?.memberIds) ? req.body.memberIds : [];
      const validPeers = requested.filter((id) =>
        ctx.people.some((p) => p.id === id && p.role !== "contractor_manager")
      );
      if (!name || validPeers.length === 0) {
        throw fail(400, "Enter a group name and select at least one employee.");
      }
      const roomId = `group_${Date.now()}_${Object.keys(ctx.op.rooms || {}).length}`;
      const room = {
        id: roomId,
        name,
        members: [...new Set([ctx.meId, ...validPeers])],
        messages: [],
        updated: new Date().toISOString(),
      };
      ctx.op.rooms[roomId] = room;
      await saveOperationFields(ctx.vendorId, ctx.plantId, { [`rooms.${roomId}`]: room });
      res.status(201).json({ room });
    })
  );

  router.post(
    "/rooms/:roomId/messages",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      if (ctx.isContractor) throw fail(403, "Chat is unavailable for contractor managers.");
      const room = ctx.op.rooms?.[req.params.roomId];
      if (!room || !Array.isArray(room.members) || !room.members.includes(ctx.meId)) {
        throw fail(404, "Conversation not found.");
      }
      const text = String(req.body?.text || "").trim().slice(0, 1000);
      if (!text) throw fail(400, "Enter a message.");
      const nowIso = new Date().toISOString();
      room.messages = Array.isArray(room.messages) ? room.messages : [];
      room.messages.push({ by: ctx.meId, at: nowIso, text, delivered: [], seen: [] });
      room.updated = nowIso;
      const peerRecipients = room.members.filter((id) => id !== ctx.meId);
      if (peerRecipients.length) {
        appendNotifications(
          ctx.op,
          peerRecipients.map((to) => ({
            to,
            title: room.name ? `Message in ${room.name}` : `Message from ${ctx.meName}`,
            text: text.slice(0, 140),
            at: nowIso,
            roomId: req.params.roomId,
          })),
          ctx
        );
      }
      await saveOperationFields(ctx.vendorId, ctx.plantId, {
        [`rooms.${req.params.roomId}`]: room,
        notifications: ctx.op.notifications,
      });
      res.status(201).json({ room });
    })
  );

  router.post(
    "/rooms/:roomId/read",
    catchAsync(async (req, res) => {
      const ctx = await loadContext(req);
      if (ctx.isContractor) throw fail(403, "Chat is unavailable for contractor managers.");
      const room = ctx.op.rooms?.[req.params.roomId];
      if (!room || !Array.isArray(room.members) || !room.members.includes(ctx.meId)) {
        throw fail(404, "Conversation not found.");
      }
      for (const msg of room.messages || []) {
        if (msg.by === ctx.meId) continue;
        if (!Array.isArray(msg.delivered)) msg.delivered = [];
        if (!Array.isArray(msg.seen)) msg.seen = [];
        if (!msg.delivered.includes(ctx.meId)) msg.delivered.push(ctx.meId);
        if (!msg.seen.includes(ctx.meId)) msg.seen.push(ctx.meId);
      }
      await saveOperationFields(ctx.vendorId, ctx.plantId, { [`rooms.${req.params.roomId}`]: room });
      res.json({ room });
    })
  );

  return router;
}

module.exports = { createOpsRouter };

