"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sellerRoutes = void 0;
require("dotenv/config");
const express_1 = require("express");
const zod_1 = require("zod");
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const authMiddleware_1 = require("../middleware/authMiddleware");
const prisma_1 = require("../lib/prisma");
const productUseCases_1 = require("../usecases/productUseCases");
const orderUseCases_1 = require("../usecases/orderUseCases");
const productRoutes_1 = require("./productRoutes");
const rateLimiters_1 = require("../middleware/rateLimiters");
const sellerDeliveryProfileService_1 = require("../services/sellerDeliveryProfileService");
const payoutService_1 = require("../services/payoutService");
const shipmentService_1 = require("../services/shipmentService");
const sellerOrderDocumentsService_1 = require("../services/sellerOrderDocumentsService");
const cdekService_1 = require("../services/cdekService");
exports.sellerRoutes = (0, express_1.Router)();
// ---------------------------------------------------------
// Uploads
// ---------------------------------------------------------
const uploadDir = path_1.default.join(process.cwd(), "uploads");
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
        const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
        cb(null, `${unique}-${file.originalname}`);
    }
});
const allowedImageTypes = ["image/jpeg", "image/png", "image/webp"];
const allowedVideoTypes = ["video/mp4", "video/webm"];
const maxImageSize = 10 * 1024 * 1024;
const maxVideoSize = 100 * 1024 * 1024;
const upload = (0, multer_1.default)({
    storage,
    limits: { fileSize: maxVideoSize },
    fileFilter: (_req, file, cb) => {
        if ([...allowedImageTypes, ...allowedVideoTypes].includes(file.mimetype))
            return cb(null, true);
        return cb(new Error("UPLOAD_FILE_TYPE_INVALID"));
    }
});
const toShipmentView = (shipment) => {
    if (!shipment)
        return null;
    return {
        id: shipment.id,
        provider: shipment.provider,
        status: shipment.status,
        sourceStationId: shipment.sourceStationId,
        destinationStationId: shipment.destinationStationId,
        lastSyncAt: shipment.lastSyncAt,
        updatedAt: shipment.updatedAt,
        preparationChecklist: readPreparationChecklist(shipment.statusRaw)
    };
};
// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
// ---------------------------------------------------------
// Schemas
// ---------------------------------------------------------
/** Минимальная регистрация продавца: только базовые поля. Данные для мерчанта NDD и KYC — в разделе «Подключение продавца». */
const sellerTypeInputSchema = zod_1.z.enum(['IP', 'SELF_EMPLOYED', 'LLC', 'ИП', 'Самозанятый', 'ООО'], {
    invalid_type_error: 'Укажите корректный тип продавца.',
    required_error: 'Укажите тип продавца.'
});
const sellerTypeFieldSchema = sellerTypeInputSchema.optional();
const sellerLifecycleStatusSchema = zod_1.z.string().trim().min(1).optional();
const optionalTrimmedString = () => zod_1.z.preprocess((value) => {
    if (typeof value !== 'string')
        return value;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
}, zod_1.z.string().min(2).optional());
const sellerOnboardingSchema = zod_1.z.object({
    name: zod_1.z.string({ required_error: 'Укажите имя продавца.' }).trim().min(2, 'Имя продавца должно содержать минимум 2 символа.'),
    phone: zod_1.z.string({ required_error: 'Укажите номер телефона.' }).trim().min(5, 'Укажите корректный номер телефона.'),
    email: zod_1.z.union([
        zod_1.z.string().trim().email('Укажите корректный email.'),
        zod_1.z.literal('')
    ]).optional(),
    sellerType: sellerTypeFieldSchema,
    status: sellerLifecycleStatusSchema,
    storeName: zod_1.z.string().trim().optional(),
    city: zod_1.z.string({ required_error: 'Укажите город.' }).trim().min(2, 'Название города должно содержать минимум 2 символа.'),
    referenceCategory: optionalTrimmedString()
}).superRefine((payload, ctx) => {
    if (!payload.sellerType && !payload.status) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            path: ['status'],
            message: 'Укажите тип продавца.'
        });
        return;
    }
    if (payload.status && !['ИП', 'Самозанятый', 'ООО', 'IP', 'SELF_EMPLOYED', 'LLC'].includes(payload.status)) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            path: ['status'],
            message: 'Поле status должно содержать тип продавца: ИП, Самозанятый или ООО.'
        });
    }
    if (payload.sellerType && payload.status) {
        const normalizedSellerType = normalizeSellerType(payload.sellerType);
        const normalizedStatus = normalizeSellerType(payload.status);
        if (normalizedSellerType !== normalizedStatus) {
            ctx.addIssue({
                code: zod_1.z.ZodIssueCode.custom,
                path: ['status'],
                message: 'Поля status и sellerType передают один и тот же тип продавца и не должны конфликтовать.'
            });
        }
    }
}).transform((payload) => ({
    ...payload,
    sellerType: normalizeSellerType((payload.sellerType ?? payload.status)),
    status: undefined,
    storeName: payload.storeName?.trim() || undefined,
    email: payload.email?.trim() || '',
    city: payload.city.trim(),
    name: payload.name.trim(),
    phone: payload.phone.trim()
}));
/** Данные для мерчанта NDD (раздел «Подключение продавца»). */
const merchantDataBaseSchema = zod_1.z.object({
    contactName: zod_1.z.string().trim().min(2).optional(),
    contactPhone: zod_1.z.string().trim().min(5).optional(),
    representativeName: zod_1.z.string().trim().min(2).optional(),
    legalAddressFull: zod_1.z.string().trim().min(5).optional().or(zod_1.z.literal('')),
    siteUrl: zod_1.z.string().trim().min(2).optional().or(zod_1.z.literal('')),
    shipmentType: zod_1.z.enum(['import', 'withdraw']).optional(),
    legalName: zod_1.z.string().trim().min(1).optional(),
    inn: zod_1.z.string().trim().optional(),
    ogrn: zod_1.z.string().trim().optional(),
    kpp: zod_1.z.string().trim().optional()
});
const merchantDataSchemaOOO = merchantDataBaseSchema.required({
    contactName: true,
    contactPhone: true,
    legalName: true,
    inn: true,
    ogrn: true
}).refine((d) => /^\d{10}$/.test(d.inn ?? ''), { message: 'ИНН ООО — 10 цифр', path: ['inn'] })
    .refine((d) => /^\d{13}$/.test(d.ogrn ?? ''), { message: 'ОГРН — 13 цифр', path: ['ogrn'] });
