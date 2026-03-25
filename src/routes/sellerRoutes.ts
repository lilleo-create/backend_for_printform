import "dotenv/config";
import { Response, Router } from "express";
import { z } from "zod";
import multer from "multer";
import path from "path";
import fs from "fs";
import { requireAuth, requireSeller, AuthRequest } from "../middleware/authMiddleware";
import { OrderStatus, SellerType, type Prisma, type SellerKycSubmission, type SellerProfile } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { productUseCases } from "../usecases/productUseCases";
import { orderUseCases } from "../usecases/orderUseCases";
import { sellerProductCreateSchema, sellerProductUpdateSchema } from "./productRoutes";
import { writeLimiter } from "../middleware/rateLimiters";
import { sellerDeliveryProfileService } from "../services/sellerDeliveryProfileService";
import { payoutService } from "../services/payoutService";
import { shipmentService } from "../services/shipmentService";
import { sellerOrderDocumentsService } from "../services/sellerOrderDocumentsService";
import { resolveRoleAfterSellerEnablement } from '../utils/accessControl';
import { cdekService } from "../services/cdekService";
export const sellerRoutes = Router();

export type SellerKycSubmissionWithDocuments = Prisma.SellerKycSubmissionGetPayload<{ include: { documents: true } }>;

export interface SellerContextResponse {
  isSeller: boolean;
  profile: SellerProfile | null;
  kyc?: SellerKycSubmissionWithDocuments | SellerKycSubmission | null;
  canSell?: boolean;
}

// ---------------------------------------------------------
// Uploads
// ---------------------------------------------------------
const uploadDir = path.join(process.cwd(), "uploads");

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}-${file.originalname}`);
  }
});

const IMAGE_UPLOAD_RULES: ReadonlyArray<{ mime: string; extensions: string[] }> = [
  { mime: "image/jpeg", extensions: [".jpg", ".jpeg"] },
  { mime: "image/png", extensions: [".png"] },
  { mime: "image/webp", extensions: [".webp"] },
  { mime: "image/heic", extensions: [".heic"] },
  { mime: "image/heif", extensions: [".heif"] }
];

const VIDEO_UPLOAD_RULES: ReadonlyArray<{ mime: string; extensions: string[] }> = [
  { mime: "video/mp4", extensions: [".mp4", ".m4v"] },
  { mime: "video/quicktime", extensions: [".mov", ".qt"] },
  { mime: "video/webm", extensions: [".webm"] }
];

const allowedImageTypes = IMAGE_UPLOAD_RULES.map((rule) => rule.mime);
const allowedVideoTypes = VIDEO_UPLOAD_RULES.map((rule) => rule.mime);
const maxImageSize = 10 * 1024 * 1024;
const maxVideoSize = 100 * 1024 * 1024;

const resolveUploadKind = (file: Pick<Express.Multer.File, "mimetype" | "originalname">): "IMAGE" | "VIDEO" | null => {
  const extension = path.extname(file.originalname ?? "").toLowerCase();
  const isAllowed = (rules: ReadonlyArray<{ mime: string; extensions: string[] }>) =>
    rules.some((rule) => rule.mime === file.mimetype && rule.extensions.includes(extension));

  if (isAllowed(IMAGE_UPLOAD_RULES)) return "IMAGE";
  if (isAllowed(VIDEO_UPLOAD_RULES)) return "VIDEO";
  return null;
};

const upload = multer({
  storage,
  limits: { fileSize: maxVideoSize },
  fileFilter: (_req, file, cb) => {
    if (resolveUploadKind(file)) return cb(null, true);
    return cb(new Error("PRODUCT_UPLOAD_FILE_TYPE_INVALID"));
  }
});


const toShipmentView = (shipment: any) => {
  if (!shipment) return null;
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
const sellerTypeInputSchema = z.enum(['IP', 'SELF_EMPLOYED', 'LLC', 'ИП', 'Самозанятый', 'ООО'], {
  invalid_type_error: 'Укажите корректный тип продавца.',
  required_error: 'Укажите тип продавца.'
});

const sellerTypeFieldSchema = sellerTypeInputSchema.optional();
const sellerLifecycleStatusSchema = z.string().trim().min(1).optional();
const optionalTrimmedString = () => z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  },
  z.string().min(2).optional()
);

const sellerOnboardingSchema = z.object({
  name: z.string({ required_error: 'Укажите имя продавца.' }).trim().min(2, 'Имя продавца должно содержать минимум 2 символа.'),
  phone: z.string({ required_error: 'Укажите номер телефона.' }).trim().min(5, 'Укажите корректный номер телефона.'),
  email: z.union([
    z.string().trim().email('Укажите корректный email.'),
    z.literal('')
  ]).optional(),
  sellerType: sellerTypeFieldSchema,
  status: sellerLifecycleStatusSchema,
  storeName: z.string().trim().optional(),
  city: z.string({ required_error: 'Укажите город.' }).trim().min(2, 'Название города должно содержать минимум 2 символа.'),
  referenceCategory: optionalTrimmedString()
}).superRefine((payload, ctx) => {
  if (!payload.sellerType && !payload.status) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'Укажите тип продавца.'
    });
    return;
  }

  if (payload.status && !['ИП', 'Самозанятый', 'ООО', 'IP', 'SELF_EMPLOYED', 'LLC'].includes(payload.status)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'Поле status должно содержать тип продавца: ИП, Самозанятый или ООО.'
    });
  }

  if (payload.sellerType && payload.status) {
    const normalizedSellerType = normalizeSellerType(payload.sellerType);
    const normalizedStatus = normalizeSellerType(payload.status as z.infer<typeof sellerTypeInputSchema>);
    if (normalizedSellerType !== normalizedStatus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'Поля status и sellerType передают один и тот же тип продавца и не должны конфликтовать.'
      });
    }
  }
}).transform((payload) => ({
  ...payload,
  sellerType: normalizeSellerType((payload.sellerType ?? payload.status) as z.infer<typeof sellerTypeInputSchema>),
  status: undefined,
  storeName: payload.storeName?.trim() || undefined,
  email: payload.email?.trim() || '',
  city: payload.city.trim(),
  name: payload.name.trim(),
  phone: payload.phone.trim()
}));

/** Данные для мерчанта NDD (раздел «Подключение продавца»). */
const merchantDataBaseSchema = z.object({
  contactName: z.string().trim().min(2).optional(),
  contactPhone: z.string().trim().min(5).optional(),
  representativeName: z.string().trim().min(2).optional(),
  legalAddressFull: z.string().trim().min(5).optional().or(z.literal('')),
  siteUrl: z.string().trim().min(2).optional().or(z.literal('')),
  shipmentType: z.enum(['import', 'withdraw']).optional(),
  legalName: z.string().trim().min(1).optional(),
  inn: z.string().trim().optional(),
  ogrn: z.string().trim().optional(),
  kpp: z.string().trim().optional()
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


const sellerTypeToLegacyLabel: Record<SellerType, 'ИП' | 'Самозанятый' | 'ООО'> = {
  IP: 'ИП',
  SELF_EMPLOYED: 'Самозанятый',
  LLC: 'ООО'
};

const normalizeSellerType = (value: z.infer<typeof sellerTypeInputSchema>): SellerType => {
  if (value === 'ИП') return 'IP';
  if (value === 'Самозанятый') return 'SELF_EMPLOYED';
  if (value === 'ООО') return 'LLC';
  return value;
};

const getSellerTypeFromProfile = (profile: { sellerType?: SellerType | null; legalType?: string | null; status?: string | null }) => {
  if (profile.sellerType) return profile.sellerType;
  const legacy = profile.legalType ?? profile.status ?? '';
  if (legacy === 'ИП' || legacy === 'IP') return 'IP' as const;
  if (legacy === 'Самозанятый' || legacy === 'SELF_EMPLOYED') return 'SELF_EMPLOYED' as const;
  if (legacy === 'ООО' || legacy === 'LLC') return 'LLC' as const;
  return null;
};

function parseMerchantDataPayload(body: unknown, status: 'ООО' | 'ИП' | 'Самозанятый') {
  if (status === 'ООО') return merchantDataSchemaOOO.parse(body);
  if (status === 'ИП') return merchantDataSchemaIP.parse(body);
  return merchantDataSchemaSamozanyaty.parse(body);
}

function normalizeSiteUrl(url: string | undefined): string | null {
  if (!url || !url.trim()) return null;
  const u = url.trim().toLowerCase();
  if (u.startsWith('http://') || u.startsWith('https://')) return u;
  return `https://${u}`;
}

