const express = require("express");
const router = express.Router();
const { authenticateUser, authorizeRole } = require("../middleware/AuthMiddleware");
const managers = [authenticateUser, authorizeRole(["admin", "manager"])];
const staff = [authenticateUser, authorizeRole(["admin", "manager", "cashier"])];
const {
    createItem,
    getAllItems,
    getItemById,
    updateItem,
    deleteItem,
    getItemsByCategory,
    getAllCategories,
    createCategory
} = require("../controller/InventoryItemController");

// Create new item (Manager and Admin only)
router.post("/", ...managers, createItem);

// Create new category (Manager and Admin only)
router.post("/categories", ...managers, createCategory);

// Get all items
router.get("/", ...staff, getAllItems);

// Get all categories
router.get("/categories", ...staff, getAllCategories);

// Get items by category
router.get("/category/:category", ...staff, getItemsByCategory);

// Get item by ID
router.get("/:itemId", ...staff, getItemById);

// Update item (Manager and Admin only)
router.put("/:itemId", ...managers, updateItem);

// Delete item (Manager and Admin only)
router.delete("/:itemId", ...managers, deleteItem);

module.exports = router; 
