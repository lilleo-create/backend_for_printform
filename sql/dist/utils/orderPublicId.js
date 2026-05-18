"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withOrderPublicId = exports.formatOrderPublicId = exports.normalizeOrderSearch = exports.formatOrderPublicNumber = void 0;
const PUBLIC_NUMBER_PREFIX = 'PF-';
const formatOrderPublicNumber = (value) => {
    const normalized = String(value).replace(/\D/g, '');
    return `${PUBLIC_NUMBER_PREFIX}${normalized}`;
};
exports.formatOrderPublicNumber = formatOrderPublicNumber;
const normalizeOrderSearch = (value) => value.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
exports.normalizeOrderSearch = normalizeOrderSearch;
const formatOrderPublicId = (id) => `PF-${id.slice(-8).toUpperCase()}`;
exports.formatOrderPublicId = formatOrderPublicId;
const withOrderPublicId = (order) => ({
    ...order,
    publicNumber: order.publicNumber ?? null,
    publicId: (0, exports.formatOrderPublicId)(order.id)
});
exports.withOrderPublicId = withOrderPublicId;
