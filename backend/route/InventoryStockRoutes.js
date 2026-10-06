const express = require("express");
const router = express.Router();
const { authenticateUser, authorizeRole } = require("../middleware/AuthMiddleware");
const managers = [authenticateUser, authorizeRole(["admin", "manager"])];
const staff = [authenticateUser, authorizeRole(["admin", "manager", "cashier"])];
const {
    createStock,
    getAllStock,
    getStockById,
    getStockByItemId,
    getTotalStockByItemId,
    updateStock,
    deleteStock,
    getStockAnalytics
} = require("../controller/InventoryStockController");

// Create new stock entry (Manager and Admin only)
router.post("/", ...managers, createStock);

// Get all stock entries
router.get("/", ...staff, getAllStock);

// Get stock analytics
router.get("/analytics", ...staff, getStockAnalytics);

// Get total available stock for an item
router.get("/total/:itemId", ...staff, getTotalStockByItemId);

// Get stock entries by item ID
router.get("/item/:itemId", ...staff, getStockByItemId);

// Get stock entry by ID
router.get("/:stockId", ...staff, getStockById);

// Update stock quantity (Manager and Admin only)
router.put("/:stockId", ...managers, updateStock);

// Delete stock entry (Manager and Admin only)
router.delete("/:stockId", ...managers, deleteStock);

module.exports = router; 
