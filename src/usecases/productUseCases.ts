import { productRepository } from '../repositories/productRepository';

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
    productRepository.createVariant(masterProductId, sellerId, data),
  updateVariant: (
    masterProductId: string,
    variantId: string,
    sellerId: string,
    data: Parameters<typeof productRepository.updateVariant>[3]
  ) => productRepository.updateVariant(masterProductId, variantId, sellerId, data),
  removeVariant: (masterProductId: string, variantId: string, sellerId: string) =>
    productRepository.removeVariant(masterProductId, variantId, sellerId),
  create: productRepository.create,
  update: productRepository.update,
  remove: productRepository.remove
};
