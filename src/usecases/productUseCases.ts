import { productRepository } from '../repositories/productRepository';
import { rublesToKopecks } from '../utils/money';

const withPriceInKopecks = <T extends { price?: number }>(payload: T): T => {
  if (payload.price === undefined) {
    return payload;
  }

  return {
    ...payload,
    price: rublesToKopecks(payload.price)
  };
};

export const productUseCases = {
  list: (filters: {
    shopId?: string;
    query?: string;
    category?: string;
    material?: string;
    minPrice?: number;
    maxPrice?: number;
    sort?: 'createdAt' | 'rating' | 'price';
    order?: 'asc' | 'desc';
    page?: number;
    limit?: number;
  }) => productRepository.findMany(filters),
  get: (id: string) => productRepository.findById(id),
  getForSellerEdit: (id: string, sellerId: string) => productRepository.getSellerProductForEdit(id, sellerId),
  listVariants: (id: string) => productRepository.listVariants(id),
  getSellerProductWithVariants: (id: string, sellerId: string) => productRepository.findSellerProductWithVariants(id, sellerId),
  createVariant: (masterProductId: string, sellerId: string, data: Parameters<typeof productRepository.createVariant>[2]) =>
    productRepository.createVariant(masterProductId, sellerId, withPriceInKopecks(data)),
  updateVariant: (
    masterProductId: string,
    variantId: string,
    sellerId: string,
    data: Parameters<typeof productRepository.updateVariant>[3]
  ) => productRepository.updateVariant(masterProductId, variantId, sellerId, withPriceInKopecks(data)),
  removeVariant: (masterProductId: string, variantId: string, sellerId: string) =>
    productRepository.removeVariant(masterProductId, variantId, sellerId),
  create: (data: Parameters<typeof productRepository.create>[0]) =>
    productRepository.create({
      ...withPriceInKopecks(data),
      variants: data.variants?.map((variant) => withPriceInKopecks(variant))
    }),
  update: (id: string, data: Parameters<typeof productRepository.update>[1]) =>
    productRepository.update(id, withPriceInKopecks(data)),
  remove: productRepository.remove
};
