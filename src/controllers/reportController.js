const prisma = require('../config/prisma');
const { getConversionRate, getCompanyCurrency, getCompanyHistoricalCurrency, getExchangeRates } = require('../utils/currencyConverter');

// Helper to calculate total inventory value for a company as of now
const calculateInventoryValue = async (companyId) => {
    try {
        const stocks = await prisma.stock.findMany({
            where: { product: { companyId: parseInt(companyId) } },
            include: { product: true }
        });

        let totalValue = 0;
        stocks.forEach(s => {
            const price = s.product.averageCost || s.product.purchasePrice || s.product.initialCost || 0;
            totalValue += (s.quantity * price);
        });
        return totalValue;
    } catch (error) {
        console.error("Error calculating inventory value:", error);
        return 0;
    }
};

// Helper to ensure critical inventory ledgers exist
const ensureInventoryLedgers = async (companyId) => {
    try {
        const companyIdInt = parseInt(companyId);

        // Find Groups
        const assetsGroup = await prisma.accountgroup.findFirst({ where: { companyId: companyIdInt, type: 'ASSETS' } });
        const equityGroup = await prisma.accountgroup.findFirst({ where: { companyId: companyIdInt, type: 'EQUITY' } });

        if (!assetsGroup || !equityGroup) return;

        // Check/Create Inventory Asset
        await prisma.ledger.upsert({
            where: { companyId_name: { companyId: companyIdInt, name: 'Inventory Asset' } },
            update: {},
            create: {
                name: 'Inventory Asset',
                groupId: assetsGroup.id,
                companyId: companyIdInt,
                isControlAccount: true
            }
        });

        // Check/Create Opening Balance Equity
        await prisma.ledger.upsert({
            where: { companyId_name: { companyId: companyIdInt, name: 'Opening Balance Equity' } },
            update: {},
            create: {
                name: 'Opening Balance Equity',
                groupId: equityGroup.id,
                companyId: companyIdInt
            }
        });
    } catch (e) {
        console.error("Error ensuring inventory ledgers:", e);
    }
};

// Helper: set time to end of day (23:59:59.999) for inclusive date filtering
const toEndOfDay = (dateStr) => {
    const d = new Date(dateStr);
    d.setHours(23, 59, 59, 999);
    return d;
};

