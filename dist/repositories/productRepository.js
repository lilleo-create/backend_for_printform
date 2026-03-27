"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productRepository = void 0;
const prisma_1 = require("../lib/prisma");
const productDto_1 = require("../utils/productDto");
const productInclude = {
    images: { orderBy: { sortOrder: 'asc' } },
    media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
    variants: true,
    specs: { orderBy: { sortOrder: 'asc' } }
};
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
};
const buildMediaRecords = (data) => {
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
            type: 'IMAGE',
            url,
            sortOrder: index,
            isPrimary: index === 0
        })),
        ...videoUrls.map((url, index) => ({
            type: 'VIDEO',
            url,
            sortOrder: imageUrls.length + index,
            isPrimary: false
        }))
    ];
};
const toProductView = (product) => {
    return (0, productDto_1.normalizeProductDto)(product);
};
const resolveSpecificationsInput = (data) => {
    if (data.specifications !== undefined)
        return data.specifications;
    if (data.characteristics !== undefined)
        return data.characteristics;
    return undefined;
};
const toVariantCard = (product) => ({
    id: product.id,
    title: product.title,
    shortLabel: product.descriptionShort || product.title,
    color: product.color,
    previewImage: product.image,
    sku: product.sku ?? null
});
const replaceProductRelations = async (tx, id, mediaRecords, imageUrls) => {
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
const toVariantCardView = (product) => {
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
};
const resolveVariantGroupIdForProduct = async (product) => {
    if (product.variantGroupId) {
        return product.variantGroupId;
    }
    if (!product.parentProductId) {
        return null;
    }
    const parent = await prisma_1.prisma.product.findUnique({
        where: { id: product.parentProductId },
        select: { id: true, variantGroupId: true }
    });
    return parent?.variantGroupId ?? parent?.id ?? null;
};
const getVariantSwitcherItems = async (product, moderationStatus = 'APPROVED') => {
    const variantGroupId = await resolveVariantGroupIdForProduct(product);
    if (!variantGroupId) {
        return {
            variantGroup: null,
            variants: []
        };
    }
    const variants = await prisma_1.prisma.product.findMany({
        where: {
            variantGroupId,
            deletedAt: null,
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
        variants: variants.map((item) => toVariantCardView(item))
    };
};
const ensureUniqueSkus = (baseSku, variants = []) => {
    const skuSet = new Set();
    const allSkus = [baseSku, ...variants.map((variant) => variant.sku)];
    for (const sku of allSkus) {
        if (skuSet.has(sku)) {
            throw new Error('SKU_DUPLICATE_IN_VARIANTS');
        }
        skuSet.add(sku);
    }
};
const buildSkuFallback = () => `SKU-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const stripClientOnlyProductFields = (data) => {
    const { imageUrls: _imageUrls, videoUrls: _videoUrls, media: _media, characteristics: _characteristics, specifications: _specifications, ...productData } = data;
    return productData;
};
exports.productRepository = {
    findMany: async (filters) => {
        const sortField = filters.sort === 'rating' ? 'ratingAvg' : filters.sort === 'price' ? 'price' : 'createdAt';
        const orderBy = { [sortField]: filters.order ?? 'desc' };
        const page = filters.page && filters.page > 0 ? filters.page : 1;
        const limit = filters.limit && filters.limit > 0 ? filters.limit : 12;
        const skip = (page - 1) * limit;
        const products = await prisma_1.prisma.product.findMany({
            where: {
                sellerId: filters.shopId,
                parentProductId: null,
                deletedAt: null,
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
                media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
                specs: { orderBy: { sortOrder: 'asc' } }
            },
            orderBy,
            take: limit,
            skip
        });
        const productViews = products.map(toProductView);
        const productIds = productViews.map((item) => item.id);
        const groupIds = productViews
            .map((item) => item.variantGroupId)
            .filter((groupId) => Boolean(groupId));
        const variantStatsRows = groupIds.length
            ? await prisma_1.prisma.product.groupBy({
                by: ['variantGroupId'],
                where: {
                    variantGroupId: { in: groupIds },
                    moderationStatus: 'APPROVED',
                    deletedAt: null
                },
                _count: { id: true },
                _min: { price: true },
                _max: { price: true }
            })
            : [];
        const variantStats = new Map(variantStatsRows.map((row) => [
            row.variantGroupId,
            {
                total: row._count.id,
                minPrice: row._min.price,
                maxPrice: row._max.price
            }
        ]));
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
    findById: async (id) => {
        const product = await prisma_1.prisma.product.findFirst({
            where: { id, moderationStatus: 'APPROVED', deletedAt: null },
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
    create: async (data) => {
        ensureUniqueSkus(data.sku, data.variants);
        if (data.variants?.length) {
            const created = await prisma_1.prisma.$transaction(async (tx) => {
                const variantsInput = data.variants ?? [];
                const specifications = resolveSpecificationsInput(data);
                const { variants: _variants, imageUrls: _imageUrls, videoUrls: _videoUrls, media: _media, specifications: _specifications, characteristics: _characteristics, ...productData } = data;
                const mediaRecords = buildMediaRecords(data);
                const imageUrls = mediaRecords.filter((item) => item.type === 'IMAGE').map((item) => item.url);
                const primaryImage = mediaRecords.find((item) => item.isPrimary && item.type === 'IMAGE')?.url ??
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
                    const variantPrimaryImage = variantMedia.find((item) => item.isPrimary && item.type === 'IMAGE')?.url ??
                        variantImageUrls[0] ??
                        variant.image;
                    const variantData = stripClientOnlyProductFields(variant);
                    await tx.product.create({
                        data: {
                            ...variantData,
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
                        media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
                        specs: { orderBy: { sortOrder: 'asc' } }
                    }
                });
            });
            if (!created) {
                throw new Error('PRODUCT_CREATE_FAILED');
            }
            return toProductView(created);
        }
        const specifications = resolveSpecificationsInput(data);
        const { variants: _variants, imageUrls: _imageUrls, videoUrls: _videoUrls, media: _media, specifications: _specifications, characteristics: _characteristics, ...productData } = data;
        const mediaRecords = buildMediaRecords(data);
        const imageUrls = mediaRecords.filter((item) => item.type === 'IMAGE').map((item) => item.url);
        const primaryImage = mediaRecords.find((item) => item.isPrimary && item.type === 'IMAGE')?.url ??
            imageUrls[0] ??
            data.image;
        const product = await prisma_1.prisma.product.create({
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
                media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
                specs: { orderBy: { sortOrder: 'asc' } }
            }
        });
        return toProductView(product);
    },
    update: async (id, data) => {
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
            moderationStatus: 'PENDING',
            moderationNotes: null,
            moderatedAt: null,
            moderatedById: null
        };
        const product = await prisma_1.prisma.$transaction(async (tx) => {
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
    remove: (id) => prisma_1.prisma.product.delete({ where: { id } }),
    getSellerProductForEdit: async (id, sellerId) => {
        const product = await prisma_1.prisma.product.findUnique({
            where: { id },
            include: sellerProductEditInclude
        });
        if (!product || product.deletedAt) {
            return { code: 'NOT_FOUND', data: null };
        }
        if (product.sellerId !== sellerId) {
            return { code: 'FORBIDDEN', data: null };
        }
        const variantGroupId = product.variantGroupId ?? product.id;
        const variantProducts = await prisma_1.prisma.product.findMany({
            where: {
                variantGroupId,
                sellerId,
                deletedAt: null
            },
            include: {
                media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
                specs: { orderBy: { sortOrder: 'asc' } }
            },
            orderBy: [{ createdAt: 'asc' }]
        });
        return {
            code: 'OK',
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
    },
    listVariants: async (id) => {
        const baseProduct = await prisma_1.prisma.product.findUnique({
            where: { id },
            select: { id: true, variantGroupId: true, parentProductId: true, moderationStatus: true, deletedAt: true }
        });
        if (!baseProduct || baseProduct.moderationStatus !== 'APPROVED' || baseProduct.deletedAt) {
            return null;
        }
        const variantData = await getVariantSwitcherItems(baseProduct);
        return variantData.variants;
    },
    findSellerProductWithVariants: async (id, sellerId) => {
        const product = await prisma_1.prisma.product.findFirst({
            where: { id, sellerId, deletedAt: null },
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
    createVariant: async (masterProductId, sellerId, data) => {
        const masterProduct = await prisma_1.prisma.product.findFirst({
            where: { id: masterProductId, sellerId },
            select: { id: true, sellerId: true, variantGroupId: true }
        });
        if (!masterProduct) {
            return null;
        }
        const groupId = masterProduct.variantGroupId ?? masterProduct.id;
        if (!masterProduct.variantGroupId) {
            await prisma_1.prisma.product.update({
                where: { id: masterProduct.id },
                data: { variantGroupId: groupId }
            });
        }
        const mediaRecords = buildMediaRecords(data);
        const imageUrls = mediaRecords.filter((item) => item.type === 'IMAGE').map((item) => item.url);
        const primaryImage = mediaRecords.find((item) => item.isPrimary && item.type === 'IMAGE')?.url ?? imageUrls[0] ?? data.image;
        const productData = stripClientOnlyProductFields(data);
        const created = await prisma_1.prisma.product.create({
            data: {
                ...productData,
                sku: data.sku ?? buildSkuFallback(),
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
    updateVariant: async (masterProductId, variantId, sellerId, data) => {
        const masterProduct = await prisma_1.prisma.product.findFirst({
            where: { id: masterProductId, sellerId },
            select: { id: true, variantGroupId: true }
        });
        if (!masterProduct) {
            return null;
        }
        const variant = await prisma_1.prisma.product.findFirst({
            where: { id: variantId, sellerId, variantGroupId: masterProduct.variantGroupId ?? masterProduct.id }
        });
        if (!variant || variant.id === masterProduct.id) {
            return null;
        }
        return exports.productRepository.update(variantId, data);
    },
    removeVariant: async (masterProductId, variantId, sellerId) => {
        const masterProduct = await prisma_1.prisma.product.findFirst({
            where: { id: masterProductId, sellerId },
            select: { id: true, variantGroupId: true }
        });
        if (!masterProduct) {
            return null;
        }
        const variant = await prisma_1.prisma.product.findFirst({
            where: { id: variantId, sellerId, variantGroupId: masterProduct.variantGroupId ?? masterProduct.id },
            select: { id: true }
        });
        if (!variant || variant.id === masterProduct.id) {
            return null;
        }
        await prisma_1.prisma.product.delete({ where: { id: variant.id } });
        return { id: variant.id };
    }
};
