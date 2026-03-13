"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.customRequestRepository = void 0;
const prisma_1 = require("../lib/prisma");
exports.customRequestRepository = {
    create: (data) => prisma_1.prisma.customRequest.create({ data })
};
