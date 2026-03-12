import { parsePhoneNumberFromString } from 'libphonenumber-js';

export const normalizePhone = (raw: string) => {
  const cleaned = raw.trim();
  const phone = parsePhoneNumberFromString(cleaned, 'RU');
  if (!phone || !phone.isValid()) {
    throw new Error('INVALID_PHONE');
  }
  return phone.number;
};
