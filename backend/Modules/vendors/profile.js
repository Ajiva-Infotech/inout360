const mongoose = require("mongoose");

const limits = {
  name: 120,
  contactPerson: 100,
  email: 254,
  phone: 40,
  address: 400,
  gstNumber: 32,
};

function profileChanges(body) {
  const changes = {};
  for (const [field, maxLength] of Object.entries(limits)) {
    if (!Object.hasOwn(body, field)) continue;
    if (typeof body[field] !== "string" || body[field].trim().length > maxLength) {
      throw new Error("Invalid client " + field + ".");
    }
    const value = body[field].trim();
    changes[field] = field === "email" ? value.toLowerCase() : field === "gstNumber" ? value.toUpperCase() : value;
  }
  if (changes.name === "") throw new Error("Client name is required.");
  if (changes.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(changes.email)) {
    throw new Error("Enter a valid email address.");
  }
  if (!Object.keys(changes).length) throw new Error("No editable client details were provided.");
  return changes;
}

function createProfileHandler(model = require("./model")) {
  return async (req, res) => {
    const { id } = req.params;
    if (!mongoose.isObjectIdOrHexString(id)) return res.status(404).json({ message: "Client not found." });
    let changes;
    try {
      changes = profileChanges(req.body || {});
    } catch (error) {
      return res.status(400).json({ message: error.message });
    }
    try {
      const fields = "_id vendorCode status verified " + Object.keys(limits).join(" ");
      const vendor = await model.findByIdAndUpdate(id, { $set: changes }, { new: true, runValidators: true })
        .select(fields).lean();
      if (!vendor) return res.status(404).json({ message: "Client not found." });
      return res.json({ status: true, data: { ...vendor, id: String(vendor._id) } });
    } catch (error) {
      console.error("Client profile update failed:", error.name, error.code || "");
      return res.status(500).json({ message: "The client details could not be saved." });
    }
  };
}

module.exports = { createProfileHandler };
