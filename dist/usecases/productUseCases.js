"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productUseCases = void 0;
const productRepository_1 = require("../repositories/productRepository");
const money_1 = require("../utils/money");
const withPriceInKopecks = (payload) => {
    if (payload.price === undefined) {
        return payload;
    }
    return {
        ...payload,
        price: (0, money_1.rublesToKopecks)(payload.price)
    };
};
exports.productUseCases = {
    list: (filters) => productRepository_1.productRepository.findMany(filters),
    get: (id) => productRepository_1.productRepository.findById(id),
    getForSellerEdit: (id, sellerId) => productRepository_1.productRepository.getSellerProductForEdit(id, sellerId),
    listVariants: (id) => productRepository_1.productRepository.listVariants(id),
    getSellerProductWithVariants: (id, sellerId) => productRepository_1.productRepository.findSellerProductWithVariants(id, sellerId),
    createVariant: (masterProductId, sellerId, data) => productRepository_1.productRepository.createVariant(masterProductId, sellerId, withPriceInKopecks(data)),
    updateVariant: (masterProductId, variantId, sellerId, data) => productRepository_1.productRepository.updateVariant(masterProductId, variantId, sellerId, withPriceInKopecks(data)),
    removeVariant: (masterProductId, variantId, sellerId) => productRepository_1.productRepository.removeVariant(masterProductId, variantId, sellerId),
    create: (data) => productRepository_1.productRepository.create({
        ...withPriceInKopecks(data),
        variants: data.variants?.map((variant) => withPriceInKopecks(variant))
    }),
    update: (id, data) => productRepository_1.productRepository.update(id, withPriceInKopecks(data)),
    remove: productRepository_1.productRepository.remove
};
