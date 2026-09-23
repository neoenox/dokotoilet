// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import {
  PENDING_REVIEWS_KEY,
  PENDING_VOTES_KEY,
  enqueuePendingReview,
  enqueuePendingVote,
  loadPendingReviews,
  loadPendingVotes,
  pendingQueueAction,
  removePendingReview,
  removePendingVote,
  clearStoredUserData,
} from './localDeltas';
import type { ToiletReview } from '../types';

const review = (id: string): ToiletReview => ({
  id,
  userName: 't',
  rating: 5,
  cleanlinessScore: 5,
  odorScore: 5,
  suppliesScore: 5,
  comment: 'clean',
  createdAt: new Date().toISOString(),
  helpfulCount: 0,
});

beforeEach(() => {
  localStorage.clear();
});

describe('pending queue (D)', () => {
  it('enqueues and loads pending reviews', () => {
    enqueuePendingReview({ facilityId: 'osm-1', review: review('r1'), queuedAt: 'x' });
    const loaded = loadPendingReviews();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.facilityId).toBe('osm-1');
  });

  it('dedupes by review id', () => {
    enqueuePendingReview({ facilityId: 'osm-1', review: review('r1'), queuedAt: 'x' });
    enqueuePendingReview({ facilityId: 'osm-1', review: review('r1'), queuedAt: 'y' });
    expect(loadPendingReviews()).toHaveLength(1);
  });

  it('removes flushed review', () => {
    enqueuePendingReview({ facilityId: 'osm-1', review: review('r1'), queuedAt: 'x' });
    removePendingReview('r1');
    expect(loadPendingReviews()).toHaveLength(0);
  });

  it('enqueues/dedupes/removes votes', () => {
    enqueuePendingVote({ toiletId: 't1', reviewId: 'r9', queuedAt: 'x' });
    enqueuePendingVote({ toiletId: 't1', reviewId: 'r9', queuedAt: 'y' });
    expect(loadPendingVotes()).toHaveLength(1);
    removePendingVote('r9');
    expect(loadPendingVotes()).toHaveLength(0);
  });

  it('clearStoredUserData drops queues', () => {
    enqueuePendingReview({ facilityId: 'osm-1', review: review('r1'), queuedAt: 'x' });
    enqueuePendingVote({ toiletId: 't1', reviewId: 'r9', queuedAt: 'x' });
    clearStoredUserData();
    expect(localStorage.getItem(PENDING_REVIEWS_KEY)).toBeNull();
    expect(localStorage.getItem(PENDING_VOTES_KEY)).toBeNull();
  });

  it('ignores corrupt payloads', () => {
    localStorage.setItem(PENDING_REVIEWS_KEY, 'not-json');
    localStorage.setItem(PENDING_VOTES_KEY, JSON.stringify([{ nope: 1 }]));
    expect(loadPendingReviews()).toEqual([]);
    expect(loadPendingVotes()).toEqual([]);
  });
});

describe('pendingQueueAction (README「未同期キュー（D）」の処置判定)', () => {
  it('2xx は sync（応答を反映してキューから外す）', () => {
    expect(pendingQueueAction({ ok: true, status: 200 })).toBe('sync');
    expect(pendingQueueAction({ ok: true, status: 201 })).toBe('sync');
  });

  it('4xx 確定拒否（400/404/409）は discard（再送しない・429を除く）', () => {
    expect(pendingQueueAction({ ok: false, status: 400 })).toBe('discard');
    expect(pendingQueueAction({ ok: false, status: 404 })).toBe('discard');
    expect(pendingQueueAction({ ok: false, status: 409 })).toBe('discard');
  });

  it('429（レート制限）は keep（制限解除後の再送で成功しうる）', () => {
    expect(pendingQueueAction({ ok: false, status: 429 })).toBe('keep');
  });

  it('5xx は keep（次回へ持ち越し）', () => {
    expect(pendingQueueAction({ ok: false, status: 500 })).toBe('keep');
    expect(pendingQueueAction({ ok: false, status: 502 })).toBe('keep');
    expect(pendingQueueAction({ ok: false, status: 503 })).toBe('keep');
  });

  it('status 不明は安全側で keep（破棄は確定応答のみ）', () => {
    expect(pendingQueueAction({ ok: false })).toBe('keep');
  });
});
