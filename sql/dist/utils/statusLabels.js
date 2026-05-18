"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getChatThreadStatusLabelRu = exports.getReviewModerationStatusLabelRu = exports.getKycStatusLabelRu = void 0;
const kycStatusLabelRuMap = {
    PENDING: 'На проверке',
    APPROVED: 'Одобрено',
    REJECTED: 'Отклонено',
    REVISION: 'Нужны исправления'
};
const reviewModerationStatusLabelRuMap = {
    PENDING: 'На модерации',
    APPROVED: 'Опубликован',
    REJECTED: 'Отклонён',
    NEEDS_EDIT: 'Нужны исправления'
};
const chatThreadStatusLabelRuMap = {
    ACTIVE: 'Открыт',
    CLOSED: 'Закрыт'
};
const getKycStatusLabelRu = (status) => kycStatusLabelRuMap[status] ?? status;
exports.getKycStatusLabelRu = getKycStatusLabelRu;
const getReviewModerationStatusLabelRu = (status) => reviewModerationStatusLabelRuMap[status] ?? status;
exports.getReviewModerationStatusLabelRu = getReviewModerationStatusLabelRu;
const getChatThreadStatusLabelRu = (status) => chatThreadStatusLabelRuMap[status] ?? status;
exports.getChatThreadStatusLabelRu = getChatThreadStatusLabelRu;
