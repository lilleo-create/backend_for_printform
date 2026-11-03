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
  items: { productId: string; variantId?: string; quantity: number }[],
  buyerPickupPvz: { pvzId?: string; raw?: unknown }
) => {
  const itemKeys = new Set<string>();
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999) throw new Error('QUANTITY_INVALID');
    // The shipping quote only needs product totals. An order must not contain
    // repeated identical lines because that makes the quote ambiguous.
    const key = `${item.productId}\0${item.variantId ?? ''}`;
    if (itemKeys.has(key)) throw new Error('DUPLICATE_ORDER_ITEM');
    itemKeys.add(key);
  }
  const ids = [...new Set(items.map(item => item.productId))];
  const products = await prisma.product.findMany({
    where: { id: { in: ids }, deletedAt: null, moderationStatus: 'APPROVED' },
    select: { id: true, sellerId: true, weightGrossG: true, dxCm: true, dyCm: true, dzCm: true }
  });
  if (products.length !== ids.length) throw new Error('PRODUCT_NOT_FOUND');
  const sellers = [...new Set(products.map(product => product.sellerId))];
  if (sellers.length !== 1) throw new Error('MULTI_SELLER_CHECKOUT_NOT_SUPPORTED');
  const seller = await prisma.sellerProfile.findFirst({ where: { userId: sellers[0], status: 'APPROVED' }, select: { id: true } });
  if (!seller) throw new Error('SELLER_NOT_AVAILABLE');
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
  const deliveryPoint = String(buyerPickupPvz.pvzId ?? record(buyerPickupPvz.raw).pvzId ?? record(buyerPickupPvz.raw).id ?? '').trim();
  if (!deliveryPoint) throw new ShippingQuoteError('BUYER_PICKUP_PVZ_REQUIRED');
  let providerPoint: Awaited<ReturnType<typeof cdekService.getPickupPointByCode>>;
  try {
    providerPoint = await cdekService.getPickupPointByCode(deliveryPoint);
  } catch (error) {
    if ((error as { code?: string })?.code === 'CDEK_PVZ_NOT_FOUND') {
      throw new ShippingQuoteError('PVZ_INVALID');
    }
    throw new ShippingQuoteError('CDEK_PVZ_LOOKUP_FAILED');
  }
  const toCityCode = Number(providerPoint.location?.city_code);
  if (!Number.isInteger(toCityCode) || toCityCode <= 0 || String(providerPoint.type).toUpperCase() !== 'PVZ') {
    throw new ShippingQuoteError('PVZ_INVALID');
  }
  const clientCityCode = cityCodeFromPvz(buyerPickupPvz.raw);
  if (clientCityCode && clientCityCode !== toCityCode) throw new ShippingQuoteError('PVZ_INVALID');
  const result = await calculateShippingQuote(snapshot, fromCityCode, toCityCode, undefined, {
    shipmentPoint: sellerSettings.defaultDropoffPvzId,
    deliveryPoint
  });
  return {
    ...result, snapshot, sellerSettings,
    buyerPickupPvz: {
      provider: 'CDEK' as const,
      pvzId: String(providerPoint.code),
      addressFull: String(providerPoint.location?.address_full ?? ''),
      raw: { ...providerPoint, id: providerPoint.code, type: 'PVZ' }
    }
  };
};
