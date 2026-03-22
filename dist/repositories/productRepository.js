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
        primaryMedia,
        image: primaryMedia?.type === 'IMAGE' ? primaryMedia.url : imageMedia[0]?.url ?? product.image,
        imageUrls: imageMedia.map((item) => item.url),
        videoUrls: videoMedia.map((item) => item.url),
        images: product.images && product.images.length > 0
            ? product.images
            : imageMedia.map((item) => ({ url: item.url, sortOrder: item.sortOrder }))
    };
};
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
        return product ? toProductView(product) : null;
    },
    create: async (data) => {
        const { imageUrls: _imageUrls, videoUrls: _videoUrls, media: _media, ...productData } = data;
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
    remove: (id) => prisma_1.prisma.product.delete({ where: { id } })
};
