import type { Role } from '@prisma/client';

declare global {
  namespace Express {
    interface User {
      userId: string;
      role: Role;
      isAdmin: boolean;
      isSeller: boolean;
    }

    interface Request {
      user?: User;
    }
  }
}

export {};
