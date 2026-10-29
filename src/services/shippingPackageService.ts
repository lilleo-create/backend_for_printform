import { cdekService } from './cdekService';

export type ShippingItem = {
  productId: string;
  quantity: number;
  weightGrossG: number | null;
  dxCm: number | null;
  dyCm: number | null;
  dzCm: number | null;
};

export type ShippingSnapshot = {
  packages: [{ weightGrams: number; lengthCm: number; widthCm: number; heightCm: number }];
  items: { productId: string; quantity: number; weightGrossG: number;
    lengthCm?: number; widthCm?: number; heightCm?: number }[];
  totalWeightGrams: number;
  source: 'checkout';
};

export class ShippingQuoteError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

const positive = (value: number | null): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

// MVP: place every unit vertically in one parcel. Preserve decimal product
// dimensions here; round up only when crossing the CDEK API boundary.
export const buildShippingSnapshot = (items: ShippingItem[]): ShippingSnapshot => {
  if (!items.length) throw new ShippingQuoteError('SHIPPING_ITEMS_REQUIRED');
  let weightGrams = 0;
  let lengthCm = 0;
  let widthCm = 0;
  let heightCm = 0;
  const snapshotItems: ShippingSnapshot['items'] = [];
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new ShippingQuoteError('SHIPPING_QUANTITY_INVALID');
    }
    if (!positive(item.weightGrossG)) throw new ShippingQuoteError('SHIPPING_WEIGHT_REQUIRED');
    if (!positive(item.dxCm) || !positive(item.dyCm) || !positive(item.dzCm)) {
      throw new ShippingQuoteError('SHIPPING_DIMENSIONS_REQUIRED');
    }
    weightGrams += item.weightGrossG * item.quantity;
    snapshotItems.push({ productId: item.productId, quantity: item.quantity, weightGrossG: item.weightGrossG,
      lengthCm: item.dxCm, widthCm: item.dyCm, heightCm: item.dzCm });
    lengthCm = Math.max(lengthCm, item.dxCm);
    widthCm = Math.max(widthCm, item.dyCm);
    heightCm += item.dzCm * item.quantity;
  }
  if (!Number.isSafeInteger(weightGrams) || !Number.isFinite(heightCm)) {
    throw new ShippingQuoteError('SHIPPING_PACKAGE_INVALID');
  }
  return {
    packages: [{ weightGrams, lengthCm, widthCm, heightCm }],
    items: snapshotItems,
    totalWeightGrams: weightGrams,
    source: 'checkout'
  };
};

export type PackedParcel = { weightGrams: number; lengthCm: number; widthCm: number; heightCm: number };

