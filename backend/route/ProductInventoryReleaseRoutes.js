const express = require('express');
const router = express.Router();
const { authenticateUser, authorizeRole } = require('../middleware/AuthMiddleware');
const ProductInventoryRelease = require('../controller/ProductInventoryRelease');
const staff = [authenticateUser, authorizeRole(["admin", "manager", "cashier"])];
const managers = [authenticateUser, authorizeRole(["admin", "manager"])];

// Create a new production inventory release
router.post('/', ...managers, ProductInventoryRelease.create);

// Get all production inventory releases
router.get('/', ...staff, ProductInventoryRelease.getAll);

// Get a single production inventory release by ID
router.get('/:id', ...staff, ProductInventoryRelease.getById);

// Delete a production inventory release and restore inventory
router.delete('/:id', ...managers, ProductInventoryRelease.delete);

module.exports = router; 
