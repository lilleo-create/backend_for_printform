"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePhone = void 0;
const libphonenumber_js_1 = require("libphonenumber-js");
const normalizePhone = (raw) => {
    const cleaned = raw.trim();
    const phone = (0, libphonenumber_js_1.parsePhoneNumberFromString)(cleaned, 'RU');
    if (!phone || !phone.isValid()) {
        throw new Error('INVALID_PHONE');
    }
    return phone.number;
};
exports.normalizePhone = normalizePhone;
