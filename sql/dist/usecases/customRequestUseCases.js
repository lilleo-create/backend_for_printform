"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.customRequestUseCases = void 0;
const customRequestRepository_1 = require("../repositories/customRequestRepository");
exports.customRequestUseCases = {
    create: customRequestRepository_1.customRequestRepository.create
};
