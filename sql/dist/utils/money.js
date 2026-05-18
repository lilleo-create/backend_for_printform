"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.kopecksToRubles = exports.rublesToKopecks = exports.money = void 0;
exports.money = {
    toRublesFloat(valueKopecks) {
        return valueKopecks / 100;
    },
    toRublesString(valueKopecks) {
        return (valueKopecks / 100).toFixed(2);
    },
    toKopecks(valueRubles) {
        const result = Math.round(valueRubles * 100);
        console.info('[MONEY]', {
            rubles: valueRubles,
            kopecks: result
        });
        return result;
    }
};
exports.rublesToKopecks = exports.money.toKopecks;
exports.kopecksToRubles = exports.money.toRublesString;
