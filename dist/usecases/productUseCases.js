"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productUseCases = void 0;
const productRepository_1 = require("../repositories/productRepository");
const withPriceMinorUnits = (payload) => payload;
exports.productUseCases = {
    list: (filters) => productRepository_1.productRepository.findMany(filters),
    get: (id) => productRepository_1.productRepository.findById(id),
    getForSellerEdit: (id, sellerId) => productRepository_1.productRepository.getSellerProductForEdit(id, sellerId),
    listVariants: (id) => productRepository_1.productRepository.listVariants(id),
    getSellerProductWithVariants: (id, sellerId) => productRepository_1.productRepository.findSellerProductWithVariants(id, sellerId),
    createVariant: (masterProductId, sellerId, data) => productRepository_1.productRepository.createVariant(masterProductId, sellerId, withPriceMinorUnits(data)),
    updateVariant: (masterProductId, variantId, sellerId, data) => productRepository_1.productRepository.updateVariant(masterProductId, variantId, sellerId, withPriceMinorUnits(data)),
    removeVariant: (masterProductId, variantId, sellerId) => productRepository_1.productRepository.removeVariant(masterProductId, variantId, sellerId),
    create: (data) => productRepository_1.productRepository.create({
        ...withPriceMinorUnits(data),
        variants: data.variants?.map((variant) => withPriceMinorUnits(variant))
    }),
    update: (id, data) => productRepository_1.productRepository.update(id, withPriceMinorUnits(data)),
    remove: productRepository_1.productRepository.remove
};
