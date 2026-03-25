import test from 'node:test';
import assert from 'node:assert/strict';

import { reviewService } from './reviewService';
import { prisma } from '../lib/prisma';

test('listByProducts returns nickname/storeName contract for review and replies', async () => {
  const originalReviewFindMany = prisma.review.findMany;

  (prisma.review.findMany as any) = async () => [
    {
      id: 'review-1',
      productId: 'product-1',
      rating: 5,
      pros: 'Fast',
      cons: 'None',
      comment: 'Great',
      photos: [],
      likesCount: 1,
      dislikesCount: 0,
      isPublic: true,
      status: 'PUBLISHED',
      moderationStatus: 'APPROVED',
      createdAt: new Date('2026-03-25T10:00:00.000Z'),
      updatedAt: new Date('2026-03-25T10:00:00.000Z'),
      user: { id: 'buyer-1', name: 'BuyerNick' },
      replies: [
        {
          id: 'reply-1',
          reviewId: 'review-1',
          authorType: 'BUYER',
          text: 'User reply',
          createdAt: new Date('2026-03-25T11:00:00.000Z'),
          updatedAt: new Date('2026-03-25T11:00:00.000Z'),
          author: { id: 'buyer-2', name: 'ReplyNick', sellerProfile: null }
        },
        {
          id: 'reply-2',
          reviewId: 'review-1',
          authorType: 'SELLER',
          text: 'Seller reply',
          createdAt: new Date('2026-03-25T12:00:00.000Z'),
          updatedAt: new Date('2026-03-25T12:00:00.000Z'),
          author: { id: 'seller-1', name: 'Seller User', sellerProfile: { storeName: 'StoreName' } }
        }
      ]
    }
  ];

  try {
    const reviews = await reviewService.listByProducts(['product-1']);
    assert.equal(reviews[0].user?.nickname, 'BuyerNick');
    assert.equal(reviews[0].replies[0].author.nickname, 'ReplyNick');
    assert.equal(reviews[0].replies[0].author.storeName, null);
    assert.equal(reviews[0].replies[1].author.nickname, 'Seller User');
    assert.equal(reviews[0].replies[1].author.storeName, 'StoreName');
  } finally {
    (prisma.review.findMany as any) = originalReviewFindMany;
  }
});
