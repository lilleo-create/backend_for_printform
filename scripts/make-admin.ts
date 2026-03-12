import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const email = process.argv.slice(2)[0];
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = async (message: string) => {
  console.error(message);
  await prisma.$disconnect();
  process.exit(1);
};

const succeed = async (message: string) => {
  console.log(message);
  await prisma.$disconnect();
  process.exit(0);
};

const run = async () => {
  if (!email || !emailRegex.test(email)) {
    await fail('Usage: npm run make:admin -- user@email.com');
  }

  const user = await prisma.user.findUnique({
    where: { email }
  });

  if (!user) {
    await fail(`User not found: ${email}`);
  }

  if (user.role === 'ADMIN') {
    await succeed('already admin');
  }

  await prisma.user.update({
    where: { email },
    data: { role: 'ADMIN' }
  });

  await succeed(`Promoted to admin: ${email}`);
};

run().catch(async (error) => {
  console.error('Failed to promote admin:', error);
  await prisma.$disconnect();
  process.exit(1);
});
