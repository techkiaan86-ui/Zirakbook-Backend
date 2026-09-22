const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const bcrypt = require('bcryptjs');

const getPasswordRequests = async (req, res) => {
    try {
        const { companyId: userCompanyId, role } = req.user;
        const queryCompanyId = req.query.companyId;

        let requests;

        if (role === 'SUPERADMIN' || role === 'superadmin') {
            // Superadmin sees requests. If companyId is provided in query, filter by it.
            const filter = queryCompanyId ? { companyId: parseInt(queryCompanyId) } : {};
            requests = await prisma.passwordrequest.findMany({
                where: filter,
                include: {
                    user: {
                        select: { id: true, email: true, name: true, role: true }
                    },
                    company: {
                        select: { id: true, name: true }
                    }
                },
                orderBy: { createdAt: 'desc' }
            });
        } else {
            const effectiveCompanyId = userCompanyId || queryCompanyId;

            if (!effectiveCompanyId) {
                return res.status(400).json({ success: false, message: 'Company ID is required' });
            }

            requests = await prisma.passwordrequest.findMany({
                where: { companyId: parseInt(effectiveCompanyId) },
                include: {
                    user: {
                        select: { id: true, email: true, name: true, role: true }
                    },
                    company: {
                        select: { id: true, name: true }
                    }
                },
                orderBy: { createdAt: 'desc' }
            });
        }

        res.json(requests);
    } catch (error) {
        console.error('Get Password Requests Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const updateRequestStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, newPassword } = req.body; // Approved or Rejected

        const request = await prisma.passwordrequest.findUnique({ 
            where: { id: parseInt(id) },
            include: { user: true, company: true }
        });

        if (!request) {
            return res.status(404).json({ message: 'Request not found' });
        }

        if (status === 'Approved') {
            const passwordToSet = newPassword || request.requestedPassword;

            if (!passwordToSet) {
                return res.status(400).json({ message: 'No password provided to set for this account' });
            }

            const hashedPassword = await bcrypt.hash(passwordToSet, 10);

            // Transaction: Update User Password AND Request Status
            await prisma.$transaction([
                prisma.user.update({
                    where: { id: request.userId },
                    data: { password: hashedPassword }
                }),
                prisma.passwordrequest.update({
                    where: { id: parseInt(id) },
                    data: { status: 'Approved' }
                })
            ]);

            return res.json({ 
                success: true, 
                message: `Password reset successfully for ${request.user?.email || 'user'} and request approved!` 
            });
        } else {
            // Just update status (e.g. Rejected)
            const updated = await prisma.passwordrequest.update({
                where: { id: parseInt(id) },
                data: { status: status || 'Rejected' }
            });
            res.json({ success: true, message: `Request ${status} successfully`, request: updated });
        }
    } catch (error) {
        console.error('Update Request Status Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const createPasswordRequest = async (req, res) => {
    try {
        const targetUserId = req.body.userId ? parseInt(req.body.userId) : req.user.userId;
        const effectiveCompanyId = req.user.companyId 
            ? parseInt(req.user.companyId) 
            : (req.body.companyId ? parseInt(req.body.companyId) : null);

        if (!targetUserId) {
            return res.status(400).json({ message: 'User ID is required.' });
        }

        // Check if there's already a pending request for this user
        const existingRequest = await prisma.passwordrequest.findFirst({
            where: { userId: targetUserId, status: 'Pending' }
        });

        if (existingRequest) {
            return res.status(400).json({ message: 'A pending password request already exists for this user.' });
        }

        const newRequest = await prisma.passwordrequest.create({
            data: {
                userId: targetUserId,
                companyId: effectiveCompanyId,
                requestedPassword: req.body.newPassword ? String(req.body.newPassword) : null,
                status: 'Pending'
            },
            include: {
                user: {
                    select: { id: true, email: true, name: true, role: true }
                },
                company: {
                    select: { id: true, name: true }
                }
            }
        });

        res.status(201).json({ message: 'Password request submitted successfully', request: newRequest });
    } catch (error) {
        console.error('Create Password Request Error:', error);
        res.status(500).json({ error: error.message });
    }
};

const deletePasswordRequest = async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.passwordrequest.delete({
            where: { id: parseInt(id) }
        });
        res.json({ success: true, message: 'Password request deleted successfully' });
    } catch (error) {
        console.error('Delete Password Request Error:', error);
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    getPasswordRequests,
    updateRequestStatus,
    createPasswordRequest,
    deletePasswordRequest
};
