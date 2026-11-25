const express = require("express");
const router = express.Router();
const Controller = require("./controller");
const verifyToken = require("../../middleware/verifyToken");
const checkAuthorization = require("../../middleware/checkAuthorization");

const allRoles = ["superadmin", "admin", "hr", "manager", "supervisor", "employee", "contractor"];
const manageRoles = ["superadmin", "admin", "hr"];

router.post("/", verifyToken, checkAuthorization(manageRoles, "departments"), Controller.add);
router.get("/", verifyToken, checkAuthorization(allRoles, "departments"), Controller.getAll);
router.get("/all", verifyToken, checkAuthorization(allRoles, "departments"), Controller.getList);
router.get("/search", verifyToken, checkAuthorization(allRoles, "departments"), Controller.getAll);
router.get("/:id", verifyToken, checkAuthorization(allRoles, "departments"), Controller.getById);
router.put("/:id", verifyToken, checkAuthorization(manageRoles, "departments"), Controller.update);
router.delete("/:id", verifyToken, checkAuthorization(manageRoles, "departments"), Controller.remove);
router.post("/delete", verifyToken, checkAuthorization(manageRoles, "departments", "delete"), Controller.remove);

module.exports = router;

