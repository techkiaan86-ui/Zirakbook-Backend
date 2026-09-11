const subscriptionService = require('../services/subscriptionService');
const prisma = require('../config/prisma');

/**
 * GET /api/subscriptions/report
 * Returns current plan, limits, subscription history, payment transactions, and available plans
 */
const getSubscriptionReport = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        const report = await subscriptionService.getCompanySubscriptionReport(companyId);
        res.json({ success: true, data: report });
    } catch (error) {
        console.error('getSubscriptionReport Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * POST /api/subscriptions/record
 * Record a manual subscription action (Upgrade, Renewal, Purchase, Custom)
 */
const recordSubscription = async (req, res) => {
    try {
        const companyId = req.body.companyId || req.user?.companyId;
        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        const performedBy = req.user?.name || req.user?.email || 'Admin';
        const result = await subscriptionService.recordSubscriptionHistory({
            ...req.body,
            companyId,
            performedBy
        });

        if (!result.success) {
            return res.status(500).json({ success: false, message: result.error });
        }

        // If action implies updating company record (e.g. renewal or plan change)
        if (req.body.updateCompanyRecord) {
            const updateData = {};
            if (req.body.planId !== undefined) updateData.planId = req.body.planId ? parseInt(req.body.planId) : null;
            if (req.body.planName) updateData.planName = req.body.planName;
            if (req.body.billingCycle) updateData.planType = req.body.billingCycle;
            if (req.body.startDate) updateData.startDate = new Date(req.body.startDate);
            if (req.body.endDate) updateData.endDate = new Date(req.body.endDate);

            if (Object.keys(updateData).length > 0) {
                await prisma.company.update({
                    where: { id: parseInt(companyId) },
                    data: updateData
                });
            }
        }

        res.json({
            success: true,
            message: 'Subscription record saved successfully',
            data: result
        });
    } catch (error) {
        console.error('recordSubscription Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * POST /api/subscriptions/upgrade-request
 * Company switches/upgrades or renews to a plan directly and activates immediately
 */
const requestUpgrade = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.body.companyId || req.query.companyId;
        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        const { planId, billingCycle, notes } = req.body;
        if (!planId) {
            return res.status(400).json({ success: false, message: 'Plan ID is required' });
        }

        const [company, newPlan] = await Promise.all([
            prisma.company.findUnique({ where: { id: parseInt(companyId) } }),
            prisma.plan.findUnique({ where: { id: parseInt(planId) } })
        ]);

        if (!company) return res.status(404).json({ success: false, message: 'Company not found' });
        if (!newPlan) return res.status(404).json({ success: false, message: 'Plan not found' });

        const cycle = newPlan.billingCycle || billingCycle || 'Monthly';
        const start = new Date();
        const end = new Date(start);
        const isYearly = cycle.toLowerCase().trim() === 'yearly';
        if (isYearly) {
            end.setFullYear(end.getFullYear() + 1);
        } else {
            end.setMonth(end.getMonth() + 1);
        }

        const isSamePlan = company.planId === newPlan.id;
        const actionType = isSamePlan ? 'RENEWAL' : 'UPGRADE';

        // 1. Update company record directly with the new plan
        await prisma.company.update({
            where: { id: parseInt(companyId) },
            data: {
                planId: newPlan.id,
                planName: newPlan.name,
                planType: cycle,
                startDate: start,
                endDate: end
            }
        });

        // Clear expiry cache so middleware instantly recognises company as active
        try {
            const { clearExpiryCache } = require('../middlewares/authMiddleware');
            if (clearExpiryCache) clearExpiryCache(companyId);
        } catch (e) { }

        // 2. Update role permissions if new plan unlocks modules
        try {
            let modulesArray = [];
            if (newPlan.modules) {
                modulesArray = typeof newPlan.modules === 'string' ? JSON.parse(newPlan.modules) : newPlan.modules;
            }

            const enabledModules = modulesArray
                .filter(m => m.enabled)
                .map(m => (m.name || m.module_name || "").toLowerCase());

            let defaultPermissions = [
                "show dashboard",
                "manage voucher", "create voucher", "edit voucher", "delete voucher",
                "manage reports", "view reports",
                "manage user", "create user", "edit user", "delete user",
                "manage role", "create role", "edit role", "delete role",
                "manage settings", "edit settings", "view settings"
            ];

            const moduleMapping = {
                'account': ["manage accounts", "create accounts", "edit accounts", "delete accounts"],
                'accounts': ["manage accounts", "create accounts", "edit accounts", "delete accounts"],
                'inventory': ["manage inventory", "create inventory", "edit inventory", "delete inventory"],
                'sales': ["manage sales", "create sales", "edit sales", "delete sales", "show sales", "send sales"],
                'purchase': ["manage purchases", "create purchases", "edit purchases", "delete purchases"],
                'purchases': ["manage purchases", "create purchases", "edit purchases", "delete purchases"],
                'pos': ["manage pos", "create pos", "edit pos", "delete pos"]
            };

            enabledModules.forEach(modName => {
                for (const key in moduleMapping) {
                    if (modName.includes(key)) {
                        defaultPermissions = [...new Set([...defaultPermissions, ...moduleMapping[key]])];
                    }
                }
            });

            await prisma.role.updateMany({
                where: { companyId: parseInt(companyId), name: 'COMPANY' },
                data: { permissions: JSON.stringify(defaultPermissions) }
            });
        } catch (permErr) {
            console.error('Permission sync warning on plan switch:', permErr);
        }

        // 3. Record in subscription history
        const performedBy = req.user?.name || req.user?.email || 'Company Admin';
        await subscriptionService.recordSubscriptionHistory({
            companyId: company.id,
            planId: newPlan.id,
            planName: newPlan.name,
            previousPlanName: company.planName,
            actionType,
            billingCycle: cycle,
            amount: newPlan.totalPrice || newPlan.basePrice || 0,
            currency: company.currency || 'USD',
            paymentMethod: 'Online Payment',
            paymentStatus: 'Paid',
            startDate: start,
            endDate: end,
            invoiceLimit: newPlan.invoiceLimit || 'Unlimited',
            userLimit: newPlan.userLimit || 'Unlimited',
            storageCapacity: newPlan.storageCapacity || '5 GB',
            features: newPlan.modules,
            notes: notes || (isSamePlan ? `Plan renewed for ${cycle} cycle.` : `Plan successfully switched from ${company.planName || 'Previous Plan'} to ${newPlan.name}.`),
            performedBy
        });

        // 4. Also record in planrequest as Accepted
        try {
            await prisma.planrequest.create({
                data: {
                    companyName: company.name,
                    email: company.email,
                    phone: company.phone,
                    address: company.address,
                    logo: company.logo,
                    planId: newPlan.id,
                    planName: newPlan.name,
                    billingCycle: cycle,
                    startDate: start,
                    status: 'Accepted'
                }
            });
        } catch (prErr) { }

        res.json({
            success: true,
            message: isSamePlan
                ? `Plan ${newPlan.name} renewed successfully!`
                : `Plan successfully switched to ${newPlan.name}!`,
            data: {
                planId: newPlan.id,
                planName: newPlan.name,
                billingCycle: cycle,
                startDate: start,
                endDate: end
            }
        });
    } catch (error) {
        console.error('requestUpgrade Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    getSubscriptionReport,
    recordSubscription,
    requestUpgrade
};
