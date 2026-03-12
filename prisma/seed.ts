import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.referenceCategory.createMany({
    data: [
      { slug: 'souvenirs', title: 'Сувениры', isActive: true, sortOrder: 1 },
      { slug: 'decor', title: 'Декор', isActive: true, sortOrder: 2 },
      { slug: 'figures', title: 'Фигурки', isActive: true, sortOrder: 3 },
      { slug: 'gifts', title: 'Подарки', isActive: true, sortOrder: 4 },
      { slug: 'prototypes', title: 'Прототипы', isActive: true, sortOrder: 5 },
    ],
    skipDuplicates: true,
  });

  await prisma.city.createMany({
    data: [
      { name: 'Москва', country: 'RU', isActive: true },
      { name: 'Санкт-Петербург', country: 'RU', isActive: true },
      { name: 'Белград', country: 'RS', isActive: true },
    ],
    skipDuplicates: true,
  });

  console.log('✅ Seed done');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
