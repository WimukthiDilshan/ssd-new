const express = require("express");
const router = express.Router();
const { authenticateUser, authorizeRole } = require("../middleware/AuthMiddleware");
const purchaseAccess = [authenticateUser, authorizeRole(['admin', 'manager'])];
const {
    createPurchase,
    getAllPurchases,
    getPurchaseById,
    getPurchasesByItemId,
    updatePurchase,
    deletePurchase,
    getPurchaseSummaryReport,
    getWasteAnalysisReport,
    createPurchaseWithStock,
    getPurchasesByDateRange
} = require("../controller/PurchaseController");

// Create new purchase (Manager and Admin only)
router.post("/", ...purchaseAccess, createPurchase);

// Create new purchase with automatic stock entry (Manager and Admin only)
router.post("/with-stock", ...purchaseAccess, createPurchaseWithStock);

// Get all purchases (Manager and Admin only)
router.get("/", ...purchaseAccess, getAllPurchases);

// Get purchase summary report (Manager and Admin only)
router.get("/report/summary", ...purchaseAccess, getPurchaseSummaryReport);

// Get waste analysis report (Manager and Admin only)
router.get("/report/waste", ...purchaseAccess, getWasteAnalysisReport);

// Get purchases by item ID (Manager and Admin only)
router.get("/item/:itemId", ...purchaseAccess, getPurchasesByItemId);

// Get purchases by date range (Manager and Admin only)
router.get('/date-range', ...purchaseAccess, getPurchasesByDateRange);

// Get purchase by ID (Manager and Admin only)
router.get("/:purchaseId", ...purchaseAccess, getPurchaseById);

// Update purchase (Manager and Admin only)
router.put("/:purchaseId", ...purchaseAccess, updatePurchase);

// Delete purchase (Manager and Admin only)
router.delete("/:purchaseId", ...purchaseAccess, deletePurchase);

module.exports = router; 
