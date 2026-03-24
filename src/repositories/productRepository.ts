import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export interface ProductMediaInput {
  type: 'IMAGE' | 'VIDEO';
  url: string;
  isPrimary?: boolean;
  sortOrder?: number;
}

export interface ProductInput {
  title: string;
  category: string;
  price: number;
  image: string;
  imageUrls?: string[];
  videoUrls?: string[];
  media?: ProductMediaInput[];
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
  variantLabel?: string;
  variantSize?: string;
  variantAttributes?: Prisma.InputJsonValue;
  variantGroupId?: string | null;
  weightGrossG?: number;
  dxCm?: number;
  dyCm?: number;
  dzCm?: number;
  sellerId: string;
}

export interface ProductVariantItemInput extends Omit<ProductInput, 'sellerId'> {}

export interface ProductWithVariantsInput extends ProductInput {
  variants?: ProductVariantItemInput[];
}

const productInclude = {
  images: { orderBy: { sortOrder: 'asc' } },
  media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  variants: true,
  specs: { orderBy: { sortOrder: 'asc' } }
} satisfies Prisma.ProductInclude;

const buildMediaRecords = (data: Pick<ProductInput, 'image' | 'imageUrls' | 'videoUrls' | 'media'>): ProductMediaInput[] => {
  if (data.media !== undefined) {
    const normalizedMedia = data.media.map((item, index) => ({
      type: item.type,
      url: item.url,
      sortOrder: item.sortOrder ?? index,
      isPrimary: item.isPrimary ?? false
    }));

    const primaryCount = normalizedMedia.filter((item) => item.isPrimary).length;
    if (normalizedMedia.length > 0 && primaryCount === 0) {
      normalizedMedia[0] = { ...normalizedMedia[0], isPrimary: true };
    }

    return normalizedMedia;
  }

  const imageUrls = data.imageUrls?.length ? data.imageUrls : data.image ? [data.image] : [];
  const videoUrls = data.videoUrls ?? [];

  return [
    ...imageUrls.map((url, index) => ({
      type: 'IMAGE' as const,
      url,
      sortOrder: index,
      isPrimary: index === 0
    })),
    ...videoUrls.map((url, index) => ({
      type: 'VIDEO' as const,
      url,
      sortOrder: imageUrls.length + index,
      isPrimary: false
    }))
  ];
};

const toProductView = <T extends {
  image: string;
  videoUrls?: string[];
  images?: Array<{ url: string; sortOrder: number }>;
  media?: Array<{ type: 'IMAGE' | 'VIDEO'; url: string; isPrimary: boolean; sortOrder: number }>;
}>(product: T) => {
  const media = product.media ?? [];
  const imageMedia = media.filter((item) => item.type === 'IMAGE');
  const videoMedia = media.filter((item) => item.type === 'VIDEO');
  const primaryMedia = media.find((item) => item.isPrimary) ?? media[0] ?? null;

  return {
    ...product,
    media,
    primaryMedia,
    image: primaryMedia?.type === 'IMAGE' ? primaryMedia.url : imageMedia[0]?.url ?? product.image,
    imageUrls: imageMedia.map((item) => item.url),
    videoUrls: videoMedia.length ? videoMedia.map((item) => item.url) : (product.videoUrls ?? []),
    images:
      product.images && product.images.length > 0
        ? product.images
        : imageMedia.map((item) => ({ url: item.url, sortOrder: item.sortOrder }))
  };
};

const replaceProductRelations = async (
  tx: Prisma.TransactionClient,
  id: string,
  mediaRecords: ProductMediaInput[] | undefined,
  imageUrls: string[] | undefined
) => {
  if (mediaRecords !== undefined) {
    await tx.productMedia.deleteMany({ where: { productId: id } });
    if (mediaRecords.length > 0) {
      await tx.productMedia.createMany({
        data: mediaRecords.map((item, index) => ({
          productId: id,
          type: item.type,
          url: item.url,
          isPrimary: item.isPrimary ?? index === 0,
          sortOrder: item.sortOrder ?? index
        }))
      });
    }
  }

  if (imageUrls !== undefined) {
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
  }
};

const toVariantCardView = (product: {
  id: string;
  sku: string;
  price: number;
  currency: string;
  color: string;
  variantLabel: string | null;
  variantSize: string | null;
  variantAttributes: Prisma.JsonValue | null;
  image: string;
  media?: Array<{ type: 'IMAGE' | 'VIDEO'; url: string; isPrimary: boolean; sortOrder: number }>;
}) => {
  const productView = toProductView(product);

  return {
    id: product.id,
    sku: product.sku,
    price: product.price,
    currency: product.currency,
    color: product.color,
    variantLabel: product.variantLabel,
    variantSize: product.variantSize,
    variantAttributes: product.variantAttributes,
    image: productView.image,
    media: productView.media,
    imageUrls: productView.imageUrls,
    videoUrls: productView.videoUrls
  };
};

