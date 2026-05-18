"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateOrderEconomics = void 0;
const asBps = (raw) => {
    const parsed = Number(raw ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};
const platformFeeBps = () => asBps(process.env.PLATFORM_FEE_BPS);
const acquiringFeeBps = () => asBps(process.env.ACQUIRING_FEE_BPS);
const fromBps = (amountKopecks, bps) => Math.round((amountKopecks * bps) / 10000);
const calculateOrderEconomics = (grossAmountKopecks) => {
    const platformFeeKopecks = fromBps(grossAmountKopecks, platformFeeBps());
    const acquiringFeeKopecks = fromBps(grossAmountKopecks, acquiringFeeBps());
    const serviceFeeKopecks = platformFeeKopecks + acquiringFeeKopecks;
    const sellerNetAmountKopecks = Math.max(0, grossAmountKopecks - serviceFeeKopecks);
    return {
        grossAmountKopecks,
        serviceFeeKopecks,
        platformFeeKopecks,
        acquiringFeeKopecks,
        sellerNetAmountKopecks
    };
};
exports.calculateOrderEconomics = calculateOrderEconomics;
