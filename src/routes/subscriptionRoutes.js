const express = require('express');
const router = express.Router();
const subscriptionController = require('../controllers/subscriptionController');
const { authenticateToken } = require('../middlewares/authMiddleware');

router.get('/report', authenticateToken, subscriptionController.getSubscriptionReport);
router.post('/record', authenticateToken, subscriptionController.recordSubscription);
router.post('/upgrade-request', authenticateToken, subscriptionController.requestUpgrade);

module.exports = router;
