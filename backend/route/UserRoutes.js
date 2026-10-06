const express = require("express");
const userController = require("../controller/UserController");
const { authenticateUser, optionalAuthenticate, authorizeRole } = require('../middleware/AuthMiddleware');

const router = express.Router();
const managers = [authenticateUser, authorizeRole(["admin", "manager"])];
const admins = [authenticateUser, authorizeRole(["admin"])];

// Public Routes
router.post("/register", optionalAuthenticate, userController.createUser); // Create User
router.post("/login", userController.login); // Login User
router.post("/logout", userController.logout); // Logout User
router.post("/forget-password", userController.forgetPassword); // Forget Password
router.post("/verify-code", userController.verifyCode); // Verify Code
router.post("/reset-password", userController.resetPassword); // Reset Password

// Protected Routes
router.get("/users", ...managers, userController.getUsers); // Get All Users
router.get("/users/:id", authenticateUser, userController.getUserById); // Get User by ID
router.get("/users/role/:role", ...managers, userController.getUsersByRole); // Get Users by Role
router.put("/users/:id", authenticateUser, userController.updateUser); // Update User
router.delete("/users/:id", ...admins, userController.deleteUser); // Delete User

module.exports = router;
