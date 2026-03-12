import { prisma } from '../lib/prisma';

export interface ProductInput {
  title: string;
  category: string;
  price: number;
  image: string;
  imageUrls?: string[];
  videoUrls?: string[];
  description: string;
  descriptionShort: string;
  descriptionFull: string;
  sku: string;
  currency: string;
  material: string;
  technology: string;
  printTime?: string;
  productionTimeHours?: number;
  color: string;
  weightGrossG?: number;
  dxCm?: number;
  dyCm?: number;
  dzCm?: number;
  sellerId: string;
}

export const productRepository = {
  findMany: (filters: {
    shopId?: string;
    query?: string;
    category?: string;
    material?: string;
    minPrice?: number;
    maxPrice?: number;
    sort?: 'createdAt' | 'rating' | 'price';
    order?: 'asc' | 'desc';
    page?: number;
    limit?: number;
  }) => {
    const sortField = filters.sort === 'rating' ? 'ratingAvg' : filters.sort === 'price' ? 'price' : 'createdAt';
    const orderBy = { [sortField]: filters.order ?? 'desc' } as const;
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? filters.limit : 12;
    const skip = (page - 1) * limit;
    return prisma.product.findMany({
      where: {
        sellerId: filters.shopId,
        title: filters.query
          ? {
              contains: filters.query,
              mode: 'insensitive'
            }
          : undefined,
        category: filters.category,
        material: filters.material,
        moderationStatus: 'APPROVED',
        price: {
          gte: filters.minPrice,
          lte: filters.maxPrice
        }
      },
      orderBy,
      take: limit,
      skip
    });
  },
  findById: (id: string) =>
    prisma.product.findFirst({
      where: { id, moderationStatus: 'APPROVED' },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        variants: true,
        specs: { orderBy: { sortOrder: 'asc' } }
      }
    }),
  create: (data: ProductInput) => {
    const { imageUrls, videoUrls, ...rest } = data;
    return prisma.product.create({
      data: {
        ...rest,
        videoUrls: videoUrls ?? [],
        moderationStatus: 'PENDING',
        moderationNotes: null,
        moderatedAt: null,
        moderatedById: null,
        publishedAt: null,
        images: imageUrls?.length
          ? {
              create: imageUrls.map((url, index) => ({
                url,
                sortOrder: index
              }))
            }
          : undefined
      },
      include: {
        images: { orderBy: { sortOrder: 'asc' } }
      }
    });
  },
  update: async (id: string, data: Partial<ProductInput>) => {
    const { imageUrls, videoUrls, ...rest } = data;
    const moderationPatch = {
      moderationStatus: 'PENDING' as const,
      moderationNotes: null,
      moderatedAt: null,
      moderatedById: null
    };
    const videoUrlsPatch = videoUrls !== undefined ? { videoUrls } : {};
    if (!imageUrls) {
      return prisma.product.update({
        where: { id },
        data: { ...rest, ...moderationPatch, ...videoUrlsPatch }
      });
    }
    return prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: { ...rest, ...moderationPatch, ...videoUrlsPatch } });
      await tx.productImage.deleteMany({ where: { productId: id } });
      if (imageUrls.length > 0) {
        await tx.productImage.createMany({
          data: imageUrls.map((url, index) => ({
            productId: id,
            url,
            sortOrder: index
          }))
        });
      }
      return tx.product.findUnique({
        where: { id },
        include: { images: { orderBy: { sortOrder: 'asc' } } }
      });
    });
  },
  remove: (id: string) => prisma.product.delete({ where: { id } })
};
