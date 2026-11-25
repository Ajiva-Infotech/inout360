const express = require("express");
const router = express.Router();
const Controller = require("./controller");
const verifyToken = require("../../middleware/verifyToken");
const checkAuthorization = require("../../middleware/checkAuthorization");
const { createProfileHandler } = require("./profile");

// Vendors are system-wide; keep superadmin-only
// Public: used during app registration to verify vendorCode before login
router.get("/public/verify", Controller.verifyPublic);
router.post("/public/register", Controller.register);
router.post("/public/verify-otp", Controller.verifyOtp);

const readRoles = ["superadmin", "admin", "hr", "manager", "supervisor"];
const manageRoles = ["superadmin", "admin", "hr"];

router.get("/", verifyToken, checkAuthorization(readRoles, "vendors"), Controller.getAll);
router.get("/:id", verifyToken, checkAuthorization(readRoles, "vendors"), Controller.getById);
router.post("/", verifyToken, checkAuthorization(manageRoles, "vendors"), Controller.add);
router.patch("/:id/profile", verifyToken, checkAuthorization(["superadmin"], "vendors", "update"), createProfileHandler());
router.put("/:id", verifyToken, checkAuthorization(manageRoles, "vendors"), Controller.update);
router.delete("/:id", verifyToken, checkAuthorization(manageRoles, "vendors"), Controller.remove);

module.exports = router;
