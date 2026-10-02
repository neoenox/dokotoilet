import type { ToiletFacility } from "../types";
import {
  loadPendingReviews,
  loadPendingVotes,
  pendingQueueAction,
  removePendingReview,
  removePendingVote,
  type PendingReview,
  type PendingVote,
} from "./localDeltas";
import { classifyReviewResponse, isToiletFacilityLike } from "./uiState";
import { setHelpfulCount } from "./helpfulVote";
import { overlayExternalReviews } from "./externalReviews";

/**
 * D: 未同期キューの再送（起動1回 + online復帰時）。
 *
 * README「未同期キュー（D）」との整合（pendingQueueAction が唯一の判定）:
 * - 成功（2xx）: サーバー応答を状態へ反映し、キューから外す
 * - サーバー応答ありの確定拒否（4xx: 400 バリデーション・404 未発見（モデレーション
 *   済みレビューへの投票含む）・409 重複・429 レート制限など）:
 *   キューから破棄する（再送しても結果が変わらないため。README: 「サーバー応答ありの
 *   拒否は再送しない」）。投稿はローカル表示にも残さない（サーバーが正）。
 * - 5xx: サーバー側の一時的問題の可能性があるためキューに保持し、次回の起動時・
 *   online復帰時に再送する
 * - ネットワーク断（fetch 自体の失敗）: keep と同様に次回へ持ち越し
 */
export interface PendingFlushResult {
  /** キューに残った（再試行される）口コミ・投票の件数 */
  keptReviews: number;
  keptVotes: number;
  /** 破棄された（再送しない）口コミ・投票の件数 */
  discardedReviews: number;
  discardedVotes: number;
}

export interface PendingFlushHandlers {
  /** サーバー応答（確定値）の状態反映。2xx 応答時に呼ばれる。 */
  applyToilet(toilet: ToiletFacility): void;
  /** 現在の状態スナップショット（外部施設レビューのオーバーレイ先の取得に使用） */
  getToilets(): ToiletFacility[];
  /** Remove the local optimistic copy when the server definitively rejects it. */
  removePendingReviewFromState?(facilityId: string, reviewId: string): void;
}

/** 2xxでもHTML本文ならAPI未達の可能性（PWAシェル/SPAフォールバック）。キュー保持の対象。 */
function isHtmlResponse(res: Response, body: string): boolean {
  const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
  return (
    contentType.includes("text/html") ||
    /^\s*(<!doctype\s+html|<html[\s>])/i.test(body)
  );
}