const getSalesReport = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        const { startDate, endDate, transactionFilter } = req.query; // 'ALL', 'SALES', 'RETURNS'

        let whereClause = {
            companyId: parseInt(companyId)
        };

        if (startDate && endDate) {
            whereClause.date = {
                gte: new Date(startDate),
                lte: toEndOfDay(endDate)
            };
        }

        let salesReport = [];
        if (!transactionFilter || transactionFilter === 'ALL' || transactionFilter === 'SALES' || transactionFilter === 'INVOICE') {
            salesReport = await prisma.invoice.findMany({
                where: whereClause,
                include: {
                    customer: { select: { name: true, email: true } },
                    salesperson: { select: { id: true, name: true } },
                    invoiceitem: {
                        include: {
                            product: { include: { category: true, stock: true } },
                            warehouse: true
                        }
                    }
                },
                orderBy: { date: 'desc' }
            });
        }

        let posReport = [];
        if (!transactionFilter || transactionFilter === 'ALL' || transactionFilter === 'SALES' || transactionFilter === 'POS') {
            posReport = await prisma.posinvoice.findMany({
                where: whereClause,
                include: {
                    customer: { select: { name: true, email: true } },
                    posinvoiceitem: {
                        include: {
                            product: { include: { category: true, stock: true } }
                        }
                    }
                },
                orderBy: { date: 'desc' }
            });
        }

        let salesReturns = [];
        if (!transactionFilter || transactionFilter === 'ALL' || transactionFilter === 'RETURNS') {
            salesReturns = await prisma.salesreturn.findMany({
                where: whereClause,
                include: {
                    customer: { select: { name: true, email: true } },
                    invoice: { select: { invoiceNumber: true } },
                    salesreturnitem: {
                        include: {
                            product: { include: { category: true, stock: true } },
                            warehouse: true
                        }
                    }
                },
                orderBy: { date: 'desc' }
            });
        }

        // Calculate Summary Stats & Convert to Base Currency
        const now = new Date();
        const companyCurrency = await getCompanyCurrency(companyId);

        const convertedSales = await Promise.all(salesReport.map(async inv => {
            const rate = await getConversionRate(inv.currency || 'USD', companyCurrency);
            return {
                ...inv,
                type: 'SALE',
                source: 'INVOICE',
                isReturn: false,
                subtotal: inv.subtotal * rate,
                discountAmount: inv.discountAmount * rate,
                taxAmount: inv.taxAmount * rate,
                totalAmount: inv.totalAmount * rate,
                paidAmount: inv.paidAmount * rate,
                balanceAmount: inv.balanceAmount * rate,
                invoiceitem: inv.invoiceitem.map(item => ({
                    ...item,
                    rate: item.rate * rate,
                    amount: item.amount * rate
                }))
            };
        }));

        const convertedPosSales = await Promise.all(posReport.map(async pos => {
            const rate = await getConversionRate(pos.currency || 'USD', companyCurrency);
            return {
                id: pos.id,
                invoiceNumber: pos.invoiceNumber,
                date: pos.date || pos.createdAt,
                type: 'POS_SALE',
                source: 'POS',
                isReturn: false,
                customer: pos.customer,
                status: pos.status || 'PAID',
                totalAmount: (pos.totalAmount || 0) * rate,
                paidAmount: (pos.paidAmount || 0) * rate,
                balanceAmount: (pos.balanceAmount || 0) * rate,
                subtotal: (pos.subtotal || 0) * rate,
                discountAmount: (pos.discountAmount || 0) * rate,
                taxAmount: (pos.taxAmount || 0) * rate,
                invoiceitem: (pos.posinvoiceitem || []).map(item => ({
                    id: item.id,
                    productId: item.productId,
                    product: item.product,
                    description: item.product?.name || item.description || 'POS Item',
                    quantity: item.quantity,
                    rate: (item.rate || 0) * rate,
                    amount: (item.amount || 0) * rate
                }))
            };
        }));

        const convertedReturns = await Promise.all(salesReturns.map(async ret => {
            const rate = await getConversionRate(ret.currency || 'USD', companyCurrency);

            let isPosReturn = false;
            if (ret.customFields) {
                try {
                    const parsedCF = typeof ret.customFields === 'string' ? JSON.parse(ret.customFields) : ret.customFields;
                    if (parsedCF && (parsedCF.isPosInvoice || parsedCF.posInvoiceId || parsedCF.posInvoiceNumber || parsedCF.isPos)) {
                        isPosReturn = true;
                    }
                } catch (e) { }
            }
            if (!isPosReturn && (!ret.invoiceId || (ret.notes && ret.notes.toLowerCase().includes('pos')))) {
                isPosReturn = true;
            }

            return {
                id: ret.id,
                invoiceNumber: ret.returnNumber,
                date: ret.date,
                type: isPosReturn ? 'POS_RETURN' : 'RETURN',
                isReturn: true,
                isPosReturn: isPosReturn,
                customer: ret.customer,
                status: ret.status || 'RETURNED',
                totalAmount: (ret.totalAmount || 0) * rate,
                paidAmount: (ret.totalAmount || 0) * rate,
                balanceAmount: 0,
                subtotal: (ret.subtotal || ret.totalAmount || 0) * rate,
                discountAmount: (ret.discountAmount || 0) * rate,
                taxAmount: (ret.taxAmount || 0) * rate,
                invoiceitem: (ret.salesreturnitem || []).map(item => ({
                    id: item.id,
                    productId: item.productId,
                    product: item.product,
                    description: item.product?.name || 'Returned Item',
                    quantity: item.quantity,
                    rate: (item.rate || 0) * rate,
                    amount: (item.amount || 0) * rate,
                    warehouse: item.warehouse
                }))
            };
        }));

        const allSales = [...convertedSales, ...convertedPosSales];
        const combinedData = [...allSales, ...convertedReturns].sort((a, b) => new Date(b.date) - new Date(a.date));

        const summary = {
            totalSales: 0,
            totalReturns: 0,
            netRevenue: 0,
            totalAmount: 0,
            totalPaid: 0,
            totalUnpaid: 0,
            overdue: 0
        };

        allSales.forEach(inv => {
            const total = inv.totalAmount || 0;
            const unpaid = inv.balanceAmount || 0;
            const paid = total - unpaid;

            summary.totalSales += total;
            summary.totalAmount += total;
            summary.totalPaid += paid;
            summary.totalUnpaid += unpaid;

            if (inv.dueDate && new Date(inv.dueDate) < now && unpaid > 0) {
                summary.overdue += unpaid;
            }
        });

        convertedReturns.forEach(ret => {
            summary.totalReturns += ret.totalAmount || 0;
        });

        summary.netRevenue = summary.totalSales - summary.totalReturns;

        res.status(200).json({ success: true, data: combinedData, summary });

    } catch (error) {
        console.error('Error fetching sales report:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

const getSalesByItemReport = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        const { startDate, endDate } = req.query;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        let dateFilter = {};
        if (startDate && endDate) {
            dateFilter = {
                gte: new Date(startDate),
                lte: toEndOfDay(endDate)
            };
        }

        const invoiceItems = await prisma.invoiceitem.findMany({
            where: {
                invoice: { companyId: parseInt(companyId), date: dateFilter }
            },
            include: {
                product: { include: { category: true } },
                invoice: { select: { date: true, invoiceNumber: true, exchangeRate: true, currency: true } }
            }
        });

        const companyCurrency = await getCompanyCurrency(companyId);
        const grouped = {};
        for (const item of invoiceItems) {
            const productId = item.productId || 'service-' + (item.serviceId || 'unknown');
            const productName = item.product?.name || item.description || 'Unknown';
            const rate = await getConversionRate(item.invoice?.currency || 'USD', companyCurrency);

            if (!grouped[productId]) {
                grouped[productId] = {
                    productId,
                    productName,
                    sku: item.product?.sku || '-',
                    category: item.product?.category?.name || 'Uncategorized',
                    totalQty: 0,
                    totalAmount: 0,
                    invoiceCount: 0,
                    invoiceIds: new Set()
                };
            }
            grouped[productId].invoiceIds.add(item.invoiceId);
            grouped[productId].totalQty += item.quantity;
            grouped[productId].totalAmount += item.amount * rate;
        }

        const result = Object.values(grouped).map(({ invoiceIds, ...item }) => ({
            ...item,
            invoiceCount: invoiceIds.size,
            avgRate: item.totalQty > 0 ? (item.totalAmount / item.totalQty).toFixed(2) : 0
        }));

        res.status(200).json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const getSalesByCustomerReport = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        const { startDate, endDate } = req.query;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        let dateFilter = {};
        if (startDate && endDate) {
            dateFilter = {
                gte: new Date(startDate),
                lte: toEndOfDay(endDate)
            };
        }

        const invoices = await prisma.invoice.findMany({
            where: { companyId: parseInt(companyId), date: dateFilter },
            include: { customer: true }
        });

        const posInvoices = await prisma.posinvoice.findMany({
            where: { companyId: parseInt(companyId), date: dateFilter },
            include: { customer: true }
        });

        const allInvoices = [...invoices, ...posInvoices];

        const companyCurrency = await getCompanyCurrency(companyId);
        const grouped = {};
        for (const inv of allInvoices) {
            const customerId = inv.customerId || 'walk-in';
            const customerName = inv.customer?.name || 'Walk-in Customer';
            const rate = await getConversionRate(inv.currency || 'USD', companyCurrency);

            if (!grouped[customerId]) {
                grouped[customerId] = {
                    customerId,
                    customerName,
                    totalInvoices: 0,
                    totalSales: 0,
                    totalPaid: 0,
                    totalPending: 0
                };
            }
            grouped[customerId].totalInvoices += 1;
            grouped[customerId].totalSales += inv.totalAmount * rate;
            grouped[customerId].totalPaid += (inv.paidAmount || 0) * rate;
            grouped[customerId].totalPending += (inv.balanceAmount || 0) * rate;
        }

        res.status(200).json({ success: true, data: Object.values(grouped) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const getSalesBySalesmanReport = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        const { startDate, endDate } = req.query;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        let dateFilter = {};
        if (startDate && endDate) {
            dateFilter = { gte: new Date(startDate), lte: toEndOfDay(endDate) };
        }

        const invoices = await prisma.invoice.findMany({
            where: { companyId: parseInt(companyId), date: dateFilter }
        });

        const posInvoices = await prisma.posinvoice.findMany({
            where: { companyId: parseInt(companyId), date: dateFilter }
        });

        const allInvoices = [...invoices, ...posInvoices];
        const companyCurrency = await getCompanyCurrency(companyId);
        const grouped = {};
        for (const inv of allInvoices) {
            const salesman = '';
            const rate = await getConversionRate(inv.currency || 'USD', companyCurrency);
            if (!grouped[salesman]) {
                grouped[salesman] = { salesman, totalInvoices: 0, totalSales: 0, totalPaid: 0, totalPending: 0 };
            }
            grouped[salesman].totalInvoices += 1;
            grouped[salesman].totalSales += inv.totalAmount * rate;
            grouped[salesman].totalPaid += (inv.paidAmount || 0) * rate;
            grouped[salesman].totalPending += (inv.balanceAmount || 0) * rate;
        }

        res.status(200).json({ success: true, data: Object.values(grouped) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const getPurchaseReport = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;

        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }

        const { startDate, endDate, transactionFilter } = req.query; // 'ALL', 'PURCHASE', 'RETURNS'

        let whereClause = {
            companyId: parseInt(companyId)
        };

        if (startDate && endDate) {
            whereClause.date = {
                gte: new Date(startDate),
                lte: toEndOfDay(endDate)
            };
        }

        let purchaseReport = [];
        if (!transactionFilter || transactionFilter === 'ALL' || transactionFilter === 'PURCHASE') {
            purchaseReport = await prisma.purchasebill.findMany({
                where: whereClause,
                include: {
                    vendor: {
                        select: {
                            name: true,
                            email: true
                        }
                    },
                    salesperson: {
                        select: {
                            id: true,
                            name: true
                        }
                    },
                    purchasebillitem: {
                        include: {
                            product: {
                                include: {
                                    category: true,
                                    stock: true
                                }
                            },
                            warehouse: true
                        }
                    }
                },
                orderBy: {
                    date: 'desc'
                }
            });
        }

        let purchaseReturns = [];
        if (!transactionFilter || transactionFilter === 'ALL' || transactionFilter === 'RETURNS') {
            purchaseReturns = await prisma.purchasereturn.findMany({
                where: whereClause,
                include: {
                    vendor: {
                        select: {
                            name: true,
                            email: true
                        }
                    },
                    purchasebill: {
                        select: {
                            billNumber: true
                        }
                    },
                    purchasereturnitem: {
                        include: {
                            product: {
                                include: {
                                    category: true,
                                    stock: true
                                }
                            },
                            warehouse: true
                        }
                    }
                },
                orderBy: {
                    date: 'desc'
                }
            });
        }

        // Convert to Base Currency
        const companyCurrency = await getCompanyCurrency(companyId);
        const convertedPurchaseBills = await Promise.all(purchaseReport.map(async bill => {
            const rate = await getConversionRate(bill.currency || 'USD', companyCurrency);
            return {
                ...bill,
                type: 'PURCHASE',
                isReturn: false,
                subtotal: (bill.subtotal || 0) * rate,
                discountAmount: (bill.discountAmount || 0) * rate,
                taxAmount: (bill.taxAmount || 0) * rate,
                totalAmount: (bill.totalAmount || 0) * rate,
                paidAmount: ((bill.totalAmount || 0) - (bill.balanceAmount || 0)) * rate,
                balanceAmount: (bill.balanceAmount || 0) * rate,
                purchasebillitem: bill.purchasebillitem.map(item => ({
                    ...item,
                    rate: (item.rate || 0) * rate,
                    amount: (item.amount || 0) * rate
                }))
            };
        }));

        const convertedReturns = await Promise.all(purchaseReturns.map(async ret => {
            const rate = await getConversionRate(ret.currency || 'USD', companyCurrency);
            return {
                id: ret.id,
                billNumber: ret.returnNumber,
                date: ret.date,
                type: 'RETURN',
                isReturn: true,
                vendor: ret.vendor,
                status: ret.status || 'RETURNED',
                totalAmount: (ret.totalAmount || 0) * rate,
                paidAmount: (ret.totalAmount || 0) * rate,
                balanceAmount: 0,
                subtotal: (ret.subtotal || ret.totalAmount || 0) * rate,
                discountAmount: (ret.discountAmount || 0) * rate,
                taxAmount: (ret.taxAmount || 0) * rate,
                purchasebillitem: (ret.purchasereturnitem || []).map(item => ({
                    id: item.id,
                    productId: item.productId,
                    product: item.product,
                    description: item.product?.name || 'Returned Item',
                    quantity: item.quantity,
                    rate: (item.rate || 0) * rate,
                    amount: (item.amount || 0) * rate,
                    warehouse: item.warehouse
                }))
            };
        }));

        const combinedData = [...convertedPurchaseBills, ...convertedReturns].sort((a, b) => new Date(b.date) - new Date(a.date));

        // Calculate Summary Stats
        const now = new Date();
        const summary = {
            totalPurchases: 0,
            totalReturns: 0,
            netPurchase: 0,
            totalAmount: 0,
            totalPaid: 0,
            totalUnpaid: 0,
            overdue: 0
        };

        convertedPurchaseBills.forEach(bill => {
            const total = bill.totalAmount || 0;
            const unpaid = bill.balanceAmount || 0;
            const paid = total - unpaid;

            summary.totalPurchases += total;
            summary.totalAmount += total;
            summary.totalPaid += paid;
            summary.totalUnpaid += unpaid;

            if (bill.dueDate && new Date(bill.dueDate) < now && unpaid > 0) {
                summary.overdue += unpaid;
            }
        });

        convertedReturns.forEach(ret => {
            summary.totalReturns += ret.totalAmount || 0;
        });

        summary.netPurchase = summary.totalPurchases - summary.totalReturns;

        res.status(200).json({ success: true, data: combinedData, summary });
    } catch (error) {
        console.error('Error fetching purchase report:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

const getPurchaseByItemReport = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        const { startDate, endDate } = req.query;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        let dateFilter = {};
        if (startDate && endDate) {
            dateFilter = {
                gte: new Date(startDate),
                lte: toEndOfDay(endDate)
            };
        }

        const billItems = await prisma.purchasebillitem.findMany({
            where: {
                purchasebill: { companyId: parseInt(companyId), date: dateFilter }
            },
            include: {
                product: { include: { category: true } },
                purchasebill: { select: { date: true, billNumber: true, exchangeRate: true, currency: true } }
            }
        });

        const companyCurrency = await getCompanyCurrency(companyId);
        const grouped = {};
        for (const item of billItems) {
            const productId = item.productId || 'unknown';
            const productName = item.product?.name || item.description || 'Unknown';
            const rate = await getConversionRate(item.purchasebill?.currency || 'USD', companyCurrency);

            if (!grouped[productId]) {
                grouped[productId] = {
                    productId,
                    productName,
                    sku: item.product?.sku || '-',
                    category: item.product?.category?.name || 'Uncategorized',
                    totalQty: 0,
                    totalAmount: 0,
                    billCount: 0,
                    billIds: new Set()
                };
            }
            grouped[productId].billIds.add(item.purchaseBillId);
            grouped[productId].totalQty += item.quantity;
            grouped[productId].totalAmount += item.amount * rate;
        }

        const result = Object.values(grouped).map(({ billIds, ...item }) => ({
            ...item,
            billCount: billIds.size,
            avgRate: item.totalQty > 0 ? (item.totalAmount / item.totalQty).toFixed(2) : 0
        }));

        res.status(200).json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const getPurchaseByVendorReport = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        const { startDate, endDate } = req.query;

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        let dateFilter = {};
        if (startDate && endDate) {
            dateFilter = {
                gte: new Date(startDate),
                lte: toEndOfDay(endDate)
            };
        }

        const bills = await prisma.purchasebill.findMany({
            where: { companyId: parseInt(companyId), date: dateFilter },
            include: { vendor: true }
        });

        const companyCurrency = await getCompanyCurrency(companyId);
        const grouped = {};
        for (const bill of bills) {
            const vendorId = bill.vendorId || 'unknown';
            const vendorName = bill.vendor?.name || 'Unknown Vendor';
            const rate = await getConversionRate(bill.currency || 'USD', companyCurrency);

            if (!grouped[vendorId]) {
                grouped[vendorId] = {
                    vendorId,
                    vendorName,
                    totalBills: 0,
                    totalPurchases: 0,
                    totalPaid: 0,
                    totalPending: 0
                };
            }
            grouped[vendorId].totalBills += 1;
            grouped[vendorId].totalPurchases += bill.totalAmount * rate;
            grouped[vendorId].totalPaid += (bill.totalAmount - bill.balanceAmount) * rate;
            grouped[vendorId].totalPending += bill.balanceAmount * rate;
        }

        res.status(200).json({ success: true, data: Object.values(grouped) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const getPosReport = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        const { startDate, endDate, transactionFilter } = req.query; // 'ALL', 'SALES', 'RETURNS'
        let whereClause = { companyId: parseInt(companyId) };

        if (startDate && endDate) {
            whereClause.date = {
                gte: new Date(startDate),
                lte: toEndOfDay(endDate)
            };
        }

        let posReport = [];
        if (!transactionFilter || transactionFilter === 'ALL' || transactionFilter === 'SALES') {
            posReport = await prisma.posinvoice.findMany({
                where: whereClause,
                include: {
                    customer: { select: { name: true, nameArabic: true } },
                    posinvoiceitem: {
                        include: {
                            product: { include: { category: true } }
                        }
                    }
                },
                orderBy: { date: 'desc' }
            });
        }

        let posReturns = [];
        if (!transactionFilter || transactionFilter === 'ALL' || transactionFilter === 'RETURNS') {
            posReturns = await prisma.salesreturn.findMany({
                where: whereClause,
                include: {
                    customer: { select: { name: true, nameArabic: true } },
                    salesreturnitem: {
                        include: {
                            product: { include: { category: true } }
                        }
                    }
                },
                orderBy: { date: 'desc' }
            });
        }

        const companyCurrency = await getCompanyCurrency(companyId);
        const histCurr = await getCompanyHistoricalCurrency(companyId);

        const convertedSales = [];
        for (const inv of posReport) {
            const rate = await getConversionRate(inv.currency || histCurr, companyCurrency);
            convertedSales.push({
                ...inv,
                type: 'SALE',
                isReturn: false,
                totalAmount: (inv.totalAmount || 0) * rate,
                paidAmount: (inv.paidAmount || 0) * rate,
                balanceAmount: (inv.balanceAmount || 0) * rate,
                taxAmount: (inv.taxAmount || 0) * rate,
                posinvoiceitem: (inv.posinvoiceitem || []).map(item => ({
                    ...item,
                    rate: (item.rate || 0) * rate,
                    amount: (item.amount || 0) * rate
                }))
            });
        }

        const convertedReturns = [];
        for (const ret of posReturns) {
            const rate = await getConversionRate(ret.currency || histCurr, companyCurrency);
            convertedReturns.push({
                id: ret.id,
                invoiceNumber: ret.returnNumber,
                createdAt: ret.date || ret.createdAt,
                type: 'RETURN',
                isReturn: true,
                customer: ret.customer,
                paymentMode: ret.refundMethod || 'RETURN',
                status: ret.status || 'RETURNED',
                totalAmount: (ret.totalAmount || 0) * rate,
                paidAmount: (ret.totalAmount || 0) * rate,
                balanceAmount: 0,
                taxAmount: (ret.taxAmount || 0) * rate,
                posinvoiceitem: (ret.salesreturnitem || []).map(item => ({
                    id: item.id,
                    productId: item.productId,
                    product: item.product,
                    description: item.product?.name || 'Returned Item',
                    quantity: item.quantity,
                    rate: (item.rate || 0) * rate,
                    amount: (item.amount || 0) * rate
                }))
            });
        }

        const combinedData = [...convertedSales, ...convertedReturns].sort((a, b) => new Date(b.createdAt || b.date) - new Date(a.createdAt || a.date));

        const summary = {
            totalSales: 0,
            totalReturns: 0,
            netSales: 0,
            totalCash: 0,
            totalCard: 0,
            totalUPI: 0,
            totalOther: 0
        };

        convertedSales.forEach(inv => {
            const total = inv.totalAmount || 0;
            summary.totalSales += total;
            const mode = (inv.paymentMode || 'CASH').toUpperCase();
            if (mode === 'CASH') summary.totalCash += total;
            else if (mode === 'CARD') summary.totalCard += total;
            else if (mode === 'UPI') summary.totalUPI += total;
            else summary.totalOther += total;
        });

        convertedReturns.forEach(ret => {
            summary.totalReturns += ret.totalAmount || 0;
        });

        summary.netSales = summary.totalSales - summary.totalReturns;

        res.status(200).json({ success: true, data: combinedData, summary });
    } catch (error) {
        console.error('Error fetching POS report:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

// Get Tax Report (Monthly Breakdown + Date Range Filter)
const getTaxReport = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        const { startDate: qStart, endDate: qEnd, year: qYear } = req.query;
        let startDate, endDate, year;

        if (qStart && qEnd) {
            startDate = new Date(qStart);
            endDate = toEndOfDay(qEnd);
            year = startDate.getFullYear();
        } else {
            year = parseInt(qYear) || new Date().getFullYear();
            startDate = new Date(`${year}-01-01`);
            endDate = toEndOfDay(`${year}-12-31`);
        }

        // Fetch Company Details for State comparison
        const company = await prisma.company.findUnique({
            where: { id: parseInt(companyId) },
            select: { state: true }
        });
        const companyState = company?.state?.toLowerCase().trim();

        // --- 1. INCOME TAX (Sales + POS) ---
        // Fetch Invoices
        const invoices = await prisma.invoice.findMany({
            where: {
                companyId: parseInt(companyId),
                date: {
                    gte: startDate,
                    lte: endDate
                }
            },
            include: { customer: { select: { billingState: true } }, invoiceitem: true }
        });

        // Fetch POS Invoices (Assume Intra-state/CGST+SGST for simplicity unless customer is tagged)
        const posInvoices = await prisma.posinvoice.findMany({
            where: {
                companyId: parseInt(companyId),
                date: {
                    gte: startDate,
                    lte: endDate
                }
            },
            include: { customer: { select: { billingState: true } } }
        });

        const incomeStats = {
            CGST: Array(12).fill(0),
            SGST: Array(12).fill(0),
            IGST: Array(12).fill(0)
        };

        const companyCurrency = await getCompanyCurrency(companyId);
        const histCurr = await getCompanyHistoricalCurrency(companyId);

        const processTax = (amount, date, entityState, targetStats, rate = 1.0) => {
            const month = new Date(date).getMonth(); // 0-11
            const tax = parseFloat(amount || 0) * rate;

            if (tax > 0) {
                // Determine Tax Type
                let isInterState = false;
                if (companyState && entityState) {
                    isInterState = companyState !== entityState.toLowerCase().trim();
                }

                if (isInterState) {
                    targetStats.IGST[month] += tax;
                } else {
                    // Split 50-50
                    targetStats.CGST[month] += tax / 2;
                    targetStats.SGST[month] += tax / 2;
                }
            }
        };

        for (const inv of invoices) {
            const rate = await getConversionRate(inv.currency || 'USD', companyCurrency);
            const month = new Date(inv.date).getMonth();
            const items = inv.invoiceitem || [];
            const hasDetailedGst = items.some(i => (i.cgstAmount || 0) > 0 || (i.sgstAmount || 0) > 0 || (i.igstAmount || 0) > 0);

            if (hasDetailedGst) {
                for (const item of items) {
                    incomeStats.CGST[month] += (item.cgstAmount || 0) * rate;
                    incomeStats.SGST[month] += (item.sgstAmount || 0) * rate;
                    incomeStats.IGST[month] += (item.igstAmount || 0) * rate;
                }
            } else {
                processTax(inv.taxAmount, inv.date, inv.customer?.billingState, incomeStats, rate);
            }
        }

        for (const pos of posInvoices) {
            const rate = await getConversionRate(pos.currency || histCurr, companyCurrency);
            processTax(pos.taxAmount, pos.date || pos.createdAt, pos.customer?.billingState || companyState, incomeStats, rate);
        }

        // --- 2. EXPENSE TAX (Purchases) ---
        const bills = await prisma.purchasebill.findMany({
            where: {
                companyId: parseInt(companyId),
                date: {
                    gte: startDate,
                    lte: endDate
                }
            },
            include: { vendor: { select: { billingState: true } }, purchasebillitem: true }
        });

        const expenseStats = {
            CGST: Array(12).fill(0),
            SGST: Array(12).fill(0),
            IGST: Array(12).fill(0)
        };

        for (const bill of bills) {
            const rate = await getConversionRate(bill.currency || 'USD', companyCurrency);
            const month = new Date(bill.date).getMonth();
            const items = bill.purchasebillitem || [];
            const hasDetailedGst = items.some(i => (i.cgstAmount || 0) > 0 || (i.sgstAmount || 0) > 0 || (i.igstAmount || 0) > 0);

            if (hasDetailedGst) {
                for (const item of items) {
                    expenseStats.CGST[month] += (item.cgstAmount || 0) * rate;
                    expenseStats.SGST[month] += (item.sgstAmount || 0) * rate;
                    expenseStats.IGST[month] += (item.igstAmount || 0) * rate;
                }
            } else {
                processTax(bill.taxAmount, bill.date, bill.vendor?.billingState, expenseStats, rate);
            }
        }

        res.status(200).json({
            success: true,
            data: {
                income: incomeStats,
                expense: expenseStats
            }
        });

    } catch (error) {
        console.error('Error fetching Tax report:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

// Get Inventory Summary
const getInventorySummary = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        const { startDate, endDate, warehouseId } = req.query;

        // Get All Stocks with product metadata & uoms
        const stockWhere = { product: { companyId: parseInt(companyId) } };
        if (warehouseId && warehouseId !== 'ALL') {
            stockWhere.warehouseId = parseInt(warehouseId);
        }

        const stocks = await prisma.stock.findMany({
            where: stockWhere,
            include: {
                product: {
                    include: {
                        category: true,
                        uom: true
                    }
                },
                warehouse: true
            }
        });

        // Get All Transactions
        const txWhere = { companyId: parseInt(companyId) };
        if (warehouseId && warehouseId !== 'ALL') {
            txWhere.OR = [
                { fromWarehouseId: parseInt(warehouseId) },
                { toWarehouseId: parseInt(warehouseId) }
            ];
        }
        const transactions = await prisma.inventorytransaction.findMany({
            where: txWhere,
            orderBy: { date: 'asc' }
        });

        const companyCurrency = await getCompanyCurrency(companyId);
        const histCurr = await getCompanyHistoricalCurrency(companyId);
        const rate = await getConversionRate(histCurr, companyCurrency);

        // Map data per product-warehouse key
        const reportMap = {};

        // Initialize from Stock (Current Closing)
        stocks.forEach(stk => {
            const key = `${stk.productId}-${stk.warehouseId}`;
            const p = stk.product || {};
            reportMap[key] = {
                id: stk.id,
                productId: stk.productId,
                productName: p.name || 'Unknown Item',
                sku: p.sku || 'N/A',
                hsn: p.hsn || 'N/A',
                barcode: p.barcode || 'N/A',
                unit: p.uom?.name || p.unit || 'Pcs',
                category: p.category?.name || 'Uncategorized',
                warehouseId: stk.warehouseId,
                warehouse: stk.warehouse?.name || 'Main Warehouse',
                salePrice: (p.salePrice || 0) * rate,
                purchasePrice: (p.purchasePrice || 0) * rate,
                averageCost: (p.averageCost || 0) * rate,
                initialCost: (p.initialCost || 0) * rate,
                costPrice: (p.averageCost || p.purchasePrice || p.initialCost || 0) * rate,
                price: (p.salePrice || 0) * rate,
                closing: stk.quantity,
                opening: 0,
                initialStock: 0,
                inward: 0,
                outward: 0,
                // Channel breakdown counters
                salesInvoiceQty: 0,
                posQty: 0,
                purchaseBillQty: 0,
                salesReturnQty: 0,
                purchaseReturnQty: 0,
                transferInQty: 0,
                transferOutQty: 0,
                adjustmentQty: 0,
                minOrderQty: parseFloat(stk.minOrderQty || p.minOrderQty || p.minStockLevel || p.reorderLevel || 10),
                status: 'In Stock'
            };
        });

        // Parse date filters
        const start = startDate ? new Date(startDate) : null;
        const end = endDate ? new Date(endDate) : null;

        transactions.forEach(txn => {
            const rLower = (txn.reason || '').toLowerCase();
            if (rLower.includes('stock reversal') || rLower.includes('edited (stock reversal)') || rLower.includes('void items on update pos')) {
                return;
            }
            const txnDate = new Date(txn.date);
            const isOpeningStockTxn = rLower.includes('opening') || rLower.includes('initial') || txn.type === 'OPENING_STOCK';

            // Handle OUT from warehouse
            if (txn.fromWarehouseId) {
                if (warehouseId && warehouseId !== 'ALL' && txn.fromWarehouseId !== parseInt(warehouseId)) {
                    // skip
                } else {
                    const key = `${txn.productId}-${txn.fromWarehouseId}`;
                    if (reportMap[key]) {
                        if (end && txnDate > end) {
                            reportMap[key].closing += txn.quantity;
                        } else if ((!start || txnDate >= start) && (!end || txnDate <= end)) {
                            reportMap[key].outward += txn.quantity;

                            // Channel categorization
                            if (rLower.includes('pos')) {
                                reportMap[key].posQty += txn.quantity;
                            } else if (rLower.includes('sales invoice') || rLower.includes('inv-')) {
                                reportMap[key].salesInvoiceQty += txn.quantity;
                            } else if (rLower.includes('purchase return') || rLower.includes('vendor return')) {
                                reportMap[key].purchaseReturnQty += txn.quantity;
                            } else if (rLower.includes('transfer')) {
                                reportMap[key].transferOutQty += txn.quantity;
                            } else if (rLower.includes('adjustment')) {
                                reportMap[key].adjustmentQty -= txn.quantity;
                            } else {
                                reportMap[key].salesInvoiceQty += txn.quantity;
                            }
                        }
                    }
                }
            }

            // Handle IN to warehouse
            if (txn.toWarehouseId) {
                if (warehouseId && warehouseId !== 'ALL' && txn.toWarehouseId !== parseInt(warehouseId)) {
                    // skip
                } else {
                    const key = `${txn.productId}-${txn.toWarehouseId}`;
                    if (reportMap[key]) {
                        if (end && txnDate > end) {
                            reportMap[key].closing -= txn.quantity;
                        } else if ((!start || txnDate >= start) && (!end || txnDate <= end)) {
                            if (isOpeningStockTxn) {
                                reportMap[key].initialStock += txn.quantity;
                            } else {
                                reportMap[key].inward += txn.quantity;

                                // Channel categorization
                                if (rLower.includes('purchase bill') || rLower.includes('grn') || rLower.includes('bill-')) {
                                    reportMap[key].purchaseBillQty += txn.quantity;
                                } else if (rLower.includes('sales return') || rLower.includes('customer return')) {
                                    reportMap[key].salesReturnQty += txn.quantity;
                                } else if (rLower.includes('transfer')) {
                                    reportMap[key].transferInQty += txn.quantity;
                                } else if (rLower.includes('adjustment')) {
                                    reportMap[key].adjustmentQty += txn.quantity;
                                } else {
                                    reportMap[key].purchaseBillQty += txn.quantity;
                                }
                            }
                        }
                    }
                }
            }
        });

        // Compute Opening & Values
        const rawList = Object.values(reportMap);
        rawList.forEach(item => {
            if (start) {
                item.opening = item.closing - item.inward + item.outward;
            } else {
                item.opening = item.initialStock || Math.max(0, item.closing - item.inward + item.outward);
            }
            item.openingValue = item.opening * item.costPrice;
            item.inwardValue = item.inward * item.costPrice;
            item.outwardValue = item.outward * item.costPrice;
            item.totalValue = item.closing * item.costPrice; // Cost-based valuation
            item.salesValue = item.closing * item.salePrice; // Retail-based valuation

            const threshold = parseFloat(item.minOrderQty) || 10;
            if (item.closing <= 0) item.status = 'Out of Stock';
            else if (item.closing < threshold) item.status = 'Low Stock';
            else item.status = 'In Stock';
        });

        // Build Consolidated Item-Wise View across warehouses
        const itemConsolidatedMap = {};
        rawList.forEach(stk => {
            const pid = stk.productId;
            if (!itemConsolidatedMap[pid]) {
                itemConsolidatedMap[pid] = {
                    productId: pid,
                    productName: stk.productName,
                    sku: stk.sku,
                    hsn: stk.hsn,
                    barcode: stk.barcode,
                    unit: stk.unit,
                    category: stk.category,
                    salePrice: stk.salePrice,
                    purchasePrice: stk.purchasePrice,
                    averageCost: stk.averageCost,
                    initialCost: stk.initialCost,
                    costPrice: stk.costPrice,
                    minOrderQty: stk.minOrderQty,
                    opening: 0,
                    inward: 0,
                    outward: 0,
                    closing: 0,
                    salesInvoiceQty: 0,
                    posQty: 0,
                    purchaseBillQty: 0,
                    salesReturnQty: 0,
                    purchaseReturnQty: 0,
                    transferInQty: 0,
                    transferOutQty: 0,
                    adjustmentQty: 0,
                    openingValue: 0,
                    inwardValue: 0,
                    outwardValue: 0,
                    totalValue: 0,
                    salesValue: 0,
                    warehouses: []
                };
            }

            const c = itemConsolidatedMap[pid];
            c.opening += stk.opening;
            c.inward += stk.inward;
            c.outward += stk.outward;
            c.closing += stk.closing;
            c.salesInvoiceQty += stk.salesInvoiceQty;
            c.posQty += stk.posQty;
            c.purchaseBillQty += stk.purchaseBillQty;
            c.salesReturnQty += stk.salesReturnQty;
            c.purchaseReturnQty += stk.purchaseReturnQty;
            c.transferInQty += stk.transferInQty;
            c.transferOutQty += stk.transferOutQty;
            c.adjustmentQty += stk.adjustmentQty;
            c.openingValue += stk.openingValue;
            c.inwardValue += stk.inwardValue;
            c.outwardValue += stk.outwardValue;
            c.totalValue += stk.totalValue;
            c.salesValue += stk.salesValue;

            c.warehouses.push({
                warehouseId: stk.warehouseId,
                warehouseName: stk.warehouse,
                opening: stk.opening,
                inward: stk.inward,
                outward: stk.outward,
                closing: stk.closing,
                totalValue: stk.totalValue,
                status: stk.status
            });
        });

        Object.values(itemConsolidatedMap).forEach(item => {
            const threshold = parseFloat(item.minOrderQty) || 10;
            if (item.closing <= 0) item.status = 'Out of Stock';
            else if (item.closing < threshold) item.status = 'Low Stock';
            else item.status = 'In Stock';
        });

        res.status(200).json({
            success: true,
            data: rawList,
            itemWise: Object.values(itemConsolidatedMap)
        });

    } catch (error) {
        console.error('Error fetching Inventory Summary:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

// Get Balance Sheet
const getBalanceSheet = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        const asOfDate = req.query.asOfDate ? new Date(req.query.asOfDate) : new Date();

        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        // Ensure date includes end of day
        const endOfDay = new Date(asOfDate);
        endOfDay.setHours(23, 59, 59, 999);

        // 1. Fetch All Ledgers with Groups
        // Filter by createdAt to exclude accounts that didn't exist yet
        const ledgers = await prisma.ledger.findMany({
            where: {
                companyId: parseInt(companyId),
                createdAt: { lte: endOfDay }
            },
            include: { accountgroup: true, accountsubgroup: true }
        });

        // 2. Fetch Transaction Aggregates up to asOfDate
        // We need Sum(amount) grouped by debitLedgerId and creditLedgerId

        const debitSums = await prisma.transaction.groupBy({
            by: ['debitLedgerId'],
            where: {
                companyId: parseInt(companyId),
                date: { lte: endOfDay }
            },
            _sum: { amount: true }
        });

        const creditSums = await prisma.transaction.groupBy({
            by: ['creditLedgerId'],
            where: {
                companyId: parseInt(companyId),
                date: { lte: endOfDay }
            },
            _sum: { amount: true }
        });

        // Helpers
        const getDebit = (id) => debitSums.find(d => d.debitLedgerId === id)?._sum.amount || 0;
        const getCredit = (id) => creditSums.find(c => c.creditLedgerId === id)?._sum.amount || 0;

        const reportData = {
            assets: { current: [], fixed: [], total: 0 },
            liabilities: { current: [], longTerm: [], total: 0 },
            equity: { items: [], total: 0 },
            netProfit: 0
        };

        let totalIncome = 0;
        let totalExpense = 0;

        const companyCurrency = await getCompanyCurrency(companyId);
        const histCurr = await getCompanyHistoricalCurrency(companyId);
        const rate = await getConversionRate(histCurr, companyCurrency);

        // --- Dynamic Inventory Value (real-time: quantity × cost from stock table) ---
        const currentInventoryValue = (await calculateInventoryValue(companyId)) * rate;

        ledgers.forEach(ledger => {
            //  if (ledger.name.toLowerCase().includes('opening balance equity')) {
            //     return;
            // }
            const groupType = ledger.accountgroup?.type;
            const opening = (ledger.openingBalance || 0) * rate;

            // Calculate Balance
            // ASSETS, EXPENSES: Debit normal (Opening + Debits - Credits)
            // LIABILITIES, EQUITY, INCOME: Credit normal (Opening + Credits - Debits)
            let balance = 0;
            if (['ASSETS', 'EXPENSES'].includes(groupType)) {
                balance = opening + (getDebit(ledger.id) - getCredit(ledger.id)) * rate;
            } else {
                balance = opening + (getCredit(ledger.id) - getDebit(ledger.id)) * rate;
            }

            // Only process non-zero balances (Equity accounts should always show in Balance Sheet)
            if (Math.abs(balance) < 0.01 && !ledger.name.toLowerCase().includes('inventory asset') && groupType !== 'EQUITY') return;

            const name = ledger.name;

            if (groupType === 'ASSETS') {
                // Improved Grouping Logic - Robust classification
                const groupName = ledger.accountgroup.name.toLowerCase();
                const currentAssetKeywords = [
                    'current assets',
                    'bank',
                    'cash',
                    'receivable',
                    'debtor',
                    'stock',
                    'inventory',
                    'advance',
                    'deposit',
                    'prepaid'
                ];
                // Force customer ledgers or ledgers with current keywords into Current Assets
                const isCurrent = currentAssetKeywords.some(s => groupName.includes(s) || name.toLowerCase().includes(s)) || ledger.customerId !== null;

                if (isCurrent) {
                    reportData.assets.current.push({ id: ledger.id, ledgerId: ledger.id, name, value: balance });
                } else {
                    // Default to Fixed if not Current
                    reportData.assets.fixed.push({ id: ledger.id, ledgerId: ledger.id, name, value: balance });
                }
                reportData.assets.total += balance;

            } else if (groupType === 'LIABILITIES') {
                const groupName = ledger.accountgroup.name.toLowerCase();
                const currentLiabilityKeywords = [
                    'current liabilities',
                    'payable',
                    'creditor',
                    'duties',
                    'tax',
                    'provision',
                    'overdraft',
                    'short-term',
                    'salary',
                    'expense payable'
                ];
                // Force vendor ledgers or current liability keywords into Current Liabilities
                const isCurrent = currentLiabilityKeywords.some(s => groupName.includes(s) || name.toLowerCase().includes(s)) || ledger.vendorId !== null;

                if (isCurrent) {
                    reportData.liabilities.current.push({ id: ledger.id, name, value: balance });
                } else {
                    // Long Term Liabilities
                    reportData.liabilities.longTerm.push({ id: ledger.id, name, value: balance });
                }
                reportData.liabilities.total += balance;

            } else if (groupType === 'EQUITY') {
                reportData.equity.items.push({ id: ledger.id, name, value: balance });
                reportData.equity.total += balance;

            } else if (groupType === 'INCOME') {
                totalIncome += balance;
            } else if (groupType === 'EXPENSES') {
                totalExpense += balance;
            }
        });

        // 2. Calculate Net Profit/Loss
        // Since COGS is already calculated on every invoice, P&L Net Profit is simply Income - Expense.
        // We do NOT add currentInventoryValue here to avoid double counting stock as direct profit.
        const finalNetProfit = totalIncome - totalExpense;
        reportData.netProfit = finalNetProfit;

        // Add Net Profit to Equity
        reportData.equity.items.push({
            name: 'Current Year Earnings (Net Profit)',
            value: finalNetProfit,
            isProfitLoss: true
        });
        reportData.equity.total += finalNetProfit;

        // 4. Legitimate Opening Balance Equity & Discrepancy Detection
        const hasExplicitObeLedger = reportData.equity.items.some(item => {
            const n = (item.name || '').toLowerCase();
            return n.includes('opening balance equity') || n === 'obe';
        });

        // If no explicit OBE ledger exists, compute legitimate setup OBE from initial setup opening balances
        if (!hasExplicitObeLedger) {
            let assetOpenSum = 0;
            let liabilityOpenSum = 0;
            let equityOpenSum = 0;

            ledgers.forEach(l => {
                const open = (parseFloat(l.openingBalance || 0)) * rate;
                const gType = l.accountgroup?.type;
                if (gType === 'ASSETS') assetOpenSum += open;
                else if (gType === 'LIABILITIES') liabilityOpenSum += open;
                else if (gType === 'EQUITY') equityOpenSum += open;
            });

            const setupOBE = assetOpenSum - liabilityOpenSum - equityOpenSum;
            if (Math.abs(setupOBE) > 0.001) {
                reportData.equity.items.push({
                    name: 'Opening Balance Equity',
                    value: setupOBE
                });
                reportData.equity.total += setupOBE;
            }
        }

        // Calculate total sums for Assets, Liabilities, and Equity
        reportData.assets.total = reportData.assets.current.reduce((sum, item) => sum + item.value, 0) + reportData.assets.fixed.reduce((sum, item) => sum + item.value, 0);
        reportData.liabilities.total = reportData.liabilities.current.reduce((sum, item) => sum + item.value, 0) + reportData.liabilities.longTerm.reduce((sum, item) => sum + item.value, 0);
        reportData.equity.total = reportData.equity.items.reduce((sum, item) => sum + item.value, 0);

        // Calculate imbalance / posting discrepancy
        // Assets = Liabilities + Total Equity
        const discrepancy = reportData.assets.total - (reportData.liabilities.total + reportData.equity.total);

        reportData.discrepancy = Math.abs(discrepancy) > 0.01 ? Math.round(discrepancy * 100) / 100 : 0;

        if (Math.abs(discrepancy) > 0.01) {
            reportData.equity.items.push({
                name: 'Unreconciled Imbalance / Discrepancy',
                value: discrepancy,
                isDiscrepancy: true
            });
            reportData.equity.total += discrepancy;
        }

        res.status(200).json({ success: true, data: reportData });

    } catch (error) {
        console.error('Error fetching Balance Sheet:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

// Get Cash Flow Statement (Standard GAAP: Operating, Investing, Financing Activities)
const getCashFlowStatement = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        const year = parseInt(req.query.year) || new Date().getFullYear();
        const companyCurrency = await getCompanyCurrency(companyId);

        // Fetch Cash and Bank Ledgers for Company
        const allCompanyLedgers = await prisma.ledger.findMany({
            where: { companyId: parseInt(companyId) },
            select: { id: true, name: true, openingBalance: true, accountgroup: { select: { name: true, type: true } } }
        });

        const cashBankLedgers = allCompanyLedgers.filter(l => {
            const groupName = l.accountgroup?.name?.toLowerCase() || '';
            const ledgerName = l.name?.toLowerCase() || '';
            return groupName.includes('bank') || groupName.includes('cash') || ledgerName.includes('cash') || ledgerName.includes('bank');
        });

        const cashBankLedgerIds = new Set(cashBankLedgers.map(l => l.id));

        // Calculate Opening Cash Balance before Jan 1 of the target year
        let openingCash = 0;
        for (const ledger of cashBankLedgers) {
            const isDebit = ledger.accountgroup?.type === 'ASSETS' || ledger.accountgroup?.type === 'EXPENSES';
            const ob = (ledger.openingBalance || 0) * (isDebit ? 1 : -1);

            // Fetch receipts prior to start of year for this bank account
            const priorReceipts = await prisma.receipt.aggregate({
                where: {
                    cashBankAccountId: ledger.id,
                    date: { lt: new Date(`${year}-01-01`) },
                    companyId: parseInt(companyId)
                },
                _sum: { amount: true }
            });

            // Fetch payments prior to start of year for this bank account
            const priorPayments = await prisma.payment.aggregate({
                where: {
                    cashBankAccountId: ledger.id,
                    date: { lt: new Date(`${year}-01-01`) },
                    companyId: parseInt(companyId)
                },
                _sum: { amount: true }
            });

            const netPrior = (priorReceipts._sum.amount || 0) - (priorPayments._sum.amount || 0);
            openingCash += (ob + netPrior);
        }

        // Initialize 12-month activity trackers
        const operatingInflows = Array(12).fill(0);
        const operatingOutflows = Array(12).fill(0);
        const investingInflows = Array(12).fill(0);
        const investingOutflows = Array(12).fill(0);
        const financingInflows = Array(12).fill(0);
        const financingOutflows = Array(12).fill(0);

        // Legacy tracker arrays
        const receiptsArr = Array(12).fill(0);
        const paymentsArr = Array(12).fill(0);

        // 1. Process Receipts (Cash Inflows)
        const receipts = await prisma.receipt.findMany({
            where: {
                companyId: parseInt(companyId),
                date: {
                    gte: new Date(`${year}-01-01`),
                    lte: toEndOfDay(`${year}-12-31`)
                }
            },
            include: { cashBankAccount: { include: { accountgroup: true } } }
        });

        for (const item of receipts) {
            const d = new Date(item.date);
            const month = d.getMonth();
            const rate = await getConversionRate(item.currency || 'USD', companyCurrency);
            const val = (item.amount || 0) * rate;

            receiptsArr[month] += val;

            const groupName = item.cashBankAccount?.accountgroup?.name?.toLowerCase() || '';
            const groupType = item.cashBankAccount?.accountgroup?.type || '';

            if (groupType === 'LIABILITIES' && (groupName.includes('loan') || groupName.includes('borrowing'))) {
                financingInflows[month] += val;
            } else if (groupType === 'EQUITY' || groupName.includes('capital') || groupName.includes('equity')) {
                financingInflows[month] += val;
            } else if (groupType === 'ASSETS' && (groupName.includes('fixed') || groupName.includes('property') || groupName.includes('equipment'))) {
                investingInflows[month] += val;
            } else {
                // Default: Operating Customer / Revenue Receipt
                operatingInflows[month] += val;
            }
        }

        // 2. Process Payments (Cash Outflows)
        const payments = await prisma.payment.findMany({
            where: {
                companyId: parseInt(companyId),
                date: {
                    gte: new Date(`${year}-01-01`),
                    lte: toEndOfDay(`${year}-12-31`)
                }
            },
            include: { bankLedger: { include: { accountgroup: true } } }
        });

        for (const item of payments) {
            const d = new Date(item.date);
            const month = d.getMonth();
            const rate = await getConversionRate(item.currency || 'USD', companyCurrency);
            const val = (item.amount || 0) * rate;

            paymentsArr[month] += val;

            const groupName = item.bankLedger?.accountgroup?.name?.toLowerCase() || '';
            const groupType = item.bankLedger?.accountgroup?.type || '';

            if (groupType === 'ASSETS' && (groupName.includes('fixed') || groupName.includes('property') || groupName.includes('equipment') || groupName.includes('machinery') || groupName.includes('vehicle'))) {
                investingOutflows[month] += val;
            } else if (groupType === 'LIABILITIES' && (groupName.includes('loan') || groupName.includes('borrowing') || groupName.includes('debt'))) {
                financingOutflows[month] += val;
            } else if (groupType === 'EQUITY' || groupName.includes('drawing') || groupName.includes('dividend')) {
                financingOutflows[month] += val;
            } else {
                // Default: Operating Supplier / Expense Payment
                operatingOutflows[month] += val;
            }
        }

        // 3. Process Accrual Sales Invoices & Purchase Bills for legacy arrays
        const invoices = await prisma.invoice.findMany({
            where: { companyId: parseInt(companyId), date: { gte: new Date(`${year}-01-01`), lte: toEndOfDay(`${year}-12-31`) } }
        });
        const invoicesArr = Array(12).fill(0);
        for (const item of invoices) {
            const month = new Date(item.date).getMonth();
            const rate = await getConversionRate(item.currency || 'USD', companyCurrency);
            invoicesArr[month] += (item.totalAmount || 0) * rate;
        }

        const bills = await prisma.purchasebill.findMany({
            where: { companyId: parseInt(companyId), date: { gte: new Date(`${year}-01-01`), lte: toEndOfDay(`${year}-12-31`) } }
        });
        const billsArr = Array(12).fill(0);
        for (const item of bills) {
            const month = new Date(item.date).getMonth();
            const rate = await getConversionRate(item.currency || 'USD', companyCurrency);
            billsArr[month] += (item.totalAmount || 0) * rate;
        }

        // Calculate Net Activity arrays & Cumulative Cash Balances
        const operatingNet = operatingInflows.map((inflow, i) => inflow - operatingOutflows[i]);
        const investingNet = investingInflows.map((inflow, i) => inflow - investingOutflows[i]);
        const financingNet = financingInflows.map((inflow, i) => inflow - financingOutflows[i]);
        const netCashFlow = operatingNet.map((op, i) => op + investingNet[i] + financingNet[i]);

        const openingCashArr = Array(12).fill(0);
        const closingCashArr = Array(12).fill(0);

        let runningCash = openingCash;
        for (let m = 0; m < 12; m++) {
            openingCashArr[m] = runningCash;
            runningCash += netCashFlow[m];
            closingCashArr[m] = runningCash;
        }

        res.status(200).json({
            success: true,
            data: {
                operating: {
                    inflows: operatingInflows,
                    outflows: operatingOutflows,
                    net: operatingNet
                },
                investing: {
                    inflows: investingInflows,
                    outflows: investingOutflows,
                    net: investingNet
                },
                financing: {
                    inflows: financingInflows,
                    outflows: financingOutflows,
                    net: financingNet
                },
                netCashFlow,
                openingCash: openingCashArr,
                closingCash: closingCashArr,
                // Legacy fields for backward compatibility
                revenue: receiptsArr,
                invoice: invoicesArr,
                payment: paymentsArr,
                bill: billsArr
            }
        });

    } catch (error) {
        console.error('Error fetching Cash Flow:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

// Get Profit & Loss Report
const getProfitLoss = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });


        const { startDate: qStart, endDate: qEnd, year: qYear } = req.query;

        // Determine date range
        let startDate = null;
        let endDate = null;
        let year = new Date().getFullYear();

        if (qStart || qEnd) {
            if (qStart) {
                const sStr = String(qStart).split('T')[0];
                startDate = new Date(`${sStr}T00:00:00.000Z`);
                year = startDate.getFullYear();
            }
            if (qEnd) {
                const eStr = String(qEnd).split('T')[0];
                endDate = new Date(`${eStr}T23:59:59.999Z`);
            }
        }

        const prevYear = year - 1;

        // Helper to fetch ledger balances matching type
        const fetchLedgerData = async (start, end) => {
            // Fetch Ledgers for company with Group and Sub-Group info
            const ledgers = await prisma.ledger.findMany({
                where: {
                    companyId: parseInt(companyId),
                    accountgroup: {
                        type: { in: ['INCOME', 'EXPENSES'] }
                    }
                },
                include: {
                    accountgroup: true,
                    accountsubgroup: true
                }
            });

            const txWhere = { companyId: parseInt(companyId) };
            if (start || end) {
                txWhere.date = {};
                if (start) txWhere.date.gte = start;
                if (end) txWhere.date.lte = end;
            }

            const transactions = await prisma.transaction.findMany({
                where: txWhere
            });

            // Process Data
            let totalIncome = 0;
            let totalExpense = 0;
            const monthlyData = Array(12).fill(0).map(() => ({ income: 0, expense: 0 }));

            // Standard P&L Categories
            const statement = {
                revenue: { items: [], total: 0 },
                cogs: { items: [], total: 0 },
                operatingExpenses: { items: [], total: 0 },
                otherIncome: { items: [], total: 0 },
                otherExpense: { items: [], total: 0 }
            };

            const isFullYearOrAll = (!start && !end) || (start && end && new Date(start).getUTCMonth() === 0 && new Date(start).getUTCDate() === 1 && new Date(end).getUTCMonth() === 11 && new Date(end).getUTCDate() >= 30);

            const ledgerValues = {}; // To store net value per ledger
            ledgers.forEach(l => {
                // Opening balances of INCOME and EXPENSE ledgers are included by default or in full-year context
                const openBal = isFullYearOrAll ? parseFloat(l.openingBalance || 0) : 0;
                ledgerValues[l.id] = openBal;

                if (l.accountgroup.type === 'INCOME') totalIncome += openBal;
                if (l.accountgroup.type === 'EXPENSES') totalExpense += openBal;
            });

            transactions.forEach(txn => {
                const month = new Date(txn.date).getMonth(); // 0-11
                const amount = parseFloat(txn.amount || 0);

                const debitLedger = ledgers.find(l => l.id === txn.debitLedgerId);
                const creditLedger = ledgers.find(l => l.id === txn.creditLedgerId);

                // DEBIT SIDE Checks
                if (debitLedger) {
                    if (debitLedger.accountgroup.type === 'EXPENSES') {
                        totalExpense += amount;
                        monthlyData[month].expense += amount;
                        ledgerValues[debitLedger.id] += amount;
                    } else if (debitLedger.accountgroup.type === 'INCOME') {
                        totalIncome -= amount;
                        monthlyData[month].income -= amount;
                        ledgerValues[debitLedger.id] -= amount;
                    }
                }

                // CREDIT SIDE Checks
                if (creditLedger) {
                    if (creditLedger.accountgroup.type === 'INCOME') {
                        totalIncome += amount;
                        monthlyData[month].income += amount;
                        ledgerValues[creditLedger.id] += amount;
                    } else if (creditLedger.accountgroup.type === 'EXPENSES') {
                        totalExpense -= amount;
                        monthlyData[month].expense -= amount;
                        ledgerValues[creditLedger.id] -= amount;
                    }
                }
            });

            // Populate Statement Structure
            ledgers.forEach(ledger => {
                const val = ledgerValues[ledger.id] !== undefined ? ledgerValues[ledger.id] : 0;

                const item = { id: ledger.id, name: ledger.name, value: val };
                const groupType = ledger.accountgroup.type;
                const subGroupName = ledger.accountsubgroup?.name?.toLowerCase() || '';
                const ledgerName = ledger.name.toLowerCase();

                if (groupType === 'INCOME') {
                    if (subGroupName.includes('other')) {
                        statement.otherIncome.items.push(item);
                        statement.otherIncome.total += val;
                    } else {
                        statement.revenue.items.push(item);
                        statement.revenue.total += val;
                    }
                } else if (groupType === 'EXPENSES') {
                    if (subGroupName.includes('direct') ||
                        ledgerName.includes('cost of goods sold') ||
                        ledgerName.includes('cogs') ||
                        ledgerName.includes('purchases')) {
                        statement.cogs.items.push(item);
                        statement.cogs.total += val;
                    } else if (subGroupName.includes('other')) {
                        statement.otherExpense.items.push(item);
                        statement.otherExpense.total += val;
                    } else {
                        statement.operatingExpenses.items.push(item);
                        statement.operatingExpenses.total += val;
                    }
                }
            });

            return {
                totalIncome,
                totalExpense,
                netProfit: totalIncome - totalExpense,
                monthlyData,
                statement
            };
        };

        const currentData = await fetchLedgerData(startDate, endDate);

        let prevData = { totalIncome: 0, totalExpense: 0, netProfit: 0 };
        if (startDate && endDate) {
            const prevStart = new Date(startDate);
            prevStart.setFullYear(prevStart.getFullYear() - 1);
            const prevEnd = new Date(endDate);
            prevEnd.setFullYear(prevEnd.getFullYear() - 1);
            prevData = await fetchLedgerData(prevStart, prevEnd);
        }

        // Net Profit = (Income - Expense) as COGS is already posted on sales invoices in real-time.
        // Unsold inventory remains in Balance Sheet Current Assets, not added as a direct income in P&L.

        // Calculate Growth %
        const calcGrowth = (curr, prev) => {
            if (prev === 0) return curr === 0 ? 0 : 100;
            return parseFloat(((curr - prev) / Math.abs(prev) * 100).toFixed(1));
        };

        const summary = {
            totalIncome: currentData.totalIncome,
            totalExpense: currentData.totalExpense,
            netProfit: currentData.netProfit,
            incomeGrowth: calcGrowth(currentData.totalIncome, prevData.totalIncome),
            expenseGrowth: calcGrowth(currentData.totalExpense, prevData.totalExpense),
            profitGrowth: calcGrowth(currentData.netProfit, prevData.netProfit)
        };

        // Format Chart Data
        const chartData = [
            'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
        ].map((name, i) => ({
            name,
            income: currentData.monthlyData[i].income,
            expense: currentData.monthlyData[i].expense
        }));

        // Official Statement Totals
        const grossProfit = currentData.statement.revenue.total - currentData.statement.cogs.total;
        const operatingIncome = grossProfit - currentData.statement.operatingExpenses.total;
        const netOther = currentData.statement.otherIncome.total - currentData.statement.otherExpense.total;

        res.status(200).json({
            success: true,
            data: {
                summary,
                chartData,
                statement: currentData.statement,
                calculations: {
                    grossProfit,
                    operatingIncome,
                    netOther,
                    netProfit: currentData.netProfit
                }
            }
        });

    } catch (error) {
        console.error('Error fetching Profit & Loss:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

// Get VAT Report (Detailed Transaction List + Date Range Filter)
const getVatReport = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        const { startDate: qStart, endDate: qEnd, year: qYear } = req.query;
        let startDate, endDate, year;

        if (qStart && qEnd) {
            startDate = new Date(qStart);
            endDate = toEndOfDay(qEnd);
            year = startDate.getFullYear();
        } else {
            year = parseInt(qYear) || new Date().getFullYear();
            startDate = new Date(`${year}-01-01`);
            endDate = toEndOfDay(`${year}-12-31`);
        }

        // 1. Fetch Sales (Invoices)
        const invoices = await prisma.invoice.findMany({
            where: {
                companyId: parseInt(companyId),
                date: { gte: startDate, lte: endDate }
            },
            include: { customer: { select: { name: true } } }
        });

        // 2. Fetch POS Sales
        const posInvoices = await prisma.posinvoice.findMany({
            where: {
                companyId: parseInt(companyId),
                date: { gte: startDate, lte: endDate }
            },
            include: { customer: { select: { name: true } } }
        });

        // 3. Fetch Purchases (Bills)
        const bills = await prisma.purchasebill.findMany({
            where: {
                companyId: parseInt(companyId),
                date: { gte: startDate, lte: endDate }
            },
            include: { vendor: { select: { name: true } } }
        });

        // Map to Unified Structure
        let reportData = [];

        const companyCurrency = await getCompanyCurrency(companyId);

        // Map Invoices
        for (const inv of invoices) {
            const exRate = await getConversionRate(inv.currency || 'USD', companyCurrency);
            const taxable = (parseFloat(inv.subtotal) || 0) * exRate;
            const tax = (parseFloat(inv.taxAmount) || 0) * exRate;
            const rate = taxable > 0 ? ((tax / taxable) * 100).toFixed(1) : 0;

            reportData.push({
                id: `INV-${inv.id}`,
                type: 'Sales',
                description: `Invoice #${inv.invoiceNumber} - ${inv.customer.name}`,
                taxableAmount: taxable,
                vatAmount: tax,
                vatRate: rate,
                date: inv.date
            });
        }

        // Map POS
        const histCurr = await getCompanyHistoricalCurrency(companyId);
        for (const pos of posInvoices) {
            const exRate = await getConversionRate(pos.currency || histCurr, companyCurrency);
            const taxable = (parseFloat(pos.subtotal) || 0) * exRate;
            const tax = (parseFloat(pos.taxAmount) || 0) * exRate;
            const rate = taxable > 0 ? ((tax / taxable) * 100).toFixed(1) : 0;
            const custName = pos.customer ? pos.customer.name : 'Walk-in Customer';

            reportData.push({
                id: `POS-${pos.id}`,
                type: 'Sales',
                description: `POS #${pos.invoiceNumber} - ${custName}`,
                taxableAmount: taxable,
                vatAmount: tax,
                vatRate: rate,
                date: pos.date || pos.createdAt
            });
        }

        // Map Bills
        for (const bill of bills) {
            const exRate = await getConversionRate(bill.currency || 'USD', companyCurrency);
            const taxable = (parseFloat(bill.subtotal) || 0) * exRate;
            const tax = (parseFloat(bill.taxAmount) || 0) * exRate;
            const rate = taxable > 0 ? ((tax / taxable) * 100).toFixed(1) : 0;

            reportData.push({
                id: `BILL-${bill.id}`,
                type: 'Purchase',
                description: `Bill #${bill.billNumber} - ${bill.vendor.name}`,
                taxableAmount: taxable,
                vatAmount: tax,
                vatRate: rate,
                date: bill.date
            });
        }

        // Sort by Date Descending
        reportData.sort((a, b) => new Date(b.date) - new Date(a.date));

        res.status(200).json({ success: true, data: reportData });

    } catch (error) {
        console.error('Error fetching VAT report:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

// Get Day Book Report (Consolidated from all source tables)
const getDayBook = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        const { startDate, endDate, voucherType, ledgerId } = req.query;

        // Date Range Logic
        let dateFilter = undefined;
        if (startDate && endDate) {
            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999); // include full end day
            dateFilter = { gte: start, lte: end };
        } else if (startDate) {
            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            dateFilter = { gte: start };
        } else if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter = { lte: end };
        }

        const companyIdInt = parseInt(companyId);
        const lId = ledgerId ? parseInt(ledgerId) : null;

        // Helper to check if a type should be included
        const includeType = (type) => !voucherType || voucherType === 'ALL' || voucherType.toUpperCase() === type.toUpperCase();

        const queries = [];

        // 1. Invoices
        if (includeType('SALES') || includeType('TAX_INVOICE')) {
            queries.push(prisma.invoice.findMany({
                where: {
                    companyId: companyIdInt,
                    date: dateFilter,
                    ...(lId ? { customer: { ledgerId: lId } } : {})
                },
                include: { customer: true }
            }).then(async items => {
                const companyCurrency = await getCompanyCurrency(companyIdInt);
                return Promise.all(items.map(async inv => {
                    const rate = await getConversionRate(inv.currency || 'USD', companyCurrency);
                    return {
                        id: `INV-${inv.id}`,
                        date: inv.date,
                        voucherType: 'Sales',
                        voucherNo: inv.invoiceNumber,
                        ledger: inv.customer?.name || 'Unknown',
                        ledgerId: inv.customer?.ledgerId || null,
                        description: inv.notes || 'Sales Invoice',
                        debit: inv.totalAmount * rate,
                        credit: 0,
                        source: { type: 'SALES', id: inv.id, link: `/company/sales/invoice/view/${inv.id}` }
                    };
                }));
            }));
        }

        // 2. POS Invoices
        if (includeType('SALES') || includeType('POS_INVOICE')) {
            queries.push(prisma.posinvoice.findMany({
                where: {
                    companyId: companyIdInt,
                    createdAt: dateFilter,
                    ...(lId ? { OR: [{ customer: { ledgerId: lId } }, { transaction: { some: { OR: [{ debitLedgerId: lId }, { creditLedgerId: lId }] } } }] } : {})
                },
                include: { customer: true, transaction: { select: { debitLedgerId: true } } }
            }).then(async items => {
                const companyCurrency = await getCompanyCurrency(companyIdInt);
                const histCurr = await getCompanyHistoricalCurrency(companyIdInt);
                return Promise.all(items.map(async pos => {
                    const ledgerId = pos.customer?.ledgerId || pos.transaction[0]?.debitLedgerId || null;
                    const rate = await getConversionRate(pos.currency || histCurr, companyCurrency);
                    return {
                        id: `POS-${pos.id}`,
                        date: pos.createdAt,
                        voucherType: 'POS Invoice',
                        voucherNo: pos.invoiceNumber,
                        ledger: pos.customer?.name || 'Walk-in (Cash)',
                        ledgerId,
                        description: 'POS Sale',
                        debit: pos.totalAmount * rate,
                        credit: 0,
                        source: { type: 'POS_INVOICE', id: pos.id, link: `/company/pos/view/${pos.id}` }
                    };
                }));
            }));
        }

        // 3. Purchase Bills
        if (includeType('PURCHASE')) {
            queries.push(prisma.purchasebill.findMany({
                where: {
                    companyId: companyIdInt,
                    date: dateFilter,
                    ...(lId ? { vendor: { ledgerId: lId } } : {})
                },
                include: { vendor: true }
            }).then(async items => {
                const companyCurrency = await getCompanyCurrency(companyIdInt);
                return Promise.all(items.map(async bill => {
                    const rate = await getConversionRate(bill.currency || 'USD', companyCurrency);
                    return {
                        id: `BILL-${bill.id}`,
                        date: bill.date,
                        voucherType: 'Purchase',
                        voucherNo: bill.billNumber,
                        ledger: bill.vendor?.name || 'Unknown',
                        ledgerId: bill.vendor?.ledgerId || null,
                        description: bill.notes || 'Purchase Bill',
                        debit: 0,
                        credit: bill.totalAmount * rate,
                        source: { type: 'PURCHASE', id: bill.id, link: `/company/purchase/bill/view/${bill.id}` }
                    };
                }));
            }));
        }

        // 4. Receipts
        if (includeType('RECEIPT')) {
            queries.push(prisma.receipt.findMany({
                where: {
                    companyId: companyIdInt,
                    date: dateFilter,
                    ...(lId ? { OR: [{ customer: { ledgerId: lId } }, { cashBankAccountId: lId }] } : {})
                },
                include: { customer: true, cashBankAccount: true }
            }).then(items => items.map(rec => ({
                id: `REC-${rec.id}`,
                date: rec.date,
                voucherType: 'Receipt',
                voucherNo: rec.receiptNumber,
                ledger: rec.customer?.name || rec.cashBankAccount?.name || 'Unknown',
                ledgerId: rec.customer?.ledgerId || rec.cashBankAccountId || null,
                description: 'Payment Received',
                debit: 0,
                credit: rec.amount,
                source: { type: 'RECEIPT', id: rec.id, link: `/company/payment/receipt/view/${rec.id}` }
            }))));
        }

        // 5. Payments
        if (includeType('PAYMENT')) {
            queries.push(prisma.payment.findMany({
                where: {
                    companyId: companyIdInt,
                    date: dateFilter,
                    ...(lId ? { OR: [{ vendor: { ledgerId: lId } }, { cashBankAccountId: lId }] } : {})
                },
                include: { vendor: true, bankLedger: true }
            }).then(items => items.map(pay => ({
                id: `PAY-${pay.id}`,
                date: pay.date,
                voucherType: 'Payment',
                voucherNo: pay.paymentNumber,
                ledger: pay.vendor?.name || pay.bankLedger?.name || 'Unknown',
                ledgerId: pay.vendor?.ledgerId || pay.cashBankAccountId || null,
                description: 'Payment Made',
                debit: pay.amount,
                credit: 0,
                source: { type: 'PAYMENT', id: pay.id, link: `/company/payment/made/view/${pay.id}` }
            }))));
        }

        // 6. Journal Entries (Only included when explicitly filtered by JOURNAL to avoid duplicate double entries with primary invoices/bills/receipts/payments)
        if (voucherType && voucherType.toUpperCase() === 'JOURNAL') {
            queries.push(prisma.journalentry.findMany({
                where: {
                    companyId: companyIdInt,
                    date: dateFilter,
                    source: { not: 'system' },
                    ...(lId ? { transaction: { some: { OR: [{ debitLedgerId: lId }, { creditLedgerId: lId }] } } } : {})
                },
                include: { transaction: { include: { ledger_transaction_debitLedgerIdToledger: true, ledger_transaction_creditLedgerIdToledger: true } } }
            }).then(items => items.map(je => ({
                id: `JE-${je.id}`,
                date: je.date,
                voucherType: 'Journal',
                voucherNo: je.voucherNumber || je.journalNumber || '-',
                ledger: 'Journal Entry',
                ledgerId: null,
                description: je.narration || 'Journal Voucher',
                debit: je.transaction.reduce((sum, t) => sum + (t.debitLedgerId ? t.amount : 0), 0),
                credit: 0, // In Day Book we usually show total magnitude or DR/CR split
                source: { type: 'JOURNAL', id: je.id, link: `/company/journal/view/${je.id}` }
            }))));
        }

        // 7. Vouchers (Expense, Income, Contra)
        if (includeType('EXPENSE') || includeType('INCOME') || includeType('CONTRA')) {
            queries.push(prisma.voucher.findMany({
                where: {
                    companyId: companyIdInt,
                    date: dateFilter,
                    ...(voucherType && voucherType !== 'ALL' ? { voucherType: voucherType.toUpperCase() } : {}),
                    ...(lId ? { OR: [{ paidFromLedgerId: lId }, { paidToLedgerId: lId }, { vendor: { ledgerId: lId } }, { customer: { ledgerId: lId } }] } : {})
                },
                include: { vendor: true, customer: true, paidFromLedger: true, paidToLedger: true }
            }).then(items => items.map(v => ({
                id: `VCH-${v.id}`,
                date: v.date,
                voucherType: v.voucherType,
                voucherNo: v.voucherNumber,
                ledger: v.vendor?.name || v.customer?.name || v.paidToLedger?.name || v.paidFromLedger?.name || 'Unknown',
                ledgerId: v.vendor?.ledgerId || v.customer?.ledgerId || v.paidToLedgerId || v.paidFromLedgerId || null,
                description: v.notes || `${v.voucherType} Voucher`,
                debit: v.voucherType === 'EXPENSE' ? v.totalAmount : (v.voucherType === 'CONTRA' ? v.totalAmount : 0),
                credit: v.voucherType === 'INCOME' ? v.totalAmount : 0,
                source: { type: v.voucherType, id: v.id, link: `/company/vouchers/view/${v.id}` }
            }))));
        }

        // 8. Stock Transfers
        if (includeType('STOCK_TRANSFER') || includeType('TRANSFER')) {
            queries.push(prisma.stocktransfer.findMany({
                where: {
                    companyId: companyIdInt,
                    date: dateFilter
                },
                include: {
                    warehouse: true,
                    stocktransferitem: { include: { warehouse: true } }
                }
            }).then(items => items.map(st => {
                const fromWH = st.stocktransferitem?.[0]?.warehouse?.name || 'Warehouse';
                const toWH = st.warehouse?.name || 'Warehouse';
                return {
                    id: `ST-${st.id}`,
                    date: st.date,
                    voucherType: 'Stock Transfer',
                    voucherNo: st.voucherNo,
                    ledger: `${fromWH} → ${toWH}`,
                    ledgerId: null,
                    description: st.narration || 'Stock Transfer',
                    debit: st.totalAmount || 0,
                    credit: st.totalAmount || 0,
                    source: { type: 'STOCK_TRANSFER', id: st.id, link: `/company/inventory/transfer` }
                };
            })));
        }

        const results = await Promise.all(queries);
        const dayBook = results.flat().sort((a, b) => new Date(b.date) - new Date(a.date));

        res.status(200).json({ success: true, data: dayBook });

    } catch (error) {
        console.error('Error fetching Day Book:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

// Get Journal Entries
const getJournalReport = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        const { startDate: qStartDate, endDate: qEndDate, year: qYear, month: qMonth } = req.query;

        let dateFilter = undefined;

        if (qStartDate && qEndDate) {
            const start = new Date(qStartDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(qEndDate);
            end.setHours(23, 59, 59, 999);
            dateFilter = { gte: start, lte: end };
        } else if (qStartDate) {
            const start = new Date(qStartDate);
            start.setHours(0, 0, 0, 0);
            dateFilter = { gte: start };
        } else if (qEndDate) {
            const end = new Date(qEndDate);
            end.setHours(23, 59, 59, 999);
            dateFilter = { lte: end };
        } else if (qYear !== undefined && qYear !== '' && qMonth !== undefined && qMonth !== '') {
            const year = parseInt(qYear);
            const month = parseInt(qMonth);
            const startDate = new Date(year, month, 1);
            const endDate = new Date(year, month + 1, 0);
            endDate.setHours(23, 59, 59, 999);
            dateFilter = { gte: startDate, lte: endDate };
        }

        const journals = await prisma.journalentry.findMany({
            where: {
                companyId: parseInt(companyId),
                ...(dateFilter ? { date: dateFilter } : {}),
                OR: [
                    { source: 'manual' },
                    { source: null },
                    { source: 'journal' },
                    { source: 'JOURNAL' }
                ]
            },
            include: {
                transaction: {
                    include: {
                        ledger_transaction_debitLedgerIdToledger: true,
                        ledger_transaction_creditLedgerIdToledger: true
                    }
                }
            },
            orderBy: { date: 'desc' }
        });

        const companyCurrency = await getCompanyCurrency(companyId);
        const histCurr = await getCompanyHistoricalCurrency(companyId);
        const rate = await getConversionRate(histCurr, companyCurrency);

        const reportData = journals.map(entry => {
            let ledgers = [];

            // Each transaction represents a Debit-Credit pair
            entry.transaction.forEach(txn => {
                const amount = parseFloat(txn.amount) * rate;

                // Debit Side
                if (txn.debitLedgerId) {
                    ledgers.push({
                        id: txn.debitLedgerId,
                        name: txn.ledger_transaction_debitLedgerIdToledger?.name || 'Unknown',
                        nature: 'Debit',
                        amount: amount
                    });
                }

                // Credit Side
                if (txn.creditLedgerId) {
                    ledgers.push({
                        id: txn.creditLedgerId,
                        name: txn.ledger_transaction_creditLedgerIdToledger?.name || 'Unknown',
                        nature: 'Credit',
                        amount: amount
                    });
                }
            });

            return {
                id: entry.id,
                date: entry.date,
                voucherNo: entry.voucherNumber || entry.manualVoucherNo || `JE-${entry.id}`,
                type: 'Journal', // Default type
                narration: entry.narration || '',
                ledgers
            };
        });

        res.status(200).json({ success: true, data: reportData });

    } catch (error) {
        console.error('Error fetching Journal report:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

// Get Trial Balance
const getTrialBalance = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        const { startDate: qStartDate, endDate: qEndDate, date: qDate } = req.query;

        let dateFilter = undefined;

        if (qStartDate && qEndDate) {
            const start = new Date(qStartDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(qEndDate);
            end.setHours(23, 59, 59, 999);
            dateFilter = { gte: start, lte: end };
        } else if (qStartDate) {
            const start = new Date(qStartDate);
            start.setHours(0, 0, 0, 0);
            dateFilter = { gte: start };
        } else if (qEndDate || qDate) {
            const end = new Date(qEndDate || qDate);
            end.setHours(23, 59, 59, 999);
            dateFilter = { lte: end };
        }

        const companyCurrency = await getCompanyCurrency(companyId);
        const histCurr = await getCompanyHistoricalCurrency(companyId);
        const rate = await getConversionRate(histCurr, companyCurrency);

        // Fetch all ledgers with their group details
        const ledgers = await prisma.ledger.findMany({
            where: { companyId: parseInt(companyId) },
            include: { accountgroup: true }
        });

        // --- Single-pass transaction aggregates (avoids N+1 queries) ---
        const [debitSums, creditSums] = await Promise.all([
            prisma.transaction.groupBy({
                by: ['debitLedgerId'],
                where: { companyId: parseInt(companyId), ...(dateFilter ? { date: dateFilter } : {}) },
                _sum: { amount: true }
            }),
            prisma.transaction.groupBy({
                by: ['creditLedgerId'],
                where: { companyId: parseInt(companyId), ...(dateFilter ? { date: dateFilter } : {}) },
                _sum: { amount: true }
            })
        ]);

        const debitMap = new Map(debitSums.map(d => [d.debitLedgerId, d._sum.amount || 0]));
        const creditMap = new Map(creditSums.map(c => [c.creditLedgerId, c._sum.amount || 0]));

        // Calculate dynamic inventory value once
        const currentInventoryValue = (await calculateInventoryValue(companyId)) * rate;

        const trialBalance = [];

        for (const ledger of ledgers) {
            const isOBE = ledger.name.toLowerCase().includes('opening balance equity');
            const groupType = ledger.accountgroup?.type;

            // Skip transaction aggregation for OBE — it will be set dynamically below
            let totalDebit = 0;
            let totalCredit = 0;

            if (!isOBE) {
                const txnDebit = (debitMap.get(ledger.id) || 0) * rate;
                const txnCredit = (creditMap.get(ledger.id) || 0) * rate;
                const openingBalance = parseFloat(ledger.openingBalance || 0) * rate;

                // Assets and Expenses: Debit-normal
                if (groupType === 'ASSETS' || groupType === 'EXPENSES') {
                    totalDebit = txnDebit + openingBalance;
                    totalCredit = txnCredit;
                } else {
                    // Liabilities, Income, Equity: Credit-normal
                    totalCredit = txnCredit + openingBalance;
                    totalDebit = txnDebit;
                }
            }

            // Determine Net Balance
            let netDebit = 0;
            let netCredit = 0;

            if (totalDebit > totalCredit) {
                netDebit = totalDebit - totalCredit;
            } else if (totalCredit > totalDebit) {
                netCredit = totalCredit - totalDebit;
            }

            // Always include OBE (even with 0 balance — the adjustment below will populate it)
            if (netDebit !== 0 || netCredit !== 0 || isOBE) {
                trialBalance.push({
                    id: ledger.id,
                    name: ledger.name,
                    type: ledger.accountgroup ? ledger.accountgroup.name : 'Uncategorized',
                    groupType: ledger.accountgroup ? ledger.accountgroup.type : 'UNCATEGORIZED',
                    debit: netDebit,
                    credit: netCredit
                });
            }
        }

        // Sort by Name
        trialBalance.sort((a, b) => a.name.localeCompare(b.name));

        // Dynamic OBE adjustment — absorb any imbalance so TB always balances
        const totalDebitTB = trialBalance.reduce((sum, item) => sum + item.debit, 0);
        const totalCreditTB = trialBalance.reduce((sum, item) => sum + item.credit, 0);
        const tbDifference = totalDebitTB - totalCreditTB;

        if (Math.abs(tbDifference) > 0.01) {
            const obeIndex = trialBalance.findIndex(item => item.name.toLowerCase().includes('opening balance equity'));

            if (obeIndex !== -1) {
                // Adjust existing OBE to absorb the difference
                if (tbDifference > 0) {
                    trialBalance[obeIndex].credit += tbDifference;
                } else {
                    trialBalance[obeIndex].debit += Math.abs(tbDifference);
                }

                // Convert back to net balance for display
                const net = trialBalance[obeIndex].debit - trialBalance[obeIndex].credit;
                trialBalance[obeIndex].debit = net > 0 ? net : 0;
                trialBalance[obeIndex].credit = net < 0 ? Math.abs(net) : 0;
            } else {
                // Add a new OBE adjustment entry if not present
                trialBalance.push({
                    id: 999997,
                    name: 'Opening Balance Adjustment',
                    type: 'Equity',
                    debit: tbDifference < 0 ? Math.abs(tbDifference) : 0,
                    credit: tbDifference > 0 ? tbDifference : 0
                });
            }
        }

        res.status(200).json({ success: true, data: trialBalance });

    } catch (error) {
        console.error('Error fetching Trial Balance:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};


// Get All Transactions
const getAllTransactions = async (req, res) => {
    try {
        const companyId = req.user?.companyId || req.query.companyId;
        if (!companyId) return res.status(400).json({ success: false, message: 'Company ID is required' });

        const transactions = await prisma.transaction.findMany({
            where: {
                companyId: parseInt(companyId)
            },
            include: {
                ledger_transaction_debitLedgerIdToledger: { include: { accountgroup: true } },
                ledger_transaction_creditLedgerIdToledger: { include: { accountgroup: true } },
                invoice: { include: { customer: true, invoiceitem: { include: { product: true, warehouse: true, uom: true } } } },
                purchasebill: { include: { vendor: true, purchasebillitem: { include: { product: true, warehouse: true, uom: true } } } },
                payment: { include: { vendor: true, bankLedger: true } },
                receipt: { include: { customer: true, cashBankAccount: true } },
                journalentry: true,
                posinvoice: { include: { customer: true, posinvoiceitem: { include: { product: true, warehouse: true, uom: true } } } }
            },
            orderBy: {
                date: 'desc'
            }
        });

        // Retrieve all vouchers for this company to link Journal/Contra/Expense/Income types to voucher.id
        const vouchers = await prisma.voucher.findMany({
            where: {
                companyId: parseInt(companyId)
            },
            select: {
                id: true,
                voucherNumber: true,
                voucherType: true
            }
        });

        const voucherMap = new Map();
        vouchers.forEach(v => {
            const key = `${v.voucherType}_${v.voucherNumber}`;
            voucherMap.set(key, v.id);
        });

        // Retrieve all sales returns for this company to link type to salesreturn.id
        const salesReturns = await prisma.salesreturn.findMany({
            where: {
                companyId: parseInt(companyId)
            },
            select: {
                id: true,
                returnNumber: true,
                autoVoucherNo: true,
                manualVoucherNo: true
            }
        });

        // Retrieve all purchase returns for this company to link type to purchasereturn.id
        const purchaseReturns = await prisma.purchasereturn.findMany({
            where: {
                companyId: parseInt(companyId)
            },
            select: {
                id: true,
                returnNumber: true
            }
        });

        // Retrieve all stock transfers for this company
        const stockTransfers = await prisma.stocktransfer.findMany({
            where: {
                companyId: parseInt(companyId)
            },
            include: {
                warehouse: { select: { id: true, name: true } },
                stocktransferitem: {
                    include: {
                        product: {
                            select: {
                                id: true,
                                name: true,
                                sku: true,
                                unit: true,
                                uom: { select: { unitName: true, symbol: true } }
                            }
                        },
                        warehouse: { select: { id: true, name: true } }
                    }
                }
            },
            orderBy: {
                date: 'desc'
            }
        });

        const returnMap = new Map();
        salesReturns.forEach(sr => {
            if (sr.returnNumber) returnMap.set(`SALES_RETURN_${sr.returnNumber}`, sr.id);
            if (sr.autoVoucherNo) returnMap.set(`SALES_RETURN_${sr.autoVoucherNo}`, sr.id);
            if (sr.manualVoucherNo) returnMap.set(`SALES_RETURN_${sr.manualVoucherNo}`, sr.id);
        });
        purchaseReturns.forEach(pr => {
            if (pr.returnNumber) returnMap.set(`PURCHASE_RETURN_${pr.returnNumber}`, pr.id);
        });

        // Group transactions in memory by source document/event to prevent duplicate rows
        const groups = {};
        const groupOrder = [];

        transactions.forEach(txn => {
            let key = '';
            if (txn.voucherType === 'SALES_RETURN' || txn.voucherType === 'PURCHASE_RETURN') {
                key = `${txn.voucherType}_${txn.voucherNumber}`;
            } else if (txn.invoiceId) key = `invoice_${txn.invoiceId}`;
            else if (txn.purchaseBillId) key = `purchasebill_${txn.purchaseBillId}`;
            else if (txn.receiptId) key = `receipt_${txn.receiptId}`;
            else if (txn.paymentId) key = `payment_${txn.paymentId}`;
            else if (txn.posInvoiceId) key = `posinvoice_${txn.posInvoiceId}`;
            else if (txn.journalEntryId) key = `journalentry_${txn.journalEntryId}`;
            else if (txn.voucherNumber) key = `${txn.voucherType}_${txn.voucherNumber}`;
            else key = `other_${txn.id}`;

            if (!groups[key]) {
                groups[key] = [];
                groupOrder.push(key);
            }
            groups[key].push(txn);
        });

        const companyCurrency = await getCompanyCurrency(companyId);
        const histCurr = await getCompanyHistoricalCurrency(companyId);
        const rates = await getExchangeRates();

        const calcRate = (from, to) => {
            const fromUpper = (from || 'USD').toUpperCase();
            const toUpper = (to || 'USD').toUpperCase();
            if (fromUpper === toUpper) return 1.0;
            const fromRate = rates[fromUpper] || 1.0;
            const toRate = rates[toUpper] || 1.0;
            return toRate / fromRate;
        };

        const histRate = calcRate(histCurr, companyCurrency);
        const round2 = (num) => Math.round((parseFloat(num || 0) + Number.EPSILON) * 100) / 100;

        const formattedTransactions = groupOrder.map(key => {
            const txns = groups[key];
            const primaryTxn = txns[0];

            let balanceType = 'Debit';
            let partyName = '-';
            let accountType = '-';
            let voucherNo = primaryTxn.voucherNumber || '-';
            let note = primaryTxn.description;
            let targetId = null;
            let amount = parseFloat(primaryTxn.amount || 0);
            let vType = primaryTxn.voucherType;
            let currency = companyCurrency;
            let exchangeRate = 1.0;

            // Resolve Note from source documents if description is empty or generic
            if (!note || note === '-') {
                if (primaryTxn.invoice) note = primaryTxn.invoice.notes;
                else if (primaryTxn.purchasebill) note = primaryTxn.purchasebill.notes;
                else if (primaryTxn.receipt) note = primaryTxn.receipt.notes;
                else if (primaryTxn.payment) note = primaryTxn.payment.notes;
                else if (primaryTxn.journalentry) note = primaryTxn.journalentry.narration;
            }

            let customerVendor = '-';
            let customerName = null;
            let vendorName = null;
            let itemsList = [];
            let skuList = [];
            let qtyList = [];
            let unitList = [];
            let priceList = [];
            let discList = [];
            let taxList = [];
            let whList = [];
            let paymentMethod = '-';
            let bankAccount = '-';
            let cashAccount = '-';
            let status = 'COMPLETED';
            let referenceNo = '-';
            let createdDate = primaryTxn.createdAt;
            let lastUpdated = primaryTxn.createdAt;
            let sourceModule = 'General Ledger';
            let originalAmount = amount;

            // Sales (Invoice) -> Customer Debited (Receivable), Sales Credited -> Debit
            if (key.startsWith('invoice_') && primaryTxn.invoice) {
                balanceType = 'Debit';
                partyName = primaryTxn.invoice.customer?.name || primaryTxn.ledger_transaction_debitLedgerIdToledger?.name;
                accountType = primaryTxn.ledger_transaction_debitLedgerIdToledger?.accountgroup?.name || 'Debtors';
                voucherNo = primaryTxn.invoice.invoiceNumber;
                targetId = primaryTxn.invoice.id;
                vType = 'SALES_INVOICE';
                if (!note) note = primaryTxn.invoice.notes;

                customerVendor = primaryTxn.invoice.customer?.name || '-';
                currency = primaryTxn.invoice.currency || histCurr || companyCurrency;

                if (primaryTxn.invoice.exchangeRate && parseFloat(primaryTxn.invoice.exchangeRate) > 0 && parseFloat(primaryTxn.invoice.exchangeRate) !== 1.0) {
                    exchangeRate = parseFloat(primaryTxn.invoice.exchangeRate);
                } else if (currency !== companyCurrency) {
                    exchangeRate = calcRate(currency, companyCurrency);
                } else {
                    exchangeRate = 1.0;
                }

                const rawTotal = parseFloat(primaryTxn.invoice.totalAmount || 0);
                originalAmount = round2(rawTotal);
                amount = round2(currency !== companyCurrency ? rawTotal * exchangeRate : rawTotal);

                status = primaryTxn.invoice.status || 'UNPAID';
                referenceNo = primaryTxn.invoice.manualReference || '-';
                createdDate = primaryTxn.invoice.createdAt;
                lastUpdated = primaryTxn.invoice.updatedAt;
                sourceModule = 'Sales';

                const items = primaryTxn.invoice.invoiceitem || [];
                itemsList = items.map(item => item.product?.name || item.description).filter(Boolean);
                skuList = items.map(item => item.product?.sku).filter(Boolean);
                qtyList = items.map(item => item.quantity);
                unitList = items.map(item => item.uom?.symbol || item.uom?.name).filter(Boolean);
                priceList = items.map(item => currency !== companyCurrency ? round2(parseFloat(item.rate || 0) * exchangeRate) : item.rate);
                discList = items.map(item => item.discount);
                taxList = items.map(item => item.taxRate);
                whList = items.map(item => item.warehouse?.name).filter(Boolean);
            }
            // Purchase (Bill) -> Inventory/Expense Debited, Vendor Credited -> Credit
            else if (key.startsWith('purchasebill_') && primaryTxn.purchasebill) {
                balanceType = 'Credit';
                partyName = primaryTxn.purchasebill.vendor?.name || primaryTxn.ledger_transaction_creditLedgerIdToledger?.name;
                accountType = primaryTxn.ledger_transaction_creditLedgerIdToledger?.accountgroup?.name || 'Creditors';
                voucherNo = primaryTxn.purchasebill.billNumber;
                targetId = primaryTxn.purchasebill.id;
                vType = 'PURCHASE_BILL';
                if (!note) note = primaryTxn.purchasebill.notes;

                customerVendor = primaryTxn.purchasebill.vendor?.name || '-';
                currency = primaryTxn.purchasebill.currency || histCurr || companyCurrency;

                if (primaryTxn.purchasebill.exchangeRate && parseFloat(primaryTxn.purchasebill.exchangeRate) > 0 && parseFloat(primaryTxn.purchasebill.exchangeRate) !== 1.0) {
                    exchangeRate = parseFloat(primaryTxn.purchasebill.exchangeRate);
                } else if (currency !== companyCurrency) {
                    exchangeRate = calcRate(currency, companyCurrency);
                } else {
                    exchangeRate = 1.0;
                }

                const rawTotal = parseFloat(primaryTxn.purchasebill.totalAmount || 0);
                originalAmount = round2(rawTotal);
                amount = round2(currency !== companyCurrency ? rawTotal * exchangeRate : rawTotal);

                status = primaryTxn.purchasebill.status || 'UNPAID';
                referenceNo = primaryTxn.purchasebill.billNumber || '-';
                createdDate = primaryTxn.purchasebill.createdAt;
                lastUpdated = primaryTxn.purchasebill.updatedAt;
                sourceModule = 'Purchases';

                const items = primaryTxn.purchasebill.purchasebillitem || [];
                itemsList = items.map(item => item.product?.name || item.description).filter(Boolean);
                skuList = items.map(item => item.product?.sku).filter(Boolean);
                qtyList = items.map(item => item.quantity);
                unitList = items.map(item => item.uom?.symbol || item.uom?.name).filter(Boolean);
                priceList = items.map(item => currency !== companyCurrency ? round2(parseFloat(item.rate || 0) * exchangeRate) : item.rate);
                discList = items.map(item => item.discount);
                taxList = items.map(item => item.taxRate);
                whList = items.map(item => item.warehouse?.name).filter(Boolean);
            }
            // Receipt -> Cash/Bank Debited (Inflow), Customer Credited -> Debit
            else if (key.startsWith('receipt_') && primaryTxn.receipt) {
                balanceType = 'Debit';
                partyName = primaryTxn.receipt.customer?.name || primaryTxn.ledger_transaction_creditLedgerIdToledger?.name;
                accountType = primaryTxn.ledger_transaction_debitLedgerIdToledger?.accountgroup?.name || 'Bank/Cash';
                voucherNo = primaryTxn.receipt.receiptNumber;
                targetId = primaryTxn.receipt.id;
                vType = 'RECEIPT';
                if (!note) note = primaryTxn.receipt.notes;

                customerVendor = primaryTxn.receipt.customer?.name || '-';
                paymentMethod = primaryTxn.receipt.paymentMode || '-';
                cashAccount = primaryTxn.receipt.cashBankAccount?.name || '-';
                referenceNo = primaryTxn.receipt.referenceNo || primaryTxn.receipt.receiptNumber || '-';
                createdDate = primaryTxn.receipt.createdAt;
                sourceModule = 'Sales Receipts';

                currency = histCurr || companyCurrency;
                exchangeRate = currency !== companyCurrency ? calcRate(currency, companyCurrency) : 1.0;
                const rawTotal = parseFloat(primaryTxn.receipt.amount || 0);
                originalAmount = round2(rawTotal);
                amount = round2(currency !== companyCurrency ? rawTotal * exchangeRate : rawTotal);
            }
            // Payment -> Vendor Debited, Bank/Cash Credited (Outflow) -> Credit
            else if (key.startsWith('payment_') && primaryTxn.payment) {
                balanceType = 'Credit';
                partyName = primaryTxn.payment.vendor?.name || primaryTxn.ledger_transaction_debitLedgerIdToledger?.name;
                accountType = primaryTxn.ledger_transaction_creditLedgerIdToledger?.accountgroup?.name || 'Bank/Cash';
                voucherNo = primaryTxn.payment.paymentNumber;
                targetId = primaryTxn.payment.id;
                vType = 'PAYMENT';
                if (!note) note = primaryTxn.payment.notes;

                customerVendor = primaryTxn.payment.vendor?.name || '-';
                paymentMethod = primaryTxn.payment.paymentMode || '-';
                bankAccount = primaryTxn.payment.bankLedger?.name || '-';
                referenceNo = primaryTxn.payment.referenceNo || primaryTxn.payment.paymentNumber || '-';
                createdDate = primaryTxn.payment.createdAt;
                sourceModule = 'Purchase Payments';

                currency = histCurr || companyCurrency;
                exchangeRate = currency !== companyCurrency ? calcRate(currency, companyCurrency) : 1.0;
                const rawTotal = parseFloat(primaryTxn.payment.amount || 0);
                originalAmount = round2(rawTotal);
                amount = round2(currency !== companyCurrency ? rawTotal * exchangeRate : rawTotal);
            }
            // POS Invoice -> Cash/Customer Debited, Sales Credited -> Debit
            else if (key.startsWith('posinvoice_') && primaryTxn.posinvoice) {
                balanceType = 'Debit';
                partyName = primaryTxn.posinvoice.customer?.name || 'Walk-in';
                accountType = primaryTxn.ledger_transaction_debitLedgerIdToledger?.accountgroup?.name || 'Debtors';
                voucherNo = primaryTxn.posinvoice.invoiceNumber;
                targetId = primaryTxn.posinvoice.id;
                vType = 'POS_INVOICE';
                if (!note) note = primaryTxn.posinvoice.notes;

                customerVendor = primaryTxn.posinvoice.customer?.name || 'Walk-in';
                currency = primaryTxn.posinvoice.currency || histCurr || companyCurrency;

                if (currency !== companyCurrency) {
                    exchangeRate = calcRate(currency, companyCurrency);
                } else {
                    exchangeRate = 1.0;
                }

                const rawTotal = parseFloat(primaryTxn.posinvoice.totalAmount || 0);
                originalAmount = round2(rawTotal);
                amount = round2(currency !== companyCurrency ? rawTotal * exchangeRate : rawTotal);

                status = primaryTxn.posinvoice.status || 'PAID';
                createdDate = primaryTxn.posinvoice.createdAt;
                sourceModule = 'POS';

                const items = primaryTxn.posinvoice.posinvoiceitem || [];
                itemsList = items.map(item => item.product?.name || item.description).filter(Boolean);
                skuList = items.map(item => item.product?.sku).filter(Boolean);
                qtyList = items.map(item => item.quantity);
                unitList = items.map(item => item.uom?.symbol || item.uom?.name).filter(Boolean);
                priceList = items.map(item => currency !== companyCurrency ? round2(parseFloat(item.rate || 0) * exchangeRate) : item.rate);
                discList = items.map(item => item.discount);
                taxList = items.map(item => item.taxRate);
                whList = items.map(item => item.warehouse?.name).filter(Boolean);
            }
            // Opening Stock -> Product initial valuation
            else if ((primaryTxn.narration || '').startsWith('Opening Stock for Product:') || primaryTxn.voucherNumber?.startsWith('OS-')) {
                vType = 'OPENING_STOCK';
                balanceType = 'Debit';
                const prodName = (primaryTxn.narration || '').replace('Opening Stock for Product:', '').trim() || 'Inventory Item';
                partyName = 'Opening Balance Equity';
                customerVendor = 'Opening Stock';
                itemsList = [prodName];
                accountType = 'Inventory Asset';
                sourceModule = 'Inventory';
                voucherNo = primaryTxn.voucherNumber || `OS-${primaryTxn.id}`;
                currency = companyCurrency;
                exchangeRate = 1.0;
                const rawTotal = txns.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
                originalAmount = round2(rawTotal);
                amount = round2(rawTotal);
            }
            // Journal Voucher & Opening Balances -> Process properly
            else if (key.startsWith('journalentry_') || key.startsWith('JOURNAL_') || primaryTxn.voucherType === 'JOURNAL') {
                const narrationLower = (primaryTxn.narration || '').toLowerCase();
                const isCustomerOB = narrationLower.includes('opening balance for customer') || primaryTxn.voucherNumber?.startsWith('OB-CUST-');
                const isVendorOB = narrationLower.includes('opening balance for vendor') || primaryTxn.voucherNumber?.startsWith('OB-VEND-');
                const isGeneralOB = narrationLower.startsWith('opening balance') || primaryTxn.voucherNumber?.startsWith('OB-');

                if (isCustomerOB) {
                    balanceType = 'Debit'; // Customer (Debtors / Asset) is Debited
                    partyName = primaryTxn.ledger_transaction_debitLedgerIdToledger?.name || 'Customer';
                    accountType = primaryTxn.ledger_transaction_debitLedgerIdToledger?.accountgroup?.name || 'Debtors';
                    customerVendor = partyName;
                    customerName = partyName;
                    sourceModule = 'Customer Setup';
                } else if (isVendorOB) {
                    balanceType = 'Credit'; // Vendor (Creditors / Liability) is Credited
                    partyName = primaryTxn.ledger_transaction_creditLedgerIdToledger?.name || 'Vendor';
                    accountType = primaryTxn.ledger_transaction_creditLedgerIdToledger?.accountgroup?.name || 'Creditors';
                    customerVendor = partyName;
                    vendorName = partyName;
                    sourceModule = 'Vendor Setup';
                } else if (isGeneralOB) {
                    const isCreditEquity = (primaryTxn.ledger_transaction_creditLedgerIdToledger?.name || '').toLowerCase().includes('opening balance equity');
                    if (isCreditEquity) {
                        balanceType = 'Debit';
                        partyName = primaryTxn.ledger_transaction_debitLedgerIdToledger?.name || 'Opening Balance';
                        accountType = primaryTxn.ledger_transaction_debitLedgerIdToledger?.accountgroup?.name || 'General';
                        customerVendor = partyName;
                    } else {
                        balanceType = 'Credit';
                        partyName = primaryTxn.ledger_transaction_creditLedgerIdToledger?.name || 'Opening Balance';
                        accountType = primaryTxn.ledger_transaction_creditLedgerIdToledger?.accountgroup?.name || 'General';
                        customerVendor = partyName;
                    }
                } else {
                    // Regular Journal Voucher
                    const debitGroup = (primaryTxn.ledger_transaction_debitLedgerIdToledger?.accountgroup?.name || '').toLowerCase();
                    const creditGroup = (primaryTxn.ledger_transaction_creditLedgerIdToledger?.accountgroup?.name || '').toLowerCase();
                    if (debitGroup.includes('debtor') || debitGroup.includes('receivable')) {
                        balanceType = 'Debit';
                        partyName = primaryTxn.ledger_transaction_debitLedgerIdToledger?.name || 'Journal Entry';
                        accountType = primaryTxn.ledger_transaction_debitLedgerIdToledger?.accountgroup?.name;
                        customerVendor = partyName;
                        customerName = partyName;
                    } else if (creditGroup.includes('creditor') || creditGroup.includes('payable')) {
                        balanceType = 'Credit';
                        partyName = primaryTxn.ledger_transaction_creditLedgerIdToledger?.name || 'Journal Entry';
                        accountType = primaryTxn.ledger_transaction_creditLedgerIdToledger?.accountgroup?.name;
                        customerVendor = partyName;
                        vendorName = partyName;
                    } else {
                        balanceType = 'Transfer';
                        partyName = primaryTxn.ledger_transaction_debitLedgerIdToledger?.name || 'Journal Entry';
                        accountType = primaryTxn.ledger_transaction_debitLedgerIdToledger?.accountgroup?.name;
                        customerVendor = partyName;
                    }
                }

                const vNo = primaryTxn.journalentry?.voucherNumber || primaryTxn.voucherNumber;
                voucherNo = vNo || '-';

                // Try to find matching voucher from our Map, fallback to journalentry.id
                const lookupKey = `JOURNAL_${vNo}`;
                targetId = voucherMap.get(lookupKey) || null;
                vType = 'JOURNAL';

                currency = companyCurrency;
                exchangeRate = 1.0;
                const rawTotal = txns.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
                originalAmount = round2(rawTotal);
                amount = round2(rawTotal);

                if (!note && primaryTxn.journalentry) note = primaryTxn.journalentry.narration;
            }
            // Expense / Income / Contra, and other fallbacks
            else {
                if (primaryTxn.voucherType === 'SALES_RETURN') {
                    balanceType = 'Credit';
                } else if (primaryTxn.voucherType === 'PURCHASE_RETURN') {
                    balanceType = 'Debit';
                } else if (primaryTxn.voucherType === 'EXPENSE') {
                    balanceType = 'Credit'; // Cash outflow
                } else if (primaryTxn.voucherType === 'INCOME') {
                    balanceType = 'Debit'; // Cash inflow
                } else if (primaryTxn.voucherType === 'CONTRA') {
                    balanceType = 'Transfer';
                } else {
                    balanceType = ['INCOME', 'RECEIPT'].includes(primaryTxn.voucherType) ? 'Debit' : 'Credit';
                }

                partyName = balanceType === 'Debit'
                    ? primaryTxn.ledger_transaction_debitLedgerIdToledger?.name
                    : primaryTxn.ledger_transaction_creditLedgerIdToledger?.name;
                accountType = balanceType === 'Debit'
                    ? primaryTxn.ledger_transaction_debitLedgerIdToledger?.accountgroup?.name
                    : primaryTxn.ledger_transaction_creditLedgerIdToledger?.accountgroup?.name;

                if (['EXPENSE', 'INCOME', 'CONTRA'].includes(primaryTxn.voucherType)) {
                    targetId = primaryTxn.id;
                    if (primaryTxn.voucherType === 'CONTRA') {
                        const isBankTransfer = !primaryTxn.voucherNumber?.startsWith('CNT-');
                        if (isBankTransfer) {
                            vType = 'BANK_TRANSFER';
                        }
                    }
                } else if (['SALES_RETURN', 'PURCHASE_RETURN'].includes(primaryTxn.voucherType)) {
                    const lookupKey = `${primaryTxn.voucherType}_${primaryTxn.voucherNumber}`;
                    targetId = returnMap.get(lookupKey) || null;
                }

                currency = companyCurrency;
                exchangeRate = 1.0;
                const rawTotal = txns.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
                originalAmount = round2(rawTotal);
                amount = round2(rawTotal);
            }

            // Prefer non-COGS entries for primary account strings if available to avoid mixing internal valuation
            const debitAccountsSet = new Set();
            const creditAccountsSet = new Set();
            const nonCogsTxns = txns.filter(t => !t.voucherNumber?.startsWith('COGS-') && !t.narration?.toLowerCase().includes('cogs'));
            const displayTxns = nonCogsTxns.length > 0 ? nonCogsTxns : txns;

            displayTxns.forEach(t => {
                if (t.ledger_transaction_debitLedgerIdToledger?.name) debitAccountsSet.add(t.ledger_transaction_debitLedgerIdToledger.name);
                if (t.ledger_transaction_creditLedgerIdToledger?.name) creditAccountsSet.add(t.ledger_transaction_creditLedgerIdToledger.name);
            });

            // Specific clean fallbacks for standard vouchers
            if (key.startsWith('invoice_') && primaryTxn.invoice) {
                if (primaryTxn.invoice.customer?.name) {
                    debitAccountsSet.clear();
                    debitAccountsSet.add(primaryTxn.invoice.customer.name);
                }
                if (creditAccountsSet.size === 0) {
                    creditAccountsSet.add('Sales Income');
                }
            } else if (key.startsWith('purchasebill_') && primaryTxn.purchasebill) {
                if (primaryTxn.purchasebill.vendor?.name) {
                    creditAccountsSet.clear();
                    creditAccountsSet.add(primaryTxn.purchasebill.vendor.name);
                }
                if (debitAccountsSet.size === 0) {
                    debitAccountsSet.add('Inventory Asset');
                }
            } else if (key.startsWith('receipt_') && primaryTxn.receipt) {
                if (primaryTxn.receipt.cashBankAccount?.name) {
                    debitAccountsSet.clear();
                    debitAccountsSet.add(primaryTxn.receipt.cashBankAccount.name);
                }
                if (primaryTxn.receipt.customer?.name) {
                    creditAccountsSet.clear();
                    creditAccountsSet.add(primaryTxn.receipt.customer.name);
                }
            } else if (key.startsWith('payment_') && primaryTxn.payment) {
                if (primaryTxn.payment.vendor?.name) {
                    debitAccountsSet.clear();
                    debitAccountsSet.add(primaryTxn.payment.vendor.name);
                }
                if (primaryTxn.payment.bankLedger?.name) {
                    creditAccountsSet.clear();
                    creditAccountsSet.add(primaryTxn.payment.bankLedger.name);
                }
            }

            let debitAccountStr = [...debitAccountsSet].join(', ') || '-';
            let creditAccountStr = [...creditAccountsSet].join(', ') || '-';

            return {
                id: primaryTxn.id,
                date: primaryTxn.date,
                transactionId: `TXN-${primaryTxn.id.toString().padStart(5, '0')}`,
                targetId,
                balanceType,
                voucherType: vType,
                voucherNo,
                amount,
                originalAmount,
                partyName: partyName || customerVendor || (primaryTxn.ledger_transaction_debitLedgerIdToledger?.name) || '-',
                fromTo: partyName || customerVendor || 'Unknown',
                accountType: accountType || 'General',
                note: note || '-',
                debitAccount: debitAccountStr,
                creditAccount: creditAccountStr,
                customerVendor: ['JOURNAL'].includes(vType) ? (partyName || 'Journal Entry') : (customerVendor !== '-' && customerVendor !== '' ? customerVendor : (partyName || '-')),
                customerName: customerName || primaryTxn.invoice?.customer?.name || primaryTxn.receipt?.customer?.name || primaryTxn.posinvoice?.customer?.name || '-',
                vendorName: vendorName || primaryTxn.purchasebill?.vendor?.name || primaryTxn.payment?.vendor?.name || '-',
                postings: txns.map(t => {
                    const rawPostAmt = parseFloat(t.amount || 0);
                    const convertedPostAmt = (currency !== companyCurrency && exchangeRate && exchangeRate !== 1.0)
                        ? round2(rawPostAmt * exchangeRate)
                        : round2(rawPostAmt);
                    return {
                        id: t.id,
                        debitAccount: t.ledger_transaction_debitLedgerIdToledger?.name || '-',
                        creditAccount: t.ledger_transaction_creditLedgerIdToledger?.name || '-',
                        amount: convertedPostAmt,
                        originalAmount: round2(rawPostAmt)
                    };
                }),

                // Detailed product/item attributes
                items: itemsList.length > 0 ? itemsList.join(', ') : (vType === 'JOURNAL' ? '' : '-'),
                skus: skuList.length > 0 ? skuList.join(', ') : (vType === 'JOURNAL' ? '' : '-'),
                quantities: qtyList.length > 0 ? qtyList.join(', ') : (vType === 'JOURNAL' ? '' : '-'),
                units: unitList.length > 0 ? unitList.join(', ') : (vType === 'JOURNAL' ? '' : '-'),
                prices: priceList.length > 0 ? priceList.join(', ') : (vType === 'JOURNAL' ? '' : '-'),
                discounts: discList.length > 0 ? discList.join(', ') : (vType === 'JOURNAL' ? '' : '-'),
                taxes: taxList.length > 0 ? taxList.join(', ') : (vType === 'JOURNAL' ? '' : '-'),
                warehouses: whList.length > 0 ? whList.join(', ') : (vType === 'JOURNAL' ? '' : '-'),

                // Accounting Details
                currency,
                exchangeRate: exchangeRate === 1.0 ? 1.0 : parseFloat(Number(exchangeRate).toFixed(4)),
                status,
                referenceNo,
                paymentMethod,
                bankAccount,
                cashAccount,
                createdDate,
                lastUpdated,
                sourceModule
            };
        });

        const formattedTransfers = stockTransfers.map(st => {
            const items = st.stocktransferitem || [];
            const itemsList = items.map(item => item.product?.name || 'Item').filter(Boolean);
            const skuList = items.map(item => item.product?.sku || '-');
            const qtyList = items.map(item => item.quantity);
            const unitList = items.map(item => item.product?.uom?.unitName || item.product?.uom?.symbol || item.product?.unit || 'Pcs');
            const priceList = items.map(item => round2(item.rate || 0));
            const discList = items.map(() => 0);
            const taxList = items.map(() => 0);
            const whList = items.map(item => `${item.warehouse?.name || 'Warehouse'} → ${st.warehouse?.name || 'Warehouse'}`);

            const fromWarehouses = [...new Set(items.map(i => i.warehouse?.name).filter(Boolean))].join(', ');
            const toWarehouse = st.warehouse?.name || 'Destination';
            const transferRoute = `${fromWarehouses || 'Source'} → ${toWarehouse}`;
            const totalAmt = round2(st.totalAmount || 0);

            return {
                id: `st_${st.id}`,
                targetId: st.id,
                date: st.date,
                transactionId: `ST-${st.id.toString().padStart(5, '0')}`,
                voucherNo: st.voucherNo || `ST-${st.id}`,
                voucherType: 'STOCK_TRANSFER',
                balanceType: 'Transfer',
                amount: totalAmt,
                originalAmount: totalAmt,
                fromTo: transferRoute,
                accountType: 'Inventory',
                note: st.narration || 'Stock Transfer',
                debitAccount: `Inventory (${toWarehouse})`,
                creditAccount: `Inventory (${fromWarehouses || 'Source'})`,
                customerVendor: transferRoute,
                customerName: '-',
                vendorName: '-',
                postings: [
                    {
                        id: `st_post_dr_${st.id}`,
                        debitAccount: `Inventory (${toWarehouse})`,
                        creditAccount: '-',
                        amount: totalAmt,
                        originalAmount: totalAmt
                    },
                    {
                        id: `st_post_cr_${st.id}`,
                        debitAccount: '-',
                        creditAccount: `Inventory (${fromWarehouses || 'Source'})`,
                        amount: totalAmt,
                        originalAmount: totalAmt
                    }
                ],
                items: itemsList.join(', ') || '-',
                skus: skuList.join(', ') || '-',
                quantities: qtyList.join(', ') || '-',
                units: unitList.join(', ') || '-',
                prices: priceList.join(', ') || '-',
                discounts: discList.join(', ') || '-',
                taxes: taxList.join(', ') || '-',
                warehouses: whList.join(', ') || transferRoute,
                currency: companyCurrency,
                exchangeRate: 1.0,
                status: 'COMPLETED',
                referenceNo: st.manualVoucherNo || '-',
                paymentMethod: 'Transfer',
                bankAccount: '-',
                cashAccount: '-',
                createdDate: st.createdAt,
                lastUpdated: st.updatedAt || st.createdAt,
                sourceModule: 'Inventory'
            };
        });

        const allTransactions = [...formattedTransactions, ...formattedTransfers].sort((a, b) => {
            return new Date(b.date).getTime() - new Date(a.date).getTime();
        });

        res.status(200).json({ success: true, data: allTransactions });

    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

module.exports = {
    getSalesReport,
    getSalesByItemReport,
    getSalesByCustomerReport,
    getSalesBySalesmanReport,
    getPurchaseReport,
    getPurchaseByItemReport,
    getPurchaseByVendorReport,
    getPosReport,
    getTaxReport,
    getInventorySummary,
    getBalanceSheet,
    getCashFlowStatement,
    getProfitLoss,
    getVatReport,
    getDayBook,
    getJournalReport,
    getTrialBalance,
    getAllTransactions
};
