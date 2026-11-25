const express = require("express");
const router = express.Router();
const Controller = require("./controller");
const verifyToken = require("../../middleware/verifyToken");
const checkAuthorization = require("../../middleware/checkAuthorization");

const allRoles = ["superadmin", "admin", "hr", "manager", "supervisor", "employee", "contractor"];
const manageRoles = ["superadmin", "admin", "hr"];

router.post("/", verifyToken, checkAuthorization(manageRoles, "floors"), Controller.add);
router.get("/", verifyToken, checkAuthorization(allRoles, "floors"), Controller.getAll);
router.get("/all", verifyToken, checkAuthorization(allRoles, "floors"), Controller.getList);
router.get("/search", verifyToken, checkAuthorization(allRoles, "floors"), Controller.getAll);
router.get("/:id", verifyToken, checkAuthorization(allRoles, "floors"), Controller.getById);
router.put("/:id", verifyToken, checkAuthorization(manageRoles, "floors"), Controller.update);
router.delete("/:id", verifyToken, checkAuthorization(manageRoles, "floors"), Controller.remove);
router.post("/delete", verifyToken, checkAuthorization(manageRoles, "floors", "delete"), Controller.remove);

module.exports = router;

