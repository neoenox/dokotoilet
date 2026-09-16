// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from 'vitest';
import {
  PENDING_REVIEWS_KEY,
  PENDING_VOTES_KEY,
  enqueuePendingReview,
  enqueuePendingVote,
  loadPendingReviews,
  loadPendingVotes,
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
