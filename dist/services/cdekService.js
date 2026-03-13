"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cdekService = void 0;
const axios_1 = __importDefault(require("axios"));
const cdek_1 = require("../config/cdek");
class CdekService {
    constructor() {
        this.tokenCache = null;
    }
    async request(methodName, config) {
        const startedAt = Date.now();
        try {
            const response = await axios_1.default.request(config);
            console.info(`[CDEK][${methodName}]`, {
                status: response.status,
                durationMs: Date.now() - startedAt,
            });
            return response.data;
        }
        catch (error) {
            console.info(`[CDEK][${methodName}]`, {
                status: Number(error?.response?.status ?? 0),
                durationMs: Date.now() - startedAt,
                data: error?.response?.data,
            });
            throw error;
        }
    }
    looksLikeCdekPvz(code) {
        return typeof code === "string" && /^[A-Z]{3}\d{2,6}$/.test(code.trim());
    }
    extractOrderUuid(resp) {
        const e = resp?.entity ?? {};
        const uuid = e.uuid ??
            e.order_uuid ??
            (Array.isArray(e.uuids) ? e.uuids[0] : undefined);
        return String(uuid ?? "").trim();
    }
    extractCdekNumber(resp) {
        const e = resp?.entity ?? {};
        return String(e.cdek_number ?? resp?.cdek_number ?? "").trim();
    }
    extractLastStatusCode(resp) {
        const statuses = (resp?.entity?.statuses ?? resp?.statuses ?? []);
        const last = statuses.length > 0 ? (statuses[statuses.length - 1]?.code ?? "") : "";
        return String(last ?? "").trim();
    }
    extractErrors(resp) {
        const requests = resp?.requests ?? [];
        const state = String(requests?.[0]?.state ?? "");
        const errors = requests.flatMap((r) => r?.errors ?? []);
        return { state, errors };
    }
    async getToken() {
        const now = Date.now();
        if (this.tokenCache && now < this.tokenCache.expiresAtMs - 60000) {
            return this.tokenCache.token;
        }
        const { baseUrl, clientId, clientSecret } = (0, cdek_1.getCdekConfig)();
        const body = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
        });
        const response = await this.request("getToken", {
            method: "POST",
            url: `${baseUrl}/v2/oauth/token`,
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            data: body.toString(),
        });
        this.tokenCache = {
            token: response.access_token,
            expiresAtMs: now + response.expires_in * 1000,
        };
        return response.access_token;
    }
    async getPickupPoints(cityCode, city) {
        const token = await this.getToken();
        const { baseUrl } = (0, cdek_1.getCdekConfig)();
        const response = await this.request("getPickupPoints", {
            method: "GET",
            url: `${baseUrl}/v2/deliverypoints`,
            params: {
                city_code: cityCode,
                type: "PVZ",
                is_handout: true,
                is_reception: true,
            },
            headers: { Authorization: `Bearer ${token}` },
        });
        return response
            .map((point) => {
            const lat = Number(point.location?.latitude ?? 0);
            const lon = Number(point.location?.longitude ?? 0);
            return {
                code: String(point.code ?? "").trim(),
                name: String(point.name ?? "").trim(),
                address: String(point.location?.address_full ?? "").trim(),
                cityCode: Number(point.location?.city_code ?? 0),
                cityName: String(point.location?.city ?? "").trim(),
                latitude: Number.isFinite(lat) ? lat : 0,
                longitude: Number.isFinite(lon) ? lon : 0,
                workTime: String(point.work_time ?? "").trim(),
                type: String(point.type ?? "PVZ").trim(),
            };
        })
            .filter((point) => {
            if (!point.code)
                return false;
            if (!city)
                return true;
            return point.cityName.toLowerCase().includes(city.toLowerCase());
        });
    }
    /**
     * ⚠️ Не идеально: без cityCode это может быть очень много точек.
     * Но оставляю как было, чтобы не ломать проект.
     */
    async getPickupPointByCode(pvzCode) {
        const code = String(pvzCode ?? "").trim();
        if (!code)
            throw new Error("CDEK_PVZ_CODE_REQUIRED");
        const points = await this.getPickupPoints(); // может быть тяжело
        const found = points.find((p) => String(p.code).toUpperCase() === code.toUpperCase());
        if (!found) {
            const err = new Error(`CDEK_PVZ_NOT_FOUND: ${code}`);
            err.code = "CDEK_PVZ_NOT_FOUND";
            throw err;
        }
        return {
            code: found.code,
            name: found.name,
            type: found.type ?? "PVZ",
            location: {
                city_code: found.cityCode,
                city: found.cityName,
                latitude: found.latitude,
                longitude: found.longitude,
                address_full: found.address,
            },
            work_time: found.workTime,
        };
    }
    async calculateDelivery(params) {
        const token = await this.getToken();
        const { baseUrl } = (0, cdek_1.getCdekConfig)();
        const response = await this.request("calculateDelivery", {
            method: "POST",
            url: `${baseUrl}/v2/calculator/tariff`,
            headers: { Authorization: `Bearer ${token}` },
            data: {
                tariff_code: 136,
                from_location: { code: params.fromCityCode },
                to_location: { code: params.toCityCode },
                packages: [
                    {
                        weight: params.weightGrams,
                        length: params.lengthCm ?? 10,
                        width: params.widthCm ?? 10,
                        height: params.heightCm ?? 10,
                    },
                ],
            },
        });
        return {
            totalSum: Number(response.total_sum ?? 0),
            deliveryDaysMin: Number(response.period_min ?? 0),
            deliveryDaysMax: Number(response.period_max ?? 0),
            tariffCode: 136,
        };
    }
    async createOrder(params) {
        // ✅ валидации ДО запроса
        if (!params.fromPvzCode)
            throw new Error("CDEK_FROM_PVZ_MISSING");
        if (!params.toPvzCode)
            throw new Error("CDEK_DESTINATION_PVZ_MISSING");
        if (!this.looksLikeCdekPvz(params.fromPvzCode)) {
            throw new Error(`CDEK_FROM_PVZ_INVALID_CODE: ${params.fromPvzCode}`);
        }
        if (!this.looksLikeCdekPvz(params.toPvzCode)) {
            throw new Error(`CDEK_DESTINATION_PVZ_INVALID_CODE: ${params.toPvzCode}`);
        }
        if (!params.recipientName)
            throw new Error("CDEK_RECIPIENT_NAME_MISSING");
        if (!params.recipientPhone)
            throw new Error("CDEK_RECIPIENT_PHONE_MISSING");
        if (!params.orderId)
            throw new Error("CDEK_ORDER_ID_MISSING");
        if (!Array.isArray(params.items) || params.items.length === 0)
            throw new Error("CDEK_ITEMS_MISSING");
        const token = await this.getToken();
        const { baseUrl } = (0, cdek_1.getCdekConfig)();
        console.info("[CDEK][createOrder] pvz", {
            from: params.fromPvzCode,
            to: params.toPvzCode,
            orderId: params.orderId,
        });
        const response = await this.request("createOrder", {
            method: "POST",
            url: `${baseUrl}/v2/orders`,
            headers: { Authorization: `Bearer ${token}` },
            data: {
                number: params.orderId,
                tariff_code: 136,
                shipment_point: params.fromPvzCode,
                delivery_point: params.toPvzCode,
                comment: params.comment ?? "",
                recipient: {
                    name: params.recipientName,
                    phones: [{ number: params.recipientPhone }],
                },
                sender: {
                    name: params.senderName ?? "Маркетплейс PrintForm",
                    phones: [{ number: params.senderPhone ?? "+70000000000" }],
                },
                services: [],
                packages: [
                    {
                        number: params.orderId,
                        weight: params.weightGrams ?? 500,
                        length: params.lengthCm ?? 10,
                        width: params.widthCm ?? 10,
                        height: params.heightCm ?? 10,
                        comment: params.comment ?? "",
                        items: params.items.map((item) => ({
                            name: item.name,
                            ware_key: item.article ?? item.id,
                            payment: { value: 0 },
                            cost: item.price,
                            weight: 50,
                            amount: item.quantity,
                        })),
                    },
                ],
            },
        });
        console.info("[CDEK][createOrder][raw]", JSON.stringify(response, null, 2));
        const cdekOrderUuid = this.extractOrderUuid(response);
        const cdekRequestUuid = String(response?.requests?.[0]?.request_uuid ?? '').trim();
        const state = String(response?.requests?.[0]?.state ?? '').trim();
        const trackingNumber = this.extractCdekNumber(response);
        // лог на один раз (потом уберешь)
        console.info("[CDEK][createOrder][parsed]", {
            cdekOrderId: cdekOrderUuid,
            cdekRequestUuid,
            trackingNumber,
            state,
            errors: response?.requests?.flatMap((r) => r?.errors ?? []) ?? [],
        });
        if (!cdekOrderUuid) {
            const errors = response?.requests?.flatMap((r) => r?.errors ?? []) ?? [];
            throw new Error(`CDEK_CREATE_ORDER_NO_UUID: ${JSON.stringify({ state, errors, response }, null, 2)}`);
        }
        return { cdekOrderId: cdekOrderUuid, trackingNumber, cdekRequestUuid, state };
    }
    async getOrderInfo(cdekOrderId) {
        return this.getOrderByUuid(cdekOrderId);
    }
    async getOrderByTracking(trackingNumber) {
        const number = String(trackingNumber ?? '').trim();
        if (!number)
            throw new Error('CDEK_TRACKING_NUMBER_REQUIRED');
        const token = await this.getToken();
        const { baseUrl } = (0, cdek_1.getCdekConfig)();
        const response = await this.request('getOrderByTracking', {
            method: 'GET',
            url: `${baseUrl}/v2/orders`,
            headers: { Authorization: `Bearer ${token}` },
            params: { cdek_number: number }
        });
        const first = Array.isArray(response.entity) ? response.entity[0] : null;
        if (!first)
            throw new Error('CDEK_ORDER_NOT_FOUND_BY_TRACKING');
        const cdekOrderId = String(first.uuid ?? first.order_uuid ?? '').trim();
        if (!cdekOrderId)
            throw new Error('CDEK_ORDER_UUID_MISSING_BY_TRACKING');
        return this.getOrderByUuid(cdekOrderId);
    }
    async getOrderByUuid(cdekOrderId) {
        const id = String(cdekOrderId ?? '').trim();
        if (!id)
            throw new Error('CDEK_ORDER_ID_REQUIRED');
        const token = await this.getToken();
        const { baseUrl } = (0, cdek_1.getCdekConfig)();
        const response = await this.request('getOrderInfo', {
            method: 'GET',
            url: `${baseUrl}/v2/orders/${id}`,
            headers: { Authorization: `Bearer ${token}` }
        });
        const requestUuid = String(response?.requests?.[0]?.request_uuid ?? '').trim();
        const relatedEntities = this.extractPrintForms(response);
        console.debug('[CDEK][getOrderInfo] forms snapshot', {
            cdekOrderId: id,
            waybillUrl: relatedEntities.waybillUrl,
            relatedEntities,
            rawRelatedEntities: response?.related_entities ?? []
        });
        return {
            cdekOrderId: this.extractOrderUuid(response),
            status: this.extractLastStatusCode(response),
            trackingNumber: this.extractCdekNumber(response),
            requestUuid,
            relatedEntities,
            raw: response
        };
    }
    getPrintForms(snapshot) {
        return snapshot.relatedEntities;
    }
    extractPrintForms(resp) {
        const entities = Array.isArray(resp.related_entities) ? resp.related_entities : [];
        const normalized = entities.map((entry) => ({
            type: String(entry?.type ?? '').trim().toLowerCase(),
            url: String(entry?.url ?? '').trim()
        }));
        const waybillAliases = new Set(['waybill', 'waybill_url', 'waybillurl']);
        const barcodeAliases = new Set(['barcode', 'barcode_url', 'barcodeurl']);
        const waybillEntity = normalized.find((entry) => waybillAliases.has(entry.type) && entry.url);
        const barcodeUrls = entities
            .map((entry) => ({
            type: String(entry?.type ?? '').trim().toLowerCase(),
            url: String(entry?.url ?? '').trim()
        }))
            .filter((entry) => barcodeAliases.has(entry.type))
            .map((entry) => entry.url)
            .filter(Boolean);
        return {
            waybillUrl: String(waybillEntity?.url ?? '').trim() || null,
            barcodeUrls
        };
    }
    /**
     * ✅ Обертка под “старый” вызов из проекта:
     * cdekService.createOrderFromMarketplaceOrder(...)
     */
    async createOrderFromMarketplaceOrder(payload) {
        return this.createOrder({
            orderId: payload.orderId,
            fromPvzCode: payload.fromPvzCode,
            toPvzCode: payload.toPvzCode,
            recipientName: payload.recipientName,
            recipientPhone: payload.recipientPhone,
            items: payload.items,
            comment: payload.comment,
            senderName: payload.senderName,
            senderPhone: payload.senderPhone,
            weightGrams: payload.weightGrams,
            lengthCm: payload.lengthCm,
            widthCm: payload.widthCm,
            heightCm: payload.heightCm,
        });
    }
    async createOrderPrint(orderUuids, type = 'tpl_russia', copyCount = 2) {
        const normalizedOrderUuids = Array.from(new Set(orderUuids.map((value) => String(value ?? '').trim()).filter(Boolean)));
        if (!normalizedOrderUuids.length)
            throw new Error('CDEK_ORDER_UUID_REQUIRED');
        const token = await this.getToken();
        const { baseUrl } = (0, cdek_1.getCdekConfig)();
        const response = await this.request('createOrderPrint', {
            method: 'POST',
            url: `${baseUrl}/v2/print/orders`,
            headers: { Authorization: `Bearer ${token}` },
            data: {
                orders: normalizedOrderUuids.map((orderUuid) => ({ order_uuid: orderUuid })),
                copy_count: copyCount,
                type: String(type ?? 'tpl_russia')
            }
        });
        const printUuid = String(response.entity?.uuid ?? '').trim();
        if (!printUuid) {
            const { state, errors } = this.extractErrors(response);
            throw new Error(`CDEK_ORDER_PRINT_TASK_UUID_MISSING: ${JSON.stringify({ state, errors }, null, 2)}`);
        }
        return printUuid;
    }
    async getOrderPrintStatus(printUuid) {
        return this.getReceiptPrintTask(printUuid);
    }
    async downloadOrderPrintPdf(printUuid) {
        return this.getReceiptPdfByPrintTaskUuid(printUuid);
    }
    async createBarcodePrint(orderUuids, copyCount = 1, format = 'A4', lang = 'RUS') {
        const normalizedOrderUuids = Array.from(new Set(orderUuids.map((value) => String(value ?? '').trim()).filter(Boolean)));
        if (!normalizedOrderUuids.length)
            throw new Error('CDEK_ORDER_UUID_REQUIRED');
        const token = await this.getToken();
        const { baseUrl } = (0, cdek_1.getCdekConfig)();
        const response = await this.request('createBarcodePrint', {
            method: 'POST',
            url: `${baseUrl}/v2/print/barcodes`,
            headers: { Authorization: `Bearer ${token}` },
            data: {
                orders: normalizedOrderUuids.map((orderUuid) => ({ order_uuid: orderUuid })),
                copy_count: copyCount,
                format,
                lang
            }
        });
        const printUuid = String(response.entity?.uuid ?? '').trim();
        if (!printUuid) {
            const { state, errors } = this.extractErrors(response);
            throw new Error(`CDEK_BARCODE_PRINT_TASK_UUID_MISSING: ${JSON.stringify({ state, errors }, null, 2)}`);
        }
        return printUuid;
    }
    async createBarcodePrintTaskForLabel(params) {
        return this.createBarcodePrint(params.orderUuids, params.copyCount ?? 1, params.format ?? 'A4', params.lang ?? 'RUS');
    }
    async getBarcodePrintStatus(printUuid) {
        return this.getBarcodePrintTask(printUuid);
    }
    async downloadBarcodePrintPdf(printUuid) {
        return this.getBarcodePdfByPrintTaskUuid(printUuid);
    }
    async createWaybillPrintTask(orderUuid) {
        const uuid = String(orderUuid ?? "").trim();
        if (!uuid)
            throw new Error("CDEK_ORDER_UUID_REQUIRED");
        const token = await this.getToken();
        const { baseUrl } = (0, cdek_1.getCdekConfig)();
        const resp = await this.request("createWaybillPrintTask", {
            method: "POST",
            url: `${baseUrl}/v2/print/orders`,
            headers: { Authorization: `Bearer ${token}` },
            data: {
                orders: [{ order_uuid: uuid }],
                copy_count: 1,
            },
        });
        const printUuid = String(resp.entity?.uuid ?? "").trim();
        if (!printUuid) {
            const { state, errors } = this.extractErrors(resp);
            throw new Error(`CDEK_PRINT_TASK_UUID_MISSING: ${JSON.stringify({ state, errors }, null, 2)}`);
        }
        return printUuid;
    }
    async createReceiptPrintTask(params) {
        const orderUuid = String(params.orderUuid ?? '').trim();
        return this.createOrderPrint([orderUuid], params.type ?? 'tpl_russia', params.copyCount ?? 2);
    }
    async createBarcodePrintTask(params) {
        const orderUuid = String(params.orderUuid ?? '').trim();
        return this.createBarcodePrint([orderUuid], params.copyCount ?? 1, params.format ?? 'A4', params.lang ?? 'RUS');
    }
    normalizePrintTaskStatus(response) {
        const uuid = String(response.entity?.uuid ?? '').trim();
        const statuses = Array.isArray(response.entity?.statuses) ? response.entity.statuses : [];
        const normalizedStatuses = statuses.map((entry) => ({
            code: String(entry?.code ?? '').trim().toUpperCase(),
            dateTime: entry?.date_time,
            city: entry?.city
        })).filter((entry) => Boolean(entry.code));
        const status = (normalizedStatuses[normalizedStatuses.length - 1]?.code ?? 'UNKNOWN');
        return { uuid, status, statuses: normalizedStatuses };
    }
    async getReceiptPrintTask(printTaskUuid) {
        const uuid = String(printTaskUuid ?? '').trim();
        if (!uuid)
            throw new Error('CDEK_PRINT_TASK_UUID_REQUIRED');
        const token = await this.getToken();
        const { baseUrl } = (0, cdek_1.getCdekConfig)();
        const response = await this.request('getReceiptPrintTask', {
            method: 'GET',
            url: `${baseUrl}/v2/print/orders/${uuid}`,
            headers: { Authorization: `Bearer ${token}` }
        });
        return this.normalizePrintTaskStatus(response);
    }
    async getBarcodePrintTask(printTaskUuid) {
        const uuid = String(printTaskUuid ?? '').trim();
        if (!uuid)
            throw new Error('CDEK_PRINT_TASK_UUID_REQUIRED');
        const token = await this.getToken();
        const { baseUrl } = (0, cdek_1.getCdekConfig)();
        const response = await this.request('getBarcodePrintTask', {
            method: 'GET',
            url: `${baseUrl}/v2/print/barcodes/${uuid}`,
            headers: { Authorization: `Bearer ${token}` }
        });
        return this.normalizePrintTaskStatus(response);
    }
    async getBarcodePrintTaskForLabel(printTaskUuid) {
        return this.getBarcodePrintTask(printTaskUuid);
    }
    async getWaybillPdfByPrintTaskUuid(printTaskUuid) {
        const uuid = String(printTaskUuid ?? "").trim();
        if (!uuid)
            throw new Error("CDEK_PRINT_TASK_UUID_REQUIRED");
        const token = await this.getToken();
        const { baseUrl } = (0, cdek_1.getCdekConfig)();
        const arrayBuffer = await this.request("getWaybillPdfByPrintTaskUuid", {
            method: "GET",
            url: `${baseUrl}/v2/print/orders/${uuid}.pdf`,
            headers: { Authorization: `Bearer ${token}` },
            responseType: "arraybuffer",
        });
        return Buffer.from(arrayBuffer);
    }
    async getReceiptPdfByPrintTaskUuid(printTaskUuid) {
        const uuid = String(printTaskUuid ?? '').trim();
        if (!uuid)
            throw new Error('CDEK_PRINT_TASK_UUID_REQUIRED');
        const token = await this.getToken();
        const { baseUrl } = (0, cdek_1.getCdekConfig)();
        const arrayBuffer = await this.request('getReceiptPdfByPrintTaskUuid', {
            method: 'GET',
            url: `${baseUrl}/v2/print/orders/${uuid}.pdf`,
            headers: { Authorization: `Bearer ${token}` },
            responseType: 'arraybuffer'
        });
        return Buffer.from(arrayBuffer);
    }
    async getBarcodePdfByPrintTaskUuid(printTaskUuid) {
        const uuid = String(printTaskUuid ?? '').trim();
        if (!uuid)
            throw new Error('CDEK_PRINT_TASK_UUID_REQUIRED');
        const token = await this.getToken();
        const { baseUrl } = (0, cdek_1.getCdekConfig)();
        const arrayBuffer = await this.request('getBarcodePdfByPrintTaskUuid', {
            method: 'GET',
            url: `${baseUrl}/v2/print/barcodes/${uuid}.pdf`,
            headers: { Authorization: `Bearer ${token}` },
            responseType: 'arraybuffer'
        });
        return Buffer.from(arrayBuffer);
    }
    async downloadBarcodePdf(printTaskUuid) {
        return this.getBarcodePdfByPrintTaskUuid(printTaskUuid);
    }
    async getWaybillPdfByOrderUuid(orderUuid) {
        const printTaskUuid = await this.createWaybillPrintTask(orderUuid);
        return this.getWaybillPdfByPrintTaskUuid(printTaskUuid);
    }
    async downloadPdfByUrl(url) {
        const normalizedUrl = String(url ?? '').trim();
        if (!normalizedUrl)
            throw new Error('CDEK_PDF_URL_REQUIRED');
        const token = await this.getToken();
        const startedAt = Date.now();
        console.info('[CDEK][downloadPdfByUrl][start]', { url: normalizedUrl });
        try {
            const response = await axios_1.default.get(normalizedUrl, {
                responseType: 'arraybuffer',
                headers: { Authorization: `Bearer ${token}` },
                validateStatus: () => true
            });
            const contentType = String(response.headers?.['content-type'] ?? '').toLowerCase();
            const contentLength = Number(response.headers?.['content-length'] ?? 0) || Buffer.byteLength(Buffer.from(response.data));
            console.info('[CDEK][downloadPdfByUrl][response]', {
                url: normalizedUrl,
                status: response.status,
                contentType,
                contentLength,
                durationMs: Date.now() - startedAt
            });
            if (response.status < 200 || response.status >= 300) {
                const error = new Error(`CDEK_PDF_DOWNLOAD_HTTP_${response.status}`);
                error.status = response.status;
                error.data = response.data;
                throw error;
            }
            if (contentType && !contentType.includes('application/pdf') && !contentType.includes('application/octet-stream')) {
                const error = new Error(`CDEK_PDF_CONTENT_TYPE_INVALID: ${contentType}`);
                error.status = response.status;
                error.contentType = contentType;
                throw error;
            }
            return Buffer.from(response.data);
        }
        catch (error) {
            console.error('[CDEK][downloadPdfByUrl][error]', {
                url: normalizedUrl,
                status: Number(error?.response?.status ?? error?.status ?? 0),
                data: error?.response?.data ?? error?.data,
                message: String(error?.message ?? 'unknown_error'),
                durationMs: Date.now() - startedAt
            });
            throw error;
        }
    }
}
exports.cdekService = new CdekService();
