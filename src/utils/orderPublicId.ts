export const formatOrderPublicId = (id: string): string => `PF-${id.slice(-8).toUpperCase()}`;

export const withOrderPublicId = <T extends { id: string }>(order: T): T & { publicId: string } => ({
  ...order,
  publicId: formatOrderPublicId(order.id)
});
