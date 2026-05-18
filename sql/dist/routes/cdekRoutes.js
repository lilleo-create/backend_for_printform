"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cdekRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const cdek_1 = require("../config/cdek");
const cdekService_1 = require("../services/cdekService");
const cdekWebhookService_1 = require("../services/cdekWebhookService");
const authMiddleware_1 = require("../middleware/authMiddleware");
const prisma_1 = require("../lib/prisma");
exports.cdekRoutes = (0, express_1.Router)();
const allowedProxyPaths = new Set(['deliverypoints', 'location/cities', 'pvz']);
const allowedWidgetServicePaths = new Set([
    'deliverypoints',
    'location/cities',
    'pvz',
    'calculator/tariff'
]);
const calculateForOrderSchema = zod_1.z.object({
    orderId: zod_1.z.string().min(1)
});
const printReceiptSchema = zod_1.z.object({
    cdekOrderUuid: zod_1.z.string().min(1),
    copyCount: zod_1.z.number().int().positive().max(100).optional(),
    type: zod_1.z.string().min(1).optional()
});
const printBarcodeSchema = zod_1.z.object({
    cdekOrderUuid: zod_1.z.string().min(1),
    copyCount: zod_1.z.number().int().positive().max(100).optional(),
    format: zod_1.z.enum(['A4', 'A5', 'A6', 'A7']).optional(),
    lang: zod_1.z.enum(['RUS', 'ENG']).optional()
});
const PRINT_POLL_INTERVAL_MS = 750;
const PRINT_POLL_MAX_WAIT_MS = 15000;
const toErrorResponse = (error) => ({
    error: {
        code: error?.response?.data?.code ?? 'CDEK_REQUEST_FAILED',
        message: error?.response?.data?.message ?? error?.message ?? 'CDEK request failed',
        details: error?.response?.data ?? null
    }
});
const readCityCode = (meta) => {
    if (!meta || typeof meta !== 'object')
        return null;
    const raw = meta.raw;
    if (!raw || typeof raw !== 'object')
        return null;
    const value = raw.city_code;
    const cityCode = Number(value);
    return Number.isFinite(cityCode) && cityCode > 0 ? cityCode : null;
};
const asPositiveInt = (value, min, fallback) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.max(min, Math.round(parsed));
};
const safeRecord = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const pollPrintTaskReady = async (getStatusFn, maxWaitMs = PRINT_POLL_MAX_WAIT_MS, intervalMs = PRINT_POLL_INTERVAL_MS) => {
    const startedAt = Date.now();
    let last = null;
    while (Date.now() - startedAt < maxWaitMs) {
        const state = await getStatusFn();
        last = state;
        console.info('[CDEK][print][poll]', { status: state.status, statuses: state.statuses.map((entry) => entry.code) });
        if (state.status === 'READY')
            return { ...state, timedOut: false };
        if (state.status === 'INVALID') {
            throw new Error(`CDEK_PRINT_TASK_INVALID: ${JSON.stringify(state.statuses)}`);
        }
        if (state.status === 'REMOVED') {
            throw new Error('CDEK_PRINT_TASK_REMOVED_EXPIRED');
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return { ...(last ?? { status: 'PROCESSING', statuses: [] }), timedOut: true };
};
const resolveShipmentByCdekOrderUuid = async (cdekOrderUuid) => {
    const order = await prisma_1.prisma.order.findFirst({
        where: { cdekOrderId: cdekOrderUuid },
        include: { shipment: true }
    });
    if (!order?.shipment)
        return null;
    return order.shipment;
};
const upsertPrintState = async (cdekOrderUuid, patch) => {
    const shipment = await resolveShipmentByCdekOrderUuid(cdekOrderUuid);
    if (!shipment)
        return;
    const statusRaw = safeRecord(shipment.statusRaw);
    const printRaw = safeRecord(statusRaw.print);
    await prisma_1.prisma.orderShipment.update({
        where: { id: shipment.id },
        data: {
            statusRaw: {
                ...statusRaw,
                print: {
                    ...printRaw,
                    ...patch
                }
            }
        }
    });
};
const streamPdfResponse = (res, buffer, filename) => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.status(200).send(buffer);
};
exports.cdekRoutes.get('/pickup-points', async (req, res) => {
    try {
        const cityCodeRaw = req.query.cityCode;
        const cityRaw = req.query.city;
        const cityCode = cityCodeRaw !== undefined ? Number(cityCodeRaw) : undefined;
        const city = cityRaw !== undefined ? String(cityRaw) : undefined;
        const points = await cdekService_1.cdekService.getPickupPoints(Number.isFinite(cityCode) ? cityCode : undefined, city);
        res.json(points);
    }
    catch (error) {
        res.status(error?.response?.status ?? 502).json(toErrorResponse(error));
    }
});
exports.cdekRoutes.post('/calculate', async (req, res) => {
    try {
        const { fromCityCode, toCityCode, weightGrams, lengthCm, widthCm, heightCm } = req.body ?? {};
        const result = await cdekService_1.cdekService.calculateDelivery({
            fromCityCode: Number(fromCityCode),
            toCityCode: Number(toCityCode),
            weightGrams: Number(weightGrams),
            lengthCm: lengthCm !== undefined ? Number(lengthCm) : undefined,
            widthCm: widthCm !== undefined ? Number(widthCm) : undefined,
            heightCm: heightCm !== undefined ? Number(heightCm) : undefined
        });
        res.json(result);
    }
    catch (error) {
        res.status(error?.response?.status ?? 502).json(toErrorResponse(error));
    }
});
exports.cdekRoutes.post('/webhooks/order-status', async (req, res) => {
    try {
        const result = await cdekWebhookService_1.cdekWebhookService.applyIncomingStatus(req.body ?? {});
        return res.status(200).json({ received: true, data: result });
    }
    catch (error) {
        console.error('[CDEK][webhook][order-status][failed]', { error });
        return res.status(200).json({ received: true });
    }
});
exports.cdekRoutes.post('/calculate-for-order', authMiddleware_1.authenticate, async (req, res) => {
    try {
        const { orderId } = calculateForOrderSchema.parse(req.body ?? {});
        const order = await prisma_1.prisma.order.findFirst({
            where: {
                id: orderId,
                OR: [{ buyerId: req.user.userId }, { items: { some: { product: { sellerId: req.user.userId } } } }]
            },
            include: {
                items: {
                    include: {
                        product: {
                            select: { id: true, weightGrossG: true, dxCm: true, dyCm: true, dzCm: true }
                        },
                        variant: {
                            select: { id: true }
                        }
                    }
                }
            }
        });
        if (!order) {
            return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND', message: 'Order not found', details: { orderId } } });
        }
        const fromCityCode = readCityCode(order.sellerDropoffPvzMeta);
        const toCityCode = readCityCode(order.buyerPickupPvzMeta);
        if (!fromCityCode || !toCityCode) {
            return res.status(400).json({
                error: {
                    code: 'CITY_CODE_MISSING',
                    message: 'sellerDropoffPvzMeta.raw.city_code and buyerPickupPvzMeta.raw.city_code are required',
                    details: {
                        orderId,
                        fromCityCode,
                        toCityCode
                    }
                }
            });
        }
        let totalWeightGrams = 0;
        let maxDx = 10;
        let maxDy = 10;
        let maxDz = 2;
        let totalItems = 0;
        for (const item of order.items) {
            const weightPerItem = asPositiveInt(item.product.weightGrossG, 1, 200);
            if (!item.product.weightGrossG || Number(item.product.weightGrossG) <= 0) {
                console.warn('[CDEK][calculate-for-order] missing weightGrossG, using fallback 200g', {
                    orderId,
                    orderItemId: item.id,
                    productId: item.productId,
                    variantId: item.variantId
                });
            }
            totalWeightGrams += weightPerItem * item.quantity;
            totalItems += item.quantity;
            maxDx = Math.max(maxDx, asPositiveInt(item.product.dxCm, 10, 10));
            maxDy = Math.max(maxDy, asPositiveInt(item.product.dyCm, 10, 10));
            maxDz = Math.max(maxDz, asPositiveInt(item.product.dzCm, 2, 2));
        }
        const packageDx = Math.max(10, maxDx);
        const packageDy = Math.max(10, maxDy);
        const packageDz = Math.max(2, maxDz + Math.floor((Math.max(1, totalItems) - 1) / 2));
        const quote = await cdekService_1.cdekService.calculateDelivery({
            fromCityCode,
            toCityCode,
            weightGrams: totalWeightGrams,
            lengthCm: packageDx,
            widthCm: packageDy,
            heightCm: packageDz
        });
        const etaMin = new Date(order.createdAt);
        etaMin.setDate(etaMin.getDate() + quote.deliveryDaysMin);
        const etaMax = new Date(order.createdAt);
        etaMax.setDate(etaMax.getDate() + quote.deliveryDaysMax);
        await prisma_1.prisma.order.update({
            where: { id: orderId },
            data: {
                deliveryDaysMin: quote.deliveryDaysMin,
                deliveryDaysMax: quote.deliveryDaysMax,
                deliveryEtaText: `${quote.deliveryDaysMin}–${quote.deliveryDaysMax} дней`,
                estimatedDeliveryDateMin: etaMin,
                estimatedDeliveryDateMax: etaMax,
                deliveryTariffCode: quote.tariffCode,
                deliveryCalculatedAt: new Date()
            }
        });
        return res.json({
            ...quote,
            weightGrams: totalWeightGrams,
            lengthCm: packageDx,
            widthCm: packageDy,
            heightCm: packageDz,
            fromCityCode,
            toCityCode
        });
    }
    catch (error) {
        if (error instanceof zod_1.z.ZodError) {
            return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid payload', details: error.flatten() } });
        }
        return res.status(error?.response?.status ?? 502).json(toErrorResponse(error));
    }
});
exports.cdekRoutes.post('/orders/:orderId/sync', authMiddleware_1.authenticate, async (req, res) => {
    try {
        const order = await prisma_1.prisma.order.findFirst({
            where: {
                id: req.params.orderId,
                OR: [{ buyerId: req.user.userId }, { items: { some: { product: { sellerId: req.user.userId } } } }]
            },
            select: { id: true, cdekOrderId: true }
        });
        if (!order) {
            return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND', message: 'Order not found', details: null } });
        }
        const cdekOrderUuid = String(order.cdekOrderId ?? '').trim();
        if (!cdekOrderUuid) {
            return res.status(400).json({ error: { code: 'CDEK_ORDER_UUID_MISSING', message: 'Order does not have CDEK order UUID', details: { orderId: order.id } } });
        }
        const info = await cdekService_1.cdekService.getOrderInfo(cdekOrderUuid);
        await prisma_1.prisma.$transaction(async (tx) => {
            await tx.order.update({
                where: { id: order.id },
                data: {
                    cdekStatus: info.status || undefined,
                    trackingNumber: info.trackingNumber || undefined
                }
            });
            const existingShipment = await tx.orderShipment.findUnique({ where: { orderId: order.id } });
            if (existingShipment) {
                const statusRaw = (existingShipment.statusRaw ?? {});
                await tx.orderShipment.update({
                    where: { id: existingShipment.id },
                    data: {
                        statusRaw: {
                            ...statusRaw,
                            cdek_order_uuid: cdekOrderUuid,
                            trackingNumber: info.trackingNumber ?? ''
                        }
                    }
                });
            }
        });
        return res.json({ data: info });
    }
    catch (error) {
        return res.status(error?.response?.status ?? 502).json(toErrorResponse(error));
    }
});
exports.cdekRoutes.post('/print/receipt', authMiddleware_1.authenticate, async (req, res, next) => {
    try {
        const payload = printReceiptSchema.parse(req.body ?? {});
        const printUuid = await cdekService_1.cdekService.createReceiptPrintTask({
            orderUuid: payload.cdekOrderUuid,
            copyCount: payload.copyCount,
            type: payload.type ?? 'tpl_russia'
        });
        console.info('[CDEK][print][receipt] task created', { cdekOrderUuid: payload.cdekOrderUuid, printUuid });
        const result = await pollPrintTaskReady(() => cdekService_1.cdekService.getReceiptPrintTask(printUuid));
        await upsertPrintState(payload.cdekOrderUuid, {
            receiptPrintUuid: printUuid,
            lastPrintStatusReceipt: result.status
        });
        if (result.status === 'READY') {
            const pdf = await cdekService_1.cdekService.getReceiptPdfByPrintTaskUuid(printUuid);
            return streamPdfResponse(res, pdf, `cdek-receipt-${payload.cdekOrderUuid}.pdf`);
        }
        return res.json({ status: 'PROCESSING', printUuid });
    }
    catch (error) {
        next(error);
    }
});
exports.cdekRoutes.get('/print/receipt/:printUuid.pdf', authMiddleware_1.authenticate, async (req, res, next) => {
    try {
        const printUuid = String(req.params.printUuid ?? '').trim();
        if (!printUuid)
            return res.status(400).json({ error: { code: 'PRINT_UUID_REQUIRED' } });
        const status = await cdekService_1.cdekService.getReceiptPrintTask(printUuid);
        if (status.status === 'REMOVED') {
            return res.status(410).json({ error: { code: 'PRINT_LINK_EXPIRED', message: 'ссылка истекла, сформируйте заново' } });
        }
        if (status.status !== 'READY') {
            return res.status(409).json({ error: { code: 'PRINT_NOT_READY', message: 'ещё формируется', status: status.status } });
        }
        const pdf = await cdekService_1.cdekService.getReceiptPdfByPrintTaskUuid(printUuid);
        return streamPdfResponse(res, pdf, `cdek-receipt-${printUuid}.pdf`);
    }
    catch (error) {
        next(error);
    }
});
exports.cdekRoutes.post('/print/barcode', authMiddleware_1.authenticate, async (req, res, next) => {
    try {
        const payload = printBarcodeSchema.parse(req.body ?? {});
        const printUuid = await cdekService_1.cdekService.createBarcodePrintTask({
            orderUuid: payload.cdekOrderUuid,
            copyCount: payload.copyCount,
            format: payload.format,
            lang: payload.lang
        });
        console.info('[CDEK][print][barcode] task created', { cdekOrderUuid: payload.cdekOrderUuid, printUuid });
        const result = await pollPrintTaskReady(() => cdekService_1.cdekService.getBarcodePrintTask(printUuid));
        await upsertPrintState(payload.cdekOrderUuid, {
            barcodePrintUuid: printUuid,
            lastPrintStatusBarcode: result.status
        });
        if (result.status === 'READY') {
            const pdf = await cdekService_1.cdekService.getBarcodePdfByPrintTaskUuid(printUuid);
            return streamPdfResponse(res, pdf, `cdek-barcode-${payload.cdekOrderUuid}.pdf`);
        }
        return res.json({ status: 'PROCESSING', printUuid });
    }
    catch (error) {
        next(error);
    }
});
exports.cdekRoutes.get('/print/barcode/:printUuid.pdf', authMiddleware_1.authenticate, async (req, res, next) => {
    try {
        const printUuid = String(req.params.printUuid ?? '').trim();
        if (!printUuid)
            return res.status(400).json({ error: { code: 'PRINT_UUID_REQUIRED' } });
        const status = await cdekService_1.cdekService.getBarcodePrintTask(printUuid);
        if (status.status === 'REMOVED') {
            return res.status(410).json({ error: { code: 'PRINT_LINK_EXPIRED', message: 'ссылка истекла, сформируйте заново' } });
        }
        if (status.status !== 'READY') {
            return res.status(409).json({ error: { code: 'PRINT_NOT_READY', message: 'ещё формируется', status: status.status } });
        }
        const pdf = await cdekService_1.cdekService.getBarcodePdfByPrintTaskUuid(printUuid);
        return streamPdfResponse(res, pdf, `cdek-barcode-${printUuid}.pdf`);
    }
    catch (error) {
        next(error);
    }
});
exports.cdekRoutes.get('/track/:trackingNumber', authMiddleware_1.authenticate, async (req, res, next) => {
    try {
        const trackingNumber = String(req.params.trackingNumber ?? '').trim();
        if (!trackingNumber)
            return res.status(400).json({ error: { code: 'TRACKING_NUMBER_REQUIRED' } });
        const cdek = await cdekService_1.cdekService.getOrderByTracking(trackingNumber);
        const statuses = Array.isArray(cdek.raw.entity?.statuses) ? cdek.raw.entity.statuses : [];
        const events = statuses.map((entry) => ({ code: String(entry.code ?? '').trim(), dateTime: null }));
        return res.json({
            data: {
                trackingNumber: cdek.trackingNumber,
                state: cdek.status,
                events
            }
        });
    }
    catch (error) {
        next(error);
    }
});
exports.cdekRoutes.all('/service', async (req, res) => {
    const startedAt = Date.now();
    const pathRaw = String(req.query.path ?? req.body?.path ?? '').trim().toLowerCase();
    try {
        if (!pathRaw) {
            return res.status(400).json({ error: { code: 'INVALID_PATH', message: 'path is required', details: null } });
        }
        if (!/^[a-z0-9/_-]+$/.test(pathRaw) || pathRaw.includes('..') || pathRaw.startsWith('/') || pathRaw.includes('http')) {
            return res.status(400).json({ error: { code: 'INVALID_PATH', message: 'path format is invalid', details: { path: pathRaw } } });
        }
        if (!allowedProxyPaths.has(pathRaw)) {
            return res.status(400).json({ error: { code: 'INVALID_PATH', message: 'path is not allowed', details: { path: pathRaw } } });
        }
        if (!['GET', 'POST'].includes(req.method)) {
            return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET and POST are allowed', details: { method: req.method } } });
        }
        const config = (0, cdek_1.getCdekConfig)();
        const token = await cdekService_1.cdekService.getToken();
        const cdekUrl = new URL(`${config.baseUrl}/v2/${pathRaw}`);
        for (const [key, value] of Object.entries(req.query)) {
            if (key === 'path')
                continue;
            if (Array.isArray(value)) {
                value.forEach((entry) => cdekUrl.searchParams.append(key, String(entry)));
            }
            else if (value !== undefined) {
                cdekUrl.searchParams.append(key, String(value));
            }
        }
        const body = req.method === 'POST' && req.body && typeof req.body === 'object'
            ? Object.fromEntries(Object.entries(req.body).filter(([key]) => key !== 'path'))
            : undefined;
        const response = await fetch(cdekUrl.toString(), {
            method: req.method,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: req.method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
            signal: AbortSignal.timeout(12000)
        });
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
            const data = await response.json();
            return res.status(response.status).json(data);
        }
        const text = await response.text();
        return res.status(response.status).send(text);
    }
    catch (error) {
        const isTimeout = error?.name === 'TimeoutError';
        return res.status(isTimeout ? 504 : 502).json({
            error: {
                code: isTimeout ? 'CDEK_TIMEOUT' : 'CDEK_PROXY_FAILED',
                message: isTimeout ? 'CDEK proxy timeout' : error?.message ?? 'CDEK proxy failed',
                details: null
            }
        });
    }
    finally {
        console.info('[CDEK][proxy]', { status: res.statusCode, durationMs: Date.now() - startedAt, path: pathRaw });
    }
});
exports.cdekRoutes.all('/widget/service', async (req, res) => {
    const startedAt = Date.now();
    // Виджет CDEK v3 может слать как POST с JSON-телом, так и GET с query-параметрами
    const rawBody = req.body && typeof req.body === 'object' ? req.body : {};
    const rawQuery = req.query;
    const merged = { ...rawQuery, ...rawBody };
    const action = String(merged.action ?? merged.path ?? '').trim().toLowerCase();
    const resolvePath = () => {
        const pathFromMerged = String(merged.path ?? '').trim().toLowerCase();
        if (pathFromMerged)
            return pathFromMerged;
        switch (action) {
            case 'cities':
            case 'city':
            case 'location/cities':
                return 'location/cities';
            case 'deliverypoints':
            case 'pvz':
            case 'offices':
                return 'deliverypoints';
            case 'calculator/tariff':
            case 'calculate':
                return 'calculator/tariff';
            default:
                return action;
        }
    };
    const path = resolvePath();
    // GET-запросы от виджета идут как GET, POST — как POST
    const httpMethod = req.method === 'GET' ? 'GET' : 'POST';
    const { action: _action, path: _path, method: _method, httpMethod: _httpMethod, ...restBody } = rawBody;
    try {
        if (!path || !allowedWidgetServicePaths.has(path)) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_WIDGET_ACTION',
                    message: 'Unsupported widget action/path',
                    details: { action, path }
                }
            });
        }
        const config = (0, cdek_1.getCdekConfig)();
        const token = await cdekService_1.cdekService.getToken();
        const cdekUrl = new URL(`${config.baseUrl}/v2/${path}`);
        // Для GET — пробрасываем все query-параметры (кроме служебных)
        if (httpMethod === 'GET') {
            for (const [key, value] of Object.entries(rawQuery)) {
                if (['action', 'path', 'method'].includes(key))
                    continue;
                if (value === undefined || value === null)
                    continue;
                cdekUrl.searchParams.append(key, String(value));
            }
        }
        // Для POST — пробрасываем params из тела
        const params = rawBody.params && typeof rawBody.params === 'object'
            ? rawBody.params
            : {};
        if (httpMethod === 'POST') {
            for (const [key, value] of Object.entries(params)) {
                if (value === undefined || value === null)
                    continue;
                if (Array.isArray(value)) {
                    value.forEach((entry) => cdekUrl.searchParams.append(key, String(entry)));
                }
                else {
                    cdekUrl.searchParams.append(key, String(value));
                }
            }
        }
        const payload = rawBody.payload && typeof rawBody.payload === 'object'
            ? rawBody.payload
            : rawBody.data && typeof rawBody.data === 'object'
                ? rawBody.data
                : restBody;
        const response = await fetch(cdekUrl.toString(), {
            method: httpMethod,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: httpMethod === 'POST' ? JSON.stringify(payload ?? {}) : undefined,
            signal: AbortSignal.timeout(15000)
        });
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
            const data = await response.json();
            return res.status(response.status).json(data);
        }
        const text = await response.text();
        return res.status(response.status).send(text);
    }
    catch (error) {
        const isTimeout = error?.name === 'TimeoutError';
        return res.status(isTimeout ? 504 : 502).json({
            error: {
                code: isTimeout ? 'CDEK_TIMEOUT' : 'CDEK_WIDGET_PROXY_FAILED',
                message: isTimeout ? 'CDEK widget service timeout' : error?.message ?? 'CDEK widget service failed',
                details: null
            }
        });
    }
    finally {
        console.info('[CDEK][widgetService]', {
            action: action || path,
            status: res.statusCode,
            durationMs: Date.now() - startedAt
        });
    }
});
