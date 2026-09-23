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
} from './localDeltas';
import { flushPendingQueue } from './pendingFlush';
import type { ToiletFacility, ToiletReview } from '../types';

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

const toilet = (id: string): ToiletFacility => ({
  id,
  name: `トイレ ${id}`,
  facilityType: '公衆トイレ',
  category: 'park',
  dataSource: 'community',
  lat: 35,
  lng: 139,
  address: 'test',
  openingHours: '',
  description: '',
  cleanlinessGrade: null,
  cleanlinessScore: null,
  equipmentGrade: null,
  equipmentScore: null,
  subScores: { cleanliness: null, odor: null, supplies: null, comfort: null },
  attributes: {
    hasWashlet: null,
    hasMultipurpose: null,
    hasBabyTable: null,
    hasNursingRoom: null,
    hasPowderRoom: null,
    hasOstomate: null,
    isFree: null,
    isOpen24h: null,
    hasSoap: null,
    hasAlcohol: null,
    hasPaperTowelOrDryer: null,
    toiletStyle: null,
  },
  reviewCount: 0,
  reviews: [],
});

/** fetch モック: path → Response を返す。未登録は throw（ネットワーク断相当）。 */
function mockFetch(routes: (url: string) => Response | undefined) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const res = routes(url);
    if (!res) throw new TypeError('network down');
    return res;
  }) as typeof fetch;
  return calls;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(() => {
  localStorage.clear();
});

describe('pendingQueueAction (README「未同期キュー（D）」の判定)', () => {
  it('2xx は sync', () => {
    expect(pendingQueueAction({ ok: true, status: 200 })).toBe('sync');
    expect(pendingQueueAction({ ok: true, status: 201 })).toBe('sync');
  });

  it('4xx 確定拒否（400/404/409/429）は discard', () => {
    expect(pendingQueueAction({ ok: false, status: 400 })).toBe('discard');
    expect(pendingQueueAction({ ok: false, status: 404 })).toBe('discard');
    expect(pendingQueueAction({ ok: false, status: 409 })).toBe('discard');
    expect(pendingQueueAction({ ok: false, status: 429 })).toBe('discard');
  });

  it('5xx は keep（再送）', () => {
    expect(pendingQueueAction({ ok: false, status: 500 })).toBe('keep');
    expect(pendingQueueAction({ ok: false, status: 502 })).toBe('keep');
    expect(pendingQueueAction({ ok: false, status: 503 })).toBe('keep');
  });

  it('status 不明は安全側で keep', () => {
    expect(pendingQueueAction({ ok: false })).toBe('keep');
  });
});

