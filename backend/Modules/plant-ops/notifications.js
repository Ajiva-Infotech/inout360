const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");
const mongoose = require("mongoose");
const { GoogleAuth } = require("google-auth-library");

const { Schema } = mongoose;

const pushTokenSchema = new Schema(
  {
    _id: String,
    userId: { type: String, required: true, index: true },
    vendorId: { type: String, default: "" },
    plantId: { type: String, default: "" },
    token: { type: String, required: true },
    platform: { type: String, enum: ["android", "ios", "web", "other"], default: "other" },
    deviceName: { type: String, default: "" },
  },
  {
    autoCreate: false,
    autoIndex: false,
    timestamps: true,
    versionKey: false,
    collection: "plantops_push_tokens",
  }
);

const PushToken =
  mongoose.models.PlantOpsPushToken ||
  mongoose.model("PlantOpsPushToken", pushTokenSchema);

// Dedicated Plant-OPS Firebase service account (strictly isolated from PIL Firebase).
const DEFAULT_PLANT_OPS_SERVICE_ACCOUNT_PATH = path.join(
  __dirname,
  "..",
  "..",
  "config",
  "plant-ops-firebase-service-account.json"
);

function resolvePlantOpsServiceAccountPath() {
  const envPath = process.env.PLANT_OPS_FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!envPath) return DEFAULT_PLANT_OPS_SERVICE_ACCOUNT_PATH;
  return path.isAbsolute(envPath) ? envPath : path.join(process.cwd(), envPath);
}

let cachedProjectId;
function resolvePlantOpsProjectId(keyFile) {
  if (process.env.PLANT_OPS_FIREBASE_PROJECT_ID) {
    return process.env.PLANT_OPS_FIREBASE_PROJECT_ID;
  }
  if (cachedProjectId) return cachedProjectId;
  try {
    const parsed = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    if (parsed?.project_id) {
      cachedProjectId = parsed.project_id;
      return cachedProjectId;
    }
  } catch {
    // Unable to parse service account JSON
  }
  return "";
}

async function getPlantOpsFcmAccessToken(keyFile) {
  const auth = new GoogleAuth({
    keyFile,
    scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
  });
  const client = await auth.getClient();
  const tokenObj = await client.getAccessToken();
  if (!tokenObj?.token) {
    throw new Error("No access token returned from Plant-OPS GoogleAuth");
  }
  return tokenObj.token;
}

function tokenKey(userId, token) {
  const digest = crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 24);
  return `${userId}:${digest}`;
}

async function registerPushDevice({ userId, vendorId, plantId, token, platform = "other", deviceName = "" }) {
  const cleanToken = typeof token === "string" ? token.trim() : "";
  if (!userId || !cleanToken || cleanToken.length > 4096) return null;
  const safePlatform = ["android", "ios", "web", "other"].includes(platform) ? platform : "other";
  const _id = tokenKey(userId, cleanToken);
  await PushToken.updateOne(
    { _id },
    {
      $set: {
        userId: String(userId),
        vendorId: String(vendorId || ""),
        plantId: String(plantId || ""),
        token: cleanToken,
        platform: safePlatform,
        deviceName: String(deviceName || "").trim().slice(0, 120),
      },
    },
    { upsert: true }
  );
  return { id: _id, platform: safePlatform };
}

async function unregisterPushDevice(userId, token) {
  const cleanToken = typeof token === "string" ? token.trim() : "";
  if (!userId || !cleanToken) return;
  await PushToken.deleteOne({ _id: tokenKey(userId, cleanToken) });
}

async function collectPlantOpsTokens(userIds) {
  const uniqueIds = [...new Set((userIds || []).map((id) => String(id || "")).filter(Boolean))];
  if (!uniqueIds.length) return [];

  const rows = await PushToken.find({ userId: { $in: uniqueIds } })
    .select("token userId")
    .lean();

  const seen = new Set();
  const targets = [];
  for (const row of rows) {
    const t = String(row.token || "").trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      targets.push({ token: t, userId: String(row.userId) });
    }
  }
  return targets;
}

let missingConfigLogged = false;

async function sendPlantOpsPush({ recipientIds, title, body, data = {} }) {
  try {
    const targets = await collectPlantOpsTokens(recipientIds);
    if (!targets.length) return { sent: 0, skipped: 0 };

    const keyFile = resolvePlantOpsServiceAccountPath();
    if (!fs.existsSync(keyFile)) {
      if (!missingConfigLogged) {
        missingConfigLogged = true;
        console.warn(
          `[Plant-OPS Push] Dedicated Plant-OPS Firebase service account not found at ${keyFile}. Set PLANT_OPS_FIREBASE_SERVICE_ACCOUNT_PATH (and optionally PLANT_OPS_FIREBASE_PROJECT_ID) to enable Plant-OPS FCM push.`
        );
      }
      return { sent: 0, skipped: targets.length };
    }

    const projectId = resolvePlantOpsProjectId(keyFile);
    if (!projectId) {
      console.warn("[Plant-OPS Push] Missing project_id in Plant-OPS Firebase config.");
      return { sent: 0, skipped: targets.length };
    }

    const accessToken = await getPlantOpsFcmAccessToken(keyFile);
    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    const stringData = {};
    for (const [k, v] of Object.entries({ app: "plant_ops", ...data })) {
      if (v !== undefined && v !== null) stringData[k] = String(v);
    }

    let sent = 0;
    await Promise.all(
      targets.map(async ({ token, userId }) => {
        const message = {
          message: {
            token,
            notification: {
              title: String(title || "Plant-OPS"),
              body: String(body || ""),
            },
            android: {
              priority: "HIGH",
              notification: {
                channel_id: "plant_ops_alerts",
                color: "#0D2B45",
              },
            },
            data: stringData,
          },
        };
        try {
          await axios.post(url, message, {
            timeout: 10000,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
          });
          sent += 1;
        } catch (error) {
          const fcmCode =
            error.response?.data?.error?.details?.[0]?.errorCode ||
            error.response?.data?.error?.status ||
            "";
          if (["UNREGISTERED", "NOT_FOUND"].includes(fcmCode)) {
            await unregisterPushDevice(userId, token).catch(() => {});
          }
          if (process.env.NODE_ENV !== "production") {
            console.warn("[Plant-OPS Push] FCM send failed:", fcmCode || error.message);
          }
        }
      })
    );
    return { sent, skipped: targets.length - sent };
  } catch (error) {
    console.warn("[Plant-OPS Push] Dispatch error:", error.message);
    return { sent: 0, skipped: 0 };
  }
}

module.exports = {
  registerPushDevice,
  unregisterPushDevice,
  sendPlantOpsPush,
};
