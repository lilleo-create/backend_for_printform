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
  create: productRepository.create,
  update: productRepository.update,
  remove: productRepository.remove
};