const attachVariantGroup = async <T extends {
  id: string;
  variantGroupId: string | null;
  sku: string;
  price: number;
  currency: string;
  color: string;
  variantLabel: string | null;
  variantSize: string | null;
  variantAttributes: Prisma.JsonValue | null;
  image: string;
  media?: Array<{ type: 'IMAGE' | 'VIDEO'; url: string; isPrimary: boolean; sortOrder: number }>;
}>(product: T) => {
  if (!product.variantGroupId) {
    return {
      ...toProductView(product),
      variantGroup: null,
      variants: []
    };
  }

  const variants = await prisma.product.findMany({
    where: { variantGroupId: product.variantGroupId, moderationStatus: 'APPROVED' },
    orderBy: [{ createdAt: 'asc' }],
    select: {
      id: true,
      sku: true,
      price: true,
      currency: true,
      color: true,
      variantLabel: true,
      variantSize: true,
      variantAttributes: true,
      image: true,
      media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
    }
  });

  return {
    ...toProductView(product),
    variantGroup: {
      id: product.variantGroupId,
      total: variants.length,
      activeVariantId: product.id
    },
    variants: variants.map(toVariantCardView)
  };
};

const ensureUniqueSkus = (baseSku: string, variants: ProductVariantItemInput[] = []) => {
  const skuSet = new Set<string>();
  const allSkus = [baseSku, ...variants.map((variant) => variant.sku)];
  for (const sku of allSkus) {
    if (skuSet.has(sku)) {
      throw new Error('SKU_DUPLICATE_IN_VARIANTS');
    }
    skuSet.add(sku);
  }
};