const normalizeMerchantUpdateData = (
  payload: z.infer<typeof merchantDataBaseSchema>,
  status: 'ООО' | 'ИП' | 'Самозанятый'
) => {
  const representativeName = payload.representativeName ?? payload.contactName ?? '';
  const legalName =
    payload.legalName?.trim() ||
    (status === 'ИП' ? `ИП ${payload.contactName ?? ''}`.trim() : null) ||
    (status === 'Самозанятый' ? `Самозанятый ${payload.contactName ?? ''}`.trim() : null) ||
    null;

  const updateData: Record<string, unknown> = {
    shipmentType: payload.shipmentType ?? 'import'
  };

  if (payload.contactName !== undefined) updateData.contactName = payload.contactName?.trim() || null;
  if (payload.contactPhone !== undefined) updateData.contactPhone = payload.contactPhone?.trim() || null;
  if (payload.representativeName !== undefined || payload.contactName !== undefined) {
    updateData.representativeName = representativeName.trim() || null;
  }
  if (payload.legalName !== undefined || payload.contactName !== undefined) {
    updateData.legalName = legalName ?? payload.legalName?.trim() ?? null;
  }
  if (payload.inn !== undefined) updateData.inn = payload.inn?.trim() || null;
  if (payload.ogrn !== undefined) updateData.ogrn = payload.ogrn?.trim() || null;
  if (status === 'ООО') {
    if (payload.kpp !== undefined) updateData.kpp = payload.kpp?.trim() || null;
  }
  if (payload.legalAddressFull !== undefined) updateData.legalAddressFull = payload.legalAddressFull?.trim() || null;
  if (payload.siteUrl !== undefined) updateData.siteUrl = normalizeSiteUrl(payload.siteUrl ?? undefined);

  return updateData;
};

const sellerOrdersQuerySchema = z.object({
  status: z.enum(['CREATED', 'PRINTING', 'HANDED_TO_DELIVERY', 'IN_TRANSIT', 'DELIVERED']).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const sellerOrderStatusSchema = z.object({
  status: z.enum(['CREATED', 'PRINTING', 'HANDED_TO_DELIVERY', 'IN_TRANSIT', 'DELIVERED']),
  trackingNumber: z.string().min(2).optional(),
  carrier: z.string().min(2).optional()
});

const sellerShipmentStageSchema = z.object({
  stage: z.enum(['CREATING', 'PRINTING', 'READY_FOR_DROP', 'IN_TRANSIT', 'READY_FOR_PICKUP'])
});


const sellerSettingsSchema = z.object({
  dropoffSchedule: z.enum(['DAILY', 'WEEKDAYS'])
});

const sellerFulfillmentStepsSchema = z.object({
  isPacked: z.boolean().optional(),
  isLabelPrinted: z.boolean().optional(),
  isActPrinted: z.boolean().optional()
});

const sellerMediaUrlSchema = z.string().refine((value) => {
  if (value.startsWith('/uploads/')) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
});

const sellerVariantMutationSchema = z.object({
  sku: z.string().min(3).optional(),
  price: z.number().int().positive().optional(),
  color: z.string().min(2).optional(),
  variantLabel: z.string().min(1).max(120).optional(),
  variantSize: z.string().min(1).max(64).optional(),
  variantAttributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  image: sellerMediaUrlSchema.optional(),
  imageUrls: z.array(sellerMediaUrlSchema).optional(),
  videoUrls: z.array(sellerMediaUrlSchema).optional(),
  media: z
    .array(
      z.object({
        type: z.enum(['IMAGE', 'VIDEO']),
        url: sellerMediaUrlSchema,
        isPrimary: z.boolean().optional(),
        sortOrder: z.number().int().min(0).optional()
      })
    )
    .optional()
});

type PreparationChecklist = {
  packedDone?: boolean;
  packedAt?: string;
  labelPrintedDone?: boolean;
  labelPrintedAt?: string;
  actPrintedDone?: boolean;
  actPrintedAt?: string;
  readyForDropoffDone?: boolean;
  readyForDropoffAt?: string;
};

type SellerMediaInput = {
  type: 'IMAGE' | 'VIDEO';
  url: string;
  isPrimary?: boolean;
  sortOrder?: number;
};

type SellerProductPayload = Partial<z.infer<typeof sellerProductCreateSchema>>;
type SellerProductVariantPayload = NonNullable<z.infer<typeof sellerProductCreateSchema>['variants']>[number];

const generateSkuFallback = (suffix?: string) => {
  const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();
  const normalizedSuffix = suffix ? `-${suffix}` : '';
  return `SKU-${Date.now()}-${randomPart}${normalizedSuffix}`;
};

const normalizeProductMediaInput = (payload: SellerProductPayload): SellerMediaInput[] => {
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
      type: 'IMAGE' as const,
      url,
      isPrimary: index === 0,
      sortOrder: index
    })),
    ...videoUrls.map((url, index) => ({
      type: 'VIDEO' as const,
      url,
      isPrimary: false,
      sortOrder: imageUrls.length + index
    }))
  ];
};

