"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productUseCases = void 0;
const productRepository_1 = require("../repositories/productRepository");
exports.productUseCases = {
    list: (filters) => productRepository_1.productRepository.findMany(filters),
    get: (id) => productRepository_1.productRepository.findById(id),
    getForSellerEdit: (id, sellerId) => productRepository_1.productRepository.getSellerProductForEdit(id, sellerId),
    listVariants: (id) => productRepository_1.productRepository.listVariants(id),
    getSellerProductWithVariants: (id, sellerId) => productRepository_1.productRepository.findSellerProductWithVariants(id, sellerId),
    createVariant: (masterProductId, sellerId, data) => productRepository_1.productRepository.createVariant(masterProductId, sellerId, data),
    updateVariant: (masterProductId, variantId, sellerId, data) => productRepository_1.productRepository.updateVariant(masterProductId, variantId, sellerId, data),
    removeVariant: (masterProductId, variantId, sellerId) => productRepository_1.productRepository.removeVariant(masterProductId, variantId, sellerId),
    create: productRepository_1.productRepository.create,
    update: productRepository_1.productRepository.update,
    remove: productRepository_1.productRepository.remove
};
