const prisma = require('../config/prisma');

/**
 * Parses limit string or number into a usable number or Infinity.
 * Examples:
 * - "10 invoices" -> 10
 * - "Unlimited" -> Infinity
 * - "1 user" -> 1
 * - "5 GB" -> 5368709120 bytes
 */
const parseLimit = (val, type = 'number') => {
    if (val === undefined || val === null || val === '') return Infinity;
    const str = String(val).trim().toLowerCase();

    if (str.includes('unlimited') || str.includes('infinity')) {
        return Infinity;
    }

    if (type === 'storage') {
        const match = str.match(/[\d.]+/);
        if (!match) return Infinity;
        const num = parseFloat(match[0]);
        if (isNaN(num) || num <= 0) return Infinity;

        if (str.includes('tb')) {
            return Math.round(num * 1024 * 1024 * 1024 * 1024);
        } else if (str.includes('mb')) {
            return Math.round(num * 1024 * 1024);
        } else if (str.includes('kb')) {
            return Math.round(num * 1024);
        } else {
            // Default is GB
            return Math.round(num * 1024 * 1024 * 1024);
        }
    }

    // Number type (invoice, user)
    const match = str.match(/\d+/);
    if (!match) return Infinity;
    const num = parseInt(match[0], 10);
    // Note: If 0 was stored as a default placeholder in db, treat as Unlimited
    if (isNaN(num) || num <= 0) return Infinity;
    return num;
};

/**
 * Format bytes into human readable format (e.g. 1.2 MB, 5 GB)
 */
