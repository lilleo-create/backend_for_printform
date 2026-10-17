import { cdekService } from './cdekService';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const positiveCityCode = (...values: unknown[]): number => {
  for (const value of values) {
    const code = Number(value);
    if (Number.isInteger(code) && code > 0) return code;
  }
  return 0;
};

const finiteCoordinate = (...values: unknown[]): number | null => {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
};

const firstText = (...values: unknown[]): string =>
  values.map(value => typeof value === 'string' ? value.trim() : '').find(Boolean) ?? '';

export const normalizeSellerDropoffPvzMeta = async (pvzId: string, input: unknown) => {
  const meta = record(input);
  const suppliedRaw = record(meta.raw);
  const raw = Object.keys(suppliedRaw).length ? suppliedRaw : meta;
  const location = record(raw.location);
  const cityCode = positiveCityCode(
    meta.cityCode, meta.city_code, raw.cityCode, raw.city_code, location.city_code
  );
  const point = cityCode ? null : await cdekService.getPickupPointByCode(pvzId);
  const pointLocation = record(point?.location);
  const resolvedCityCode = cityCode || positiveCityCode(pointLocation.city_code);
  if (!resolvedCityCode) throw new Error('SELLER_CITY_CODE_REQUIRED');

  return {
    provider: 'CDEK' as const,
    pvzId,
    cityCode: resolvedCityCode,
    cityName: firstText(meta.cityName, raw.cityName, raw.city, location.city, pointLocation.city),
    addressFull: firstText(meta.addressFull, raw.address_full, location.address_full, pointLocation.address_full),
    latitude: finiteCoordinate(meta.latitude, raw.latitude, location.latitude, pointLocation.latitude),
    longitude: finiteCoordinate(meta.longitude, raw.longitude, location.longitude, pointLocation.longitude),
    raw: Object.keys(suppliedRaw).length ? suppliedRaw : point ?? raw
  };
};
