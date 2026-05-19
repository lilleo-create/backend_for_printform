"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveRoleAfterSellerEnablement = exports.canAccessSellerCabinet = exports.isSellerAccount = exports.isAdminRole = void 0;
const SELLER_PROFILE_BLOCKED_STATUSES = new Set();
const normalizeSellerStatus = (status) => String(status ?? '').trim().toUpperCase();
const isAdminRole = (role) => role === 'ADMIN';
exports.isAdminRole = isAdminRole;
const isSellerAccount = (user) => {
    if (!user?.sellerProfile) {
        return false;
    }
    const normalizedStatus = normalizeSellerStatus(user.sellerProfile.status);
    if (!normalizedStatus) {
        return true;
    }
    return !SELLER_PROFILE_BLOCKED_STATUSES.has(normalizedStatus);
};
exports.isSellerAccount = isSellerAccount;
const canAccessSellerCabinet = (user) => {
    if (!user) {
        return false;
    }
    return (0, exports.isSellerAccount)(user);
};
exports.canAccessSellerCabinet = canAccessSellerCabinet;
const resolveRoleAfterSellerEnablement = (role) => {
    return (0, exports.isAdminRole)(role) ? role : 'SELLER';
};
exports.resolveRoleAfterSellerEnablement = resolveRoleAfterSellerEnablement;
