import { prisma } from '../lib/prisma';

export const customRequestRepository = {
  create: (data: { name: string; contact: string; comment: string }) =>
    prisma.customRequest.create({ data })
};