const normalizeVariantPayload = (
  basePayload: z.infer<typeof sellerProductCreateSchema>,
  variantPayload: SellerProductVariantPayload
) => {
  const mergedPayload: SellerProductPayload = {
    image: variantPayload.image ?? basePayload.image,
    imageUrls: variantPayload.imageUrls ?? basePayload.imageUrls,
    videoUrls: variantPayload.videoUrls ?? basePayload.videoUrls,
    media: variantPayload.media ?? basePayload.media
  };

  const media = normalizeProductMediaInput(mergedPayload);
  const imageMedia = media.filter((item) => item.type === 'IMAGE');
  const videoMedia = media.filter((item) => item.type === 'VIDEO');

  return {
    sku: variantPayload.sku ?? generateSkuFallback(),
    title: basePayload.title,
    category: basePayload.category,
    price: variantPayload.price ?? basePayload.price,
    currency: basePayload.currency ?? 'RUB',
    description: basePayload.description,
    descriptionShort: basePayload.descriptionShort ?? basePayload.description,
    descriptionFull: basePayload.descriptionFull ?? basePayload.description,
    material: basePayload.material,
    technology: basePayload.technology,
    printTime: basePayload.printTime,
    productionTimeHours: basePayload.productionTimeHours,
    color: variantPayload.color ?? basePayload.color,
    variantLabel: variantPayload.variantLabel,
    variantSize: variantPayload.variantSize,
    variantAttributes: variantPayload.variantAttributes,
    weightGrossG: basePayload.weightGrossG,
    dxCm: basePayload.dxCm,
    dyCm: basePayload.dyCm,
    dzCm: basePayload.dzCm,
    image: imageMedia[0]?.url ?? basePayload.image ?? '',
    imageUrls: imageMedia.map((item) => item.url),
    videoUrls: videoMedia.map((item) => item.url),
    media
  };
};

function readPreparationChecklist(statusRaw: unknown): PreparationChecklist {
  const raw = (statusRaw && typeof statusRaw === 'object' ? statusRaw : {}) as Record<string, unknown>;
  const prep = (raw.preparationChecklist && typeof raw.preparationChecklist === 'object' ? raw.preparationChecklist : {}) as Record<string, unknown>;
  return prep as PreparationChecklist;
};


const sellerDropoffPvzSchema = z.object({
  provider: z.literal('CDEK'),
  pvzId: z.string().trim().min(1),
  addressFull: z.string().optional(),
  raw: z.object({
    city_code: z.number().int().positive(),
    city: z.string().optional(),
    address_full: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    work_time: z.string().optional()
  }).catchall(z.unknown())
});

const sellerDropoffPvzSaveSchema = z.object({
  dropoffPvz: z.object({
    provider: z.literal('CDEK').optional().default('CDEK'),
    pvzId: z.string().trim().min(1),
    addressFull: z.string().optional(),
    raw: z.record(z.unknown()).optional()
  })
});




const orderStatusFlow: OrderStatus[] = ['CREATED', 'PRINTING', 'HANDED_TO_DELIVERY', 'IN_TRANSIT', 'DELIVERED'];
const shipmentStageFlow = ['CREATING', 'PRINTING', 'READY_FOR_DROP', 'IN_TRANSIT', 'READY_FOR_PICKUP'] as const;

const normalizeShipmentStage = (status?: string | null) => {
  const normalized = String(status ?? '').toUpperCase();
  if (normalized === 'READY_FOR_PICKUP' || normalized === 'DELIVERED') return 'READY_FOR_PICKUP';
  if (normalized === 'IN_TRANSIT' || normalized === 'TRANSPORTING') return 'IN_TRANSIT';
  if (normalized === 'ACCEPTED' || normalized === 'CREATED') return 'READY_FOR_DROP';
  if (normalized === 'READY_FOR_DROP' || normalized === 'READY_TO_SHIP') return 'READY_FOR_DROP';
  if (normalized === 'PRINTING' || normalized === 'DOCS_PRINTING') return 'PRINTING';
  return 'CREATING';
};

const MAX_FETCH_LIMIT = 5000;

