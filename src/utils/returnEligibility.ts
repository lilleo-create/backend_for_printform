import type { OrderStatus } from '@prisma/client';

export const RETURN_ELIGIBLE_STATUSES = ['DELIVERED'] as const satisfies readonly OrderStatus[];

export const canCreateReturnForOrderStatus = (status: OrderStatus) =>
  RETURN_ELIGIBLE_STATUSES.some(eligible => eligible === status);
