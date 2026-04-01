import { productRepository } from '../repositories/productRepository';
const withPriceMinorUnits = <T extends { price?: number }>(payload: T): T => payload;

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
    productRepository.createVariant(masterProductId, sellerId, withPriceMinorUnits(data)),
  updateVariant: (
    masterProductId: string,
    variantId: string,
    sellerId: string,
    data: Parameters<typeof productRepository.updateVariant>[3]
  ) => productRepository.updateVariant(masterProductId, variantId, sellerId, withPriceMinorUnits(data)),
  removeVariant: (masterProductId: string, variantId: string, sellerId: string) =>
    productRepository.removeVariant(masterProductId, variantId, sellerId),
  create: (data: Parameters<typeof productRepository.create>[0]) =>
    productRepository.create({
      ...withPriceMinorUnits(data),
      variants: data.variants?.map((variant) => withPriceMinorUnits(variant))
    }),
  update: (id: string, data: Parameters<typeof productRepository.update>[1]) =>
    productRepository.update(id, withPriceMinorUnits(data)),
  remove: productRepository.remove
};
