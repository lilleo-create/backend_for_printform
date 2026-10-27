import { normalizePhone } from '../utils/phone';

type SellerContact = {
  name: string | null;
  fullName: string | null;
  phone: string | null;
  sellerProfile: {
    contactName: string | null;
    representativeName: string | null;
    storeName: string;
    contactPhone: string | null;
    phone: string;
  } | null;
};

const firstNonBlank = (values: Array<string | null | undefined>) =>
  values.map(value => String(value ?? '').trim()).find(Boolean) ?? '';

export const normalizeCdekContactPhone = (value: string, requiredCode: string, invalidCode: string) => {
  if (!value.trim()) throw new Error(requiredCode);
  try {
    return normalizePhone(value);
  } catch {
    throw new Error(invalidCode);
  }
};

export const resolveCdekSender = (seller: SellerContact) => {
  const profile = seller.sellerProfile;
  const senderName = firstNonBlank([
    profile?.contactName, profile?.representativeName,
    seller.fullName, seller.name, profile?.storeName
  ]);
  if (!senderName) throw new Error('CDEK_SENDER_NAME_REQUIRED');
  const rawPhone = firstNonBlank([profile?.contactPhone, profile?.phone, seller.phone]);
  const senderPhone = normalizeCdekContactPhone(rawPhone, 'CDEK_SENDER_PHONE_REQUIRED', 'CDEK_SENDER_PHONE_INVALID');
  return { senderName, senderPhone };
};

export const resolveCdekRecipient = (name: string, phone: string) => {
  const recipientName = name.trim();
  if (!recipientName) throw new Error('CDEK_RECIPIENT_NAME_REQUIRED');
  const recipientPhone = normalizeCdekContactPhone(phone, 'RECIPIENT_PHONE_REQUIRED', 'RECIPIENT_PHONE_INVALID');
  return { recipientName, recipientPhone };
};
