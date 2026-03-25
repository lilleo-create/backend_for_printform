"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productRepository = void 0;
const prisma_1 = require("../lib/prisma");
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
        images: product.images && product.images.length > 0
            ? product.images
            : imageMedia.map((item) => ({ url: item.url, sortOrder: item.sortOrder }))
    };
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
const attachVariantGroup = async (product) => {
    if (!product.variantGroupId) {
        return {
            ...toProductView(product),
            variantGroup: null,
            variants: []
        };
    }
    const variants = await prisma_1.prisma.product.findMany({
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
    findById: async (id) => {
        const product = await prisma_1.prisma.product.findFirst({
            where: { id, moderationStatus: 'APPROVED' },
            include: productInclude
        });
        if (!product) {
            return null;
        }
        const parentProduct = product.parentProductId
            ? await prisma_1.prisma.product.findFirst({
                where: { id: product.parentProductId, moderationStatus: 'APPROVED' },
                select: { id: true, variantGroupId: true }
            })
            : null;
        const hasVariantRelation = Boolean(product.variantGroupId || product.parentProductId || parentProduct?.id);
        if (!hasVariantRelation) {
            return toProductView(product);
        }
        const effectiveVariantGroupId = product.variantGroupId ?? parentProduct?.variantGroupId ?? parentProduct?.id ?? null;
        const parentId = product.parentProductId ?? parentProduct?.id ?? null;
        const relatedProducts = await prisma_1.prisma.product.findMany({
            where: {
                moderationStatus: 'APPROVED',
                OR: [
                    { id: product.id },
                    ...(effectiveVariantGroupId ? [{ variantGroupId: effectiveVariantGroupId }] : []),
                    ...(parentId ? [{ parentProductId: parentId }, { id: parentId }] : [])
                ]
            },
            select: {
                id: true,
                title: true,
                descriptionShort: true,
                color: true,
                image: true,
                sku: true
            }
        });
        const uniqueVariants = Array.from(new Map(relatedProducts.map((item) => [item.id, item])).values());
        return {
            ...toProductView(product),
            variantRelation: {
                variantGroupId: effectiveVariantGroupId,
                parentProductId: parentId
            },
            availableVariants: uniqueVariants.map(toVariantCard)
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
                media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
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
        if (!product) {
            return { code: 'NOT_FOUND', data: null };
        }
        if (product.sellerId !== sellerId) {
            return { code: 'FORBIDDEN', data: null };
        }
        const variantGroupId = product.variantGroupId ?? product.id;
        const variantProducts = await prisma_1.prisma.product.findMany({
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
            select: { id: true, variantGroupId: true, moderationStatus: true }
        });
        if (!baseProduct || baseProduct.moderationStatus !== 'APPROVED') {
            return null;
        }
        if (!baseProduct.variantGroupId) {
            return [];
        }
        const variants = await prisma_1.prisma.product.findMany({
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
