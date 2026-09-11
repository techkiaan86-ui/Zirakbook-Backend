const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const numberingService = require('../services/numberingService');

// Helper to get currency decimal places (KWD/BHD/OMR etc have 3, others have 2)
const getDecimalPlaces = (currency) => {
    const threeDecimalCurrencies = ['KWD', 'BHD', 'OMR', 'JOD', 'LYD', 'TND'];
    return threeDecimalCurrencies.includes(currency?.toUpperCase()) ? 3 : 2;
};

// Round value to specified decimal places
const roundTo = (val, decimals = 2) => {
    const factor = Math.pow(10, decimals);
    return Math.round(val * factor) / factor;
};

// Helper to reliably update bill balances
const updateBillBalance = async (tx, billId, deltaPaid) => {
    const bill = await tx.purchasebill.findUnique({ where: { id: billId } });
    if (bill) {
        const decimals = getDecimalPlaces(bill.currency || 'INR');
        const newPaid = Math.max(0, roundTo((bill.paidAmount || 0) + deltaPaid, decimals));
        const newBalance = Math.max(0, roundTo((bill.totalAmount || 0) - newPaid, decimals));
        const tolerance = decimals === 3 ? 0.001 : 0.01;
        await tx.purchasebill.update({
            where: { id: billId },
            data: {
                paidAmount: newPaid,
                balanceAmount: newBalance,
                status: newBalance <= tolerance ? 'PAID' : (newPaid > 0 ? 'PARTIAL' : 'UNPAID')
            }
        });
    }
};

