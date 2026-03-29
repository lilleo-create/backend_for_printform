"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.kopecksToRubles = exports.rublesToKopecks = void 0;
const rublesToKopecks = (value) => {
    const result = Math.round(value * 100);
    console.info('[MONEY]', {
        rubles: value,
        kopecks: result
    });
    return result;
};
exports.rublesToKopecks = rublesToKopecks;
const kopecksToRubles = (value) => {
    return (value / 100).toFixed(2);
};
exports.kopecksToRubles = kopecksToRubles;
