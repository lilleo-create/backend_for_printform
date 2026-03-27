type ProductLikeSpec = { key: string; value: string; sortOrder?: number | null };
type ProductLikeMedia = { type: 'IMAGE' | 'VIDEO'; url: string; isPrimary?: boolean | null; sortOrder?: number | null };
type ProductLikeImage = { url: string; sortOrder?: number | null };

type ProductLike = {
  image?: string | null;
  videoUrls?: string[] | null;
  media?: ProductLikeMedia[] | null;
  images?: ProductLikeImage[] | null;
  specs?: ProductLikeSpec[] | null;
  characteristics?: ProductLikeSpec[] | null;
  specifications?: ProductLikeSpec[] | null;
  material?: string | null;
  technology?: string | null;
  color?: string | null;
  productionTimeHours?: number | null;
  weightGrossG?: number | null;
  dxCm?: number | null;
  dyCm?: number | null;
  dzCm?: number | null;
  moderationStatus?: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'NEEDS_EDIT' | 'ARCHIVED' | null;
};

const moderationStatusLabelRuMap: Record<string, string> = {
  DRAFT: 'Черновик',
  PENDING: 'На проверке',
  APPROVED: 'Одобрен',
  REJECTED: 'Отклонён',
  NEEDS_EDIT: 'Нужна доработка',
  ARCHIVED: 'В архиве'
};

const withLeadingSlash = (value: string) => (value.startsWith('/') ? value : `/${value}`);

const toAbsoluteMediaUrl = (value: string): string => {
  if (!value) return value;
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  const base = (process.env.BACKEND_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
  return `${base}${withLeadingSlash(value)}`;
};

const normalizeSpecs = (specs: ProductLikeSpec[] = []): Array<{ key: string; value: string; sortOrder: number }> =>
  specs
    .filter((item) => Boolean(item?.key) && Boolean(item?.value))
    .map((item, index) => ({
      key: item.key.trim(),
      value: item.value.trim(),
      sortOrder: item.sortOrder ?? index
    }));

const buildFallbackCharacteristics = (product: ProductLike): Array<{ key: string; value: string; sortOrder: number }> => {
  const fallback: Array<{ key: string; value: string }> = [];

  if (product.material) fallback.push({ key: 'Материал', value: product.material });
  if (product.technology) fallback.push({ key: 'Технология', value: product.technology });
  if (product.color) fallback.push({ key: 'Цвет', value: product.color });
  if (product.productionTimeHours != null) fallback.push({ key: 'Срок изготовления', value: `${product.productionTimeHours} ч` });
  if (product.weightGrossG != null) fallback.push({ key: 'Вес', value: `${product.weightGrossG} г` });
  if (product.dxCm != null && product.dyCm != null && product.dzCm != null) {
    fallback.push({ key: 'Размер', value: `${product.dxCm} × ${product.dyCm} × ${product.dzCm} см` });
  }

  return fallback.map((item, index) => ({ ...item, sortOrder: index }));
};

export const normalizeProductDto = <T extends ProductLike>(product: T) => {
  const sourceSpecs = normalizeSpecs(
    product.specs ??
      product.characteristics ??
      product.specifications ??
      []
  );
  const characteristics = sourceSpecs.length > 0 ? sourceSpecs : buildFallbackCharacteristics(product);

  const mediaSource: ProductLikeMedia[] =
    product.media?.length
      ? product.media
      : [
          ...(product.image ? [{ type: 'IMAGE' as const, url: product.image, isPrimary: true, sortOrder: 0 }] : []),
          ...((product.videoUrls ?? []).map((url, index) => ({
            type: 'VIDEO' as const,
            url,
            isPrimary: false,
            sortOrder: index + 1
          })))
        ];

  const seen = new Set<string>();
  const dedupedMedia = mediaSource
    .map((item, index) => ({
      type: item.type,
      url: toAbsoluteMediaUrl(item.url),
      isPrimary: Boolean(item.isPrimary),
      sortOrder: item.sortOrder ?? index
    }))
    .filter((item) => {
      const key = `${item.type}:${item.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const hasPrimaryImage = dedupedMedia.some((item) => item.type === 'IMAGE' && item.isPrimary);
  if (!hasPrimaryImage) {
    const firstImageIndex = dedupedMedia.findIndex((item) => item.type === 'IMAGE');
    if (firstImageIndex >= 0) {
      dedupedMedia[firstImageIndex] = { ...dedupedMedia[firstImageIndex], isPrimary: true };
    }
  }

  const imageMedia = dedupedMedia.filter((item) => item.type === 'IMAGE');
  const videoMedia = dedupedMedia.filter((item) => item.type === 'VIDEO');
  const primaryMedia = dedupedMedia.find((item) => item.isPrimary) ?? dedupedMedia[0] ?? null;
  const primaryImage = imageMedia.find((item) => item.isPrimary)?.url ?? imageMedia[0]?.url ?? toAbsoluteMediaUrl(product.image ?? '');
  const normalizedImages =
    product.images && product.images.length > 0
      ? product.images.map((item, index) => ({
          url: toAbsoluteMediaUrl(item.url),
          sortOrder: item.sortOrder ?? index
        }))
      : imageMedia.map((item, index) => ({ url: item.url, sortOrder: item.sortOrder ?? index }));

  const hasAnyDimension = [product.weightGrossG, product.dxCm, product.dyCm, product.dzCm].some((value) => value != null);

  return {
    ...product,
    moderationStatusLabelRu: product.moderationStatus ? (moderationStatusLabelRuMap[product.moderationStatus] ?? product.moderationStatus) : null,
    media: dedupedMedia,
    images: normalizedImages,
    image: primaryMedia?.type === 'IMAGE' ? primaryMedia.url : primaryImage,
    primaryImage,
    gallery: imageMedia.map((item) => item.url),
    imageUrls: imageMedia.map((item) => item.url),
    videoUrls: videoMedia.map((item) => item.url),
    primaryMedia,
    characteristics,
    specifications: [...characteristics],
    specs: [...characteristics],
    dimensions: hasAnyDimension
      ? {
          weightGrossG: product.weightGrossG ?? null,
          dxCm: product.dxCm ?? null,
          dyCm: product.dyCm ?? null,
          dzCm: product.dzCm ?? null
        }
      : null
  };
};