export const validatePackedParcel = (parcel: PackedParcel, snapshot: ShippingSnapshot): PackedParcel => {
  if (!Number.isSafeInteger(parcel.weightGrams) || parcel.weightGrams <= 0 || parcel.weightGrams > 100_000) {
    throw new ShippingQuoteError('PACKED_WEIGHT_INVALID');
  }
  const dimensions = [parcel.lengthCm, parcel.widthCm, parcel.heightCm];
  if (dimensions.some(value => !Number.isFinite(value) || value <= 0 || value > 300)) {
    throw new ShippingQuoteError('PACKED_DIMENSIONS_INVALID');
  }
  if (!Array.isArray(snapshot.items) || snapshot.items.length === 0 ||
      snapshot.items.some(item => !Number.isInteger(item.quantity) || item.quantity <= 0 ||
        !Number.isSafeInteger(item.weightGrossG) || item.weightGrossG <= 0)) {
    throw new ShippingQuoteError('SHIPPING_SNAPSHOT_INVALID');
  }
  const itemWeight = snapshot.items.reduce((sum, item) => sum + item.weightGrossG * item.quantity, 0);
  if (parcel.weightGrams < itemWeight) throw new ShippingQuoteError('PACKED_WEIGHT_TOO_LOW');
  if (snapshot.items.length === 1 && snapshot.items[0].quantity === 1) {
    const item = snapshot.items[0];
    const checkoutParcel = snapshot.packages?.[0];
    const itemDimensions = [item.lengthCm ?? checkoutParcel?.lengthCm,
      item.widthCm ?? checkoutParcel?.widthCm, item.heightCm ?? checkoutParcel?.heightCm];
    if (itemDimensions.every((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)) {
      const sortedItem = itemDimensions.sort((a, b) => a - b);
      const sortedParcel = [...dimensions].sort((a, b) => a - b);
      if (sortedItem.some((value, index) => value > sortedParcel[index])) {
        throw new ShippingQuoteError('PACKED_DIMENSIONS_TOO_SMALL');
      }
    }
  }
  return parcel;
};

export const toCdekPackedParcel = (parcel: PackedParcel): PackedParcel => {
  if (!Number.isSafeInteger(parcel.weightGrams) || parcel.weightGrams <= 0 ||
      [parcel.lengthCm, parcel.widthCm, parcel.heightCm].some(value => !Number.isFinite(value) || value <= 0)) {
    throw new ShippingQuoteError('PACKED_PARCEL_REQUIRED');
  }
  return {
    weightGrams: parcel.weightGrams,
    lengthCm: Math.ceil(Number(parcel.lengthCm.toFixed(6))),
    widthCm: Math.ceil(Number(parcel.widthCm.toFixed(6))),
    heightCm: Math.ceil(Number(parcel.heightCm.toFixed(6)))
  };
};

export const toCdekPackage = (snapshot: ShippingSnapshot) => {
  const parcel = snapshot.packages[0];
  if (snapshot.packages.length !== 1 || !parcel || !Array.isArray(snapshot.items) ||
      !positive(parcel.weightGrams) || !positive(parcel.lengthCm) ||
      !positive(parcel.widthCm) || !positive(parcel.heightCm) ||
      parcel.weightGrams !== snapshot.totalWeightGrams ||
      snapshot.items.reduce((sum, item) => sum + item.weightGrossG * item.quantity, 0) !== snapshot.totalWeightGrams) {
    throw new ShippingQuoteError('SHIPPING_SNAPSHOT_INVALID');
  }
  return {
    weightGrams: Math.ceil(parcel.weightGrams),
    lengthCm: Math.ceil(Number(parcel.lengthCm.toFixed(6))),
    widthCm: Math.ceil(Number(parcel.widthCm.toFixed(6))),
    heightCm: Math.ceil(Number(parcel.heightCm.toFixed(6)))
  };
};

const calculateParcelQuote = async (
  parcel: PackedParcel,
  fromCityCode: number,
  toCityCode: number,
  calculate = cdekService.calculateDelivery.bind(cdekService),
  points?: { shipmentPoint: string; deliveryPoint: string }
) => {
  if (!Number.isInteger(fromCityCode) || fromCityCode <= 0) {
    throw new ShippingQuoteError('SELLER_CITY_CODE_REQUIRED');
  }
  if (!Number.isInteger(toCityCode) || toCityCode <= 0) {
    throw new ShippingQuoteError('BUYER_CITY_CODE_REQUIRED');
  }
  let quote: Awaited<ReturnType<typeof cdekService.calculateDelivery>>;
  try {
    quote = await calculate({ fromCityCode, toCityCode, ...parcel, ...points });
  } catch {
    throw new ShippingQuoteError('CDEK_QUOTE_FAILED');
  }
  if (!Number.isFinite(quote.totalSum) || quote.totalSum <= 0 ||
      !Number.isInteger(Math.round(quote.totalSum * 100)) ||
      !Number.isFinite(quote.deliveryDaysMin) || !Number.isFinite(quote.deliveryDaysMax)) {
    throw new ShippingQuoteError('CDEK_QUOTE_INVALID');
  }
  return { quote, deliveryAmountKopecks: Math.round(quote.totalSum * 100) };
};

export const calculateShippingQuote = async (
  snapshot: ShippingSnapshot,
  fromCityCode: number,
  toCityCode: number,
  calculate = cdekService.calculateDelivery.bind(cdekService),
  points?: { shipmentPoint: string; deliveryPoint: string }
) => calculateParcelQuote(toCdekPackage(snapshot), fromCityCode, toCityCode, calculate, points);

export const calculatePackedShippingQuote = async (
  parcel: PackedParcel,
  snapshot: ShippingSnapshot,
  fromCityCode: number,
  toCityCode: number,
  calculate = cdekService.calculateDelivery.bind(cdekService),
  points?: { shipmentPoint: string; deliveryPoint: string }
) => calculateParcelQuote(toCdekPackedParcel(validatePackedParcel(parcel, snapshot)),
  fromCityCode, toCityCode, calculate, points);
