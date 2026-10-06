const express = require("express");
const router = express.Router();
const { authenticateUser, authorizeRole } = require("../middleware/AuthMiddleware");
const staff = [authenticateUser, authorizeRole(["admin", "manager", "cashier"])];
const managers = [authenticateUser, authorizeRole(["admin", "manager"])];
const {
    createInventoryRelease,
    getAllInventoryReleases,
    getInventoryReleaseById,
    getInventoryReleasesByOrder,
    updateInventoryRelease,
    deleteInventoryRelease
} = require("../controller/InventoryReleaseController");

// Create new inventory release (Manager and Admin only)
router.post("/", ...managers, createInventoryRelease);

// Get all inventory releases
router.get("/", ...staff, getAllInventoryReleases);

// Get inventory releases by order ID
router.get("/order/:orderId", ...staff, getInventoryReleasesByOrder);

// Get inventory release by ID
router.get("/:releaseId", ...staff, getInventoryReleaseById);

// Update inventory release (Manager and Admin only)
router.put("/:releaseId", ...managers, updateInventoryRelease);

// Delete inventory release (Manager and Admin only)
router.delete("/:releaseId", ...managers, deleteInventoryRelease);

module.exports = router; 
