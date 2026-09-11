const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const createPlan = async (req, res) => {
    try {
        const {
            name,
            basePrice,
            currency,
            invoiceLimit,
            additionalInvoicePrice,
            userLimit,
            storageCapacity,
            billingCycle,
            status,
            modules,
            totalPrice,
            descriptions
        } = req.body;

        const plan = await prisma.plan.create({
            data: {
                name,
                basePrice: parseFloat(basePrice) || 0,
                currency,
                invoiceLimit,
                additionalInvoicePrice: parseFloat(additionalInvoicePrice) || 0,
                userLimit,
                storageCapacity,
                billingCycle,
                status,
                modules: modules ? (typeof modules === 'object' ? JSON.stringify(modules) : modules) : "[]",
                totalPrice: parseFloat(totalPrice) || 0,
                descriptions: descriptions ? (typeof descriptions === 'object' ? JSON.stringify(descriptions) : descriptions) : "[]"
            }
        });

        res.status(201).json(plan);
    } catch (error) {
        console.error('Create Plan Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const getPlans = async (req, res) => {
    try {
        const plans = await prisma.plan.findMany({
            include: {
                _count: {
                    select: { company: true }
                }
            }
        });

        // Parse JSON fields
        const parsedPlans = plans.map(plan => ({
            ...plan,
            modules: plan.modules ? JSON.parse(plan.modules) : [],
            descriptions: plan.descriptions ? JSON.parse(plan.descriptions) : []
        }));

        res.json(parsedPlans);
    } catch (error) {
        console.error('Get Plans Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const getPlanById = async (req, res) => {
    try {
        const plan = await prisma.plan.findUnique({
            where: { id: parseInt(req.params.id) },
            include: {
                _count: {
                    select: { company: true }
                }
            }
        });
        if (!plan) return res.status(404).json({ message: 'Plan not found' });

        // Parse JSON fields
        const parsedPlan = {
            ...plan,
            modules: plan.modules ? JSON.parse(plan.modules) : [],
            descriptions: plan.descriptions ? JSON.parse(plan.descriptions) : []
        };

        res.json(parsedPlan);
    } catch (error) {
        console.error('Get Plan By ID Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const updatePlan = async (req, res) => {
    try {
        const {
            name,
            basePrice,
            currency,
            invoiceLimit,
            additionalInvoicePrice,
            userLimit,
            storageCapacity,
            billingCycle,
            status,
            modules,
            totalPrice,
            descriptions
        } = req.body;

        const plan = await prisma.plan.update({
            where: { id: parseInt(req.params.id) },
            data: {
                name,
                basePrice: parseFloat(basePrice) || 0,
                currency,
                invoiceLimit,
                additionalInvoicePrice: parseFloat(additionalInvoicePrice) || 0,
                userLimit,
                storageCapacity,
                billingCycle,
                status,
                modules: modules ? (typeof modules === 'object' ? JSON.stringify(modules) : modules) : "[]",
                totalPrice: parseFloat(totalPrice) || 0,
                descriptions: descriptions ? (typeof descriptions === 'object' ? JSON.stringify(descriptions) : descriptions) : "[]"
            }
        });

        res.json(plan);
    } catch (error) {
        console.error('Update Plan Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const deletePlan = async (req, res) => {
    try {
        const planId = parseInt(req.params.id);

        // Step 1: Find all companies that are currently using this plan
        const affectedCompanies = await prisma.company.findMany({
            where: { planId },
            select: { id: true, name: true, inventoryConfig: true }
        });

        const planToDelete = await prisma.plan.findUnique({ where: { id: planId } });

        // Step 2: Update all affected companies to Unlimited access & Unlimited Storage Capacity
        if (affectedCompanies.length > 0) {
            const subscriptionService = require('../services/subscriptionService');
            for (const company of affectedCompanies) {
                let configObj = {};
                try {
                    if (company.inventoryConfig) {
                        configObj = typeof company.inventoryConfig === 'string'
                            ? JSON.parse(company.inventoryConfig)
                            : company.inventoryConfig;
                    }
                } catch (e) {
                    configObj = {};
                }
                configObj.storageCapacity = 'Unlimited';

                await prisma.company.update({
                    where: { id: company.id },
                    data: {
                        planId: null,
                        planName: 'Unlimited',
                        planType: 'Unlimited',
                        inventoryConfig: JSON.stringify(configObj)
                    }
                });

                // Record subscription history event
                try {
                    await subscriptionService.recordSubscriptionHistory({
                        companyId: company.id,
                        planId: null,
                        planName: 'Unlimited Plan',
                        previousPlanName: planToDelete?.name || 'Deleted Plan',
                        actionType: 'AUTO_UNLIMITED',
                        billingCycle: 'Unlimited',
                        amount: 0,
                        paymentMethod: 'System Upgrade',
                        paymentStatus: 'Paid',
                        invoiceLimit: 'Unlimited',
                        userLimit: 'Unlimited',
                        storageCapacity: 'Unlimited',
                        notes: `Automatically upgraded to Unlimited Usage & Features because plan '${planToDelete?.name || planId}' was deleted.`,
                        performedBy: 'System'
                    });
                } catch (recErr) {
                    console.error('Failed to log subscription history on plan delete:', recErr);
                }
            }
            console.log(
                `[deletePlan] Plan ID ${planId} deleted. ` +
                `${affectedCompanies.length} company/companies moved to Unlimited access & Unlimited storage: ` +
                affectedCompanies.map(c => c.name).join(', ')
            );
        }

        // Step 3: Delete the plan (companies no longer reference it)
        await prisma.plan.delete({
            where: { id: planId }
        });

        res.json({
            message: 'Plan deleted successfully',
            affectedCompanies: affectedCompanies.length,
            upgradedCompanies: affectedCompanies.map(c => ({ id: c.id, name: c.name }))
        });
    } catch (error) {
        console.error('Delete Plan Error:', error);
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    createPlan,
    getPlans,
    getPlanById,
    updatePlan,
    deletePlan
};