// ---------------------------------------------------------
// Routes
// ---------------------------------------------------------
sellerRoutes.post('/onboarding', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = sellerOnboardingSchema.parse(req.body);

    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { phoneVerifiedAt: true, phone: true, email: true }
    });
    if (!user?.phoneVerifiedAt) return res.status(403).json({ error: { code: 'PHONE_NOT_VERIFIED' } });

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

    const updated = await prisma.user.update({
      where: { id: req.user!.userId },
      data: {
        name: payload.name,
        phone,
        role: resolveRoleAfterSellerEnablement(req.user!.role),
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
          isAdmin: req.user!.isAdmin,
          isSeller: true
        }
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
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

const loadSellerContext = async (userId: string): Promise<SellerContextResponse | null> => {
  const profile = await prisma.sellerProfile.findUnique({ where: { userId } });
  if (!profile) return null;

  const latestSubmission = await prisma.sellerKycSubmission.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { documents: true }
  });

  const approvedSubmission = await prisma.sellerKycSubmission.findFirst({
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

const respondSellerContext = async (req: AuthRequest, res: Response) => {
  const context = await loadSellerContext(req.user!.userId);
  if (!context) {
    console.warn('Seller profile missing for user', { userId: req.user!.userId });
    return res.status(409).json({ code: 'SELLER_PROFILE_MISSING', message: 'Seller onboarding required' });
  }

  return res.json({ data: context });
};

sellerRoutes.get('/context', requireAuth, async (req: AuthRequest, res, next) => {
  try { await respondSellerContext(req, res); } catch (e) { next(e); }
});
sellerRoutes.get('/me', requireAuth, async (req: AuthRequest, res, next) => {
  try { await respondSellerContext(req, res); } catch (e) { next(e); }
});

sellerRoutes.use(requireAuth, requireSeller);

// ------------------- KYC -------------------
const ensureKycApproved = async (userId: string) => {
  const approved = await prisma.sellerKycSubmission.findFirst({
    where: { userId, status: 'APPROVED' },
    orderBy: { reviewedAt: 'desc' }
  });
  return Boolean(approved);
};

const ensureReferenceCategory = async (category: string) => {
  const ref = await prisma.referenceCategory.findFirst({
    where: { isActive: true, OR: [{ title: category }, { slug: category }] }
  });
  if (!ref) throw new Error('CATEGORY_INVALID');
  return ref.title;
};

sellerRoutes.get('/kyc/me', async (req: AuthRequest, res, next) => {
  try {
    const submission = await prisma.sellerKycSubmission.findFirst({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      include: { documents: true }
    });
    res.json({ data: submission ?? null });
  } catch (error) {
    next(error);
  }
});

const kycSubmitPayloadSchema = z.object({
  merchantData: merchantDataBaseSchema,
  dropoffPvzId: z.string().trim().min(1),
  dropoffPvzMeta: z.record(z.unknown()).optional(),
  acceptedRules: z.boolean(),
  acceptedPersonalData: z.boolean(),
  acceptedRulesSlug: z.string().trim().min(1).optional(),
  acceptedPersonalDataSlug: z.string().trim().min(1).optional()
});

sellerRoutes.post('/kyc/submit', writeLimiter, async (req: AuthRequest, res, next) => {
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

    const profile = await prisma.sellerProfile.findFirst({
      where: { userId: req.user!.userId },
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

    const latestSubmission = await prisma.sellerKycSubmission.findFirst({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      include: { documents: true }
    });

    const dropoffPvzMeta = {
      provider: 'CDEK' as const,
      pvzId: submitPayload.dropoffPvzId,
      ...(submitPayload.dropoffPvzMeta ?? {})
    };

    const submitted = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const now = new Date();
      const consentData: Prisma.SellerProfileUpdateInput = {
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
        where: { userId: req.user!.userId },
        data: {
          ...normalizeMerchantUpdateData(merchantPayload, legalType),
          ...consentData
        }
      });

      await tx.sellerSettings.upsert({
        where: { sellerId: req.user!.userId },
        create: {
          sellerId: req.user!.userId,
          defaultDropoffProvider: 'CDEK',
          defaultDropoffPvzId: submitPayload.dropoffPvzId,
          defaultDropoffPvzMeta: dropoffPvzMeta as unknown as object
        },
        update: {
          defaultDropoffProvider: 'CDEK',
          defaultDropoffPvzId: submitPayload.dropoffPvzId,
          defaultDropoffPvzMeta: dropoffPvzMeta as unknown as object
        }
      });

      await tx.sellerDeliveryProfile.upsert({
        where: { sellerId: req.user!.userId },
        create: {
          sellerId: req.user!.userId,
          dropoffPvzId: submitPayload.dropoffPvzId,
          dropoffStationMeta: dropoffPvzMeta as unknown as object
        },
        update: {
          dropoffPvzId: submitPayload.dropoffPvzId,
          dropoffStationMeta: dropoffPvzMeta as unknown as object
        }
      });

      const submission = latestSubmission
        ? await tx.sellerKycSubmission.update({
          where: { id: latestSubmission.id },
          data: {
            status: 'PENDING',
            merchantData: submitPayload.merchantData as unknown as object,
            dropoffPvzId: submitPayload.dropoffPvzId,
            dropoffPvzMeta: dropoffPvzMeta as unknown as object,
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
            userId: req.user!.userId,
            status: 'PENDING',
            merchantData: submitPayload.merchantData as unknown as object,
            dropoffPvzId: submitPayload.dropoffPvzId,
            dropoffPvzMeta: dropoffPvzMeta as unknown as object,
            submittedAt: new Date()
          }
        });

      return tx.sellerKycSubmission.findUnique({
        where: { id: submission.id },
        include: { documents: true }
      });
    });

    res.status(201).json({ data: submitted });
  } catch (error) {
    if (error instanceof z.ZodError) {
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
sellerRoutes.get('/products', async (req: AuthRequest, res, next) => {
  try {
    const approved = await ensureKycApproved(req.user!.userId);
    if (!approved && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: { code: 'KYC_NOT_APPROVED', message: 'KYC not approved' } });
    }

    const sellerProducts = await prisma.product.findMany({
      where: { sellerId: req.user!.userId, parentProductId: null },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
      }
    });

    res.json({ data: sellerProducts });
  } catch (error) {
    next(error);
  }
});

sellerRoutes.get('/products/:id', async (req: AuthRequest, res, next) => {
  try {
    const productResult = await productUseCases.getForSellerEdit(req.params.id, req.user!.userId);

    if (productResult.code === 'NOT_FOUND') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Товар не найден.' } });
    }

    if (productResult.code === 'FORBIDDEN') {
      return res.status(403).json({
        error: { code: 'SELLER_PRODUCT_FORBIDDEN', message: 'У вас нет доступа к этому товару.' }
      });
    }

    return res.json({ data: productResult.data });
  } catch (error) {
    next(error);
  }
});

sellerRoutes.post('/products', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const approved = await ensureKycApproved(req.user!.userId);
    if (!approved && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: { code: 'KYC_NOT_APPROVED', message: 'KYC not approved' } });
    }

    const payload = sellerProductCreateSchema.parse(req.body);
    const normalizedCategory = await ensureReferenceCategory(payload.category);
    const skuFallback = payload.sku ?? generateSkuFallback();

    const media = normalizeProductMediaInput(payload);
    const imageMedia = media.filter((item) => item.type === 'IMAGE');
    const videoMedia = media.filter((item) => item.type === 'VIDEO');

    if (!imageMedia.length) {
      return res.status(400).json({ error: { code: 'IMAGE_REQUIRED' } });
    }

    const product = await productUseCases.create({
      ...payload,
      category: normalizedCategory,
      descriptionShort: payload.descriptionShort ?? payload.description,
      descriptionFull: payload.descriptionFull ?? payload.description,
      sku: skuFallback,
      currency: payload.currency ?? 'RUB',
      sellerId: req.user!.userId,
      image: imageMedia[0].url,
      imageUrls: imageMedia.map((item) => item.url),
      videoUrls: videoMedia.map((item) => item.url),
      media,
      variants: payload.variants?.map((variantPayload) =>
        normalizeVariantPayload(payload, variantPayload)
      ),
      characteristics: payload.characteristics ?? payload.specifications,
      specifications: payload.specifications ?? payload.characteristics
    });

    res.status(201).json({ data: product });
  } catch (error) {
    if (error instanceof Error && error.message === 'CATEGORY_INVALID') {
      return res.status(400).json({ error: { code: 'CATEGORY_INVALID', message: 'Категория недоступна.' } });
    }
    if (error instanceof Error && error.message === 'SKU_DUPLICATE_IN_VARIANTS') {
      return res.status(400).json({ error: { code: 'SKU_DUPLICATE_IN_VARIANTS', message: 'SKU варианта должен быть уникальным.' } });
    }
    next(error);
  }
});

