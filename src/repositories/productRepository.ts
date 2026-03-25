import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export interface ProductMediaInput {
  type: 'IMAGE' | 'VIDEO';
  url: string;
  isPrimary?: boolean;
  sortOrder?: number;
}

export interface ProductSpecificationInput {
  key: string;
  value: string;
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
  characteristics?: ProductSpecificationInput[];
  specifications?: ProductSpecificationInput[];
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
  parentProductId?: string | null;
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

const sellerProductEditInclude = {
  ...productInclude,
  seller: {
    select: {
      id: true,
      name: true,
      email: true,
      sellerProfile: {
        select: {
          storeName: true,
          city: true
        }
      }
    }
  }
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
  specs?: Array<{ key: string; value: string; sortOrder: number }>;
}>(product: T) => {
  const media = product.media ?? [];
  const imageMedia = media.filter((item) => item.type === 'IMAGE');
  const videoMedia = media.filter((item) => item.type === 'VIDEO');
  const primaryMedia = media.find((item) => item.isPrimary) ?? media[0] ?? null;

  return {
    ...product,
    media,
    characteristics: product.specs ?? [],
    specifications: product.specs ?? [],
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

const resolveSpecificationsInput = (data: Partial<ProductInput>): ProductSpecificationInput[] | undefined => {
  if (data.specifications !== undefined) return data.specifications;
  if (data.characteristics !== undefined) return data.characteristics;
  return undefined;
};

interface ProductVariantCard {
  id: string;
  title: string;
  shortLabel: string;
  color: string;
  previewImage: string;
  sku: string | null;
}

const toVariantCard = (product: {
  id: string;
  title: string;
  descriptionShort: string;
  color: string;
  image: string;
  sku: string;
}): ProductVariantCard => ({
  id: product.id,
  title: product.title,
  shortLabel: product.descriptionShort || product.title,
  color: product.color,
  previewImage: product.image,
  sku: product.sku ?? null
});

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

const variantSwitcherSelect = {
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
} satisfies Prisma.ProductSelect;

type VariantSwitcherProduct = Prisma.ProductGetPayload<{ select: typeof variantSwitcherSelect }>;

const resolveVariantGroupIdForProduct = async (product: {
  id: string;
  variantGroupId: string | null;
  parentProductId: string | null;
}) => {
  if (product.variantGroupId) {
    return product.variantGroupId;
  }
  if (!product.parentProductId) {
    return null;
  }
  const parent = await prisma.product.findUnique({
    where: { id: product.parentProductId },
    select: { id: true, variantGroupId: true }
  });
  return parent?.variantGroupId ?? parent?.id ?? null;
};

const getVariantSwitcherItems = async (product: {
  id: string;
  variantGroupId: string | null;
  parentProductId: string | null;
}, moderationStatus: 'APPROVED' | 'PENDING' | 'REJECTED' | null = 'APPROVED') => {
  const variantGroupId = await resolveVariantGroupIdForProduct(product);
  if (!variantGroupId) {
    return {
      variantGroup: null,
      variants: [] as ReturnType<typeof toVariantCardView>[]
    };
  }

  const variants = await prisma.product.findMany({
    where: {
      variantGroupId,
      ...(moderationStatus ? { moderationStatus } : {})
    },
    orderBy: [{ createdAt: 'asc' }],
    select: variantSwitcherSelect
  });

  return {
    variantGroup: {
      id: variantGroupId,
      total: variants.length,
      activeVariantId: product.id
    },
    variants: variants.map((item) => toVariantCardView(item as VariantSwitcherProduct))
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
        parentProductId: null,
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

    const productViews = products.map(toProductView);
    const productIds = productViews.map((item) => item.id);
    const groupIds = productViews
      .map((item) => item.variantGroupId)
      .filter((groupId): groupId is string => Boolean(groupId));

    const variantStatsRows = groupIds.length
      ? await prisma.product.groupBy({
          by: ['variantGroupId'],
          where: {
            variantGroupId: { in: groupIds },
            moderationStatus: 'APPROVED'
          },
          _count: { id: true },
          _min: { price: true },
          _max: { price: true }
        })
      : [];

    const variantStats = new Map(
      variantStatsRows.map((row) => [
        row.variantGroupId,
        {
          total: row._count.id,
          minPrice: row._min.price,
          maxPrice: row._max.price
        }
      ])
    );

    return productViews.map((product) => {
      if (!product.variantGroupId) {
        return { ...product, variantSummary: null };
      }
      const summary = variantStats.get(product.variantGroupId);
      return {
        ...product,
        variantSummary: summary
          ? {
              groupId: product.variantGroupId,
              total: summary.total,
              minPrice: summary.minPrice,
              maxPrice: summary.maxPrice
            }
          : null
      };
    });
  },
  findById: async (id: string) => {
    const product = await prisma.product.findFirst({
      where: { id, moderationStatus: 'APPROVED' },
      include: productInclude
    });

    if (!product) {
      return null;
    }

    const variantData = await getVariantSwitcherItems(product);
    return {
      ...toProductView(product),
      ...variantData
    };
  },
  create: async (data: ProductWithVariantsInput) => {
    ensureUniqueSkus(data.sku, data.variants);

    if (data.variants?.length) {
      const created = await prisma.$transaction(async (tx) => {
        const variantsInput = data.variants ?? [];
        const specifications = resolveSpecificationsInput(data);
        const {
          variants: _variants,
          imageUrls: _imageUrls,
          videoUrls: _videoUrls,
          media: _media,
          specifications: _specifications,
          characteristics: _characteristics,
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
              : undefined,
            specs: specifications?.length
              ? {
                  create: specifications.map((item, index) => ({
                    key: item.key,
                    value: item.value,
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
              parentProductId: mainProduct.id,
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

    const specifications = resolveSpecificationsInput(data);
    const {
      variants: _variants,
      imageUrls: _imageUrls,
      videoUrls: _videoUrls,
      media: _media,
      specifications: _specifications,
      characteristics: _characteristics,
      ...productData
    } = data;
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
          : undefined,
        specs: specifications?.length
          ? {
              create: specifications.map((item, index) => ({
                key: item.key,
                value: item.value,
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
    const { imageUrls, videoUrls, media, characteristics, specifications, ...rest } = data;
    const nextSpecifications = specifications ?? characteristics;
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
      if (nextSpecifications !== undefined) {
        await tx.productSpec.deleteMany({ where: { productId: id } });
        if (nextSpecifications.length > 0) {
          await tx.productSpec.createMany({
            data: nextSpecifications.map((item, index) => ({
              productId: id,
              key: item.key,
              value: item.value,
              sortOrder: item.sortOrder ?? index
            }))
          });
        }
      }

      return tx.product.findUnique({
        where: { id },
        include: {
          images: { orderBy: { sortOrder: 'asc' } },
          media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
          specs: { orderBy: { sortOrder: 'asc' } }
        }
      });
    });

    return product ? toProductView(product) : null;
  },
  remove: (id: string) => prisma.product.delete({ where: { id } })
  ,
  getSellerProductForEdit: async (id: string, sellerId: string) => {
    const product = await prisma.product.findUnique({
      where: { id },
      include: sellerProductEditInclude
    });

    if (!product) {
      return { code: 'NOT_FOUND' as const, data: null };
    }

    if (product.sellerId !== sellerId) {
      return { code: 'FORBIDDEN' as const, data: null };
    }

    const variantGroupId = product.variantGroupId ?? product.id;
    const variantProducts = await prisma.product.findMany({
      where: {
        variantGroupId,
        sellerId
      },
      include: {
        media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
        specs: { orderBy: { sortOrder: 'asc' } }
      },
      orderBy: [{ createdAt: 'asc' }]
    });

    return {
      code: 'OK' as const,
      data: {
        ...toProductView(product),
        status: product.moderationStatus,
        seller: {
          id: product.seller.id,
          name: product.seller.name,
          email: product.seller.email,
          store: {
            storeName: product.seller.sellerProfile?.storeName ?? null,
            city: product.seller.sellerProfile?.city ?? null
          }
        },
        variants: variantProducts.map((variant) => ({
          ...toProductView(variant),
          status: variant.moderationStatus
        }))
      }
    };
  }
  ,
  listVariants: async (id: string) => {
    const baseProduct = await prisma.product.findUnique({
      where: { id },
      select: { id: true, variantGroupId: true, parentProductId: true, moderationStatus: true }
    });

    if (!baseProduct || baseProduct.moderationStatus !== 'APPROVED') {
      return null;
    }

    const variantData = await getVariantSwitcherItems(baseProduct);
    return variantData.variants;
  },
  findSellerProductWithVariants: async (id: string, sellerId: string) => {
    const product = await prisma.product.findFirst({
      where: { id, sellerId },
      include: productInclude
    });
    if (!product) {
      return null;
    }

    const variantData = await getVariantSwitcherItems(product, null);
    return {
      ...toProductView(product),
      ...variantData
    };
  },
  createVariant: async (masterProductId: string, sellerId: string, data: ProductVariantItemInput) => {
    const masterProduct = await prisma.product.findFirst({
      where: { id: masterProductId, sellerId },
      select: { id: true, sellerId: true, variantGroupId: true }
    });
    if (!masterProduct) {
      return null;
    }

    const groupId = masterProduct.variantGroupId ?? masterProduct.id;
    const mediaRecords = buildMediaRecords(data);
    const imageUrls = mediaRecords.filter((item) => item.type === 'IMAGE').map((item) => item.url);
    const primaryImage = mediaRecords.find((item) => item.isPrimary && item.type === 'IMAGE')?.url ?? imageUrls[0] ?? data.image;

    const created = await prisma.product.create({
      data: {
        ...data,
        sellerId,
        variantGroupId: groupId,
        parentProductId: masterProduct.id,
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
      include: productInclude
    });

    return toProductView(created);
  },
  updateVariant: async (masterProductId: string, variantId: string, sellerId: string, data: Partial<ProductInput>) => {
    const masterProduct = await prisma.product.findFirst({
      where: { id: masterProductId, sellerId },
      select: { id: true, variantGroupId: true }
    });
    if (!masterProduct) {
      return null;
    }

    const variant = await prisma.product.findFirst({
      where: { id: variantId, sellerId, variantGroupId: masterProduct.variantGroupId ?? masterProduct.id }
    });
    if (!variant || variant.id === masterProduct.id) {
      return null;
    }

    return productRepository.update(variantId, data);
  },
  removeVariant: async (masterProductId: string, variantId: string, sellerId: string) => {
    const masterProduct = await prisma.product.findFirst({
      where: { id: masterProductId, sellerId },
      select: { id: true, variantGroupId: true }
    });
    if (!masterProduct) {
      return null;
    }

    const variant = await prisma.product.findFirst({
      where: { id: variantId, sellerId, variantGroupId: masterProduct.variantGroupId ?? masterProduct.id },
      select: { id: true }
    });
    if (!variant || variant.id === masterProduct.id) {
      return null;
    }

    await prisma.product.delete({ where: { id: variant.id } });
    return { id: variant.id };
  }
};
