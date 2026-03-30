"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withOrderPublicId = exports.formatOrderPublicId = void 0;
const formatOrderPublicId = (id) => `PF-${id.slice(-8).toUpperCase()}`;
exports.formatOrderPublicId = formatOrderPublicId;
const withOrderPublicId = (order) => ({
    ...order,
    publicId: (0, exports.formatOrderPublicId)(order.id)
});
exports.withOrderPublicId = withOrderPublicId;