const merchantDataSchemaIP = merchantDataBaseSchema.required({
    contactName: true,
    contactPhone: true,
    inn: true,
    ogrn: true
}).refine((d) => /^\d{12}$/.test(d.inn ?? ''), { message: 'ИНН ИП — 12 цифр', path: ['inn'] })
    .refine((d) => /^\d{15}$/.test(d.ogrn ?? ''), { message: 'ОГРНИП — 15 цифр', path: ['ogrn'] })
    .transform((d) => ({ ...d, kpp: undefined }));
const merchantDataSchemaSamozanyaty = merchantDataBaseSchema.required({
    contactName: true,
    contactPhone: true,
    legalName: true,
    inn: true
}).refine((d) => /^\d{12}$/.test(d.inn ?? ''), { message: 'ИНН самозанятого — 12 цифр', path: ['inn'] })
    .transform((d) => ({ ...d, kpp: undefined }));
const sellerTypeToLegacyLabel = {
    IP: 'ИП',
    SELF_EMPLOYED: 'Самозанятый',
    LLC: 'ООО'
};
const normalizeSellerType = (value) => {
    if (value === 'ИП')
        return 'IP';
    if (value === 'Самозанятый')
        return 'SELF_EMPLOYED';
    if (value === 'ООО')
        return 'LLC';
    return value;
};
const getSellerTypeFromProfile = (profile) => {
    if (profile.sellerType)
        return profile.sellerType;
    const legacy = profile.legalType ?? profile.status ?? '';
    if (legacy === 'ИП' || legacy === 'IP')
        return 'IP';
    if (legacy === 'Самозанятый' || legacy === 'SELF_EMPLOYED')
        return 'SELF_EMPLOYED';
    if (legacy === 'ООО' || legacy === 'LLC')
        return 'LLC';
    return null;
};
function parseMerchantDataPayload(body, status) {
    if (status === 'ООО')
        return merchantDataSchemaOOO.parse(body);
    if (status === 'ИП')
        return merchantDataSchemaIP.parse(body);
    return merchantDataSchemaSamozanyaty.parse(body);
}
function normalizeSiteUrl(url) {
    if (!url || !url.trim())
        return null;
    const u = url.trim().toLowerCase();
    if (u.startsWith('http://') || u.startsWith('https://'))
        return u;
    return `https://${u}`;
}
const normalizeMerchantUpdateData = (payload, status) => {
    const representativeName = payload.representativeName ?? payload.contactName ?? '';
    const legalName = payload.legalName?.trim() ||
        (status === 'ИП' ? `ИП ${payload.contactName ?? ''}`.trim() : null) ||
        (status === 'Самозанятый' ? `Самозанятый ${payload.contactName ?? ''}`.trim() : null) ||
        null;
    const updateData = {
        shipmentType: payload.shipmentType ?? 'import'
    };
    if (payload.contactName !== undefined)
        updateData.contactName = payload.contactName?.trim() || null;
    if (payload.contactPhone !== undefined)
        updateData.contactPhone = payload.contactPhone?.trim() || null;
    if (payload.representativeName !== undefined || payload.contactName !== undefined) {
        updateData.representativeName = representativeName.trim() || null;
    }
    if (payload.legalName !== undefined || payload.contactName !== undefined) {
        updateData.legalName = legalName ?? payload.legalName?.trim() ?? null;
    }
    if (payload.inn !== undefined)
        updateData.inn = payload.inn?.trim() || null;
    if (payload.ogrn !== undefined)
        updateData.ogrn = payload.ogrn?.trim() || null;
    if (status === 'ООО') {
        if (payload.kpp !== undefined)
            updateData.kpp = payload.kpp?.trim() || null;
    }
    if (payload.legalAddressFull !== undefined)
        updateData.legalAddressFull = payload.legalAddressFull?.trim() || null;
    if (payload.siteUrl !== undefined)
        updateData.siteUrl = normalizeSiteUrl(payload.siteUrl ?? undefined);
    return updateData;
};
const sellerOrdersQuerySchema = zod_1.z.object({
    status: zod_1.z.enum(['CREATED', 'PRINTING', 'HANDED_TO_DELIVERY', 'IN_TRANSIT', 'DELIVERED']).optional(),
    offset: zod_1.z.coerce.number().int().min(0).optional(),
    limit: zod_1.z.coerce.number().int().min(1).max(100).optional()
});
const sellerOrderStatusSchema = zod_1.z.object({
    status: zod_1.z.enum(['CREATED', 'PRINTING', 'HANDED_TO_DELIVERY', 'IN_TRANSIT', 'DELIVERED']),
    trackingNumber: zod_1.z.string().min(2).optional(),
    carrier: zod_1.z.string().min(2).optional()
});
const sellerShipmentStageSchema = zod_1.z.object({
    stage: zod_1.z.enum(['CREATING', 'PRINTING', 'READY_FOR_DROP', 'IN_TRANSIT', 'READY_FOR_PICKUP'])
});
const sellerSettingsSchema = zod_1.z.object({
    dropoffSchedule: zod_1.z.enum(['DAILY', 'WEEKDAYS'])
});
const sellerFulfillmentStepsSchema = zod_1.z.object({
    isPacked: zod_1.z.boolean().optional(),
    isLabelPrinted: zod_1.z.boolean().optional(),
    isActPrinted: zod_1.z.boolean().optional()
});
const normalizeProductMediaInput = (payload) => {
    if (payload.media !== undefined) {
        return payload.media.map((item, index) => ({
            type: item.type,
            url: item.url,
            isPrimary: item.isPrimary ?? false,
            sortOrder: item.sortOrder ?? index
        }));
    }
    const imageUrls = payload.imageUrls ?? (payload.image ? [payload.image] : []);
    const videoUrls = payload.videoUrls ?? [];
    return [
        ...imageUrls.map((url, index) => ({
            type: 'IMAGE',
            url,
            isPrimary: index === 0,
            sortOrder: index
        })),
        ...videoUrls.map((url, index) => ({
            type: 'VIDEO',
            url,
            isPrimary: false,
            sortOrder: imageUrls.length + index
        }))
    ];
};
function readPreparationChecklist(statusRaw) {
    const raw = (statusRaw && typeof statusRaw === 'object' ? statusRaw : {});
    const prep = (raw.preparationChecklist && typeof raw.preparationChecklist === 'object' ? raw.preparationChecklist : {});
    return prep;
}
;
const sellerDropoffPvzSchema = zod_1.z.object({
    provider: zod_1.z.literal('CDEK'),
    pvzId: zod_1.z.string().trim().min(1),
    addressFull: zod_1.z.string().optional(),
    raw: zod_1.z.object({
        city_code: zod_1.z.number().int().positive(),
        city: zod_1.z.string().optional(),
        address_full: zod_1.z.string().optional(),
        latitude: zod_1.z.number().optional(),
        longitude: zod_1.z.number().optional(),
        work_time: zod_1.z.string().optional()
    }).catchall(zod_1.z.unknown())
});
const sellerDropoffPvzSaveSchema = zod_1.z.object({
    dropoffPvz: zod_1.z.object({
        provider: zod_1.z.literal('CDEK').optional().default('CDEK'),
        pvzId: zod_1.z.string().trim().min(1),
        addressFull: zod_1.z.string().optional(),
        raw: zod_1.z.record(zod_1.z.unknown()).optional()
    })
});
const orderStatusFlow = ['CREATED', 'PRINTING', 'HANDED_TO_DELIVERY', 'IN_TRANSIT', 'DELIVERED'];
const shipmentStageFlow = ['CREATING', 'PRINTING', 'READY_FOR_DROP', 'IN_TRANSIT', 'READY_FOR_PICKUP'];
const normalizeShipmentStage = (status) => {
    const normalized = String(status ?? '').toUpperCase();
    if (normalized === 'READY_FOR_PICKUP' || normalized === 'DELIVERED')
        return 'READY_FOR_PICKUP';
    if (normalized === 'IN_TRANSIT' || normalized === 'TRANSPORTING')
        return 'IN_TRANSIT';
    if (normalized === 'ACCEPTED' || normalized === 'CREATED')
        return 'READY_FOR_DROP';
    if (normalized === 'READY_FOR_DROP' || normalized === 'READY_TO_SHIP')
        return 'READY_FOR_DROP';
    if (normalized === 'PRINTING' || normalized === 'DOCS_PRINTING')
        return 'PRINTING';
    return 'CREATING';
};
const MAX_FETCH_LIMIT = 5000;
// ---------------------------------------------------------
// Routes
// ---------------------------------------------------------
exports.sellerRoutes.post('/onboarding', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = sellerOnboardingSchema.parse(req.body);
        const user = await prisma_1.prisma.user.findUnique({
            where: { id: req.user.userId },
            select: { phoneVerifiedAt: true, phone: true, email: true }
        });
        if (!user?.phoneVerifiedAt)
            return res.status(403).json({ error: { code: 'PHONE_NOT_VERIFIED' } });
        const phone = user.phone ?? payload.phone;
        const storeName = payload.storeName || payload.name;
        const contactEmail = (payload.email || user.email || '').trim() || null;
        const sellerType = payload.sellerType;
        const legacySellerType = sellerTypeToLegacyLabel[sellerType];
        const profileData = {
            status: 'PENDING',
            sellerType,
            storeName,
            phone,
            city: payload.city,
            referenceCategory: payload.referenceCategory || null,
            legalType: legacySellerType,
            contactName: payload.name.trim(),
            contactPhone: phone,
            contactEmail
        };
        const updated = await prisma_1.prisma.user.update({
            where: { id: req.user.userId },
            data: {
                name: payload.name,
                phone,
                role: req.user.isAdmin ? 'ADMIN' : 'SELLER',
                sellerProfile: {
                    upsert: {
                        create: profileData,
                        update: profileData
                    }
                }
            }
        });
        return res.json({
            data: {
                id: updated.id,
                name: updated.name,
                email: updated.email,
                phone: updated.phone,
                role: updated.role,
                sellerType,
                sellerStatus: profileData.status,
                capabilities: {
                    isAdmin: req.user.isAdmin,
                    isSeller: true
                }
            }
        });
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            return res.status(400).json({
                error: {
                    code: 'ONBOARDING_VALIDATION_ERROR',
                    message: 'Ошибка валидации данных',
                    issues: error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
                }
            });
        }
        next(error);
    }
});
const loadSellerContext = async (userId) => {
    const profile = await prisma_1.prisma.sellerProfile.findUnique({ where: { userId } });
    if (!profile)
        return null;
    const latestSubmission = await prisma_1.prisma.sellerKycSubmission.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        include: { documents: true }
    });
    const approvedSubmission = await prisma_1.prisma.sellerKycSubmission.findFirst({
        where: { userId, status: 'APPROVED' },
        orderBy: { reviewedAt: 'desc' }
    });
    return {
        isSeller: true,
        profile,
        kyc: latestSubmission ?? null,
        canSell: Boolean(approvedSubmission)
    };
};
const respondSellerContext = async (req, res) => {
    const context = await loadSellerContext(req.user.userId);
    if (!context) {
        console.warn('Seller profile missing for user', { userId: req.user.userId });
        return res.status(409).json({ code: 'SELLER_PROFILE_MISSING', message: 'Seller onboarding required' });
    }
    return res.json({ data: context });
};
exports.sellerRoutes.get('/context', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        await respondSellerContext(req, res);
    }
    catch (e) {
        next(e);
    }
});
exports.sellerRoutes.get('/me', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        await respondSellerContext(req, res);
    }
    catch (e) {
        next(e);
    }
});
exports.sellerRoutes.use(authMiddleware_1.requireAuth, authMiddleware_1.requireSeller);
// ------------------- KYC -------------------
const ensureKycApproved = async (userId) => {
    const approved = await prisma_1.prisma.sellerKycSubmission.findFirst({
        where: { userId, status: 'APPROVED' },
        orderBy: { reviewedAt: 'desc' }
    });
    return Boolean(approved);
};
const ensureReferenceCategory = async (category) => {
    const ref = await prisma_1.prisma.referenceCategory.findFirst({
        where: { isActive: true, OR: [{ title: category }, { slug: category }] }
    });
    if (!ref)
        throw new Error('CATEGORY_INVALID');
    return ref.title;
};
exports.sellerRoutes.get('/kyc/me', async (req, res, next) => {
    try {
        const submission = await prisma_1.prisma.sellerKycSubmission.findFirst({
            where: { userId: req.user.userId },
            orderBy: { createdAt: 'desc' },
            include: { documents: true }
        });
        res.json({ data: submission ?? null });
    }
    catch (error) {
        next(error);
    }
});
const kycSubmitPayloadSchema = zod_1.z.object({
    merchantData: merchantDataBaseSchema,
    dropoffPvzId: zod_1.z.string().trim().min(1),
    dropoffPvzMeta: zod_1.z.record(zod_1.z.unknown()).optional(),
    acceptedRules: zod_1.z.boolean(),
    acceptedPersonalData: zod_1.z.boolean(),
    acceptedRulesSlug: zod_1.z.string().trim().min(1).optional(),
    acceptedPersonalDataSlug: zod_1.z.string().trim().min(1).optional()
});
exports.sellerRoutes.post('/kyc/submit', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const submitPayload = kycSubmitPayloadSchema.parse(req.body);
        if (!submitPayload.acceptedRules || !submitPayload.acceptedPersonalData) {
            return res.status(400).json({
                error: {
                    code: 'CONSENT_REQUIRED',
                    message: 'Для отправки заявки необходимо принять обязательные согласия.'
                }
            });
        }
        const profile = await prisma_1.prisma.sellerProfile.findFirst({
            where: { userId: req.user.userId },
            select: { status: true, sellerType: true, legalType: true }
        });
        if (!profile) {
            return res.status(409).json({ error: { code: 'SELLER_PROFILE_MISSING', message: 'Сначала завершите регистрацию продавца.' } });
        }
        const sellerType = getSellerTypeFromProfile(profile);
        if (!sellerType) {
            return res.status(409).json({ error: { code: 'SELLER_TYPE_MISSING', message: 'Тип продавца не заполнен. Повторите onboarding.' } });
        }
        const legalType = sellerTypeToLegacyLabel[sellerType];
        const merchantPayload = parseMerchantDataPayload(submitPayload.merchantData, legalType);
        const latestSubmission = await prisma_1.prisma.sellerKycSubmission.findFirst({
            where: { userId: req.user.userId },
            orderBy: { createdAt: 'desc' },
            include: { documents: true }
        });
        const dropoffPvzMeta = {
            provider: 'CDEK',
            pvzId: submitPayload.dropoffPvzId,
            ...(submitPayload.dropoffPvzMeta ?? {})
        };
        const submitted = await prisma_1.prisma.$transaction(async (tx) => {
            const now = new Date();
            const consentData = {
                ...(submitPayload.acceptedRules
                    ? {
                        acceptedRulesAt: now,
                        acceptedRulesSlug: submitPayload.acceptedRulesSlug ?? 'seller-delivery-and-store-rules'
                    }
                    : {}),
                ...(submitPayload.acceptedPersonalData
                    ? {
                        acceptedPersonalDataAt: now,
                        acceptedPersonalDataSlug: submitPayload.acceptedPersonalDataSlug ?? 'privacy-policy'
                    }
                    : {})
            };
            await tx.sellerProfile.update({
                where: { userId: req.user.userId },
                data: {
                    ...normalizeMerchantUpdateData(merchantPayload, legalType),
                    ...consentData
                }
            });
            await tx.sellerSettings.upsert({
                where: { sellerId: req.user.userId },
                create: {
                    sellerId: req.user.userId,
                    defaultDropoffProvider: 'CDEK',
                    defaultDropoffPvzId: submitPayload.dropoffPvzId,
                    defaultDropoffPvzMeta: dropoffPvzMeta
                },
                update: {
                    defaultDropoffProvider: 'CDEK',
                    defaultDropoffPvzId: submitPayload.dropoffPvzId,
                    defaultDropoffPvzMeta: dropoffPvzMeta
                }
            });
            await tx.sellerDeliveryProfile.upsert({
                where: { sellerId: req.user.userId },
                create: {
                    sellerId: req.user.userId,
                    dropoffPvzId: submitPayload.dropoffPvzId,
                    dropoffStationMeta: dropoffPvzMeta
                },
                update: {
                    dropoffPvzId: submitPayload.dropoffPvzId,
                    dropoffStationMeta: dropoffPvzMeta
                }
            });
            const submission = latestSubmission
                ? await tx.sellerKycSubmission.update({
                    where: { id: latestSubmission.id },
                    data: {
                        status: 'PENDING',
                        merchantData: submitPayload.merchantData,
                        dropoffPvzId: submitPayload.dropoffPvzId,
                        dropoffPvzMeta: dropoffPvzMeta,
                        comment: null,
                        submittedAt: new Date(),
                        reviewedAt: null,
                        reviewerId: null,
                        moderationNotes: null,
                        notes: null
                    }
                })
                : await tx.sellerKycSubmission.create({
                    data: {
                        userId: req.user.userId,
                        status: 'PENDING',
                        merchantData: submitPayload.merchantData,
                        dropoffPvzId: submitPayload.dropoffPvzId,
                        dropoffPvzMeta: dropoffPvzMeta,
                        submittedAt: new Date()
                    }
                });
            return tx.sellerKycSubmission.findUnique({
                where: { id: submission.id },
                include: { documents: true }
            });
        });
        res.status(201).json({ data: submitted });
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            return res.status(400).json({
                error: {
                    code: 'MERCHANT_DATA_VALIDATION_ERROR',
                    message: 'Ошибка валидации данных для отправки KYC',
                    issues: error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
                }
            });
        }
        next(error);
    }
});
// ------------------- Products -------------------
exports.sellerRoutes.get('/products', async (req, res, next) => {
    try {
        const approved = await ensureKycApproved(req.user.userId);
        if (!approved && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: { code: 'KYC_NOT_APPROVED', message: 'KYC not approved' } });
        }
        const sellerProducts = await prisma_1.prisma.product.findMany({
            where: { sellerId: req.user.userId },
            include: {
                images: { orderBy: { sortOrder: 'asc' } },
                media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
            }
        });
        res.json({ data: sellerProducts });
    }
    catch (error) {
        next(error);
    }
});
exports.sellerRoutes.post('/products', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const approved = await ensureKycApproved(req.user.userId);
        if (!approved && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: { code: 'KYC_NOT_APPROVED', message: 'KYC not approved' } });
        }
        const payload = productRoutes_1.sellerProductSchema.parse(req.body);
        const normalizedCategory = await ensureReferenceCategory(payload.category);
        const skuFallback = payload.sku ?? `SKU-${Date.now()}`;
        const media = normalizeProductMediaInput(payload);
        const imageMedia = media.filter((item) => item.type === 'IMAGE');
        const videoMedia = media.filter((item) => item.type === 'VIDEO');
        if (!imageMedia.length) {
            return res.status(400).json({ error: { code: 'IMAGE_REQUIRED' } });
        }
        const product = await productUseCases_1.productUseCases.create({
            ...payload,
            category: normalizedCategory,
            descriptionShort: payload.descriptionShort ?? payload.description,
            descriptionFull: payload.descriptionFull ?? payload.description,
            sku: skuFallback,
            currency: payload.currency ?? 'RUB',
            sellerId: req.user.userId,
            image: imageMedia[0].url,
            imageUrls: imageMedia.map((item) => item.url),
            videoUrls: videoMedia.map((item) => item.url),
            media
        });
        res.status(201).json({ data: product });
    }
    catch (error) {
        if (error instanceof Error && error.message === 'CATEGORY_INVALID') {
            return res.status(400).json({ error: { code: 'CATEGORY_INVALID', message: 'Категория недоступна.' } });
        }
        next(error);
    }
});
exports.sellerRoutes.put('/products/:id', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const approved = await ensureKycApproved(req.user.userId);
        if (!approved && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: { code: 'KYC_NOT_APPROVED', message: 'KYC not approved' } });
        }
        const payload = productRoutes_1.sellerProductSchema.partial().parse(req.body);
        const normalizedCategory = payload.category ? await ensureReferenceCategory(payload.category) : undefined;
        const media = payload.media !== undefined || payload.imageUrls !== undefined || payload.videoUrls !== undefined || payload.image !== undefined
            ? normalizeProductMediaInput(payload)
            : undefined;
        const imageMedia = media?.filter((item) => item.type === 'IMAGE') ?? [];
        const videoMedia = media?.filter((item) => item.type === 'VIDEO') ?? [];
        const product = await productUseCases_1.productUseCases.update(req.params.id, {
            ...payload,
            category: normalizedCategory ?? payload.category,
            descriptionShort: payload.descriptionShort ?? payload.description,
            descriptionFull: payload.descriptionFull ?? payload.description,
            sku: payload.sku,
            currency: payload.currency,
            sellerId: req.user.userId,
            image: imageMedia[0]?.url ?? payload.image,
            imageUrls: media ? imageMedia.map((item) => item.url) : undefined,
            videoUrls: media ? videoMedia.map((item) => item.url) : undefined,
            media
        });
        res.json({ data: product });
    }
    catch (error) {
        if (error instanceof Error && error.message === 'CATEGORY_INVALID') {
            return res.status(400).json({ error: { code: 'CATEGORY_INVALID', message: 'Категория недоступна.' } });
        }
        next(error);
    }
});
exports.sellerRoutes.delete('/products/:id', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const approved = await ensureKycApproved(req.user.userId);
        if (!approved && req.user.role !== 'ADMIN') {
            return res.status(403).json({ error: { code: 'KYC_NOT_APPROVED', message: 'KYC not approved' } });
        }
        await productUseCases_1.productUseCases.remove(req.params.id);
        res.json({ success: true });
    }
    catch (error) {
        next(error);
    }
});
exports.sellerRoutes.post('/uploads', rateLimiters_1.writeLimiter, upload.array('files', 10), async (req, res) => {
    const files = req.files ?? [];
    if (!files.length) {
        return res.status(400).json({ error: { code: 'FILES_REQUIRED' } });
    }
    const oversizedFiles = files.filter((file) => {
        if (allowedImageTypes.includes(file.mimetype))
            return file.size > maxImageSize;
        if (allowedVideoTypes.includes(file.mimetype))
            return file.size > maxVideoSize;
        return true;
    });
    if (oversizedFiles.length) {
        await Promise.all(files.map((file) => file.path ? fs_1.default.promises.unlink(file.path).catch(() => undefined) : Promise.resolve()));
        return res.status(400).json({ error: { code: 'FILE_TOO_LARGE' } });
    }
    const urls = files
        .filter((file) => file.filename)
        .map((file) => `/uploads/${file.filename}`);
    return res.json({ data: { urls } });
});
// ------------------- Settings -------------------
exports.sellerRoutes.get('/settings', async (req, res, next) => {
    try {
        const [settings, deliveryProfile] = await Promise.all([
            prisma_1.prisma.sellerSettings.findUnique({ where: { sellerId: req.user.userId } }),
            prisma_1.prisma.sellerDeliveryProfile.findUnique({ where: { sellerId: req.user.userId } })
        ]);
        const dropoffPvz = settings?.defaultDropoffPvzId
            ? {
                provider: 'CDEK',
                pvzId: settings.defaultDropoffPvzId,
                raw: settings.defaultDropoffPvzMeta,
                addressFull: typeof settings.defaultDropoffPvzMeta === 'object' && settings.defaultDropoffPvzMeta
                    ? String(settings.defaultDropoffPvzMeta.addressFull ?? '')
                    : undefined
            }
            : null;
        res.json({
            data: {
                ...(settings ?? { sellerId: req.user.userId }),
                dropoffSchedule: deliveryProfile?.dropoffSchedule ?? 'DAILY',
                dropoffPvz
            }
        });
    }
    catch (error) {
        next(error);
    }
});
exports.sellerRoutes.put('/settings', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = sellerSettingsSchema.parse(req.body ?? {});
        const profile = await sellerDeliveryProfileService_1.sellerDeliveryProfileService.upsert(req.user.userId, {
            dropoffSchedule: payload.dropoffSchedule
        });
        res.json({ data: profile });
    }
    catch (error) {
        next(error);
    }
});
exports.sellerRoutes.put('/settings/dropoff-pvz', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = sellerDropoffPvzSaveSchema.parse(req.body ?? {});
        const pvzId = payload.dropoffPvz.pvzId;
        let raw = payload.dropoffPvz.raw && typeof payload.dropoffPvz.raw === 'object'
            ? payload.dropoffPvz.raw
            : undefined;
        if (!raw) {
            const point = await cdekService_1.cdekService.getPickupPointByCode(pvzId);
            raw = point;
        }
        const rawRec = raw;
        const addressFull = payload.dropoffPvz.addressFull ??
            String(rawRec?.address_full ?? rawRec?.location?.address_full ?? '');
        const dropoffPvzMeta = {
            provider: 'CDEK',
            pvzId,
            addressFull,
            raw
        };
        const settings = await prisma_1.prisma.sellerSettings.upsert({
            where: { sellerId: req.user.userId },
            create: {
                sellerId: req.user.userId,
                defaultDropoffProvider: 'CDEK',
                defaultDropoffPvzId: pvzId,
                defaultDropoffPvzMeta: dropoffPvzMeta
            },
            update: {
                defaultDropoffProvider: 'CDEK',
                defaultDropoffPvzId: pvzId,
                defaultDropoffPvzMeta: dropoffPvzMeta
            }
        });
        return res.json({ data: settings });
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Некорректный payload для CDEK ПВЗ.',
                    details: error.issues
                }
            });
        }
        next(error);
    }
});
// ------------------- Orders -------------------
exports.sellerRoutes.get('/orders', async (req, res, next) => {
    try {
        const query = sellerOrdersQuerySchema.parse(req.query);
        const orders = await orderUseCases_1.orderUseCases.listBySeller(req.user.userId, {
            status: query.status,
            offset: query.offset,
            limit: query.limit
        });
        const shipments = await shipmentService_1.shipmentService.getByOrderIds(orders.map((o) => o.id));
        res.json({ data: orders.map((o) => ({ ...o, shipment: toShipmentView(shipments.get(o.id) ?? null) })) });
    }
    catch (error) {
        next(error);
    }
});
exports.sellerRoutes.patch('/orders/:id/fulfillment-steps', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = sellerFulfillmentStepsSchema.parse(req.body);
        const order = await prisma_1.prisma.order.findFirst({ where: { id: req.params.id, items: { some: { product: { sellerId: req.user.userId } } } } });
        if (!order)
            return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });
        if (!(await isOrderPaid(order))) {
            return res.status(400).json({ error: { code: 'PAYMENT_REQUIRED', message: 'Чеклист доступен только для оплаченных заказов.' } });
        }
        const updated = await prisma_1.prisma.order.update({
            where: { id: order.id },
            data: {
                ...(payload.isPacked !== undefined ? { isPacked: payload.isPacked } : {}),
                ...(payload.isLabelPrinted !== undefined ? { isLabelPrinted: payload.isLabelPrinted } : {}),
                ...(payload.isActPrinted !== undefined ? { isActPrinted: payload.isActPrinted } : {}),
                fulfillmentUpdatedAt: new Date()
            }
        });
        return res.json({ data: { isPacked: updated.isPacked, isLabelPrinted: updated.isLabelPrinted, isActPrinted: updated.isActPrinted } });
    }
    catch (error) {
        next(error);
    }
});
exports.sellerRoutes.post('/orders/:orderId/ready-to-ship', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const result = await shipmentService_1.shipmentService.readyToShipCdek({
            orderId: req.params.orderId,
            sellerId: req.user.userId
        });
        const order = await prisma_1.prisma.order.findFirst({
            where: { id: req.params.orderId, items: { some: { product: { sellerId: req.user.userId } } } },
            include: { shipment: true }
        });
        return res.json({ data: { order, shipment: toShipmentView(result.shipment), cdek: result.cdek } });
    }
    catch (e) {
        next(e);
    }
});
exports.sellerRoutes.post('/orders/:orderId/shipment', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const result = await shipmentService_1.shipmentService.createShipmentCdek({
            orderId: req.params.orderId,
            sellerId: req.user.userId
        });
        const order = await prisma_1.prisma.order.findFirst({
            where: { id: req.params.orderId, items: { some: { product: { sellerId: req.user.userId } } } },
            include: { shipment: true }
        });
        return res.json({ data: { order, shipment: toShipmentView(result.shipment), cdek: result.cdek } });
    }
    catch (e) {
        next(e);
    }
});
exports.sellerRoutes.post('/shipments/:id/sync', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const shipment = await prisma_1.prisma.orderShipment.findUnique({
            where: { id: req.params.id },
            include: { order: { include: { items: { include: { product: true } } } } }
        });
        if (!shipment)
            return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });
        const hasAccess = shipment.order.items.some((item) => item.product.sellerId === req.user.userId);
        if (!hasAccess)
            return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });
        const result = await shipmentService_1.shipmentService.syncByShipmentId(req.params.id);
        return res.json({ data: result });
    }
    catch (e) {
        next(e);
    }
});
exports.sellerRoutes.get('/shipments/:id/label', async (req, res, next) => {
    try {
        const shipment = await prisma_1.prisma.orderShipment.findUnique({
            where: { id: req.params.id },
            include: { order: { include: { items: { include: { product: true } } } } }
        });
        if (!shipment)
            return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });
        const hasAccess = shipment.order.items.some((item) => item.product.sellerId === req.user.userId);
        if (!hasAccess)
            return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });
        const result = await shipmentService_1.shipmentService.resolveLabelBarcodePdf({
            shipmentId: shipment.id,
            cdekOrderId: String(shipment.order.cdekOrderId ?? ''),
            labelPrintRequestUuid: shipment.labelPrintRequestUuid
        });
        if (result.status === 'need_ready_to_ship')
            return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
        if (result.status === 'processing')
            return res.status(409).json({ error: FORMS_NOT_READY_ERROR });
        if (result.status !== 'ready')
            return res.status(502).json({ error: DOCUMENT_DOWNLOAD_FAILED_ERROR });
        await prisma_1.prisma.$transaction(async (tx) => {
            await tx.order.update({
                where: { id: shipment.orderId },
                data: {
                    isLabelPrinted: true,
                    fulfillmentUpdatedAt: new Date()
                }
            });
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="cdek-label-${shipment.id}.pdf"`);
        res.setHeader('Content-Length', result.pdf.length);
        return res.status(200).send(result.pdf);
    }
    catch (e) {
        next(e);
    }
});
exports.sellerRoutes.get('/shipments/:id/barcodes', async (req, res, next) => {
    try {
        const shipment = await prisma_1.prisma.orderShipment.findUnique({
            where: { id: req.params.id },
            include: { order: { include: { items: { include: { product: true } } } } }
        });
        if (!shipment)
            return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });
        const hasAccess = shipment.order.items.some((item) => item.product.sellerId === req.user.userId);
        if (!hasAccess)
            return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });
        const result = await shipmentService_1.shipmentService.resolveLabelBarcodePdf({
            shipmentId: shipment.id,
            cdekOrderId: String(shipment.order.cdekOrderId ?? ''),
            labelPrintRequestUuid: shipment.labelPrintRequestUuid
        });
        if (result.status === 'need_ready_to_ship')
            return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
        if (result.status === 'processing')
            return res.status(409).json({ error: FORMS_NOT_READY_ERROR });
        if (result.status !== 'ready')
            return res.status(502).json({ error: DOCUMENT_DOWNLOAD_FAILED_ERROR });
        return res.json({ data: { status: 'ready', format: 'application/pdf', size: result.pdf.length } });
    }
    catch (e) {
        next(e);
    }
});
exports.sellerRoutes.get('/shipments/:id/act', async (req, res, next) => {
    try {
        const shipment = await prisma_1.prisma.orderShipment.findUnique({
            where: { id: req.params.id },
            include: { order: { include: { items: { include: { product: true } } } } }
        });
        if (!shipment)
            return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });
        const hasAccess = shipment.order.items.some((item) => item.product.sellerId === req.user.userId);
        if (!hasAccess)
            return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });
        const result = await resolveOrderPrintPdf({
            shipmentId: shipment.id,
            cdekOrderId: shipment.order.cdekOrderId,
            printRequestUuid: shipment.actPrintRequestUuid,
            type: 'tpl_russia',
            kind: 'act'
        }).catch(() => ({ status: 'invalid' }));
        if (result.status === 'need_ready_to_ship')
            return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
        if (result.status === 'processing')
            return res.status(409).json({ error: FORMS_NOT_READY_ERROR });
        if (result.status === 'expired')
            return res.status(409).json({ error: FORMS_EXPIRED_ERROR });
        if (result.status !== 'ready')
            return res.status(502).json({ error: DOCUMENT_DOWNLOAD_FAILED_ERROR });
        await prisma_1.prisma.$transaction(async (tx) => {
            await tx.order.update({
                where: { id: shipment.orderId },
                data: {
                    isActPrinted: true,
                    fulfillmentUpdatedAt: new Date()
                }
            });
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', withUtf8PdfDisposition(`cdek-act-${shipment.id}.pdf`));
        res.setHeader('Content-Length', result.pdf.length);
        return res.status(200).send(result.pdf);
    }
    catch (error) {
        next(error);
    }
});
const loadSellerOrderForDocuments = async (sellerId, orderId) => prisma_1.prisma.order.findFirst({
    where: { id: orderId, items: { some: { product: { sellerId } } } },
    include: { items: { include: { product: true } }, shipment: true }
});
const NEED_READY_TO_SHIP_ERROR = {
    code: 'NEED_READY_TO_SHIP',
    message: 'Сначала нажмите ‘Готов к отгрузке’'
};
const FORMS_NOT_READY_ERROR = {
    code: 'FORMS_NOT_READY',
    message: 'Документы ещё формируются. Повторите после синхронизации.',
    retryAfterSec: 10
};
const FORMS_EXPIRED_ERROR = {
    code: 'FORMS_EXPIRED',
    message: 'Срок действия сформированного документа истёк. Запросите форму повторно.'
};
const DOCUMENT_DOWNLOAD_FAILED_ERROR = {
    code: 'DOCUMENT_DOWNLOAD_FAILED',
    message: 'Ошибка документа'
};
const withUtf8PdfDisposition = (filename) => {
    const safeAscii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};
const resolveOrderPrintPdf = async (params) => {
    const cdekOrderId = String(params.cdekOrderId ?? '').trim();
    if (!cdekOrderId)
        return { status: 'need_ready_to_ship' };
    let printUuid = String(params.printRequestUuid ?? '').trim();
    if (!printUuid) {
        printUuid = await cdekService_1.cdekService.createOrderPrint([cdekOrderId], params.type ?? 'tpl_russia', 2);
        await prisma_1.prisma.orderShipment.update({ where: { id: params.shipmentId }, data: params.kind === 'label' ? { labelPrintRequestUuid: printUuid } : { actPrintRequestUuid: printUuid } });
    }
    const snapshot = await cdekService_1.cdekService.getOrderPrintStatus(printUuid);
    if (snapshot.status === 'READY') {
        const pdf = await cdekService_1.cdekService.downloadOrderPrintPdf(printUuid);
        return { status: 'ready', pdf };
    }
    if (snapshot.status === 'ACCEPTED' || snapshot.status === 'PROCESSING') {
        return { status: 'processing' };
    }
    if (snapshot.status === 'REMOVED') {
        await prisma_1.prisma.orderShipment.update({ where: { id: params.shipmentId }, data: params.kind === 'label' ? { labelPrintRequestUuid: null } : { actPrintRequestUuid: null } });
        return { status: 'expired' };
    }
    return { status: 'invalid' };
};
const hasSuccessfulPayment = async (orderId) => {
    const payment = await prisma_1.prisma.payment.findFirst({
        where: { orderId },
        orderBy: { createdAt: 'desc' },
        select: { status: true }
    });
    return payment?.status === 'SUCCEEDED';
};
const isOrderPaid = async (order) => Boolean(order.paidAt) || (await hasSuccessfulPayment(order.id));
exports.sellerRoutes.get('/orders/:orderId/documents/packing-slip.pdf', async (req, res, next) => {
    try {
        const order = await loadSellerOrderForDocuments(req.user.userId, req.params.orderId);
        if (!order)
            return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });
        const pdf = await sellerOrderDocumentsService_1.sellerOrderDocumentsService.buildPackingSlip(order);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', withUtf8PdfDisposition(`packing-slip-${order.id}.pdf`));
        return res.status(200).send(pdf);
    }
    catch (error) {
        return next(error);
    }
});
exports.sellerRoutes.get('/orders/:orderId/documents/label.pdf', async (req, res, next) => {
    try {
        const order = await loadSellerOrderForDocuments(req.user.userId, req.params.orderId);
        if (!order)
            return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });
        if (!(await isOrderPaid(order))) {
            return res.status(409).json({ error: { code: 'PAYMENT_REQUIRED', message: 'Документы доступны только для оплаченных заказов.' } });
        }
        if (!order.cdekOrderId && !order.shipment?.id) {
            return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
        }
        const shipmentId = order.shipment?.id;
        if (!shipmentId) {
            return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
        }
        const result = await shipmentService_1.shipmentService.resolveLabelBarcodePdf({
            shipmentId,
            cdekOrderId: String(order.cdekOrderId ?? ''),
            labelPrintRequestUuid: order.shipment?.labelPrintRequestUuid
        });
        if (result.status === 'need_ready_to_ship')
            return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
        if (result.status === 'processing')
            return res.status(409).json({ error: FORMS_NOT_READY_ERROR });
        if (result.status !== 'ready')
            return res.status(502).json({ error: DOCUMENT_DOWNLOAD_FAILED_ERROR });
        await prisma_1.prisma.order.update({ where: { id: order.id }, data: { isLabelPrinted: true, fulfillmentUpdatedAt: new Date() } });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', withUtf8PdfDisposition(`cdek-label-${order.id}.pdf`));
        res.setHeader('Content-Length', result.pdf.length);
        return res.status(200).send(result.pdf);
    }
    catch (error) {
        return next(error);
    }
});
exports.sellerRoutes.get('/orders/:orderId/documents/handover-act.pdf', async (req, res, next) => {
    try {
        const order = await loadSellerOrderForDocuments(req.user.userId, req.params.orderId);
        if (!order)
            return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });
        if (!(await isOrderPaid(order))) {
            return res.status(409).json({ error: { code: 'PAYMENT_REQUIRED', message: 'Документы доступны только для оплаченных заказов.' } });
        }
        if (!order.cdekOrderId && !order.shipment?.id) {
            return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
        }
        const shipmentId = order.shipment?.id;
        if (!shipmentId) {
            return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
        }
        const result = await resolveOrderPrintPdf({
            shipmentId,
            cdekOrderId: order.cdekOrderId,
            printRequestUuid: order.shipment?.actPrintRequestUuid,
            type: 'tpl_russia',
            kind: 'act'
        }).catch(() => ({ status: 'invalid' }));
        if (result.status === 'need_ready_to_ship')
            return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
        if (result.status === 'processing')
            return res.status(409).json({ error: FORMS_NOT_READY_ERROR });
        if (result.status === 'expired')
            return res.status(409).json({ error: FORMS_EXPIRED_ERROR });
        if (result.status !== 'ready')
            return res.status(502).json({ error: DOCUMENT_DOWNLOAD_FAILED_ERROR });
        await prisma_1.prisma.order.update({ where: { id: order.id }, data: { isActPrinted: true, fulfillmentUpdatedAt: new Date() } });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', withUtf8PdfDisposition(`handover-act-${order.id}.pdf`));
        res.setHeader('Content-Length', result.pdf.length);
        return res.status(200).send(result.pdf);
    }
    catch (error) {
        return next(error);
    }
});
exports.sellerRoutes.patch('/orders/:id/preparation', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        return res.status(409).json({ error: { code: 'LEGACY_ENDPOINT', message: 'Используйте /seller/orders/:id/fulfillment-steps' } });
    }
    catch (error) {
        return next(error);
    }
});
// ------------------- Payments -------------------
exports.sellerRoutes.get('/payments', async (req, res, next) => {
    try {
        const payments = await prisma_1.prisma.payment.findMany({
            where: { order: { items: { some: { product: { sellerId: req.user.userId } } } } },
            select: { id: true, orderId: true, amount: true, status: true, currency: true, createdAt: true },
            orderBy: { createdAt: 'desc' }
        });
        res.json({ data: payments });
    }
    catch (error) {
        next(error);
    }
});
// ------------------- Status updates -------------------
exports.sellerRoutes.patch('/orders/:id/status', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = sellerOrderStatusSchema.parse(req.body);
        const order = await prisma_1.prisma.order.findFirst({
            where: { id: req.params.id, items: { some: { product: { sellerId: req.user.userId } } } },
            include: {
                items: { where: { product: { sellerId: req.user.userId } }, include: { product: true, variant: true } },
                contact: true,
                shippingAddress: true,
                buyer: true
            }
        });
        if (!order)
            return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });
        const currentIndex = orderStatusFlow.indexOf(order.status);
        const nextIndex = orderStatusFlow.indexOf(payload.status);
        if (currentIndex === -1 || nextIndex === -1)
            return res.status(400).json({ error: { code: 'STATUS_INVALID' } });
        if (order.status === 'DELIVERED')
            return res.status(400).json({ error: { code: 'STATUS_FINAL' } });
        if (nextIndex <= currentIndex)
            return res.status(400).json({ error: { code: 'STATUS_BACKWARD' } });
        if (nextIndex !== currentIndex + 1)
            return res.status(400).json({ error: { code: 'STATUS_SKIP_NOT_ALLOWED' } });
        const trackingNumber = payload.trackingNumber ?? order.trackingNumber ?? undefined;
        const carrier = payload.carrier ?? order.carrier ?? undefined;
        if (['HANDED_TO_DELIVERY', 'IN_TRANSIT', 'DELIVERED'].includes(payload.status) && (!trackingNumber || !carrier)) {
            return res.status(400).json({ error: { code: 'TRACKING_REQUIRED' } });
        }
        const updated = await prisma_1.prisma.$transaction(async (tx) => {
            const nextOrder = await tx.order.update({
                where: { id: order.id },
                data: { status: payload.status, statusUpdatedAt: new Date(), trackingNumber, carrier },
                include: {
                    items: { where: { product: { sellerId: req.user.userId } }, include: { product: true, variant: true } },
                    contact: true,
                    shippingAddress: true,
                    buyer: true
                }
            });
            if (payload.status === 'DELIVERED') {
                await payoutService_1.payoutService.releaseForDeliveredOrder(order.id, tx);
            }
            return nextOrder;
        });
        res.json({ data: updated });
    }
    catch (error) {
        next(error);
    }
});
exports.sellerRoutes.patch('/orders/:id/shipment-stage', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = sellerShipmentStageSchema.parse(req.body);
        const order = await prisma_1.prisma.order.findFirst({
            where: { id: req.params.id, items: { some: { product: { sellerId: req.user.userId } } } },
            include: { shipment: true }
        });
        if (!order)
            return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND', message: 'Заказ не найден.' } });
        if (!order.shipment)
            return res.status(400).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Отправление ещё не создано.' } });
        const currentStage = normalizeShipmentStage(order.shipment.status);
        const currentIndex = shipmentStageFlow.indexOf(currentStage);
        const nextIndex = shipmentStageFlow.indexOf(payload.stage);
        if (nextIndex === -1 || currentIndex === -1) {
            return res.status(400).json({ error: { code: 'STATUS_INVALID', message: 'Некорректный статус доставки.' } });
        }
        if (nextIndex < currentIndex) {
            return res.status(400).json({ error: { code: 'STATUS_BACKWARD', message: 'Нельзя откатывать статус доставки назад.' } });
        }
        if (nextIndex > currentIndex + 1) {
            return res.status(400).json({ error: { code: 'STATUS_SKIP_NOT_ALLOWED', message: 'Нельзя пропускать этапы доставки.' } });
        }
        if (payload.stage === 'READY_FOR_PICKUP' && !(await isOrderPaid(order))) {
            return res.status(400).json({ error: { code: 'PAYMENT_REQUIRED', message: 'Статус «Готов к выдаче» доступен только для оплаченных заказов.' } });
        }
        const updated = await prisma_1.prisma.$transaction(async (tx) => {
            const shipment = await tx.orderShipment.update({
                where: { id: order.shipment.id },
                data: { status: payload.stage }
            });
            await tx.orderShipmentStatusHistory.create({
                data: { shipmentId: shipment.id, status: payload.stage, payloadRaw: { source: 'seller-panel' } }
            });
            return shipment;
        });
        return res.json({ data: toShipmentView(updated) });
    }
    catch (error) {
        return next(error);
    }
});
exports.sellerRoutes.get('/stats', async (req, res, next) => {
    try {
        const orders = await orderUseCases_1.orderUseCases.listBySeller(req.user.userId);
        const revenue = orders.reduce((sum, order) => sum + order.items.reduce((itemSum, item) => itemSum + item.priceAtPurchase * item.quantity, 0), 0);
        const products = await prisma_1.prisma.product.findMany({ where: { sellerId: req.user.userId } });
        const statusCounts = orderStatusFlow.reduce((acc, status) => {
            acc[status] = orders.filter((o) => o.status === status).length;
            return acc;
        }, {});
        res.json({ data: { totalOrders: orders.length, totalRevenue: revenue, totalProducts: products.length, statusCounts } });
    }
    catch (error) {
        next(error);
    }
});
