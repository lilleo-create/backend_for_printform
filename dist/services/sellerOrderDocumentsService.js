"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sellerOrderDocumentsService = void 0;
const pdfkit_1 = __importDefault(require("pdfkit"));
const bwip_js_1 = __importDefault(require("bwip-js"));
const node_fs_1 = require("node:fs");
const toBuffer = (doc) => new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
});
const readAddress = (meta) => {
    if (!meta || typeof meta !== 'object')
        return '—';
    return String(meta.addressFull ?? '—');
};
const toLabels = (order) => {
    if (!Array.isArray(order.orderLabels))
        return [];
    return order.orderLabels.filter(Boolean);
};
const CYRILLIC_FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf'
];
const applyCyrillicFont = (doc) => {
    const fontPath = CYRILLIC_FONT_CANDIDATES.find((candidate) => (0, node_fs_1.existsSync)(candidate));
    if (fontPath) {
        doc.font(fontPath);
        return;
    }
    console.warn('[sellerOrderDocumentsService] Cyrillic-capable font is missing, fallback to default font');
};
exports.sellerOrderDocumentsService = {
    async buildPackingSlip(order) {
        const doc = new pdfkit_1.default({ size: 'A4', margin: 40 });
        applyCyrillicFont(doc);
        doc.fontSize(18).text('Упаковочный лист');
        doc.moveDown(0.5);
        doc.fontSize(11).text(`Заказ: №${order.id}`);
        doc.text(`Дата: ${new Date(order.createdAt).toLocaleString('ru-RU')}`);
        doc.moveDown();
        doc.fontSize(12).text('Получатель', { underline: true });
        doc.fontSize(11).text(`ФИО: ${order.recipientName ?? '—'}`);
        doc.text(`Телефон: ${order.recipientPhone ?? '—'}`);
        doc.text(`Email: ${order.recipientEmail ?? '—'}`);
        doc.moveDown();
        doc.text(`Куда отнести: ${readAddress(order.sellerDropoffPvzMeta)}`);
        doc.text(`Пункт получения покупателя: ${readAddress(order.buyerPickupPvzMeta)}`);
        doc.moveDown();
        doc.fontSize(12).text('Состав заказа', { underline: true });
        order.items.forEach((item, index) => {
            doc.fontSize(11).text(`${index + 1}. ${item.product.title} — ${item.quantity} шт × ${item.priceAtPurchase.toLocaleString('ru-RU')} ${order.currency}`);
        });
        doc.moveDown();
        doc.text(`Количество грузомест: ${order.packagesCount}`);
        doc.text(`Сумма: ${order.total.toLocaleString('ru-RU')} ${order.currency}`);
        doc.moveDown(2);
        doc.text('Подпись продавца: _____________________');
        doc.text('Подпись приёмщика: _____________________');
        return toBuffer(doc);
    },
    async buildLabels(order) {
        const labels = toLabels(order);
        const pages = labels.length > 0 ? labels : [{ packageNo: 1, code: 'PF-UNKNOWN-1' }];
        const doc = new pdfkit_1.default({ size: 'A6', margin: 24, autoFirstPage: false });
        for (const label of pages) {
            doc.addPage({ size: 'A6', margin: 24 });
            applyCyrillicFont(doc);
            doc.fontSize(16).text('Внутренний ярлык PF');
            doc.moveDown(0.5);
            doc.fontSize(11).text(`Заказ: №${order.id}`);
            doc.text(`Грузоместо: ${label.packageNo}/${order.packagesCount}`);
            doc.text(`Получатель: ${order.recipientName ?? '—'}`);
            doc.moveDown(0.5);
            const barcode = await bwip_js_1.default.toBuffer({
                bcid: 'code128',
                text: label.code,
                scale: 2,
                height: 12,
                includetext: false
            });
            doc.image(barcode, { fit: [250, 80] });
            doc.moveDown(0.5);
            doc.fontSize(12).text(label.code);
        }
        return toBuffer(doc);
    },
    async buildHandoverAct(order) {
        const doc = new pdfkit_1.default({ size: 'A4', margin: 40 });
        applyCyrillicFont(doc);
        doc.fontSize(18).text('Акт приема-передачи');
        doc.moveDown();
        doc.fontSize(11).text(`№ заказа: ${order.id}`);
        doc.text(`Дата: ${new Date(order.createdAt).toLocaleString('ru-RU')}`);
        doc.text(`Оценочная сумма: ${order.total.toLocaleString('ru-RU')} ${order.currency}`);
        doc.text(`Количество грузомест: ${order.packagesCount}`);
        doc.text(`Итог: ${order.total.toLocaleString('ru-RU')} ${order.currency}`);
        doc.moveDown();
        doc.text('Отправитель: Продавец / платформа Print Form');
        doc.text('Исполнитель: ООО Яндекс Доставка');
        doc.moveDown(2);
        doc.text('Подпись отправителя: _____________________');
        doc.text('Подпись исполнителя: _____________________');
        doc.text('М.П.: _____________________');
        return toBuffer(doc);
    }
};
