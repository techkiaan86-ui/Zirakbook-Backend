const prisma = require('../config/prisma');
const planLimitService = require('./planLimitService');

let _tableEnsured = false;

/**
 * Ensures the subscription_history table exists in MySQL database
 */
async function ensureTable() {
    if (_tableEnsured) return;
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS \`subscription_history\` (
              \`id\` INT NOT NULL AUTO_INCREMENT,
              \`companyId\` INT NOT NULL,
              \`planId\` INT NULL,
              \`planName\` VARCHAR(191) NOT NULL,
              \`previousPlanName\` VARCHAR(191) NULL,
              \`actionType\` VARCHAR(50) NOT NULL DEFAULT 'PURCHASE',
              \`billingCycle\` VARCHAR(50) NOT NULL DEFAULT 'Monthly',
              \`amount\` DOUBLE NOT NULL DEFAULT 0,
              \`currency\` VARCHAR(20) NOT NULL DEFAULT 'USD',
              \`paymentMethod\` VARCHAR(100) NULL DEFAULT 'Bank Transfer',
              \`paymentStatus\` VARCHAR(50) NOT NULL DEFAULT 'Paid',
              \`transactionId\` VARCHAR(100) NULL,
              \`receiptNumber\` VARCHAR(100) NULL,
              \`startDate\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
              \`endDate\` DATETIME(3) NULL,
              \`invoiceLimit\` VARCHAR(100) NULL DEFAULT 'Unlimited',
              \`userLimit\` VARCHAR(100) NULL DEFAULT 'Unlimited',
              \`storageCapacity\` VARCHAR(100) NULL DEFAULT 'Unlimited',
              \`features\` LONGTEXT NULL,
              \`notes\` TEXT NULL,
              \`performedBy\` VARCHAR(191) NULL,
              \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
              \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
              PRIMARY KEY (\`id\`),
              INDEX \`SubscriptionHistory_companyId_idx\` (\`companyId\`),
              INDEX \`SubscriptionHistory_planId_idx\` (\`planId\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        _tableEnsured = true;
    } catch (err) {
        _tableEnsured = true;
        console.warn('[subscriptionService] ensureTable warning:', err.message);
    }
}

/**
 * Generates a unique transaction reference ID
 */
function generateTransactionId() {
    const timestamp = Date.now().toString().slice(-6);
    const rand = Math.floor(1000 + Math.random() * 9000);
    return `SUB-TXN-${timestamp}-${rand}`;
}

/**
 * Generates an invoice/receipt number
 */
function generateReceiptNumber() {
    const year = new Date().getFullYear();
    const rand = Math.floor(10000 + Math.random() * 90000);
    return `REC-${year}-${rand}`;
}

/**
 * Record an entry into subscription history
 */
async function recordSubscriptionHistory(data) {
    await ensureTable();
    try {
        const companyId = parseInt(data.companyId, 10);
        const planId = data.planId ? parseInt(data.planId, 10) : null;
        const planName = data.planName || 'Unlimited Plan';
        const previousPlanName = data.previousPlanName || null;
        const actionType = data.actionType || 'PURCHASE'; // 'PURCHASE', 'UPGRADE', 'DOWNGRADE', 'RENEWAL', 'AUTO_UNLIMITED', 'INITIAL'
        const billingCycle = data.billingCycle || 'Monthly';
        const amount = typeof data.amount === 'number' ? data.amount : (parseFloat(data.amount) || 0);
        const currency = data.currency || 'USD';
        const paymentMethod = data.paymentMethod || 'Bank Transfer';
        const paymentStatus = data.paymentStatus || 'Paid';
        const transactionId = data.transactionId || generateTransactionId();
        const receiptNumber = data.receiptNumber || generateReceiptNumber();
        const startDate = data.startDate ? new Date(data.startDate) : new Date();
        const endDate = data.endDate ? new Date(data.endDate) : null;
        const invoiceLimit = data.invoiceLimit || 'Unlimited';
        const userLimit = data.userLimit || 'Unlimited';
        const storageCapacity = data.storageCapacity || 'Unlimited';
        const features = data.features ? (typeof data.features === 'object' ? JSON.stringify(data.features) : String(data.features)) : null;
        const notes = data.notes || null;
        const performedBy = data.performedBy || 'System';

        await prisma.$executeRawUnsafe(
            `INSERT INTO \`subscription_history\` (
                companyId, planId, planName, previousPlanName, actionType,
                billingCycle, amount, currency, paymentMethod, paymentStatus,
                transactionId, receiptNumber, startDate, endDate,
                invoiceLimit, userLimit, storageCapacity, features, notes,
                performedBy, createdAt, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
            companyId, planId, planName, previousPlanName, actionType,
            billingCycle, amount, currency, paymentMethod, paymentStatus,
            transactionId, receiptNumber, startDate, endDate,
            invoiceLimit, userLimit, storageCapacity, features, notes,
            performedBy
        );

        return {
            success: true,
            transactionId,
            receiptNumber
        };
    } catch (error) {
        console.error('[subscriptionService] Error recording subscription history:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Automatically backfills history for existing companies so they don't have empty records
 */
async function backfillInitialHistory(companyId) {
    await ensureTable();
    try {
        const compId = parseInt(companyId, 10);
        const countRows = await prisma.$queryRawUnsafe(
            `SELECT COUNT(*) as cnt FROM \`subscription_history\` WHERE companyId = ?`,
            compId
        );
        const count = countRows[0]?.cnt ? Number(countRows[0].cnt) : 0;

        if (count > 0) return; // Already has history

        const company = await prisma.company.findUnique({
            where: { id: compId },
            include: { plan: true }
        });

        if (!company) return;

        // Check if there was an associated plan request
        let matchingRequest = null;
        try {
            matchingRequest = await prisma.planrequest.findFirst({
                where: {
                    OR: [
                        { email: company.email },
                        { companyName: company.name }
                    ]
                },
                include: { plan: true },
                orderBy: { createdAt: 'desc' }
            });
        } catch (e) { }

        const currentPlan = company.plan;
        const currency = company.currency || 'USD';

        // 1. Initial Plan Record
        if (matchingRequest && matchingRequest.plan) {
            const reqPlan = matchingRequest.plan;
            await recordSubscriptionHistory({
                companyId: compId,
                planId: reqPlan.id,
                planName: reqPlan.name,
                previousPlanName: null,
                actionType: 'PURCHASE',
                billingCycle: matchingRequest.billingCycle || 'Yearly',
                amount: reqPlan.totalPrice || reqPlan.basePrice || 100,
                currency: currency,
                paymentMethod: 'Credit Card',
                paymentStatus: 'Paid',
                transactionId: `SUB-INIT-${compId}-${Date.now().toString().slice(-4)}`,
                receiptNumber: `REC-${new Date(matchingRequest.createdAt || company.createdAt).getFullYear()}-00${compId}`,
                startDate: matchingRequest.startDate || company.startDate || company.createdAt,
                endDate: company.endDate,
                invoiceLimit: reqPlan.invoiceLimit || 'Unlimited',
                userLimit: reqPlan.userLimit || 'Unlimited',
                storageCapacity: reqPlan.storageCapacity || '5 GB',
                features: reqPlan.modules,
                notes: `Initial subscription activated via Plan Request (#${matchingRequest.id}).`,
                performedBy: 'SuperAdmin'
            });
        } else if (currentPlan) {
            await recordSubscriptionHistory({
                companyId: compId,
                planId: currentPlan.id,
                planName: currentPlan.name,
                previousPlanName: null,
                actionType: 'INITIAL',
                billingCycle: company.planType || currentPlan.billingCycle || 'Yearly',
                amount: currentPlan.totalPrice || currentPlan.basePrice || 100,
                currency: currency,
                paymentMethod: 'Bank Transfer',
                paymentStatus: 'Paid',
                transactionId: `SUB-INIT-${compId}-${Date.now().toString().slice(-4)}`,
                receiptNumber: `REC-${new Date(company.createdAt).getFullYear()}-00${compId}`,
                startDate: company.startDate || company.createdAt,
                endDate: company.endDate,
                invoiceLimit: currentPlan.invoiceLimit || 'Unlimited',
                userLimit: currentPlan.userLimit || 'Unlimited',
                storageCapacity: currentPlan.storageCapacity || '5 GB',
                features: currentPlan.modules,
                notes: 'Initial company subscription plan.',
                performedBy: 'SuperAdmin'
            });
        }

        // 2. If company is now Unlimited Plan (e.g. converted when plan model deleted)
        if (!company.planId && (company.planName === 'Unlimited' || company.planType === 'Unlimited')) {
            await recordSubscriptionHistory({
                companyId: compId,
                planId: null,
                planName: 'Unlimited Plan',
                previousPlanName: matchingRequest?.planName || currentPlan?.name || 'Previous Plan',
                actionType: 'AUTO_UNLIMITED',
                billingCycle: 'Unlimited',
                amount: 0,
                currency: currency,
                paymentMethod: 'System Upgrade',
                paymentStatus: 'Paid',
                transactionId: `SUB-UNL-${compId}-${Date.now().toString().slice(-4)}`,
                receiptNumber: `REC-UNL-00${compId}`,
                startDate: company.startDate || company.createdAt,
                endDate: null, // Lifetime unlimited
                invoiceLimit: 'Unlimited',
                userLimit: 'Unlimited',
                storageCapacity: 'Unlimited',
                features: JSON.stringify([
                    { name: 'Account', price: 0, enabled: true },
                    { name: 'Inventory', price: 0, enabled: true },
                    { name: 'POS', price: 0, enabled: true },
                    { name: 'Sales', price: 0, enabled: true },
                    { name: 'Purchase', price: 0, enabled: true },
                    { name: 'GST Report', price: 0, enabled: true },
                    { name: 'User Management', price: 0, enabled: true }
                ]),
                notes: 'Automatically converted to Unlimited Usage & Features (Plan Model was deleted).',
                performedBy: 'System'
            });
        }
    } catch (err) {
        console.error('[subscriptionService] Error backfilling initial history:', err);
    }
}