const formatBytes = (bytes, decimals = 1) => {
    if (bytes === Infinity) return 'Unlimited';
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

/**
 * Calculate total storage used by a company in bytes
 */
const getCompanyUsedStorage = async (companyId, existingConfig = null) => {
    const compId = parseInt(companyId, 10);
    let trackedBytes = 0;

    try {
        let config = existingConfig;
        if (typeof config === 'string') {
            config = JSON.parse(config);
        }
        if (config && typeof config.usedStorageBytes === 'number') {
            trackedBytes = config.usedStorageBytes;
        }
    } catch (e) {
        // ignore JSON error
    }

    // Also estimate from active assets in DB if trackedBytes is 0
    if (trackedBytes <= 0) {
        try {
            const [company, products, users, customers, vendors] = await Promise.all([
                prisma.company.findUnique({
                    where: { id: compId },
                    select: { logo: true, invoiceLogo: true }
                }),
                prisma.product.findMany({
                    where: { companyId: compId, image: { not: null } },
                    select: { image: true }
                }),
                prisma.user.findMany({
                    where: { companyId: compId, avatar: { not: null } },
                    select: { avatar: true }
                }),
                prisma.customer.findMany({
                    where: { companyId: compId, OR: [{ profileImage: { not: null } }, { anyFile: { not: null } }] },
                    select: { profileImage: true, anyFile: true }
                }),
                prisma.vendor.findMany({
                    where: { companyId: compId, OR: [{ profileImage: { not: null } }, { anyFile: { not: null } }] },
                    select: { profileImage: true, anyFile: true }
                })
            ]);

            let estimatedBytes = 0;
            const measureString = (str) => {
                if (!str) return 0;
                if (str.startsWith('data:')) {
                    return Math.round(str.length * 0.75); // base64 byte estimation
                }
                // Cloudinary URL or remote link represents an uploaded image (~350KB typical average)
                return 350 * 1024;
            };

            if (company?.logo) estimatedBytes += measureString(company.logo);
            if (company?.invoiceLogo) estimatedBytes += measureString(company.invoiceLogo);
            products.forEach(p => estimatedBytes += measureString(p.image));
            users.forEach(u => estimatedBytes += measureString(u.avatar));
            customers.forEach(c => {
                if (c.profileImage) estimatedBytes += measureString(c.profileImage);
                if (c.anyFile) estimatedBytes += measureString(c.anyFile);
            });
            vendors.forEach(v => {
                if (v.profileImage) estimatedBytes += measureString(v.profileImage);
                if (v.anyFile) estimatedBytes += measureString(v.anyFile);
            });

            trackedBytes = estimatedBytes;
        } catch (err) {
            console.error('Storage estimation error:', err);
        }
    }

    return trackedBytes;
};

/**
 * Get comprehensive plan limits and usage for a company
 */
const getCompanyPlanLimits = async (companyId) => {
    const compId = parseInt(companyId, 10);
    if (!compId) {
        throw new Error('Valid companyId is required');
    }

    const company = await prisma.company.findUnique({
        where: { id: compId },
        include: { plan: true }
    });

    if (!company) {
        throw new Error(`Company with ID ${compId} not found`);
    }

    let inventoryConfigObj = {};
    try {
        if (company.inventoryConfig) {
            inventoryConfigObj = typeof company.inventoryConfig === 'string'
                ? JSON.parse(company.inventoryConfig)
                : company.inventoryConfig;
        }
    } catch (e) {
        inventoryConfigObj = {};
    }

    const plan = company.plan || null;
    const planName = plan?.name || company.planName || 'Standard Plan';

    // 1. INVOICE LIMIT
    const invoiceLimit = parseLimit(plan?.invoiceLimit, 'invoice');
    const [salesInvoiceCount, posInvoiceCount] = await Promise.all([
        prisma.invoice.count({
            where: {
                companyId: compId,
                NOT: { status: 'CANCELLED' }
            }
        }),
        prisma.posinvoice.count({
            where: {
                companyId: compId
            }
        })
    ]);
    const invoicesUsed = salesInvoiceCount + posInvoiceCount;
    const isInvoiceLimitReached = invoiceLimit !== Infinity && invoicesUsed >= invoiceLimit;
    const invoicesRemaining = invoiceLimit === Infinity ? Infinity : Math.max(0, invoiceLimit - invoicesUsed);
    const invoicePercentage = invoiceLimit === Infinity ? 0 : Math.min(100, Math.round((invoicesUsed / invoiceLimit) * 100));

    // 2. USER LIMIT (Excludes primary COMPANY account - only counts employee/staff users)
    const userLimit = parseLimit(plan?.userLimit, 'user');
    const usersUsed = await prisma.user.count({
        where: {
            companyId: compId,
            role: {
                notIn: ['COMPANY', 'company']
            }
        }
    });
    const isUserLimitReached = userLimit !== Infinity && usersUsed >= userLimit;
    const usersRemaining = userLimit === Infinity ? Infinity : Math.max(0, userLimit - usersUsed);
    const userPercentage = userLimit === Infinity ? 0 : Math.min(100, Math.round((usersUsed / userLimit) * 100));

    // 3. STORAGE CAPACITY
    // Custom storage override in inventoryConfig takes precedence over plan
    const storageSetting = inventoryConfigObj.storageCapacity || plan?.storageCapacity || '5 GB';
    const storageCapacityBytes = parseLimit(storageSetting, 'storage');
    const storageUsedBytes = await getCompanyUsedStorage(compId, inventoryConfigObj);
    const isStorageLimitReached = storageCapacityBytes !== Infinity && storageUsedBytes >= storageCapacityBytes;
    const storageRemainingBytes = storageCapacityBytes === Infinity ? Infinity : Math.max(0, storageCapacityBytes - storageUsedBytes);
    const storagePercentage = storageCapacityBytes === Infinity ? 0 : Math.min(100, Math.round((storageUsedBytes / storageCapacityBytes) * 100));

    // Warnings list
    const warnings = [];
    if (isInvoiceLimitReached) {
        warnings.push(`Invoice limit reached (${invoicesUsed}/${invoiceLimit}). You cannot create new invoices until you upgrade your plan.`);
    } else if (invoiceLimit !== Infinity && invoicePercentage >= 80) {
        warnings.push(`Invoice limit is ${invoicePercentage}% full (${invoicesUsed}/${invoiceLimit} invoices used).`);
    }

    if (isUserLimitReached) {
        warnings.push(`User limit reached (${usersUsed}/${userLimit}). You cannot add new users until you upgrade your plan.`);
    } else if (userLimit !== Infinity && userPercentage >= 80) {
        warnings.push(`User limit is ${userPercentage}% full (${usersUsed}/${userLimit} users created).`);
    }

    if (isStorageLimitReached) {
        warnings.push(`Storage capacity reached (${formatBytes(storageUsedBytes)}/${formatBytes(storageCapacityBytes)}). You cannot upload new files.`);
    } else if (storageCapacityBytes !== Infinity && storagePercentage >= 80) {
        warnings.push(`Storage capacity is ${storagePercentage}% full (${formatBytes(storageUsedBytes)}/${formatBytes(storageCapacityBytes)} used).`);
    }

    return {
        companyId: compId,
        companyName: company.name,
        planId: company.planId,
        planName,
        planType: company.planType || plan?.billingCycle || 'Monthly',
        startDate: company.startDate,
        endDate: company.endDate,
        invoices: {
            limit: invoiceLimit === Infinity ? 'Unlimited' : invoiceLimit,
            limitRaw: invoiceLimit,
            used: invoicesUsed,
            salesInvoiceCount,
            posInvoiceCount,
            remaining: invoicesRemaining === Infinity ? 'Unlimited' : invoicesRemaining,
            percentage: invoicePercentage,
            isReached: isInvoiceLimitReached
        },
        users: {
            limit: userLimit === Infinity ? 'Unlimited' : userLimit,
            limitRaw: userLimit,
            used: usersUsed,
            remaining: usersRemaining === Infinity ? 'Unlimited' : usersRemaining,
            percentage: userPercentage,
            isReached: isUserLimitReached
        },
        storage: {
            limit: formatBytes(storageCapacityBytes),
            limitBytes: storageCapacityBytes,
            used: formatBytes(storageUsedBytes),
            usedBytes: storageUsedBytes,
            remaining: formatBytes(storageRemainingBytes),
            remainingBytes: storageRemainingBytes,
            percentage: storagePercentage,
            isReached: isStorageLimitReached
        },
        anyLimitReached: isInvoiceLimitReached || isUserLimitReached || isStorageLimitReached,
        warnings
    };
};

/**
 * Check if invoice creation is allowed
 */
const checkInvoiceLimit = async (companyId) => {
    const limits = await getCompanyPlanLimits(companyId);
    if (limits.invoices.isReached) {
        return {
            allowed: false,
            message: `Invoice limit reached for your plan (${limits.invoices.used}/${limits.invoices.limit}). You cannot create more invoices. Please upgrade your plan.`,
            limits
        };
    }
    return { allowed: true, limits };
};

/**
 * Check if user creation is allowed
 */
const checkUserLimit = async (companyId) => {
    const limits = await getCompanyPlanLimits(companyId);
    if (limits.users.isReached) {
        return {
            allowed: false,
            message: `User limit reached for your plan (${limits.users.used}/${limits.users.limit}). You cannot add more users. Please upgrade your plan.`,
            limits
        };
    }
    return { allowed: true, limits };
};

/**
 * Check if storage upload is allowed
 */
const checkStorageLimit = async (companyId, incomingBytes = 0) => {
    const limits = await getCompanyPlanLimits(companyId);
    if (limits.storage.limitBytes !== Infinity) {
        const potentialTotal = limits.storage.usedBytes + (Number(incomingBytes) || 0);
        if (potentialTotal > limits.storage.limitBytes) {
            return {
                allowed: false,
                message: `Storage capacity limit reached for your plan (${limits.storage.used}/${limits.storage.limit}). Uploading this file (${formatBytes(incomingBytes)}) exceeds your limit. Please upgrade your plan or delete files.`,
                limits
            };
        }
    }
    return { allowed: true, limits };
};

/**
 * Increment tracked storage usage in company.inventoryConfig
 */
const recordStorageUsage = async (companyId, bytesDelta = 0) => {
    try {
        const compId = parseInt(companyId, 10);
        if (!compId || !bytesDelta) return;

        const company = await prisma.company.findUnique({
            where: { id: compId },
            select: { inventoryConfig: true }
        });
        if (!company) return;

        let config = {};
        if (company.inventoryConfig) {
            config = typeof company.inventoryConfig === 'string'
                ? JSON.parse(company.inventoryConfig)
                : company.inventoryConfig;
        }

        const currentBytes = typeof config.usedStorageBytes === 'number' ? config.usedStorageBytes : 0;
        const newBytes = Math.max(0, currentBytes + Number(bytesDelta));
        config.usedStorageBytes = newBytes;

        await prisma.company.update({
            where: { id: compId },
            data: { inventoryConfig: JSON.stringify(config) }
        });
    } catch (err) {
        console.error('Failed to record storage usage:', err);
    }
};

module.exports = {
    parseLimit,
    formatBytes,
    getCompanyPlanLimits,
    checkInvoiceLimit,
    checkUserLimit,
    checkStorageLimit,
    recordStorageUsage
};