export const productRepository = {
  findMany: async (filters: {
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
    const products = await prisma.product.findMany({
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
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
      },
      orderBy,
      take: limit,
      skip
    });

    return products.map(toProductView);
  },
  findById: async (id: string) => {
    const product = await prisma.product.findFirst({
      where: { id, moderationStatus: 'APPROVED' },
      include: productInclude
    });

    return product ? attachVariantGroup(product) : null;
  },
  create: async (data: ProductWithVariantsInput) => {
    ensureUniqueSkus(data.sku, data.variants);

    if (data.variants?.length) {
      const created = await prisma.$transaction(async (tx) => {
        const variantsInput = data.variants ?? [];
        const {
          variants: _variants,
          imageUrls: _imageUrls,
          videoUrls: _videoUrls,
          media: _media,
          ...productData
        } = data;
        const mediaRecords = buildMediaRecords(data);
        const imageUrls = mediaRecords.filter((item) => item.type === 'IMAGE').map((item) => item.url);
        const primaryImage =
          mediaRecords.find((item) => item.isPrimary && item.type === 'IMAGE')?.url ??
          imageUrls[0] ??
          data.image;

        const mainProduct = await tx.product.create({
          data: {
            ...productData,
            variantGroupId: null,
            image: primaryImage,
            videoUrls: mediaRecords.filter((item) => item.type === 'VIDEO').map((item) => item.url),
            moderationStatus: 'PENDING',
            moderationNotes: null,
            moderatedAt: null,
            moderatedById: null,
            publishedAt: null,
            images: imageUrls.length
              ? {
                  create: imageUrls.map((url, index) => ({
                    url,
                    sortOrder: index
                  }))
                }
              : undefined,
            media: mediaRecords.length
              ? {
                  create: mediaRecords.map((item, index) => ({
                    type: item.type,
                    url: item.url,
                    isPrimary: item.isPrimary ?? index === 0,
                    sortOrder: item.sortOrder ?? index
                  }))
                }
              : undefined
          }
        });

        await tx.product.update({
          where: { id: mainProduct.id },
          data: { variantGroupId: mainProduct.id }
        });

        for (const variant of variantsInput) {
          const variantMedia = buildMediaRecords(variant);
          const variantImageUrls = variantMedia.filter((item) => item.type === 'IMAGE').map((item) => item.url);
          const variantPrimaryImage =
            variantMedia.find((item) => item.isPrimary && item.type === 'IMAGE')?.url ??
            variantImageUrls[0] ??
            variant.image;

          await tx.product.create({
            data: {
              ...variant,
              sellerId: data.sellerId,
              variantGroupId: mainProduct.id,
              image: variantPrimaryImage,
              videoUrls: variantMedia.filter((item) => item.type === 'VIDEO').map((item) => item.url),
              moderationStatus: 'PENDING',
              moderationNotes: null,
              moderatedAt: null,
              moderatedById: null,
              publishedAt: null,
              images: variantImageUrls.length
                ? {
                    create: variantImageUrls.map((url, index) => ({
                      url,
                      sortOrder: index
                    }))
                  }
                : undefined,
              media: variantMedia.length
                ? {
                    create: variantMedia.map((item, index) => ({
                      type: item.type,
                      url: item.url,
                      isPrimary: item.isPrimary ?? index === 0,
                      sortOrder: item.sortOrder ?? index
                    }))
                  }
                : undefined
            }
          });
        }

        return tx.product.findUnique({
          where: { id: mainProduct.id },
          include: {
            images: { orderBy: { sortOrder: 'asc' } },
            media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
          }
        });
      });

      if (!created) {
        throw new Error('PRODUCT_CREATE_FAILED');
      }

      return toProductView(created);
    }

    const { variants: _variants, imageUrls: _imageUrls, videoUrls: _videoUrls, media: _media, ...productData } = data;
    const mediaRecords = buildMediaRecords(data);
    const imageUrls = mediaRecords.filter((item) => item.type === 'IMAGE').map((item) => item.url);
    const primaryImage =
      mediaRecords.find((item) => item.isPrimary && item.type === 'IMAGE')?.url ??
      imageUrls[0] ??
      data.image;

    const product = await prisma.product.create({
      data: {
        ...productData,
        image: primaryImage,
        videoUrls: mediaRecords.filter((item) => item.type === 'VIDEO').map((item) => item.url),
        moderationStatus: 'PENDING',
        moderationNotes: null,
        moderatedAt: null,
        moderatedById: null,
        publishedAt: null,
        images: imageUrls.length
          ? {
              create: imageUrls.map((url, index) => ({
                url,
                sortOrder: index
              }))
            }
          : undefined,
        media: mediaRecords.length
          ? {
              create: mediaRecords.map((item, index) => ({
                type: item.type,
                url: item.url,
                isPrimary: item.isPrimary ?? index === 0,
                sortOrder: item.sortOrder ?? index
              }))
            }
          : undefined
      },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
      }
    });

    return toProductView(product);
  },
  update: async (id: string, data: Partial<ProductInput>) => {
    const { imageUrls, videoUrls, media, ...rest } = data;
    const mediaRecords = media !== undefined || imageUrls !== undefined || videoUrls !== undefined || data.image !== undefined
      ? buildMediaRecords({
          image: data.image ?? '',
          imageUrls,
          videoUrls,
          media
        })
      : undefined;
    const nextImageUrls = mediaRecords?.filter((item) => item.type === 'IMAGE').map((item) => item.url) ?? imageUrls;
    const nextVideoUrls = mediaRecords?.filter((item) => item.type === 'VIDEO').map((item) => item.url) ?? videoUrls;
    const primaryImage = mediaRecords
      ? mediaRecords.find((item) => item.isPrimary && item.type === 'IMAGE')?.url ?? nextImageUrls?.[0] ?? data.image ?? undefined
      : data.image;

    const moderationPatch = {
      moderationStatus: 'PENDING' as const,
      moderationNotes: null,
      moderatedAt: null,
      moderatedById: null
    };

    const product = await prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: {
          ...rest,
          ...moderationPatch,
          ...(primaryImage !== undefined ? { image: primaryImage } : {}),
          ...(nextVideoUrls !== undefined ? { videoUrls: nextVideoUrls } : {})
        }
      });

      await replaceProductRelations(tx, id, mediaRecords, nextImageUrls);

      return tx.product.findUnique({
        where: { id },
        include: {
          images: { orderBy: { sortOrder: 'asc' } },
          media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
        }
      });
    });

    return product ? toProductView(product) : null;
  },
  remove: (id: string) => prisma.product.delete({ where: { id } })
  ,
  listVariants: async (id: string) => {
    const baseProduct = await prisma.product.findUnique({
      where: { id },
      select: { id: true, variantGroupId: true, moderationStatus: true }
    });

    if (!baseProduct || baseProduct.moderationStatus !== 'APPROVED') {
      return null;
    }

    if (!baseProduct.variantGroupId) {
      return [];
    }

    const variants = await prisma.product.findMany({
      where: {
        variantGroupId: baseProduct.variantGroupId,
        moderationStatus: 'APPROVED'
      },
      orderBy: [{ createdAt: 'asc' }],
      select: {
        id: true,
        sku: true,
        price: true,
        currency: true,
        color: true,
        variantLabel: true,
        variantSize: true,
        variantAttributes: true,
        image: true,
        media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
      }
    });

    return variants.map(toVariantCardView);
  }
};