sellerRoutes.put('/products/:id', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const approved = await ensureKycApproved(req.user!.userId);
    if (!approved && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: { code: 'KYC_NOT_APPROVED', message: 'KYC not approved' } });
    }

    const payload = sellerProductUpdateSchema.parse(req.body);
    const productAccessResult = await productUseCases.getForSellerEdit(req.params.id, req.user!.userId);

    if (productAccessResult.code === 'NOT_FOUND') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Товар не найден.' } });
    }

    if (productAccessResult.code === 'FORBIDDEN') {
      return res.status(403).json({
        error: { code: 'SELLER_PRODUCT_FORBIDDEN', message: 'У вас нет доступа к этому товару.' }
      });
    }

    const normalizedCategory = payload.category ? await ensureReferenceCategory(payload.category) : undefined;
    const media = payload.media !== undefined || payload.imageUrls !== undefined || payload.videoUrls !== undefined || payload.image !== undefined
      ? normalizeProductMediaInput(payload)
      : undefined;
    const imageMedia = media?.filter((item) => item.type === 'IMAGE') ?? [];
    const videoMedia = media?.filter((item) => item.type === 'VIDEO') ?? [];

    const product = await productUseCases.update(req.params.id, {
      ...payload,
      category: normalizedCategory ?? payload.category,
      descriptionShort: payload.descriptionShort ?? payload.description,
      descriptionFull: payload.descriptionFull ?? payload.description,
      sku: payload.sku,
      currency: payload.currency,
      sellerId: req.user!.userId,
      image: imageMedia[0]?.url ?? payload.image,
      imageUrls: media ? imageMedia.map((item) => item.url) : undefined,
      videoUrls: media ? videoMedia.map((item) => item.url) : undefined,
      media,
      characteristics: payload.characteristics ?? payload.specifications,
      specifications: payload.specifications ?? payload.characteristics
    });

    res.json({ data: product });
  } catch (error) {
    if (error instanceof Error && error.message === 'CATEGORY_INVALID') {
      return res.status(400).json({ error: { code: 'CATEGORY_INVALID', message: 'Категория недоступна.' } });
    }
    next(error);
  }
});

sellerRoutes.delete('/products/:id', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const approved = await ensureKycApproved(req.user!.userId);
    if (!approved && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: { code: 'KYC_NOT_APPROVED', message: 'KYC not approved' } });
    }
    const productAccessResult = await productUseCases.getForSellerEdit(req.params.id, req.user!.userId);
    if (productAccessResult.code === 'NOT_FOUND') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Товар не найден.' } });
    }
    if (productAccessResult.code === 'FORBIDDEN') {
      return res.status(403).json({
        error: { code: 'SELLER_PRODUCT_FORBIDDEN', message: 'У вас нет доступа к этому товару.' }
      });
    }
    await productUseCases.remove(req.params.id);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

sellerRoutes.post('/products/:id/variants', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const approved = await ensureKycApproved(req.user!.userId);
    if (!approved && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: { code: 'KYC_NOT_APPROVED', message: 'KYC not approved' } });
    }

    const baseProduct = await productUseCases.getSellerProductWithVariants(req.params.id, req.user!.userId);
    if (!baseProduct) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }

    const payload = sellerVariantMutationSchema.parse(req.body);
    const media = normalizeProductMediaInput({
      image: payload.image ?? baseProduct.image,
      imageUrls: payload.imageUrls ?? baseProduct.imageUrls,
      videoUrls: payload.videoUrls ?? baseProduct.videoUrls,
      media: payload.media
    });
    const imageMedia = media.filter((item) => item.type === 'IMAGE');
    const videoMedia = media.filter((item) => item.type === 'VIDEO');
    const variantInput = {
      sku: payload.sku ?? generateSkuFallback(),
      title: baseProduct.title,
      category: baseProduct.category,
      price: payload.price ?? baseProduct.price,
      currency: baseProduct.currency,
      description: baseProduct.description,
      descriptionShort: baseProduct.descriptionShort,
      descriptionFull: baseProduct.descriptionFull,
      material: baseProduct.material,
      technology: baseProduct.technology,
      productionTimeHours: baseProduct.productionTimeHours ?? undefined,
      color: payload.color ?? baseProduct.color,
      variantLabel: payload.variantLabel,
      variantSize: payload.variantSize,
      variantAttributes: payload.variantAttributes,
      weightGrossG: baseProduct.weightGrossG ?? undefined,
      dxCm: baseProduct.dxCm ?? undefined,
      dyCm: baseProduct.dyCm ?? undefined,
      dzCm: baseProduct.dzCm ?? undefined,
      image: imageMedia[0]?.url ?? baseProduct.image,
      imageUrls: imageMedia.map((item) => item.url),
      videoUrls: videoMedia.map((item) => item.url),
      media
    };

    const created = await productUseCases.createVariant(req.params.id, req.user!.userId, variantInput);
    if (!created) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    return res.status(201).json({ data: created });
  } catch (error) {
    return next(error);
  }
});

sellerRoutes.put('/products/:id/variants/:variantId', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const approved = await ensureKycApproved(req.user!.userId);
    if (!approved && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: { code: 'KYC_NOT_APPROVED', message: 'KYC not approved' } });
    }

    const payload = sellerVariantMutationSchema.partial().parse(req.body);
    const updated = await productUseCases.updateVariant(req.params.id, req.params.variantId, req.user!.userId, payload);
    if (!updated) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    return res.json({ data: updated });
  } catch (error) {
    return next(error);
  }
});

sellerRoutes.delete('/products/:id/variants/:variantId', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const approved = await ensureKycApproved(req.user!.userId);
    if (!approved && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: { code: 'KYC_NOT_APPROVED', message: 'KYC not approved' } });
    }
    const removed = await productUseCases.removeVariant(req.params.id, req.params.variantId, req.user!.userId);
    if (!removed) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

// ------------------- Uploads -------------------
type UploadedFile = {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination?: string;
  filename?: string;
  path?: string;
  buffer?: Buffer;
};

sellerRoutes.post('/uploads', writeLimiter, upload.array('files', 10), async (req, res) => {
  const files = (req.files as UploadedFile[] | undefined) ?? [];
  if (!files.length) {
    return res.status(400).json({ error: { code: 'FILES_REQUIRED' } });
  }

  const invalidFiles = files.filter((file) => !resolveUploadKind(file));
  if (invalidFiles.length) {
    await Promise.all(
      files.map((file) =>
        file.path ? fs.promises.unlink(file.path).catch(() => undefined) : Promise.resolve()
      )
    );
    return res.status(400).json({ error: { code: 'PRODUCT_UPLOAD_FILE_TYPE_INVALID' } });
  }

  const oversizedImageFiles = files.filter((file) => resolveUploadKind(file) === 'IMAGE' && file.size > maxImageSize);
  const oversizedVideoFiles = files.filter((file) => resolveUploadKind(file) === 'VIDEO' && file.size > maxVideoSize);

  if (oversizedImageFiles.length || oversizedVideoFiles.length) {
    await Promise.all(
      files.map((file) =>
        file.path ? fs.promises.unlink(file.path).catch(() => undefined) : Promise.resolve()
      )
    );
    return res.status(400).json({
      error: {
        code: oversizedVideoFiles.length ? 'PRODUCT_UPLOAD_VIDEO_TOO_LARGE' : 'PRODUCT_UPLOAD_IMAGE_TOO_LARGE'
      }
    });
  }

  const urls = files
    .filter((file) => file.filename)
    .map((file) => `/uploads/${file.filename}`);

  return res.json({ data: { urls } });
});