async function flushOneReview(
  p: PendingReview,
  handlers: PendingFlushHandlers,
  result: PendingFlushResult
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(
      `/api/community/toilets/${encodeURIComponent(p.facilityId)}/reviews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review: p.review }),
      }
    );
  } catch {
    /* まだオフライン: 次回に持ち越し */
    return;
  }
  const action = pendingQueueAction(res);
  if (action === "keep") return;
  if (action === "discard") {
    if (res.status === 409) {
      // A lost 2xx response followed by a retry is reported as a duplicate.
      // Reconcile with the server snapshot so we remove the optimistic ID but
      // keep the review that the server accepted under its own ID.
      try {
        const snapshotRes = await fetch("/api/community/toilets");
        if (!snapshotRes.ok) return;
        const snapshot = await snapshotRes.json();
        const communityToilet = Array.isArray(snapshot?.toilets)
          ? snapshot.toilets.find(
              (item: unknown) =>
                isToiletFacilityLike(item) && item.id === p.facilityId
            ) as ToiletFacility | undefined
          : undefined;
        if (communityToilet) {
          handlers.removePendingReviewFromState?.(p.facilityId, p.review.id);
          handlers.applyToilet(communityToilet);
          result.discardedReviews += 1;
          removePendingReview(p.review.id);
          return;
        }
        const sharedReviews = snapshot?.externalReviews?.[p.facilityId];
        const target = handlers.getToilets().find((t) => t.id === p.facilityId);
        if (!Array.isArray(sharedReviews) || !target) return;
        handlers.removePendingReviewFromState?.(p.facilityId, p.review.id);
        const withoutPending = {
          ...target,
          reviews: target.reviews.filter((review) => review.id !== p.review.id),
        };
        handlers.applyToilet(overlayExternalReviews(withoutPending, sharedReviews));
      } catch {
        // Keep the queue if reconciliation failed; retry after connectivity returns.
        return;
      }
    } else {
      handlers.removePendingReviewFromState?.(p.facilityId, p.review.id);
    }
    result.discardedReviews += 1;
    removePendingReview(p.review.id);
    return;
  }
  // action === "sync"（2xx）
  try {
    const outcome = await classifyReviewResponse(res, p.facilityId);
    if (outcome.kind === "local") {
      // HTML 2xx（PWAシェル/未知APIパスのSPAフォールバック）: リクエストがAPIに
      // 届いていない可能性が高い。破棄するとオフライン投稿を失うため、
      // キューに保持して次回へ持ち越す。
      return;
    }
    if (outcome.kind === "server-toilet") {
      handlers.applyToilet(outcome.toilet);
    } else if (outcome.kind === "server-external") {
      const target = handlers
        .getToilets()
        .find((t) => t.id === p.facilityId);
      if (target) {
        handlers.applyToilet(overlayExternalReviews(target, outcome.reviews));
      }
    }
    // 2xxでも応答本文が不正（invalid）な場合は状態反映しないが、
    // サーバー受理済みの可能性が高いためキューからは外す。
  } catch {
    /* 応答分類に失敗してもキューからは外す */
  }
  removePendingReview(p.review.id);
}

async function flushOneVote(
  v: PendingVote,
  handlers: PendingFlushHandlers,
  result: PendingFlushResult
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(
      `/api/community/reviews/${encodeURIComponent(v.reviewId)}/helpful`,
      { method: "POST" }
    );
  } catch {
    /* まだオフライン: 次回に持ち越し */
    return;
  }
  const action = pendingQueueAction(res);
  if (action === "keep") return;
  if (action === "discard") {
    // モデレーションで削除済みのレビュー（404）・重複投票など。再送しない。
    // 楽観表示は次回のサーバー同期（起動時GET・投稿応答）でサーバー値が正として上書きされる。
    result.discardedVotes += 1;
    removePendingVote(v.reviewId);
    return;
  }
  // action === "sync"（2xx）: サーバー確定値で同期
  try {
    const body = await res.text();
    if (isHtmlResponse(res, body)) {
      // HTML 2xx（PWAシェル/未知APIパスのSPAフォールバック）: リクエストがAPIに
      // 届いていない可能性が高い。破棄せず次回へ持ち越す。
      return;
    }
    let data: { helpfulCount?: unknown } | null = null;
    if (body.trim()) {
      try {
        data = JSON.parse(body) as { helpfulCount?: unknown };
      } catch {
        data = null;
      }
    }
    if (data && typeof data.helpfulCount === "number") {
      const target = handlers.getToilets().find((t) => t.id === v.toiletId);
      if (target) {
        handlers.applyToilet(
          setHelpfulCount(target, v.toiletId, v.reviewId, data.helpfulCount)
        );
      }
    }
  } catch {
    /* 応答処理に失敗してもキューからは外す */
  }
  removePendingVote(v.reviewId);
}

/**
 * キュー全体の再送。レビュー→投票の順で処理する。
 * 途中でネットワーク断になっても、それまでに確定したキュー操作は保存済み。
 */
export async function flushPendingQueue(
  handlers: PendingFlushHandlers
): Promise<PendingFlushResult> {
  const result: PendingFlushResult = {
    keptReviews: 0,
    keptVotes: 0,
    discardedReviews: 0,
    discardedVotes: 0,
  };
  for (const p of loadPendingReviews()) {
    await flushOneReview(p, handlers, result);
  }
  for (const v of loadPendingVotes()) {
    await flushOneVote(v, handlers, result);
  }
  // 「キューに残った（再試行される）件数」は処理後の実測値を返す
  //（初期キュー長だと sync/discard 済みの分も含まれてしまう）。
  result.keptReviews = loadPendingReviews().length;
  result.keptVotes = loadPendingVotes().length;
  return result;
}
