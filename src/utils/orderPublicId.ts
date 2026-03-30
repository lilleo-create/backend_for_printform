const PUBLIC_NUMBER_PREFIX = 'PF-';

export const formatOrderPublicNumber = (value: number | string): string => {
  const normalized = String(value).replace(/\D/g, '');
  return `${PUBLIC_NUMBER_PREFIX}${normalized}`;
};

export const normalizeOrderSearch = (value: string): string => value.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

export const formatOrderPublicId = (id: string): string => `PF-${id.slice(-8).toUpperCase()}`;

export const withOrderPublicId = <T extends { id: string; publicNumber?: string | null }>(
  order: T
): T & { publicId: string; publicNumber: string | null } => ({
  ...order,
  publicNumber: order.publicNumber ?? null,
  publicId: formatOrderPublicId(order.id)
});