// ------------------- Settings -------------------
sellerRoutes.get('/settings', async (req: AuthRequest, res, next) => {
  try {
    const [settings, deliveryProfile] = await Promise.all([
      prisma.sellerSettings.findUnique({ where: { sellerId: req.user!.userId } }),
      prisma.sellerDeliveryProfile.findUnique({ where: { sellerId: req.user!.userId } })
    ]);

    const dropoffPvz = settings?.defaultDropoffPvzId
      ? {
        provider: 'CDEK' as const,
        pvzId: settings.defaultDropoffPvzId,
        raw: settings.defaultDropoffPvzMeta,
        addressFull:
          typeof settings.defaultDropoffPvzMeta === 'object' && settings.defaultDropoffPvzMeta
            ? String((settings.defaultDropoffPvzMeta as Record<string, unknown>).addressFull ?? '')
            : undefined
      }
      : null;

    res.json({
      data: {
        ...(settings ?? { sellerId: req.user!.userId }),
        dropoffSchedule: (deliveryProfile as any)?.dropoffSchedule ?? 'DAILY',
        dropoffPvz
      }
    });
  } catch (error) {
    next(error);
  }
});

sellerRoutes.put('/settings', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = sellerSettingsSchema.parse(req.body ?? {});
    const profile = await sellerDeliveryProfileService.upsert(req.user!.userId, {
      dropoffSchedule: payload.dropoffSchedule
    });
    res.json({ data: profile });
  } catch (error) {
    next(error);
  }
});
sellerRoutes.put('/settings/dropoff-pvz', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = sellerDropoffPvzSaveSchema.parse(req.body ?? {});
    const pvzId = payload.dropoffPvz.pvzId;

    let raw: Record<string, unknown> | undefined =
      payload.dropoffPvz.raw && typeof payload.dropoffPvz.raw === 'object'
        ? (payload.dropoffPvz.raw as Record<string, unknown>)
        : undefined;

    if (!raw) {
      const point = await cdekService.getPickupPointByCode(pvzId);
      raw = point as unknown as Record<string, unknown>;
    }
    const rawRec = raw as any;

    const addressFull =
      payload.dropoffPvz.addressFull ??
      String(rawRec?.address_full ?? rawRec?.location?.address_full ?? '');

    const dropoffPvzMeta = {
      provider: 'CDEK' as const,
      pvzId,
      addressFull,
      raw
    };

    const settings = await prisma.sellerSettings.upsert({
      where: { sellerId: req.user!.userId },
      create: {
        sellerId: req.user!.userId,
        defaultDropoffProvider: 'CDEK',
        defaultDropoffPvzId: pvzId,
        defaultDropoffPvzMeta: dropoffPvzMeta as unknown as object
      },
      update: {
        defaultDropoffProvider: 'CDEK',
        defaultDropoffPvzId: pvzId,
        defaultDropoffPvzMeta: dropoffPvzMeta as unknown as object
      }
    });

    return res.json({ data: settings });
  } catch (error) {
    if (error instanceof z.ZodError) {
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
sellerRoutes.get('/orders', async (req: AuthRequest, res, next) => {
  try {
    const query = sellerOrdersQuerySchema.parse(req.query);
    const orders = await orderUseCases.listBySeller(req.user!.userId, {
      status: query.status as OrderStatus | undefined,
      offset: query.offset,
      limit: query.limit
    });
    const shipments = await shipmentService.getByOrderIds(orders.map((o) => o.id));
    res.json({ data: orders.map((o) => ({ ...o, shipment: toShipmentView(shipments.get(o.id) ?? null) })) });
  } catch (error) {
    next(error);
  }
});


sellerRoutes.patch('/orders/:id/fulfillment-steps', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = sellerFulfillmentStepsSchema.parse(req.body);
    const order = await prisma.order.findFirst({ where: { id: req.params.id, items: { some: { product: { sellerId: req.user!.userId } } } } });
    if (!order) return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });
    if (!(await isOrderPaid(order))) {
      return res.status(400).json({ error: { code: 'PAYMENT_REQUIRED', message: 'Чеклист доступен только для оплаченных заказов.' } });
    }

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        ...(payload.isPacked !== undefined ? { isPacked: payload.isPacked } : {}),
        ...(payload.isLabelPrinted !== undefined ? { isLabelPrinted: payload.isLabelPrinted } : {}),
        ...(payload.isActPrinted !== undefined ? { isActPrinted: payload.isActPrinted } : {}),
        fulfillmentUpdatedAt: new Date()
      } as any
    });

    return res.json({ data: { isPacked: (updated as any).isPacked, isLabelPrinted: (updated as any).isLabelPrinted, isActPrinted: (updated as any).isActPrinted } });
  } catch (error) {
    next(error);
  }
});

sellerRoutes.post('/orders/:orderId/ready-to-ship', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const result = await shipmentService.readyToShipCdek({
      orderId: req.params.orderId,
      sellerId: req.user!.userId
    });

    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, items: { some: { product: { sellerId: req.user!.userId } } } },
      include: { shipment: true }
    });

    return res.json({ data: { order, shipment: toShipmentView(result.shipment), cdek: result.cdek } });
  } catch (e) {
    next(e);
  }
});

sellerRoutes.post('/orders/:orderId/shipment', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const result = await shipmentService.createShipmentCdek({
      orderId: req.params.orderId,
      sellerId: req.user!.userId
    });

    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, items: { some: { product: { sellerId: req.user!.userId } } } },
      include: { shipment: true }
    });

    return res.json({ data: { order, shipment: toShipmentView(result.shipment), cdek: result.cdek } });
  } catch (e) {
    next(e);
  }
});

sellerRoutes.post('/shipments/:id/sync', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const shipment = await prisma.orderShipment.findUnique({
      where: { id: req.params.id },
      include: { order: { include: { items: { include: { product: true } } } } }
    });

    if (!shipment) return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });
    const hasAccess = shipment.order.items.some((item) => item.product.sellerId === req.user!.userId);
    if (!hasAccess) return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });

    const result = await shipmentService.syncByShipmentId(req.params.id);
    return res.json({ data: result });
  } catch (e) {
    next(e);
  }
});

