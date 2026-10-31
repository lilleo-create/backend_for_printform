import type { Prisma, PrismaClient } from '@prisma/client';

type ArticleDb = Pick<PrismaClient | Prisma.TransactionClient, 'printFormArticleCounter'>;
const rootArticlePattern = /^PF-[0-9]{6,}$/;
const anyArticlePattern = /^PF-[0-9]{6,}(?:-V[0-9]+)?$/;

export const isPrintFormArticle = (value: unknown): value is string =>
  typeof value === 'string' && anyArticlePattern.test(value);

export const allocatePrintFormArticle = async (db: ArticleDb, parentArticle?: string): Promise<string> => {
  if (parentArticle && !rootArticlePattern.test(parentArticle)) throw new Error('PF_PARENT_ARTICLE_INVALID');
  const counter = await db.printFormArticleCounter.update({
    where: { id: 1 }, data: { lastValue: { increment: 1 } }, select: { lastValue: true }
  });
  return parentArticle
    ? `${parentArticle}-V${counter.lastValue}`
    : `PF-${String(counter.lastValue).padStart(6, '0')}`;
};