/**
 * Get comprehensive Subscription Report for a Company
 */
async function getCompanySubscriptionReport(companyId) {
    await ensureTable();
    const compId = parseInt(companyId, 10);
    if (!compId) throw new Error('Valid companyId is required');

    // Backfill history if not present
    await backfillInitialHistory(compId);

    const [company, planLimits, historyRows, availablePlans] = await Promise.all([
        prisma.company.findUnique({
            where: { id: compId },
            include: { plan: true }
        }),
        planLimitService.getCompanyPlanLimits(compId),
        prisma.$queryRawUnsafe(
            `SELECT * FROM \`subscription_history\` WHERE companyId = ? ORDER BY id DESC`,
            compId
        ),
        prisma.plan.findMany({
            where: { status: 'Active' },
            orderBy: { totalPrice: 'asc' }
        })
    ]);

    if (!company) throw new Error(`Company #${compId} not found`);

    const isUnlimited = company.planName === 'Unlimited' || company.planType === 'Unlimited' || (!company.plan && !company.planId);
    const planName = isUnlimited ? 'Unlimited Plan' : (company.plan?.name || company.planName || 'Standard Plan');

    // Calculate days remaining
    let daysRemaining = null;
    let isExpiringSoon = false;
    let isExpired = false;

    if (company.endDate && !isUnlimited) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const end = new Date(company.endDate);
        const diffTime = end - today;
        daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        isExpired = daysRemaining < 0;
        isExpiringSoon = daysRemaining >= 0 && daysRemaining <= 15;
    }

    // Format history rows
    const history = (historyRows || []).map(row => {
        let parsedFeatures = [];
        try {
            if (row.features) parsedFeatures = JSON.parse(row.features);
        } catch (e) { }

        return {
            id: row.id,
            companyId: row.companyId,
            planId: row.planId,
            planName: row.planName,
            previousPlanName: row.previousPlanName,
            actionType: row.actionType,
            billingCycle: row.billingCycle,
            amount: parseFloat(row.amount) || 0,
            currency: row.currency || company.currency || 'USD',
            paymentMethod: row.paymentMethod,
            paymentStatus: row.paymentStatus,
            transactionId: row.transactionId,
            receiptNumber: row.receiptNumber,
            startDate: row.startDate,
            endDate: row.endDate,
            invoiceLimit: row.invoiceLimit,
            userLimit: row.userLimit,
            storageCapacity: row.storageCapacity,
            features: parsedFeatures,
            notes: row.notes,
            performedBy: row.performedBy,
            createdAt: row.createdAt
        };
    });

    // Payment Ledger format (filter for financial transactions)
    const payments = history.map(item => ({
        id: item.id,
        transactionId: item.transactionId,
        receiptNumber: item.receiptNumber,
        date: item.createdAt,
        planName: item.planName,
        actionType: item.actionType,
        billingCycle: item.billingCycle,
        amount: item.amount,
        currency: item.currency,
        paymentMethod: item.paymentMethod,
        paymentStatus: item.paymentStatus,
        notes: item.notes
    }));

    // Financial summary
    const totalSpent = payments
        .filter(p => p.paymentStatus === 'Paid')
        .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);

    const parsedAvailablePlans = availablePlans.map(p => {
        let mods = [];
        try {
            if (p.modules) mods = JSON.parse(p.modules);
        } catch (e) { }
        return {
            ...p,
            modules: mods
        };
    });

    return {
        company: {
            id: company.id,
            name: company.name,
            email: company.email,
            phone: company.phone,
            currency: company.currency || 'USD',
            startDate: company.startDate,
            endDate: company.endDate,
            logo: company.logo
        },
        currentPlan: {
            name: planName,
            planId: company.planId,
            isUnlimited,
            billingCycle: isUnlimited ? 'Lifetime Unlimited' : (company.planType || company.plan?.billingCycle || 'Monthly'),
            status: isExpired ? 'Expired' : (isExpiringSoon ? 'Expiring Soon' : 'Active'),
            startDate: company.startDate,
            endDate: company.endDate,
            daysRemaining,
            isExpiringSoon,
            isExpired,
            price: company.plan?.totalPrice || company.plan?.basePrice || 0,
            modules: company.plan?.modules ? JSON.parse(company.plan.modules) : []
        },
        limits: planLimits,
        history,
        payments,
        summary: {
            totalSpent,
            totalTransactions: payments.length,
            currency: company.currency || 'USD',
            totalUpgrades: history.filter(h => h.actionType === 'UPGRADE').length,
            totalRenewals: history.filter(h => h.actionType === 'RENEWAL').length,
            memberSince: company.createdAt || company.startDate
        },
        availablePlans: parsedAvailablePlans
    };
}

module.exports = {
    ensureTable,
    recordSubscriptionHistory,
    backfillInitialHistory,
    getCompanySubscriptionReport
};
