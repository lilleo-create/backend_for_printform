import { customRequestRepository } from '../repositories/customRequestRepository';

export const customRequestUseCases = {
  create: customRequestRepository.create
};
