const express = require('express');
const { authenticateUser, authorizeRole } = require('../middleware/AuthMiddleware');
const router = express.Router();
const managers = [authenticateUser, authorizeRole(["admin", "manager"])];
const {
    getAllRecipes,
    getRecipeByProductId,
    createRecipe,
    updateRecipe,
    deleteRecipe
} = require('../controller/recipeController');

// Get all recipes
router.get('/', ...managers, getAllRecipes);

// Get recipe by product ID
router.get('/product/:productId', ...managers, getRecipeByProductId);

// Create new recipe
router.post('/', ...managers, createRecipe);

// Update recipe
router.put('/:product_item_id/:ingredient_item_id', ...managers, updateRecipe);

// Delete recipe
router.delete('/:product_item_id/:ingredient_item_id', ...managers, deleteRecipe);

module.exports = router; 
