import { ChatThreadStatus, KycStatus, ReviewModerationStatus } from '@prisma/client';

const kycStatusLabelRuMap: Record<KycStatus, string> = {
  PENDING: 'На проверке',
  APPROVED: 'Одобрено',
  REJECTED: 'Отклонено',
  REVISION: 'Нужны исправления'
};

const reviewModerationStatusLabelRuMap: Record<ReviewModerationStatus, string> = {
  PENDING: 'На модерации',
  APPROVED: 'Опубликован',
  REJECTED: 'Отклонён',
  NEEDS_EDIT: 'Нужны исправления'
};

const chatThreadStatusLabelRuMap: Record<ChatThreadStatus, string> = {
  ACTIVE: 'Открыт',
  CLOSED: 'Закрыт'
};

export const getKycStatusLabelRu = (status: KycStatus): string => kycStatusLabelRuMap[status] ?? status;

export const getReviewModerationStatusLabelRu = (status: ReviewModerationStatus): string =>
  reviewModerationStatusLabelRuMap[status] ?? status;

export const getChatThreadStatusLabelRu = (status: ChatThreadStatus): string =>
  chatThreadStatusLabelRuMap[status] ?? status;
