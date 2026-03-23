import { Role } from '@prisma/client';

export type SellerProfileAccessShape = {
  id?: string | null;
  status?: string | null;
} | null | undefined;

export type UserAccessShape = {
  role: Role;
  sellerProfile?: SellerProfileAccessShape;
};

const SELLER_PROFILE_BLOCKED_STATUSES = new Set<string>();

const normalizeSellerStatus = (status?: string | null) => String(status ?? '').trim().toUpperCase();

export const isAdminRole = (role: Role) => role === 'ADMIN';

export const isSellerAccount = (user: Pick<UserAccessShape, 'sellerProfile'> | null | undefined): boolean => {
  if (!user?.sellerProfile) {
    return false;
  }

  const normalizedStatus = normalizeSellerStatus(user.sellerProfile.status);
  if (!normalizedStatus) {
    return true;
  }

  return !SELLER_PROFILE_BLOCKED_STATUSES.has(normalizedStatus);
};

export const canAccessSellerCabinet = (user: UserAccessShape | null | undefined): boolean => {
  if (!user) {
    return false;
  }

  return isAdminRole(user.role) || isSellerAccount(user);
};

export const resolveRoleAfterSellerEnablement = (role: Role): Role => {
  return isAdminRole(role) ? role : 'SELLER';
};
