"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productUseCases = void 0;
const productRepository_1 = require("../repositories/productRepository");
exports.productUseCases = {
    list: (filters) => productRepository_1.productRepository.findMany(filters),
    get: (id) => productRepository_1.productRepository.findById(id),
    create: productRepository_1.productRepository.create,
    update: productRepository_1.productRepository.update,
    remove: productRepository_1.productRepository.remove
};