sellerRoutes.get('/shipments/:id/label', async (req: AuthRequest, res, next) => {
  try {
    const shipment = await prisma.orderShipment.findUnique({
      where: { id: req.params.id },
      include: { order: { include: { items: { include: { product: true } } } } }
    });
    if (!shipment) return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });
    const hasAccess = shipment.order.items.some((item) => item.product.sellerId === req.user!.userId);
    if (!hasAccess) return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });

    const result = await shipmentService.resolveLabelBarcodePdf({
      shipmentId: shipment.id,
      cdekOrderId: String(shipment.order.cdekOrderId ?? ''),
      labelPrintRequestUuid: shipment.labelPrintRequestUuid
    });

    if (result.status === 'need_ready_to_ship') return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
    if (result.status === 'processing') return res.status(409).json({ error: FORMS_NOT_READY_ERROR });
    if (result.status !== 'ready') return res.status(502).json({ error: DOCUMENT_DOWNLOAD_FAILED_ERROR });

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: shipment.orderId },
        data: {
          isLabelPrinted: true,
          fulfillmentUpdatedAt: new Date()
        } as any
      });
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cdek-label-${shipment.id}.pdf"`);
    res.setHeader('Content-Length', result.pdf.length);
    return res.status(200).send(result.pdf);
  } catch (e) {
    next(e);
  }
});

sellerRoutes.get('/shipments/:id/barcodes', async (req: AuthRequest, res, next) => {
  try {
    const shipment = await prisma.orderShipment.findUnique({
      where: { id: req.params.id },
      include: { order: { include: { items: { include: { product: true } } } } }
    });
    if (!shipment) return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });
    const hasAccess = shipment.order.items.some((item) => item.product.sellerId === req.user!.userId);
    if (!hasAccess) return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });

    const result = await shipmentService.resolveLabelBarcodePdf({
      shipmentId: shipment.id,
      cdekOrderId: String(shipment.order.cdekOrderId ?? ''),
      labelPrintRequestUuid: shipment.labelPrintRequestUuid
    });

    if (result.status === 'need_ready_to_ship') return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
    if (result.status === 'processing') return res.status(409).json({ error: FORMS_NOT_READY_ERROR });
    if (result.status !== 'ready') return res.status(502).json({ error: DOCUMENT_DOWNLOAD_FAILED_ERROR });

    return res.json({ data: { status: 'ready', format: 'application/pdf', size: result.pdf.length } });
  } catch (e) {
    next(e);
  }
});

sellerRoutes.get('/shipments/:id/act', async (req: AuthRequest, res, next) => {
  try {
    const shipment = await prisma.orderShipment.findUnique({
      where: { id: req.params.id },
      include: { order: { include: { items: { include: { product: true } } } } }
    });
    if (!shipment) return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });
    const hasAccess = shipment.order.items.some((item) => item.product.sellerId === req.user!.userId);
    if (!hasAccess) return res.status(409).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Сначала оформите отгрузку' } });

    const result = await resolveOrderPrintPdf({
      shipmentId: shipment.id,
      cdekOrderId: shipment.order.cdekOrderId,
      printRequestUuid: shipment.actPrintRequestUuid,
      type: 'tpl_russia',
      kind: 'act'
    }).catch(() => ({ status: 'invalid' as const }));

    if (result.status === 'need_ready_to_ship') return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
    if (result.status === 'processing') return res.status(409).json({ error: FORMS_NOT_READY_ERROR });
    if (result.status === 'expired') return res.status(409).json({ error: FORMS_EXPIRED_ERROR });
    if (result.status !== 'ready') return res.status(502).json({ error: DOCUMENT_DOWNLOAD_FAILED_ERROR });

    await prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id: shipment.orderId },
        data: {
          isActPrinted: true,
          fulfillmentUpdatedAt: new Date()
        } as any
      });
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', withUtf8PdfDisposition(`cdek-act-${shipment.id}.pdf`));
    res.setHeader('Content-Length', result.pdf.length);
    return res.status(200).send(result.pdf);
  } catch (error) {
    next(error);
  }
});

