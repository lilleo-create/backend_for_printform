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
          authorId: 'buyer-2',
          authorType: 'BUYER',
          text: 'User reply',
          moderationStatus: 'APPROVED',
          createdAt: new Date('2026-03-25T11:00:00.000Z'),
          updatedAt: new Date('2026-03-25T11:00:00.000Z'),
          author: { id: 'buyer-2', name: 'ReplyNick', sellerProfile: null }
        },
        {
          id: 'reply-2',
          reviewId: 'review-1',
          authorId: 'seller-1',
          authorType: 'SELLER',
          text: 'Seller reply',
          moderationStatus: 'APPROVED',
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
    assert.equal(reviews[0].replies[0].moderationStatus, 'APPROVED');
  } finally {
    (prisma.review.findMany as any) = originalReviewFindMany;
  }
});

test('listByProducts prepends own pending review and hides pending review of others', async () => {
  const originalReviewFindFirst = prisma.review.findFirst;
  const originalReviewFindMany = prisma.review.findMany;
  const originalReviewReactionFindMany = prisma.reviewReaction.findMany;

  (prisma.review.findFirst as any) = async () => ({
    id: 'pending-own',
    productId: 'product-1',
    userId: 'buyer-1',
    rating: 5,
    pros: 'Pending pros',
    cons: 'Pending cons',
    comment: 'Pending comment',
    photos: [],
    likesCount: 0,
    dislikesCount: 0,
    isPublic: true,
    status: 'PENDING',
    moderationStatus: 'PENDING',
    createdAt: new Date('2026-03-26T10:00:00.000Z'),
    updatedAt: new Date('2026-03-26T10:00:00.000Z'),
    user: { id: 'buyer-1', name: 'BuyerNick' },
    replies: []
  });
  (prisma.review.findMany as any) = async () => [
    {
      id: 'approved-1',
      productId: 'product-1',
      userId: 'buyer-2',
      rating: 4,
      pros: 'Approved pros',
      cons: 'Approved cons',
      comment: 'Approved comment',
      photos: [],
      likesCount: 1,
      dislikesCount: 0,
      isPublic: true,
      status: 'APPROVED',
      moderationStatus: 'APPROVED',
      createdAt: new Date('2026-03-25T10:00:00.000Z'),
      updatedAt: new Date('2026-03-25T10:00:00.000Z'),
      user: { id: 'buyer-2', name: 'OtherUser' },
      replies: []
    }
  ];
  (prisma.reviewReaction.findMany as any) = async () => [];

  try {
    const reviews = await reviewService.listByProducts(['product-1'], 1, 5, 'new', { currentUserId: 'buyer-1' });
    assert.equal(reviews.length, 2);
    assert.equal(reviews[0].id, 'pending-own');
    assert.equal(reviews[0].moderationStatus, 'PENDING');
    assert.equal(reviews[0].isOwn, true);
    assert.equal(reviews[1].id, 'approved-1');
  } finally {
    (prisma.review.findFirst as any) = originalReviewFindFirst;
    (prisma.review.findMany as any) = originalReviewFindMany;
    (prisma.reviewReaction.findMany as any) = originalReviewReactionFindMany;
  }
});

test('countByProducts includes own pending reviews for author', async () => {
  const originalReviewCount = prisma.review.count;
  const calls: any[] = [];
  (prisma.review.count as any) = async ({ where }: any) => {
    calls.push(where);
    return calls.length === 1 ? 7 : 1;
  };

  try {
    const total = await reviewService.countByProducts(['product-1'], { currentUserId: 'buyer-1' });
    assert.equal(total, 8);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].userId, 'buyer-1');
    assert.equal(calls[1].moderationStatus, 'PENDING');
  } finally {
    (prisma.review.count as any) = originalReviewCount;
  }
});