const createPayment = async (req, res) => {
    try {
        const {
            paymentNumber,
            date,
            vendorId,
            purchaseBillId,
            amount,
            paymentMode,
            referenceNumber,
            cashBankAccountId,
            notes,
            discountAmount,
            discountLedgerId,
            allocations,
            customFields,
            manualStatus,
            status,
            advanceAmount,
            vendorTotalAmount,
            advanceAdjustmentAmount,
            advanceAdjustmentLedgerId
        } = req.body;
        const companyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        const parsedAmount = parseFloat(amount || 0);
        const parsedDiscount = parseFloat(discountAmount || 0);
        const parsedAdvanceAdj = parseFloat(advanceAdjustmentAmount || 0);
        const parsedTax = parseFloat(req.body.taxAmount || req.body.taxDeductedAmount || 0);
        const taxTargetLedgerId = req.body.taxLedgerId || req.body.taxDeductedLedgerId ? parseInt(req.body.taxLedgerId || req.body.taxDeductedLedgerId) : null;
        const parsedAdvanceAmount = parseFloat(advanceAmount || 0);
        const parsedVendorTotal = parseFloat(vendorTotalAmount || 0) || (parsedAmount + parsedDiscount + parsedAdvanceAdj + parsedTax);

        if (!vendorId || !cashBankAccountId) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        if (parsedVendorTotal <= 0 && parsedAmount <= 0 && parsedAdvanceAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Payment amount must be greater than zero' });
        }

        const vendor = await prisma.vendor.findUnique({
            where: { id: parseInt(vendorId) },
            include: { ledger: true }
        });

        const bankLedger = await prisma.ledger.findUnique({
            where: { id: parseInt(cashBankAccountId) }
        });

        if (!vendor || !vendor.ledgerId || !bankLedger) {
            return res.status(400).json({ success: false, message: 'Invalid vendor or bank/cash account' });
        }

        // Date must not be before the vendor's account creation date
        if (vendor.creationDate && date) {
            const txDate = new Date(date);
            const accountDate = new Date(vendor.creationDate);
            txDate.setHours(0, 0, 0, 0);
            accountDate.setHours(0, 0, 0, 0);
            if (txDate < accountDate) {
                return res.status(400).json({
                    success: false,
                    message: `Payment date (${txDate.toDateString()}) cannot be before the vendor's account creation date (${accountDate.toDateString()}).`
                });
            }
        }

        // Normalize payment mode for Prisma enum
        const modeMap = {
            'Bank Transfer': 'BANK',
            'Online': 'BANK',
            'UPI': 'UPI',
            'Cash': 'CASH',
            'Credit Card': 'CARD',
            'Cheque': 'CHEQUE'
        };
        const normalizedMode = modeMap[paymentMode] || 'OTHER';

        // Normalize allocations
        let normalizedAllocations = [];
        if (allocations && allocations.length > 0) {
            normalizedAllocations = allocations.map(a => ({
                purchaseBillId: parseInt(a.purchaseBillId),
                amount: parseFloat(a.amount)
            }));
        } else if (purchaseBillId) {
            normalizedAllocations = [{
                purchaseBillId: parseInt(purchaseBillId),
                amount: parsedAmount
            }];
        }

        const allocatedSum = normalizedAllocations.reduce((sum, a) => sum + a.amount, 0);
        const unallocatedAmount = Math.max(0, parsedAmount - allocatedSum);
        const isAdvance = unallocatedAmount > 0 || normalizedAllocations.length === 0;

        const result = await prisma.$transaction(async (tx) => {
            const payment = await tx.payment.create({
                data: {
                    customFields: (() => {
                        let cf = {};
                        if (customFields) {
                            try { cf = typeof customFields === 'string' ? JSON.parse(customFields) : customFields; } catch (e) { cf = {}; }
                        }
                        cf.vendorTotalAmount = parsedVendorTotal;
                        if (parsedAdvanceAdj > 0) {
                            cf.advanceAdjustmentAmount = parsedAdvanceAdj;
                            cf.advanceAdjustmentLedgerId = advanceAdjustmentLedgerId ? parseInt(advanceAdjustmentLedgerId) : null;
                        }
                        if (parsedTax > 0) {
                            cf.taxDeductedAmount = parsedTax;
                            cf.taxDeductedLedgerId = taxTargetLedgerId;
                        }
                        if (parsedAdvanceAmount > 0) {
                            cf.advanceAmount = parsedAdvanceAmount;
                        }
                        return Object.keys(cf).length > 0 ? JSON.stringify(cf) : null;
                    })(),
                    paymentNumber: paymentNumber || (await numberingService.getNextNumber(companyId, 'payment')).formattedNumber,
                    date: date ? new Date(date) : new Date(),
                    vendorId: parseInt(vendorId),
                    purchaseBillId: purchaseBillId ? parseInt(purchaseBillId) : (normalizedAllocations[0]?.purchaseBillId || null),
                    amount: parsedAmount,
                    paymentMode: normalizedMode,
                    referenceNumber,
                    cashBankAccountId: parseInt(cashBankAccountId),
                    companyId: parseInt(companyId),
                    notes,
                    discountAmount: parsedDiscount,
                    discountLedgerId: discountLedgerId ? parseInt(discountLedgerId) : null,
                    manualStatus: manualStatus === true || manualStatus === 'true',
                    status: (manualStatus === true || manualStatus === 'true') && status ? status : 'CLEARED',
                    isAdvance,
                    advanceUnallocated: unallocatedAmount
                }
            });

            let totalBankAmount = 0; // Bank credit in base currency
            let totalVendorAmount = 0; // Vendor debit in base currency
            let totalLedgerDiscount = 0; // Discount in base currency
            let totalForexDiff = 0; // Cumulative forex difference
            const appliedDiscount = parsedDiscount;

            // Payment exchange rate (from body or default to 1.0)
            const paymentRate = parseFloat(req.body.exchangeRate) || 1.0;

            // Find or create Foreign Exchange Gain/Loss Ledger
            let forexLedger = await tx.ledger.findFirst({
                where: { companyId: parseInt(companyId), name: 'Foreign Exchange Gain/Loss' }
            });
            if (!forexLedger) {
                let incomeGroup = await tx.accountgroup.findFirst({
                    where: { companyId: parseInt(companyId), type: 'INCOME' }
                });
                if (!incomeGroup) {
                    incomeGroup = await tx.accountgroup.create({
                        data: {
                            name: 'Indirect Income',
                            type: 'INCOME',
                            companyId: parseInt(companyId)
                        }
                    });
                }
                forexLedger = await tx.ledger.create({
                    data: {
                        name: 'Foreign Exchange Gain/Loss',
                        groupId: incomeGroup.id,
                        companyId: parseInt(companyId),
                        isControlAccount: false
                    }
                });
            }

            for (let i = 0; i < normalizedAllocations.length; i++) {
                const alloc = normalizedAllocations[i];

                // Create link record
                await tx.paymentbillallocation.create({
                    data: {
                        paymentId: payment.id,
                        purchaseBillId: alloc.purchaseBillId,
                        amount: alloc.amount,
                        companyId: parseInt(companyId)
                    }
                });

                const bill = await tx.purchasebill.findUnique({
                    where: { id: alloc.purchaseBillId }
                });

                if (bill) {
                    const allocDiscount = (i === 0) ? appliedDiscount : 0;
                    await updateBillBalance(tx, alloc.purchaseBillId, alloc.amount + allocDiscount);

                    const billRate = bill.exchangeRate || 1.0;
                    const bankAllocAmount = alloc.amount * paymentRate;
                    const vendorAllocAmount = alloc.amount * billRate;

                    totalBankAmount += bankAllocAmount;
                    totalVendorAmount += vendorAllocAmount;
                    totalLedgerDiscount += allocDiscount * billRate;

                    // Forex difference on Vendor Payment: cleared vendor liability - paid bank cash
                    const forexDiff = vendorAllocAmount - bankAllocAmount;
                    totalForexDiff += forexDiff;
                }
            }

            // Unallocated portion
            totalBankAmount += unallocatedAmount * paymentRate;
            totalVendorAmount += unallocatedAmount * paymentRate;
            totalBankAmount = (parsedAmount > 0 ? parsedAmount : (normalizedAllocations.length === 0 ? parsedVendorTotal : totalBankAmount)) * paymentRate;

            // Accounting Entries
            const transactions = [];

            // Discount Received (debit Vendor, credit Discount Received)
            if (discountLedgerId && totalLedgerDiscount > 0) {
                transactions.push({
                    date: date ? new Date(date) : new Date(),
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || payment.paymentNumber,
                    debitLedgerId: vendor.ledgerId,
                    creditLedgerId: parseInt(discountLedgerId),
                    amount: totalLedgerDiscount,
                    narration: `Discount received from ${vendor.name}`,
                    companyId: parseInt(companyId),
                    paymentId: payment.id
                });
            }

            // Tax Deducted / TDS (debit Vendor, credit Tax Liability)
            if (parsedTax > 0 && taxTargetLedgerId) {
                const taxInBase = parsedTax * paymentRate;
                transactions.push({
                    date: date ? new Date(date) : new Date(),
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || payment.paymentNumber,
                    debitLedgerId: vendor.ledgerId,
                    creditLedgerId: parseInt(taxTargetLedgerId),
                    amount: taxInBase,
                    narration: `Tax/TDS deducted on payment to ${vendor.name}`,
                    companyId: parseInt(companyId),
                    paymentId: payment.id
                });
            }

            // Advance Adjustment (debit Vendor, credit Advance Account)
            if (parsedAdvanceAdj > 0 && advanceAdjustmentLedgerId) {
                const advInBase = parsedAdvanceAdj * paymentRate;
                transactions.push({
                    date: date ? new Date(date) : new Date(),
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || payment.paymentNumber,
                    debitLedgerId: vendor.ledgerId,
                    creditLedgerId: parseInt(advanceAdjustmentLedgerId),
                    amount: advInBase,
                    narration: `Advance adjustment on payment to ${vendor.name}`,
                    companyId: parseInt(companyId),
                    paymentId: payment.id
                });
            }

            // Debit Vendor / Credit Bank and/or book Forex entries
            if (Math.abs(totalForexDiff) <= 0.001) {
                // Standard entry: DR Vendor, CR Bank
                transactions.push({
                    date: date ? new Date(date) : new Date(),
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || payment.paymentNumber,
                    debitLedgerId: vendor.ledgerId,
                    creditLedgerId: bankLedger.id,
                    amount: totalBankAmount,
                    narration: `Payment to ${vendor.name}`,
                    companyId: parseInt(companyId),
                    paymentId: payment.id
                });
            } else if (totalForexDiff > 0) {
                // Forex Gain (cleared liability > paid cash):
                // DR Vendor: totalVendorAmount
                // CR Bank: totalBankAmount
                // CR Forex Gain: totalForexDiff
                transactions.push({
                    date: date ? new Date(date) : new Date(),
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || payment.paymentNumber,
                    debitLedgerId: vendor.ledgerId,
                    creditLedgerId: bankLedger.id,
                    amount: totalBankAmount,
                    narration: `Payment to ${vendor.name}`,
                    companyId: parseInt(companyId),
                    paymentId: payment.id
                });
                transactions.push({
                    date: date ? new Date(date) : new Date(),
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || payment.paymentNumber,
                    debitLedgerId: vendor.ledgerId,
                    creditLedgerId: forexLedger.id,
                    amount: totalForexDiff,
                    narration: `Foreign Exchange Gain on payment to ${vendor.name}`,
                    companyId: parseInt(companyId),
                    paymentId: payment.id
                });
            } else {
                // Forex Loss (paid cash > cleared liability):
                // DR Vendor: totalVendorAmount
                // DR Forex Loss: Math.abs(totalForexDiff)
                // CR Bank: totalBankAmount
                transactions.push({
                    date: date ? new Date(date) : new Date(),
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || payment.paymentNumber,
                    debitLedgerId: vendor.ledgerId,
                    creditLedgerId: bankLedger.id,
                    amount: totalVendorAmount,
                    narration: `Payment to ${vendor.name} (Bill rate portion)`,
                    companyId: parseInt(companyId),
                    paymentId: payment.id
                });
                transactions.push({
                    date: date ? new Date(date) : new Date(),
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || payment.paymentNumber,
                    debitLedgerId: forexLedger.id,
                    creditLedgerId: bankLedger.id,
                    amount: Math.abs(totalForexDiff),
                    narration: `Foreign Exchange Loss on payment to ${vendor.name}`,
                    companyId: parseInt(companyId),
                    paymentId: payment.id
                });
            }

            const finalTxs = transactions.filter(t => t.amount > 0.001);
            for (const t of finalTxs) {
                await tx.transaction.create({ data: t });
            }

            // Update Ledger Balances strictly based on created transactions
            const allDbTxs = await tx.transaction.findMany({ where: { paymentId: payment.id } });
            const ledgerChanges = {};
            for (const t of allDbTxs) {
                ledgerChanges[t.debitLedgerId] = (ledgerChanges[t.debitLedgerId] || 0) + t.amount;
                ledgerChanges[t.creditLedgerId] = (ledgerChanges[t.creditLedgerId] || 0) - t.amount;
            }

            for (const [ledgerId, change] of Object.entries(ledgerChanges)) {
                if (change !== 0) {
                    await tx.ledger.update({
                        where: { id: parseInt(ledgerId) },
                        data: { currentBalance: { increment: change } }
                    });
                }
            }

            const finalVendorLedger = await tx.ledger.findUnique({ where: { id: vendor.ledgerId } });
            await tx.vendor.update({
                where: { id: vendor.id },
                data: { accountBalance: finalVendorLedger.currentBalance }
            });

            return payment;
        }, {
            timeout: 30000
        });

        await numberingService.incrementNumber(companyId, 'payment', paymentNumber || result.paymentNumber);
        const { logActivity } = require('../utils/auditLogger');
        logActivity(req, 'CREATE', 'Payment', result.id, `Payment #${result.paymentNumber} created for Vendor ID ${result.vendorId} with amount ${result.amount}`);
        res.status(201).json({ success: true, data: result });
    } catch (error) {
        console.error('Create Payment Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const getPayments = async (req, res) => {
    try {
        const {
            companyId,
            vendorId,
            startDate,
            endDate
        } = req.query;

        const currentCompanyId = req.user?.companyId || companyId;

        let where = {};
        if (currentCompanyId) where.companyId = parseInt(currentCompanyId);
        if (vendorId) where.vendorId = parseInt(vendorId);
        if (startDate && endDate) {
            where.date = {
                gte: new Date(startDate),
                lte: new Date(endDate)
            };
        }

        const payments = await prisma.payment.findMany({
            where,
            include: {
                vendor: true,
                bankLedger: { select: { id: true, name: true } },
                discountLedger: { select: { id: true, name: true } },
                allocations: {
                    include: {
                        purchasebill: true
                    }
                }
            },
            orderBy: {
                date: 'desc'
            }
        });

        // Map purchasebill and vendorTotalAmount for backwards compatibility and clarity
        const mapped = payments.map(p => {
            let customFieldsObj = {};
            if (p.customFields) {
                try {
                    customFieldsObj = typeof p.customFields === 'string' ? JSON.parse(p.customFields) : (p.customFields || {});
                } catch (e) {
                    customFieldsObj = {};
                }
            }
            const vendorTotalAmount = customFieldsObj.vendorTotalAmount !== undefined
                ? parseFloat(customFieldsObj.vendorTotalAmount)
                : (parseFloat(p.amount || 0) + parseFloat(p.discountAmount || 0));

            return {
                ...p,
                purchasebill: p.allocations[0]?.purchasebill || null,
                vendorTotalAmount
            };
        });

        res.json(mapped);
    } catch (error) {
        console.error('Get Payments Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const getPaymentById = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        const payment = await prisma.payment.findUnique({
            where: { id: parseInt(id), companyId: parseInt(companyId) },
            include: {
                vendor: { include: { ledger: true } },
                company: true,
                bankLedger: true,
                discountLedger: true,
                allocations: {
                    include: {
                        purchasebill: true
                    }
                }
            }
        });
        if (!payment) return res.status(404).json({ message: 'Payment not found' });

        let customFieldsObj = {};
        if (payment.customFields) {
            try {
                customFieldsObj = typeof payment.customFields === 'string' ? JSON.parse(payment.customFields) : (payment.customFields || {});
            } catch (e) {
                customFieldsObj = {};
            }
        }

        const paymentTransactions = await prisma.transaction.findMany({
            where: { paymentId: payment.id, voucherType: 'PAYMENT' }
        });

        const advAdjTx = paymentTransactions.find(t =>
            t.narration && (t.narration.toLowerCase().includes('advance adjustment') || t.narration.toLowerCase().includes('advance adj'))
        );
        const taxTx = paymentTransactions.find(t =>
            t.narration && (t.narration.toLowerCase().includes('tax/tds') || t.narration.toLowerCase().includes('tds') || t.narration.toLowerCase().includes('tax deducted'))
        );

        const advanceAdjustmentAmount = customFieldsObj.advanceAdjustmentAmount !== undefined
            ? parseFloat(customFieldsObj.advanceAdjustmentAmount)
            : (advAdjTx ? parseFloat(advAdjTx.amount) : 0);

        const advanceAdjustmentLedgerId = customFieldsObj.advanceAdjustmentLedgerId
            ? parseInt(customFieldsObj.advanceAdjustmentLedgerId)
            : (advAdjTx ? advAdjTx.creditLedgerId : null);

        const taxDeductedAmount = customFieldsObj.taxDeductedAmount !== undefined
            ? parseFloat(customFieldsObj.taxDeductedAmount)
            : (taxTx ? parseFloat(taxTx.amount) : (payment.taxAmount || 0));

        const taxDeductedLedgerId = customFieldsObj.taxDeductedLedgerId
            ? parseInt(customFieldsObj.taxDeductedLedgerId)
            : (taxTx ? taxTx.creditLedgerId : (payment.taxLedgerId || null));

        const vendorTotalAmount = customFieldsObj.vendorTotalAmount !== undefined
            ? parseFloat(customFieldsObj.vendorTotalAmount)
            : (parseFloat(payment.amount || 0) + parseFloat(payment.discountAmount || 0) + advanceAdjustmentAmount + taxDeductedAmount);

        // Calculate historical point-in-time balance due for purchase bill allocations
        const billIds = [...new Set((payment.allocations || []).map(a => a.purchaseBillId).filter(Boolean))];

        const [allBillAllocs, allBillReturns] = await Promise.all([
            billIds.length > 0 ? prisma.paymentbillallocation.findMany({
                where: { purchaseBillId: { in: billIds }, companyId: parseInt(companyId) },
                include: {
                    payment: { select: { id: true, date: true, createdAt: true, discountAmount: true } }
                },
                orderBy: [{ id: 'asc' }]
            }) : [],
            billIds.length > 0 ? prisma.purchasereturn.findMany({
                where: { purchaseBillId: { in: billIds }, companyId: parseInt(companyId) },
                select: { id: true, purchaseBillId: true, date: true, totalAmount: true }
            }) : []
        ]);

        const currentPaymentDate = payment.date ? new Date(payment.date).getTime() : 0;
        const currentPaymentId = payment.id;

        const isPaymentPriorOrEqual = (p) => {
            if (!p) return false;
            const pDate = p.date ? new Date(p.date).getTime() : 0;
            if (pDate < currentPaymentDate) return true;
            if (pDate > currentPaymentDate) return false;
            return p.id <= currentPaymentId;
        };

        const minAllocByPayment = {};
        allBillAllocs.forEach(a => {
            if (minAllocByPayment[a.paymentId] === undefined || a.id < minAllocByPayment[a.paymentId]) {
                minAllocByPayment[a.paymentId] = a.id;
            }
        });

        const mappedAllocations = (payment.allocations || []).map(a => {
            const billTotal = parseFloat(a.purchasebill?.totalAmount || 0);

            const matchingAllocs = allBillAllocs.filter(ba => ba.purchaseBillId === a.purchaseBillId && isPaymentPriorOrEqual(ba.payment));
            let cumulativePaid = 0;
            matchingAllocs.forEach(ba => {
                const isFirst = ba.id === minAllocByPayment[ba.paymentId];
                const disc = isFirst ? parseFloat(ba.payment?.discountAmount || 0) : 0;
                cumulativePaid += parseFloat(ba.amount || 0) + disc;
            });

            const matchingReturns = allBillReturns.filter(ret => {
                if (ret.purchaseBillId !== a.purchaseBillId) return false;
                const retDate = ret.date ? new Date(ret.date).getTime() : 0;
                return retDate <= currentPaymentDate;
            });
            let cumulativeReturns = 0;
            matchingReturns.forEach(ret => {
                cumulativeReturns += parseFloat(ret.totalAmount || 0);
            });

            const balanceDue = Math.max(0, parseFloat((billTotal - cumulativePaid - cumulativeReturns).toFixed(2)));

            return {
                ...a,
                balanceDue,
                purchasebill: a.purchasebill ? {
                    ...a.purchasebill,
                    balanceAmount: balanceDue,
                    balanceDue
                } : null
            };
        });

        // Map purchasebill for backwards compatibility
        const mapped = {
            ...payment,
            allocations: mappedAllocations,
            purchasebill: mappedAllocations[0]?.purchasebill || null,
            vendorTotalAmount,
            advanceAdjustmentAmount,
            advanceAdjustmentLedgerId,
            taxDeductedAmount,
            taxDeductedLedgerId,
            taxAmount: taxDeductedAmount,
            taxLedgerId: taxDeductedLedgerId
        };

        res.json({ success: true, data: mapped, ...mapped });
    } catch (error) {
        console.error('Get Payment By ID Error:', error);
        res.status(500).json({ error: error.message });
    }
};

// Update Payment
const updatePayment = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            paymentNumber,
            date,
            vendorId,
            purchaseBillId,
            amount,
            paymentMode,
            referenceNumber,
            cashBankAccountId,
            notes,
            discountAmount,
            discountLedgerId,
            allocations,
            customFields,
            manualStatus,
            status,
            onlyUpdateStatus,
            vendorTotalAmount,
            advanceAdjustmentAmount,
            advanceAdjustmentLedgerId,
            taxAmount,
            taxDeductedAmount,
            taxLedgerId,
            taxDeductedLedgerId,
            advanceAmount
        } = req.body;
        const currentCompanyId = req.user?.companyId || req.query.companyId || req.body.companyId;

        if (onlyUpdateStatus === true || onlyUpdateStatus === 'true') {
            const updated = await prisma.payment.update({
                where: { id: parseInt(id) },
                data: {
                    manualStatus: manualStatus === true || manualStatus === 'true',
                    status: status
                }
            });
            return res.status(200).json({ success: true, data: updated });
        }

        const existingPayment = await prisma.payment.findUnique({
            where: { id: parseInt(id) },
            include: {
                vendor: true,
                allocations: {
                    include: { purchasebill: true }
                }
            }
        });

        if (!existingPayment) {
            return res.status(404).json({ message: 'Payment not found' });
        }

        const modeMap = {
            'Bank Transfer': 'BANK',
            'Online': 'BANK',
            'UPI': 'UPI',
            'Cash': 'CASH',
            'Credit Card': 'CARD',
            'Cheque': 'CHEQUE'
        };
        const normalizedMode = modeMap[paymentMode] || 'OTHER';

        const parsedAmount = amount !== undefined ? parseFloat(amount || 0) : existingPayment.amount;
        const parsedDiscount = discountAmount !== undefined ? parseFloat(discountAmount || 0) : (existingPayment.discountAmount || 0);
        const parsedAdvanceAdj = advanceAdjustmentAmount !== undefined ? parseFloat(advanceAdjustmentAmount || 0) : 0;
        const parsedTax = parseFloat(taxAmount || taxDeductedAmount || 0);
        const taxTargetLedgerId = taxLedgerId || taxDeductedLedgerId ? parseInt(taxLedgerId || taxDeductedLedgerId) : null;
        const parsedAdvanceAdjLedgerId = advanceAdjustmentLedgerId ? parseInt(advanceAdjustmentLedgerId) : null;
        const parsedAdvanceAmount = advanceAmount !== undefined ? parseFloat(advanceAmount || 0) : 0;
        const parsedVendorTotal = vendorTotalAmount !== undefined ? parseFloat(vendorTotalAmount || 0) : (parsedAmount + parsedDiscount + parsedAdvanceAdj + parsedTax);

        // Normalize new allocations
        let normalizedNewAllocations = [];
        if (allocations && allocations.length > 0) {
            normalizedNewAllocations = allocations.map(a => ({
                purchaseBillId: parseInt(a.purchaseBillId),
                amount: parseFloat(a.amount)
            }));
        } else if (req.body.purchaseBillId) {
            normalizedNewAllocations = [{
                purchaseBillId: parseInt(req.body.purchaseBillId),
                amount: parsedAmount
            }];
        }

        const result = await prisma.$transaction(async (tx) => {
            // 1. REVERSE PREVIOUS EFFECTS
            // Reverse Bills based on old allocations
            const oldDiscount = existingPayment.discountAmount || 0;
            for (let i = 0; i < existingPayment.allocations.length; i++) {
                const oldAlloc = existingPayment.allocations[i];
                const bill = await tx.purchasebill.findUnique({ where: { id: oldAlloc.purchaseBillId } });
                if (bill) {
                    const oldAllocDiscount = (i === 0) ? oldDiscount : 0;
                    await updateBillBalance(tx, oldAlloc.purchaseBillId, -(oldAlloc.amount + oldAllocDiscount));
                }
            }

            // Reverse all old ledger changes from transactions
            const oldTransactions = await tx.transaction.findMany({
                where: { paymentId: existingPayment.id, voucherType: 'PAYMENT' }
            });

            const oldLedgerChanges = {};
            for (const t of oldTransactions) {
                oldLedgerChanges[t.debitLedgerId] = (oldLedgerChanges[t.debitLedgerId] || 0) - t.amount;
                oldLedgerChanges[t.creditLedgerId] = (oldLedgerChanges[t.creditLedgerId] || 0) + t.amount;
            }

            for (const [ledgerId, change] of Object.entries(oldLedgerChanges)) {
                if (change !== 0) {
                    await tx.ledger.update({
                        where: { id: parseInt(ledgerId) },
                        data: { currentBalance: { increment: change } }
                    });
                }
            }

            // Delete old transactions & old allocations
            await tx.transaction.deleteMany({ where: { paymentId: existingPayment.id } });
            await tx.paymentbillallocation.deleteMany({ where: { paymentId: existingPayment.id } });

            // 2. APPLY NEW EFFECTS
            const finalBankId = cashBankAccountId ? parseInt(cashBankAccountId) : existingPayment.cashBankAccountId;
            const finalDiscountLedgerId = discountLedgerId !== undefined ? (discountLedgerId ? parseInt(discountLedgerId) : null) : existingPayment.discountLedgerId;

            let parsedCustomFields = {};
            if (customFields !== undefined) {
                try {
                    parsedCustomFields = typeof customFields === 'string' ? JSON.parse(customFields) : (customFields || {});
                } catch (e) {
                    parsedCustomFields = {};
                }
            } else if (existingPayment.customFields) {
                try {
                    parsedCustomFields = typeof existingPayment.customFields === 'string' ? JSON.parse(existingPayment.customFields) : (existingPayment.customFields || {});
                } catch (e) {
                    parsedCustomFields = {};
                }
            }
            parsedCustomFields.vendorTotalAmount = parsedVendorTotal;
            parsedCustomFields.advanceAdjustmentAmount = parsedAdvanceAdj;
            parsedCustomFields.advanceAdjustmentLedgerId = parsedAdvanceAdjLedgerId;
            parsedCustomFields.taxDeductedAmount = parsedTax;
            parsedCustomFields.taxDeductedLedgerId = taxTargetLedgerId;
            if (parsedAdvanceAmount > 0) {
                parsedCustomFields.advanceAmount = parsedAdvanceAmount;
            }

            const updatedPayment = await tx.payment.update({
                where: { id: parseInt(id) },
                data: {
                    customFields: Object.keys(parsedCustomFields).length > 0 ? JSON.stringify(parsedCustomFields) : null,
                    paymentNumber,
                    date: date ? new Date(date) : undefined,
                    vendorId: vendorId ? parseInt(vendorId) : undefined,
                    purchaseBillId: req.body.purchaseBillId ? parseInt(req.body.purchaseBillId) : (normalizedNewAllocations[0]?.purchaseBillId || null),
                    amount: parsedAmount,
                    paymentMode: normalizedMode,
                    referenceNumber,
                    cashBankAccountId: finalBankId,
                    notes,
                    discountAmount: parsedDiscount,
                    discountLedgerId: finalDiscountLedgerId,
                    manualStatus: manualStatus === true || manualStatus === 'true',
                    status: status !== undefined ? status : undefined
                },
                include: { vendor: { include: { ledger: true } } }
            });

            const newVendor = updatedPayment.vendor;
            if (!newVendor || !newVendor.ledgerId) {
                throw new Error('Vendor ledger not found. Please link a ledger to the selected vendor first.');
            }

            // Create new allocations and update new Bills
            let totalBankAmount = 0; // Bank credit in base currency
            let totalVendorAmount = 0; // Vendor debit in base currency
            let totalLedgerDiscount = 0; // Discount in base currency
            let totalForexDiff = 0; // Cumulative forex difference
            const newAllocatedSum = normalizedNewAllocations.reduce((sum, a) => sum + a.amount, 0);
            const unallocatedAmount = Math.max(0, parsedAmount - newAllocatedSum);

            // Payment exchange rate
            const paymentRate = parseFloat(req.body.exchangeRate) || 1.0;

            // Find or create Foreign Exchange Gain/Loss Ledger
            let forexLedger = await tx.ledger.findFirst({
                where: { companyId: parseInt(currentCompanyId), name: 'Foreign Exchange Gain/Loss' }
            });
            if (!forexLedger) {
                let incomeGroup = await tx.accountgroup.findFirst({
                    where: { companyId: parseInt(currentCompanyId), type: 'INCOME' }
                });
                if (!incomeGroup) {
                    incomeGroup = await tx.accountgroup.create({
                        data: {
                            name: 'Indirect Income',
                            type: 'INCOME',
                            companyId: parseInt(currentCompanyId)
                        }
                    });
                }
                forexLedger = await tx.ledger.create({
                    data: {
                        name: 'Foreign Exchange Gain/Loss',
                        groupId: incomeGroup.id,
                        companyId: parseInt(currentCompanyId),
                        isControlAccount: false
                    }
                });
            }

            for (let i = 0; i < normalizedNewAllocations.length; i++) {
                const alloc = normalizedNewAllocations[i];

                await tx.paymentbillallocation.create({
                    data: {
                        paymentId: parseInt(id),
                        purchaseBillId: alloc.purchaseBillId,
                        amount: alloc.amount,
                        companyId: parseInt(currentCompanyId)
                    }
                });

                const bill = await tx.purchasebill.findUnique({ where: { id: alloc.purchaseBillId } });
                if (bill) {
                    const allocDiscount = (i === 0) ? parsedDiscount : 0;
                    await updateBillBalance(tx, alloc.purchaseBillId, alloc.amount + allocDiscount);

                    const billRate = bill.exchangeRate || 1.0;
                    const bankAllocAmount = alloc.amount * paymentRate;
                    const vendorAllocAmount = alloc.amount * billRate;

                    totalBankAmount += bankAllocAmount;
                    totalVendorAmount += vendorAllocAmount;
                    totalLedgerDiscount += allocDiscount * billRate;

                    // Forex difference on Vendor Payment: cleared vendor liability - paid bank cash
                    const forexDiff = vendorAllocAmount - bankAllocAmount;
                    totalForexDiff += forexDiff;
                }
            }
            // Unallocated portion
            totalBankAmount += unallocatedAmount * paymentRate;
            totalVendorAmount += unallocatedAmount * paymentRate;
            totalBankAmount = (parsedAmount > 0 ? parsedAmount : (normalizedNewAllocations.length === 0 ? parsedVendorTotal : totalBankAmount)) * paymentRate;

            // Accounting Entries
            const transactions = [];

            // Discount Received (debit Vendor, credit Discount Received)
            if (finalDiscountLedgerId && totalLedgerDiscount > 0) {
                transactions.push({
                    date: date ? new Date(date) : updatedPayment.date,
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || updatedPayment.paymentNumber,
                    debitLedgerId: newVendor.ledgerId,
                    creditLedgerId: parseInt(finalDiscountLedgerId),
                    amount: totalLedgerDiscount,
                    narration: `Updated Discount received from ${newVendor.name}`,
                    companyId: parseInt(currentCompanyId),
                    paymentId: updatedPayment.id
                });
            }

            // Tax Deducted / TDS (debit Vendor, credit Tax Liability)
            if (parsedTax > 0 && taxTargetLedgerId) {
                const taxInBase = parsedTax * paymentRate;
                transactions.push({
                    date: date ? new Date(date) : updatedPayment.date,
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || updatedPayment.paymentNumber,
                    debitLedgerId: newVendor.ledgerId,
                    creditLedgerId: parseInt(taxTargetLedgerId),
                    amount: taxInBase,
                    narration: `Updated Tax/TDS deducted on payment to ${newVendor.name}`,
                    companyId: parseInt(currentCompanyId),
                    paymentId: updatedPayment.id
                });
            }

            // Advance Adjustment (debit Vendor, credit Advance Account)
            if (parsedAdvanceAdj > 0 && parsedAdvanceAdjLedgerId) {
                const advInBase = parsedAdvanceAdj * paymentRate;
                transactions.push({
                    date: date ? new Date(date) : updatedPayment.date,
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || updatedPayment.paymentNumber,
                    debitLedgerId: newVendor.ledgerId,
                    creditLedgerId: parseInt(parsedAdvanceAdjLedgerId),
                    amount: advInBase,
                    narration: `Updated Advance adjustment on payment to ${newVendor.name}`,
                    companyId: parseInt(currentCompanyId),
                    paymentId: updatedPayment.id
                });
            }

            // Debit Vendor / Credit Bank and/or book Forex entries
            if (Math.abs(totalForexDiff) <= 0.001) {
                // Standard entry: DR Vendor, CR Bank
                transactions.push({
                    date: date ? new Date(date) : updatedPayment.date,
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || updatedPayment.paymentNumber,
                    debitLedgerId: newVendor.ledgerId,
                    creditLedgerId: finalBankId,
                    amount: totalBankAmount,
                    narration: `Updated Payment to ${newVendor.name}`,
                    companyId: parseInt(currentCompanyId),
                    paymentId: updatedPayment.id
                });
            } else if (totalForexDiff > 0) {
                // Forex Gain:
                // DR Vendor: totalVendorAmount
                // CR Bank: totalBankAmount
                // CR Forex Gain: totalForexDiff
                transactions.push({
                    date: date ? new Date(date) : updatedPayment.date,
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || updatedPayment.paymentNumber,
                    debitLedgerId: newVendor.ledgerId,
                    creditLedgerId: finalBankId,
                    amount: totalBankAmount,
                    narration: `Updated Payment to ${newVendor.name}`,
                    companyId: parseInt(currentCompanyId),
                    paymentId: updatedPayment.id
                });
                transactions.push({
                    date: date ? new Date(date) : updatedPayment.date,
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || updatedPayment.paymentNumber,
                    debitLedgerId: newVendor.ledgerId,
                    creditLedgerId: forexLedger.id,
                    amount: totalForexDiff,
                    narration: `Updated Foreign Exchange Gain on payment to ${newVendor.name}`,
                    companyId: parseInt(currentCompanyId),
                    paymentId: updatedPayment.id
                });
            } else {
                // Forex Loss:
                // DR Vendor: totalVendorAmount
                // DR Forex Loss: Math.abs(totalForexDiff)
                // CR Bank: totalBankAmount
                transactions.push({
                    date: date ? new Date(date) : updatedPayment.date,
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || updatedPayment.paymentNumber,
                    debitLedgerId: newVendor.ledgerId,
                    creditLedgerId: finalBankId,
                    amount: totalVendorAmount,
                    narration: `Updated Payment to ${newVendor.name} (Bill rate portion)`,
                    companyId: parseInt(currentCompanyId),
                    paymentId: updatedPayment.id
                });
                transactions.push({
                    date: date ? new Date(date) : updatedPayment.date,
                    voucherType: 'PAYMENT',
                    voucherNumber: paymentNumber || updatedPayment.paymentNumber,
                    debitLedgerId: forexLedger.id,
                    creditLedgerId: finalBankId,
                    amount: Math.abs(totalForexDiff),
                    narration: `Updated Foreign Exchange Loss on payment to ${newVendor.name}`,
                    companyId: parseInt(currentCompanyId),
                    paymentId: updatedPayment.id
                });
            }

            const finalTxs = transactions.filter(t => t.amount > 0.001);
            for (const t of finalTxs) {
                await tx.transaction.create({ data: t });
            }

            // Update Ledger Balances strictly based on created transactions
            const allDbTxs = await tx.transaction.findMany({ where: { paymentId: updatedPayment.id } });
            const ledgerChanges = {};
            for (const t of allDbTxs) {
                ledgerChanges[t.debitLedgerId] = (ledgerChanges[t.debitLedgerId] || 0) + t.amount;
                ledgerChanges[t.creditLedgerId] = (ledgerChanges[t.creditLedgerId] || 0) - t.amount;
            }

            for (const [ledgerId, change] of Object.entries(ledgerChanges)) {
                if (change !== 0) {
                    await tx.ledger.update({
                        where: { id: parseInt(ledgerId) },
                        data: { currentBalance: { increment: change } }
                    });
                }
            }

            const finalVendorLedger = await tx.ledger.findUnique({ where: { id: newVendor.ledgerId } });
            if (finalVendorLedger) {
                await tx.vendor.update({
                    where: { id: newVendor.id },
                    data: { accountBalance: finalVendorLedger.currentBalance }
                });
            }

            return updatedPayment;
        }, {
            timeout: 30000
        });

        const { logActivity } = require('../utils/auditLogger');
        logActivity(req, 'UPDATE', 'Payment', result.id, `Payment #${result.paymentNumber} updated for Vendor ID ${result.vendorId} with amount ${result.amount}`);
        res.json(result);
    } catch (error) {
        console.error('Update Payment Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const deletePayment = async (req, res) => {
    try {
        const { id } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        const payment = await prisma.payment.findFirst({
            where: { id: parseInt(id), companyId: parseInt(companyId) },
            include: {
                vendor: true,
                allocations: {
                    include: { purchasebill: true }
                }
            }
        });

        if (!payment) return res.status(404).json({ message: 'Payment not found' });

        await prisma.$transaction(async (tx) => {
            // Reverse Bills paid amounts based on old allocations
            const oldDiscount = payment.discountAmount || 0;
            for (let i = 0; i < payment.allocations.length; i++) {
                const oldAlloc = payment.allocations[i];
                const bill = await tx.purchasebill.findUnique({ where: { id: oldAlloc.purchaseBillId } });
                if (bill) {
                    const oldAllocDiscount = (i === 0) ? oldDiscount : 0;
                    await updateBillBalance(tx, oldAlloc.purchaseBillId, -(oldAlloc.amount + oldAllocDiscount));
                }
            }

            // Calculate old ledger amounts to revert
            let oldLedgerAmount = 0;
            let oldLedgerDiscount = 0;
            const oldAllocatedSum = payment.allocations.reduce((sum, a) => sum + a.amount, 0);
            const oldUnallocatedAmount = payment.amount - oldAllocatedSum;

            for (let i = 0; i < payment.allocations.length; i++) {
                const oldAlloc = payment.allocations[i];
                const rate = oldAlloc.purchasebill?.exchangeRate || 1.0;
                oldLedgerAmount += oldAlloc.amount * rate;
                if (i === 0) {
                    oldLedgerDiscount += oldDiscount * rate;
                }
            }
            oldLedgerAmount += oldUnallocatedAmount;

            // Reverse Vendor ledger balance
            if (payment.vendor?.ledgerId) {
                const vendorLedger = await tx.ledger.findUnique({ where: { id: payment.vendor.ledgerId } });
                if (vendorLedger) {
                    await tx.ledger.update({
                        where: { id: payment.vendor.ledgerId },
                        data: { currentBalance: { increment: oldLedgerAmount + oldLedgerDiscount } }
                    });
                }
                await tx.vendor.update({
                    where: { id: payment.vendorId },
                    data: { accountBalance: { increment: oldLedgerAmount + oldLedgerDiscount } }
                });
            }

            if (payment.cashBankAccountId) {
                const bankLedger = await tx.ledger.findUnique({ where: { id: payment.cashBankAccountId } });
                if (bankLedger) {
                    await tx.ledger.update({
                        where: { id: payment.cashBankAccountId },
                        data: { currentBalance: { increment: oldLedgerAmount } }
                    });
                }
            }

            if (payment.discountLedgerId && oldLedgerDiscount > 0) {
                const discountLedger = await tx.ledger.findUnique({ where: { id: payment.discountLedgerId } });
                if (discountLedger) {
                    await tx.ledger.update({
                        where: { id: payment.discountLedgerId },
                        data: { currentBalance: { decrement: oldLedgerDiscount } }
                    });
                }
            }

            // Delete transactions, allocations and payment
            await tx.transaction.deleteMany({ where: { paymentId: payment.id } });
            await tx.paymentbillallocation.deleteMany({ where: { paymentId: payment.id } });
            await tx.payment.delete({ where: { id: parseInt(id), companyId: parseInt(companyId) } });
        }, {
            timeout: 30000
        });

        const { logActivity } = require('../utils/auditLogger');
        logActivity(req, 'DELETE', 'Payment', payment.id, `Payment #${payment.paymentNumber} deleted for Vendor ID ${payment.vendorId} with amount ${payment.amount}`);
        res.json({ success: true, message: 'Payment deleted successfully' });
    } catch (error) {
        console.error('Delete Payment Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const deletePaymentHelper = async (tx, payment, companyId) => {
    const fullPayment = await tx.payment.findUnique({
        where: { id: payment.id },
        include: {
            allocations: { include: { purchasebill: true } }
        }
    });

    if (!fullPayment) return;

    // Reverse Bills paid amounts based on old allocations
    const oldDiscount = fullPayment.discountAmount || 0;
    for (let i = 0; i < fullPayment.allocations.length; i++) {
        const oldAlloc = fullPayment.allocations[i];
        const bill = await tx.purchasebill.findUnique({ where: { id: oldAlloc.purchaseBillId } });
        if (bill) {
            const oldAllocDiscount = (i === 0) ? oldDiscount : 0;
            const revPaid = Math.max(0, (bill.paidAmount || 0) - oldAlloc.amount - oldAllocDiscount);
            const revBalance = bill.totalAmount - revPaid;
            await tx.purchasebill.update({
                where: { id: oldAlloc.purchaseBillId },
                data: {
                    paidAmount: revPaid,
                    balanceAmount: revBalance,
                    status: revBalance <= 0 ? 'PAID' : (revPaid > 0 ? 'PARTIAL' : 'UNPAID')
                }
            });
        }
    }

    // Calculate old ledger amounts to revert
    let oldLedgerAmount = 0;
    let oldLedgerDiscount = 0;
    const oldAllocatedSum = fullPayment.allocations.reduce((sum, a) => sum + a.amount, 0);
    const oldUnallocatedAmount = fullPayment.amount - oldAllocatedSum;

    for (let i = 0; i < fullPayment.allocations.length; i++) {
        const oldAlloc = fullPayment.allocations[i];
        const rate = oldAlloc.purchasebill?.exchangeRate || 1.0;
        oldLedgerAmount += oldAlloc.amount * rate;
        if (i === 0) {
            oldLedgerDiscount += oldDiscount * rate;
        }
    }
    oldLedgerAmount += oldUnallocatedAmount;

    // Reverse Vendor ledger balance
    const vendor = await tx.vendor.findUnique({ where: { id: fullPayment.vendorId } });
    if (vendor && vendor.ledgerId) {
        await tx.ledger.update({
            where: { id: vendor.ledgerId },
            data: { currentBalance: { increment: oldLedgerAmount + oldLedgerDiscount } }
        });
        await tx.vendor.update({
            where: { id: fullPayment.vendorId },
            data: { accountBalance: { increment: oldLedgerAmount + oldLedgerDiscount } }
        });
    }

    if (fullPayment.cashBankAccountId) {
        await tx.ledger.update({
            where: { id: fullPayment.cashBankAccountId },
            data: { currentBalance: { increment: oldLedgerAmount } }
        });
    }

    if (fullPayment.discountLedgerId && oldLedgerDiscount > 0) {
        await tx.ledger.update({
            where: { id: fullPayment.discountLedgerId },
            data: { currentBalance: { decrement: oldLedgerDiscount } }
        });
    }

    // Delete transactions, allocations and payment
    await tx.transaction.deleteMany({ where: { paymentId: fullPayment.id } });
    await tx.paymentbillallocation.deleteMany({ where: { paymentId: fullPayment.id } });
    await tx.payment.delete({ where: { id: fullPayment.id } });
};

// Fetch open advance payments for a vendor
const getVendorAdvance = async (req, res) => {
    try {
        const { vendorId } = req.params;
        const companyId = req.user?.companyId || req.query.companyId;

        if (!vendorId) {
            return res.status(400).json({ success: false, message: 'Vendor ID is required' });
        }

        const advancePayments = await prisma.payment.findMany({
            where: {
                vendorId: parseInt(vendorId),
                companyId: parseInt(companyId),
                advanceUnallocated: { gt: 0 }
            },
            orderBy: { date: 'asc' }
        });

        const totalAdvance = advancePayments.reduce((sum, p) => sum + p.advanceUnallocated, 0);

        return res.json({
            success: true,
            totalAdvance,
            advancePayments
        });
    } catch (error) {
        console.error('Error fetching vendor advance:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

const getNextNumber = async (req, res) => {
    try {
        const companyId = parseInt(req.query.companyId || req.user?.companyId);
        if (!companyId) {
            return res.status(400).json({ success: false, message: 'Company ID is required' });
        }
        const result = await numberingService.getNextNumber(companyId, 'payment');
        return res.json({
            success: true,
            nextNumber: result.formattedNumber,
            details: result
        });
    } catch (error) {
        console.error('Error fetching next payment number:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    createPayment,
    getPayments,
    getPaymentById,
    updatePayment,
    deletePayment,
    deletePaymentHelper,
    getVendorAdvance,
    getNextNumber
};