const loadSellerOrderForDocuments = async (sellerId: string, orderId: string) =>
  prisma.order.findFirst({
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

const withUtf8PdfDisposition = (filename: string) => {
  const safeAscii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  return `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

const resolveOrderPrintPdf = async (params: {
  shipmentId: string;
  cdekOrderId: string | null | undefined;
  printRequestUuid: string | null | undefined;
  type?: string;
  kind: 'act' | 'label';
}) => {
  const cdekOrderId = String(params.cdekOrderId ?? '').trim();
  if (!cdekOrderId) return { status: 'need_ready_to_ship' as const };

  let printUuid = String(params.printRequestUuid ?? '').trim();
  if (!printUuid) {
    printUuid = await cdekService.createOrderPrint([cdekOrderId], params.type ?? 'tpl_russia', 2);
    await prisma.orderShipment.update({ where: { id: params.shipmentId }, data: params.kind === 'label' ? { labelPrintRequestUuid: printUuid } : { actPrintRequestUuid: printUuid } });
  }

  const snapshot = await cdekService.getOrderPrintStatus(printUuid);
  if (snapshot.status === 'READY') {
    const pdf = await cdekService.downloadOrderPrintPdf(printUuid);
    return { status: 'ready' as const, pdf };
  }
  if (snapshot.status === 'ACCEPTED' || snapshot.status === 'PROCESSING') {
    return { status: 'processing' as const };
  }
  if (snapshot.status === 'REMOVED') {
    await prisma.orderShipment.update({ where: { id: params.shipmentId }, data: params.kind === 'label' ? { labelPrintRequestUuid: null } : { actPrintRequestUuid: null } });
    return { status: 'expired' as const };
  }
  return { status: 'invalid' as const };
};

const hasSuccessfulPayment = async (orderId: string) => {
  const payment = await prisma.payment.findFirst({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
    select: { status: true }
  });
  return payment?.status === 'SUCCEEDED';
};


const isOrderPaid = async (order: { id: string; paidAt: Date | null }) =>
  Boolean(order.paidAt) || (await hasSuccessfulPayment(order.id));

sellerRoutes.get('/orders/:orderId/documents/packing-slip.pdf', async (req: AuthRequest, res, next) => {
  try {
    const order = await loadSellerOrderForDocuments(req.user!.userId, req.params.orderId);
    if (!order) return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });

    const pdf = await sellerOrderDocumentsService.buildPackingSlip(order);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', withUtf8PdfDisposition(`packing-slip-${order.id}.pdf`));
    return res.status(200).send(pdf);
  } catch (error) {
    return next(error);
  }
});

sellerRoutes.get('/orders/:orderId/documents/label.pdf', async (req: AuthRequest, res, next) => {
  try {
    const order = await loadSellerOrderForDocuments(req.user!.userId, req.params.orderId);
    if (!order) return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });

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

    const result = await shipmentService.resolveLabelBarcodePdf({
      shipmentId,
      cdekOrderId: String(order.cdekOrderId ?? ''),
      labelPrintRequestUuid: order.shipment?.labelPrintRequestUuid
    });

    if (result.status === 'need_ready_to_ship') return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
    if (result.status === 'processing') return res.status(409).json({ error: FORMS_NOT_READY_ERROR });
    if (result.status !== 'ready') return res.status(502).json({ error: DOCUMENT_DOWNLOAD_FAILED_ERROR });

    await prisma.order.update({ where: { id: order.id }, data: { isLabelPrinted: true, fulfillmentUpdatedAt: new Date() } as any });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', withUtf8PdfDisposition(`cdek-label-${order.id}.pdf`));
    res.setHeader('Content-Length', result.pdf.length);
    return res.status(200).send(result.pdf);
  } catch (error) {
    return next(error);
  }
});

sellerRoutes.get('/orders/:orderId/documents/handover-act.pdf', async (req: AuthRequest, res, next) => {
  try {
    const order = await loadSellerOrderForDocuments(req.user!.userId, req.params.orderId);
    if (!order) return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });

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
    }).catch(() => ({ status: 'invalid' as const }));

    if (result.status === 'need_ready_to_ship') return res.status(409).json({ error: NEED_READY_TO_SHIP_ERROR });
    if (result.status === 'processing') return res.status(409).json({ error: FORMS_NOT_READY_ERROR });
    if (result.status === 'expired') return res.status(409).json({ error: FORMS_EXPIRED_ERROR });
    if (result.status !== 'ready') return res.status(502).json({ error: DOCUMENT_DOWNLOAD_FAILED_ERROR });

    await prisma.order.update({ where: { id: order.id }, data: { isActPrinted: true, fulfillmentUpdatedAt: new Date() } as any });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', withUtf8PdfDisposition(`handover-act-${order.id}.pdf`));
    res.setHeader('Content-Length', result.pdf.length);
    return res.status(200).send(result.pdf);
  } catch (error) {
    return next(error);
  }
});


sellerRoutes.patch('/orders/:id/preparation', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    return res.status(409).json({ error: { code: 'LEGACY_ENDPOINT', message: 'Используйте /seller/orders/:id/fulfillment-steps' } });
  } catch (error) {
    return next(error);
  }
});

// ------------------- Payments -------------------
sellerRoutes.get('/payments', async (req: AuthRequest, res, next) => {
  try {
    const payments = await prisma.payment.findMany({
      where: { order: { items: { some: { product: { sellerId: req.user!.userId } } } } },
      select: { id: true, orderId: true, amount: true, status: true, currency: true, createdAt: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ data: payments });
  } catch (error) {
    next(error);
  }
});

// ------------------- Status updates -------------------
sellerRoutes.patch('/orders/:id/status', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = sellerOrderStatusSchema.parse(req.body);

    const order = await prisma.order.findFirst({
      where: { id: req.params.id, items: { some: { product: { sellerId: req.user!.userId } } } },
      include: {
        items: { where: { product: { sellerId: req.user!.userId } }, include: { product: true, variant: true } },
        contact: true,
        shippingAddress: true,
        buyer: true
      }
    });

    if (!order) return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });

    const currentIndex = orderStatusFlow.indexOf(order.status);
    const nextIndex = orderStatusFlow.indexOf(payload.status);
    if (currentIndex === -1 || nextIndex === -1) return res.status(400).json({ error: { code: 'STATUS_INVALID' } });
    if (order.status === 'DELIVERED') return res.status(400).json({ error: { code: 'STATUS_FINAL' } });
    if (nextIndex <= currentIndex) return res.status(400).json({ error: { code: 'STATUS_BACKWARD' } });
    if (nextIndex !== currentIndex + 1) return res.status(400).json({ error: { code: 'STATUS_SKIP_NOT_ALLOWED' } });

    const trackingNumber = payload.trackingNumber ?? (order as any).trackingNumber ?? undefined;
    const carrier = payload.carrier ?? (order as any).carrier ?? undefined;

    if (['HANDED_TO_DELIVERY', 'IN_TRANSIT', 'DELIVERED'].includes(payload.status) && (!trackingNumber || !carrier)) {
      return res.status(400).json({ error: { code: 'TRACKING_REQUIRED' } });
    }

    const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const nextOrder = await tx.order.update({
        where: { id: order.id },
        data: { status: payload.status, statusUpdatedAt: new Date(), trackingNumber, carrier },
        include: {
          items: { where: { product: { sellerId: req.user!.userId } }, include: { product: true, variant: true } },
          contact: true,
          shippingAddress: true,
          buyer: true
        }
      });

      if (payload.status === 'DELIVERED') {
        await payoutService.releaseForDeliveredOrder(order.id, tx);
      }
      return nextOrder;
    });

    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

sellerRoutes.patch('/orders/:id/shipment-stage', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = sellerShipmentStageSchema.parse(req.body);
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, items: { some: { product: { sellerId: req.user!.userId } } } },
      include: { shipment: true }
    });

    if (!order) return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND', message: 'Заказ не найден.' } });
    if (!order.shipment) return res.status(400).json({ error: { code: 'SHIPMENT_NOT_FOUND', message: 'Отправление ещё не создано.' } });

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

    const updated = await prisma.$transaction(async (tx) => {
      const shipment = await tx.orderShipment.update({
        where: { id: order.shipment!.id },
        data: { status: payload.stage }
      });

      await tx.orderShipmentStatusHistory.create({
        data: { shipmentId: shipment.id, status: payload.stage, payloadRaw: { source: 'seller-panel' } }
      });

      return shipment;
    });

    return res.json({ data: toShipmentView(updated) });
  } catch (error) {
    return next(error);
  }
});

sellerRoutes.get('/stats', async (req: AuthRequest, res, next) => {
  try {
    const orders = await orderUseCases.listBySeller(req.user!.userId);
    const revenue = orders.reduce(
      (sum, order) => sum + order.items.reduce((itemSum, item) => itemSum + item.priceAtPurchase * item.quantity, 0),
      0
    );
    const products = await prisma.product.findMany({ where: { sellerId: req.user!.userId } });

    const statusCounts = orderStatusFlow.reduce((acc, status) => {
      acc[status] = orders.filter((o) => o.status === status).length;
      return acc;
    }, {} as Record<OrderStatus, number>);

    res.json({ data: { totalOrders: orders.length, totalRevenue: revenue, totalProducts: products.length, statusCounts } });
  } catch (error) {
    next(error);
  }
});
