const prisma = require('../config/prisma');
const { getFiscalYearStartDate } = require('../services/chartOfAccountsService');

const DEFAULT_LEDGER_NAMES = [
    'Cash in Hand',
    'Main Bank Account',
    'Inventory Asset',
    'VAT / Sales Tax Payable',
    'Owner Investment / Capital',
    'Opening Balance Equity',
    'Retained Earnings',
    'Sales Revenue',
    'Discount Received on Purchase',
    'Cost of Goods Sold',
    'Rent Expense',
    'Electricity & Utilities',
    'Salary & Wages',
    'Inventory Adjustment Expense',
    'Discount Allowed on Sale'
];

const DEFAULT_GROUP_NAMES = [
    'Assets',
    'Liabilities',
    'Equity',
    'Income',
    'Expenses'
];

const DEFAULT_SUBGROUP_NAMES = [
    'Cash',
    'Bank Accounts',
    'Accounts Receivable',
    'Inventory',
    'Fixed Assets',
    'Accounts Payable',
    'Duties & Taxes',
    'Loans & Borrowings',
    'Share Capital',
    'Equity Items',
    'Sales Income',
    'Other Income',
    'Direct Expenses / COGS',
    'Operating Expenses'
];

async function syncDefaultAccountsDates(targetCompanyId = null) {
    try {
        const whereClause = targetCompanyId ? { id: parseInt(targetCompanyId) } : {};
        const companies = await prisma.company.findMany({ where: whereClause });
        console.log(`[Sync FY Dates] Found ${companies.length} companies to process.`);

        for (const company of companies) {
            const fyStartDate = getFiscalYearStartDate(company);
            console.log(`[Company ${company.id}: ${company.name}] Country: ${company.country || 'N/A'}, FY Start: ${fyStartDate.toISOString()}`);

            // 1. Update Default Ledgers
            const ledgerUpdateResult = await prisma.ledger.updateMany({
                where: {
                    companyId: company.id,
                    name: { in: DEFAULT_LEDGER_NAMES }
                },
                data: {
                    date: fyStartDate,
                    createdAt: fyStartDate
                }
            });
            console.log(`  - Updated ${ledgerUpdateResult.count} default ledgers to ${fyStartDate.toISOString().split('T')[0]}`);

            // 2. Update Default Groups
            await prisma.accountgroup.updateMany({
                where: {
                    companyId: company.id,
                    name: { in: DEFAULT_GROUP_NAMES }
                },
                data: {
                    createdAt: fyStartDate
                }
            });

            // 3. Update Default Subgroups
            await prisma.accountsubgroup.updateMany({
                where: {
                    companyId: company.id,
                    name: { in: DEFAULT_SUBGROUP_NAMES }
                },
                data: {
                    createdAt: fyStartDate
                }
            });
        }

        console.log('[Sync FY Dates] Completed successfully.');
        return { success: true, count: companies.length };
    } catch (error) {
        console.error('[Sync FY Dates] Error:', error);
        throw error;
    }
}

module.exports = { syncDefaultAccountsDates };

if (require.main === module) {
    syncDefaultAccountsDates()
        .then(() => process.exit(0))
        .catch(err => {
            console.error(err);
            process.exit(1);
        });
}
