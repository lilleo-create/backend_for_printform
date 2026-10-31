import { isPrintFormArticle } from './productArticleService';

export const resolveCdekWareKey = (
  product: { sku: string }, variant?: { sku: string | null } | null
): string => {
  const article = variant ? variant.sku : product.sku;
  if (!isPrintFormArticle(article)) throw new Error('CDEK_ARTICLE_INVALID');
  return article;
};
