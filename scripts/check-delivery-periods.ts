import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { getCdekConfig } from '../src/config/cdek';
import axios from 'axios';

const safeRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const readCityCode = (meta: unknown): number | null => {
  const raw = safeRecord(safeRecord(meta).raw);
  const code = Number(raw.city_code ?? 0);
  return Number.isFinite(code) && code > 0 ? code : null;
};

const run = async () => {
  const { baseUrl, clientId, clientSecret, isTest } = getCdekConfig();
  console.log('\n=== CDEK config ===');
  console.log('mode   :', isTest ? 'TEST (api.edu.cdek.ru)' : 'PRODUCTION');
  console.log('baseUrl:', baseUrl);

  // 1. Найти последние 5 заказов с обоими PVZ meta
  console.log('\n=== Заказы с PVZ meta ===');
  const orders = await prisma.order.findMany({
    where: {
      sellerDropoffPvzId: { not: null },
      buyerPickupPvzId:   { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      createdAt: true,
      sellerDropoffPvzId: true,
      sellerDropoffPvzMeta: true,
      buyerPickupPvzId: true,
      buyerPickupPvzMeta: true,
      deliveryDaysMin: true,
      deliveryDaysMax: true,
      deliveryEtaText: true,
      deliveryCalculatedAt: true,
    },
  });

  if (!orders.length) {
    console.log('Нет заказов с заполненными PVZ.');
    return;
  }

  for (const order of orders) {
    const fromCode = readCityCode(order.sellerDropoffPvzMeta);
    const toCode   = readCityCode(order.buyerPickupPvzMeta);
    const sellerRaw = safeRecord(safeRecord(order.sellerDropoffPvzMeta).raw);
    const buyerRaw  = safeRecord(safeRecord(order.buyerPickupPvzMeta).raw);

    console.log(`\nOrder ${order.id} (${order.createdAt.toISOString().slice(0, 10)})`);
    console.log('  sellerDropoffPvzId :', order.sellerDropoffPvzId);
    console.log('  seller raw.city_code:', fromCode ?? `❌ не найден (raw keys: ${Object.keys(sellerRaw).join(', ') || 'пусто'})`);
    console.log('  buyerPickupPvzId   :', order.buyerPickupPvzId);
    console.log('  buyer  raw.city_code:', toCode   ?? `❌ не найден (raw keys: ${Object.keys(buyerRaw).join(', ') || 'пусто'})`);
    console.log('  deliveryDaysMin/Max:', order.deliveryDaysMin, '/', order.deliveryDaysMax);
    console.log('  deliveryEtaText    :', order.deliveryEtaText ?? '(не рассчитан)');
    console.log('  deliveryCalculatedAt:', order.deliveryCalculatedAt?.toISOString() ?? '(никогда)');

    // 2. Если оба city_code есть — пробуем реальный расчёт
    if (fromCode && toCode) {
      console.log(`\n  → Пробуем расчёт CDEK: ${fromCode} → ${toCode}`);
      try {
        const tokenResp = await axios.post<{ access_token: string }>(
          `${baseUrl}/v2/oauth/token`,
          `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        );
        const token = tokenResp.data.access_token;

        const calcResp = await axios.post<{
          total_sum?: number;
          period_min?: number;
          period_max?: number;
          errors?: Array<{ code: string; message: string }>;
        }>(
          `${baseUrl}/v2/calculator/tariff`,
          {
            tariff_code: 136,
            from_location: { code: fromCode },
            to_location:   { code: toCode },
            packages: [{ weight: 500, length: 10, width: 10, height: 10 }],
          },
          { headers: { Authorization: `Bearer ${token}` } },
        );

        const d = calcResp.data;
        if (d.errors?.length) {
          console.log('  CDEK ошибка:', JSON.stringify(d.errors));
        } else {
          console.log(`  ✅ total_sum: ${d.total_sum} ₽, period: ${d.period_min}–${d.period_max} дней`);
        }
      } catch (e: any) {
        console.log('  CDEK HTTP ошибка:', e.response?.data ?? e.message);
      }
    } else {
      console.log('  ⚠️  Пропускаем расчёт — нет city_code');
    }
  }
};

run()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
