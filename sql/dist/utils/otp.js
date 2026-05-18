"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashOtpCode = exports.generateOtpCode = void 0;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
const generateOtpCode = () => {
    const value = crypto_1.default.randomInt(0, 1000000);
    return value.toString().padStart(6, '0');
};
exports.generateOtpCode = generateOtpCode;
const hashOtpCode = (code) => crypto_1.default.createHash('sha256').update(`${code}${env_1.env.otpPepper}`).digest('hex');
exports.hashOtpCode = hashOtpCode;