describe('flushPendingQueue (4xx破棄・5xx保持)', () => {
  it('400 確定拒否の未同期レビューをキューから破棄する', async () => {
    enqueuePendingReview({ facilityId: 'osm-node-1', review: review('r1'), queuedAt: 'x' });
    const calls = mockFetch((url) =>
      url.includes('/reviews') ? jsonResponse(400, { error: 'invalid comment' }) : undefined
    );

    const applied: ToiletFacility[] = [];
    const result = await flushPendingQueue({
      applyToilet: (t) => applied.push(t),
      getToilets: () => [],
    });

    expect(calls).toHaveLength(1);
    expect(loadPendingReviews()).toHaveLength(0);
    expect(result.discardedReviews).toBe(1);
    expect(applied).toHaveLength(0);
  });

  it('409 重複拒否の未同期レビューも破棄する', async () => {
    enqueuePendingReview({ facilityId: 'osm-node-1', review: review('r1'), queuedAt: 'x' });
    mockFetch((url) =>
      url.includes('/reviews') ? jsonResponse(409, { error: 'duplicate review' }) : undefined
    );

    const result = await flushPendingQueue({ applyToilet: () => {}, getToilets: () => [] });
    expect(loadPendingReviews()).toHaveLength(0);
    expect(result.discardedReviews).toBe(1);
  });

  it('404（モデレーション済みレビューへの投票）の投票をキューから破棄する', async () => {
    enqueuePendingVote({ toiletId: 't1', reviewId: 'gone', queuedAt: 'x' });
    mockFetch((url) =>
      url.includes('/helpful') ? jsonResponse(404, { error: 'review not found' }) : undefined
    );

    const result = await flushPendingQueue({ applyToilet: () => {}, getToilets: () => [] });
    expect(loadPendingVotes()).toHaveLength(0);
    expect(result.discardedVotes).toBe(1);
  });

  it('5xx はキューに保持して次回へ持ち越す', async () => {
    enqueuePendingReview({ facilityId: 'osm-node-1', review: review('r1'), queuedAt: 'x' });
    enqueuePendingVote({ toiletId: 't1', reviewId: 'r9', queuedAt: 'x' });
    mockFetch(() => jsonResponse(502, { error: 'upstream unavailable' }));

    const result = await flushPendingQueue({ applyToilet: () => {}, getToilets: () => [] });

    expect(loadPendingReviews()).toHaveLength(1);
    expect(loadPendingVotes()).toHaveLength(1);
    expect(result.keptReviews).toBe(1);
    expect(result.keptVotes).toBe(1);
  });

  it('ネットワーク断（fetch失敗）もキューに保持する', async () => {
    enqueuePendingReview({ facilityId: 'osm-node-1', review: review('r1'), queuedAt: 'x' });
    mockFetch(() => undefined);

    await flushPendingQueue({ applyToilet: () => {}, getToilets: () => [] });
    expect(loadPendingReviews()).toHaveLength(1);
  });

  it('2xx のレビューはサーバー応答を反映してキューから外す', async () => {
    enqueuePendingReview({ facilityId: 'osm-node-1', review: review('r1'), queuedAt: 'x' });
    mockFetch((url) =>
      url.includes('/reviews')
        ? jsonResponse(201, { facilityId: 'osm-node-1', reviews: [review('srv1')] })
        : undefined
    );

    const applied: ToiletFacility[] = [];
    const state = [toilet('osm-node-1')];
    const result = await flushPendingQueue({
      applyToilet: (t) => {
        applied.push(t);
        state[0] = t;
      },
      getToilets: () => state,
    });

    expect(loadPendingReviews()).toHaveLength(0);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.reviews.map((r) => r.id)).toContain('srv1');
    expect(result.discardedReviews).toBe(0);
  });

  it('2xx の投票はサーバー確定値で同期してキューから外す', async () => {
    enqueuePendingVote({ toiletId: 't1', reviewId: 'r9', queuedAt: 'x' });
    mockFetch((url) =>
      url.includes('/helpful') ? jsonResponse(200, { helpfulCount: 7, voted: true }) : undefined
    );

    const applied: ToiletFacility[] = [];
    const base = toilet('t1');
    base.reviews = [{ ...review('r9'), helpfulCount: 6 }];
    const state = [base];
    await flushPendingQueue({
      applyToilet: (t) => {
        applied.push(t);
        state[0] = t;
      },
      getToilets: () => state,
    });

    expect(loadPendingVotes()).toHaveLength(0);
    expect(applied[0]?.reviews[0]?.helpfulCount).toBe(7);
  });

  it('混在ケース: 400破棄・5xx保持・2xx反映が同時に正しく処理される', async () => {
    enqueuePendingReview({ facilityId: 'osm-node-1', review: review('r-bad'), queuedAt: 'x' });
    enqueuePendingReview({ facilityId: 'osm-node-2', review: review('r-server'), queuedAt: 'x' });
    enqueuePendingVote({ toiletId: 't1', reviewId: 'r-gone', queuedAt: 'x' });
    mockFetch((url) => {
      if (url.includes('osm-node-1')) return jsonResponse(400, { error: 'invalid comment' });
      if (url.includes('osm-node-2'))
        return jsonResponse(201, { facilityId: 'osm-node-2', reviews: [review('srv2')] });
      if (url.includes('/helpful')) return jsonResponse(404, { error: 'review not found' });
      return undefined;
    });

    const state: ToiletFacility[] = [toilet('osm-node-2')];
    const result = await flushPendingQueue({
      applyToilet: (t) => {
        const i = state.findIndex((s) => s.id === t.id);
        if (i >= 0) state[i] = t;
        else state.push(t);
      },
      getToilets: () => state,
    });

    // 破棄されたものは消え、保持すべきものは残らない（このケースでは全処理済み）
    expect(loadPendingReviews()).toHaveLength(0);
    expect(loadPendingVotes()).toHaveLength(0);
    expect(result.discardedReviews).toBe(1);
    expect(result.discardedVotes).toBe(1);
    // 2xx 分は状態へ反映済み
    expect(state[0]?.reviews.map((r) => r.id)).toContain('srv2');
  });

  it('2xx でもHTML応答（PWAシェル/SPAフォールバック）の口コミはキューに保持する', async () => {
    enqueuePendingReview({ facilityId: 'osm-node-1', review: review('r1'), queuedAt: 'x' });
    mockFetch((url) =>
      url.includes('/reviews')
        ? new Response('<!DOCTYPE html><html><body>app shell</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
        : undefined
    );

    const applied: ToiletFacility[] = [];
    const result = await flushPendingQueue({
      applyToilet: (t) => applied.push(t),
      getToilets: () => [],
    });

    // API未達の可能性があるため破棄してはならない（オフライン投稿のデータ保護）
    expect(loadPendingReviews()).toHaveLength(1);
    expect(result.keptReviews).toBe(1);
    expect(applied).toHaveLength(0);
  });

  it('2xx でもHTML応答の投票はキューに保持する', async () => {
    enqueuePendingVote({ toiletId: 't1', reviewId: 'r9', queuedAt: 'x' });
    mockFetch(() =>
      new Response('<html><body>shell</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );

    const result = await flushPendingQueue({ applyToilet: () => {}, getToilets: () => [] });
    expect(loadPendingVotes()).toHaveLength(1);
    expect(result.keptVotes).toBe(1);
  });

  it('kept* は処理後の残キュー実測値を返す（sync/discard分を含まない）', async () => {
    enqueuePendingReview({ facilityId: 'osm-node-1', review: review('r1'), queuedAt: 'x' });
    enqueuePendingReview({ facilityId: 'osm-node-2', review: review('r2'), queuedAt: 'x' });
    mockFetch((url) => {
      if (url.includes('osm-node-1')) return jsonResponse(201, { facilityId: 'osm-node-1', reviews: [review('srv1')] });
      return jsonResponse(400, { error: 'invalid' });
    });

    const result = await flushPendingQueue({ applyToilet: () => {}, getToilets: () => [] });

    expect(result.discardedReviews).toBe(1);
    expect(result.keptReviews).toBe(0);
    expect(loadPendingReviews()).toHaveLength(0);
  });

  it('空のキューでは fetch を呼ばない', async () => {
    const calls = mockFetch(() => jsonResponse(200, {}));
    await flushPendingQueue({ applyToilet: () => {}, getToilets: () => [] });
    expect(calls).toHaveLength(0);
  });

  it('localStorage 永続キーは従来どおり使用される', () => {
    enqueuePendingReview({ facilityId: 'osm-node-1', review: review('r1'), queuedAt: 'x' });
    enqueuePendingVote({ toiletId: 't1', reviewId: 'r9', queuedAt: 'x' });
    expect(localStorage.getItem(PENDING_REVIEWS_KEY)).not.toBeNull();
    expect(localStorage.getItem(PENDING_VOTES_KEY)).not.toBeNull();
    expect(loadPendingReviews()[0]?.review.id).toBe('r1');
    expect(loadPendingVotes()[0]?.reviewId).toBe('r9');
  });
});
