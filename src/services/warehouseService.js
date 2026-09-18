const { PrismaClient } = require('@prisma/client');
const defaultPrisma = new PrismaClient();

/**
 * Gets or creates a valid default warehouse for a company.
 * 1. Checks company.inventoryConfig (defaultPurchaseWarehouseId or defaultSalesWarehouseId)
 * 2. If not found or invalid, finds the first active warehouse for this company
 * 3. If no warehouse exists for this company, creates a default "Main Warehouse"
 *
 * @param {Object} txOrPrisma Prisma client or transaction client
 * @param {number|string} companyId Company ID
 * @param {'purchase'|'sales'} type Type of operation ('purchase' or 'sales')
 * @returns {Promise<Object>} Warehouse record
 */
const getDefaultWarehouse = async (txOrPrisma, companyId, type = 'purchase') => {
    const client = txOrPrisma || defaultPrisma;
    const compId = parseInt(companyId);

    if (!compId || isNaN(compId)) {
        throw new Error('Valid Company ID is required to resolve warehouse');
    }

    // 1. Check company's inventoryConfig
    try {
        const company = await client.company.findUnique({
            where: { id: compId },
            select: { inventoryConfig: true }
        });

        if (company?.inventoryConfig) {
            const cfg = typeof company.inventoryConfig === 'string'
                ? JSON.parse(company.inventoryConfig)
                : company.inventoryConfig;

            const configWhId = type === 'sales'
                ? (cfg.defaultSalesWarehouseId || cfg.defaultPurchaseWarehouseId)
                : (cfg.defaultPurchaseWarehouseId || cfg.defaultSalesWarehouseId);

            if (configWhId) {
                const wh = await client.warehouse.findFirst({
                    where: { id: parseInt(configWhId), companyId: compId }
                });
                if (wh) return wh;
            }
        }
    } catch (e) {
        console.error('Error reading company inventoryConfig in warehouseService:', e);
    }

    // 2. Find any existing warehouse belonging to this company
    const existingWh = await client.warehouse.findFirst({
        where: { companyId: compId }
    });
    if (existingWh) return existingWh;

    // 3. If company has no warehouse at all, create a default "Main Warehouse"
    const createdWh = await client.warehouse.create({
        data: {
            name: 'Main Warehouse',
            location: 'Default Location',
            companyId: compId
        }
    });

    return createdWh;
};

/**
 * Resolves a valid warehouse ID for a company.
 * Validates that preferredWarehouseId actually exists and belongs to the company;
 * if not, safely falls back to the company's default warehouse.
 *
 * @param {Object} txOrPrisma Prisma client or transaction client
 * @param {number|string} companyId Company ID
 * @param {number|string|null} preferredWarehouseId Preferred warehouse ID
 * @param {'purchase'|'sales'} type Type of operation
 * @returns {Promise<number>} Valid warehouse ID
 */
const resolveWarehouseId = async (txOrPrisma, companyId, preferredWarehouseId = null, type = 'purchase') => {
    const client = txOrPrisma || defaultPrisma;
    const compId = parseInt(companyId);

    if (preferredWarehouseId) {
        const pId = parseInt(preferredWarehouseId);
        if (!isNaN(pId)) {
            const wh = await client.warehouse.findFirst({
                where: { id: pId, companyId: compId }
            });
            if (wh) return wh.id;
        }
    }

    const defaultWh = await getDefaultWarehouse(client, compId, type);
    return defaultWh.id;
};

module.exports = {
    getDefaultWarehouse,
    resolveWarehouseId
};
