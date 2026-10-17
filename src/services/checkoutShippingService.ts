import { prisma } from '../lib/prisma';
import { cdekService } from './cdekService';
import { buildShippingSnapshot, calculateShippingQuote, ShippingQuoteError } from './shippingPackageService';

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

export const cityCodeFromPvz = (value: unknown): number => {
  const meta = record(value);
  const raw = record(meta.raw);
  const nested = record(raw.raw);
  const candidates = [
    meta.cityCode, meta.city_code, raw.cityCode, raw.city_code,
    record(raw.location).city_code, nested.city_code, record(nested.location).city_code
  ];
  for (const candidate of candidates) {
    const code = Number(candidate);
    if (Number.isInteger(code) && code > 0) return code;
  }
  return 0;
};

export const quoteCheckoutShipping = async (
  items: { productId: string; quantity: number }[],
  buyerPickupPvz: { pvzId?: string; raw?: unknown }
) => {
  const ids = [...new Set(items.map(item => item.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: ids }, deletedAt: null, moderationStatus: 'APPROVED' },
    select: { id: true, sellerId: true, weightGrossG: true, dxCm: true, dyCm: true, dzCm: true }
  });
  if (products.length !== ids.length) throw new Error('PRODUCT_NOT_FOUND');
  const sellers = [...new Set(products.map(product => product.sellerId))];
  if (sellers.length !== 1) throw new Error('MULTI_SELLER_CHECKOUT_NOT_SUPPORTED');
  const sellerSettings = await prisma.sellerSettings.findUnique({ where: { sellerId: sellers[0] } });
  if (!sellerSettings?.defaultDropoffPvzId) throw new Error('SELLER_DROPOFF_PVZ_REQUIRED');
  const snapshot = buildShippingSnapshot(items.map(item => {
    const product = products.find(product => product.id === item.productId)!;
    return { productId: item.productId, quantity: item.quantity, weightGrossG: product.weightGrossG,
      dxCm: product.dxCm, dyCm: product.dyCm, dzCm: product.dzCm };
  }));
  let fromCityCode = cityCodeFromPvz(sellerSettings.defaultDropoffPvzMeta);
  if (!fromCityCode) {
    try {
      fromCityCode = await cdekService.getCityCodeByPvzCode(sellerSettings.defaultDropoffPvzId) ?? 0;
    } catch {
      throw new ShippingQuoteError('SELLER_CITY_CODE_REQUIRED');
    }
  }
  if (!fromCityCode) throw new ShippingQuoteError('SELLER_CITY_CODE_REQUIRED');
  let toCityCode = cityCodeFromPvz(buyerPickupPvz.raw);
  const deliveryPoint = String(buyerPickupPvz.pvzId ?? record(buyerPickupPvz.raw).pvzId ?? record(buyerPickupPvz.raw).id ?? '').trim();
  if (!toCityCode && deliveryPoint) {
    try {
      toCityCode = await cdekService.getCityCodeByPvzCode(deliveryPoint) ?? 0;
    } catch {
      throw new ShippingQuoteError('BUYER_CITY_CODE_REQUIRED');
    }
  }
  if (!toCityCode) throw new ShippingQuoteError('BUYER_CITY_CODE_REQUIRED');
  if (fromCityCode > 0 && toCityCode > 0 && !deliveryPoint) {
    throw new ShippingQuoteError('BUYER_PICKUP_PVZ_REQUIRED');
  }
  const result = await calculateShippingQuote(snapshot, fromCityCode, toCityCode, undefined, {
    shipmentPoint: sellerSettings.defaultDropoffPvzId,
    deliveryPoint
  });
  return { ...result, snapshot, sellerSettings };
};
