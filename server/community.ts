import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import rateLimit from "express-rate-limit";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  ToiletFacility,
  ToiletReview,
  TriState,
} from "../src/types";
import { gradeForScore, summarizeReviews } from "../src/lib/scoring";
import { atomicWriteFile, withFileLock } from "./shared/persistence";
import { normalizeDedupText, normalizeReportReason } from "./shared/dedup";
import { sanitizeText } from "../src/lib/textPolicy";
import {
  TEXT_FIELDS,
  validateFallbackText,
  validateOptionalText,
  validateRequiredText,
} from "../src/lib/textPolicy";
import type {
  AddReviewResult,
  CommunityRepository,
  ExternalFacilityObservation,
} from "./communityRepository";
import {
  canonicalizeExternalFacilityId,
  isExternalFacilityIdFormat,
} from "./externalFacilityRegistry";

const CATEGORIES = [
  "department",
  "station",
  "convenience",
  "park",
  "hotel",
  "cafe",
] as const;

const TOILET_ID_RE = /^toilet-user-[A-Za-z0-9-]{1,64}$/;

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function isInt1to5(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 5;
}

function isShortString(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max;
}

/** 外部施設ID形式の判定は shared モジュールに一本化（二重管理の廃止）。 */
export function isExternalFacilityId(id: string): boolean {
  return isExternalFacilityIdFormat(id);
}

export interface ToiletInput {
  id: string;
  name: string;
  category: (typeof CATEGORIES)[number];
  address: string;
  floorInfo?: string;
  /** Legacy field accepted for wire compatibility but never used for registration metadata. */
  cleanlinessScore?: number;
  description: string;
  lat: number;
  lng: number;
  attributes: {
    hasWashlet: TriState;
    hasMultipurpose: TriState;
    hasBabyTable: TriState;
    hasPowderRoom: TriState;
    isOpen24h: TriState;
  };
}

export function validateToiletInput(body: any): ValidationResult<ToiletInput> {
  if (!body || typeof body !== "object")
    return { ok: false, error: "invalid body" };
  if (typeof body.id !== "string" || !TOILET_ID_RE.test(body.id))
    return { ok: false, error: "invalid id" };
  if (!CATEGORIES.includes(body.category))
    return { ok: false, error: "invalid category" };
  if (typeof body.lat !== "number" || body.lat < -90 || body.lat > 90)
    return { ok: false, error: "invalid lat" };
  if (typeof body.lng !== "number" || body.lng < -180 || body.lng > 180)
    return { ok: false, error: "invalid lng" };
  if (
    body.cleanlinessScore !== undefined &&
    (typeof body.cleanlinessScore !== "number" ||
      body.cleanlinessScore < 1 ||
      body.cleanlinessScore > 5)
  )
    return { ok: false, error: "invalid cleanlinessScore" };

  // テキスト欄は textPolicy の宣言的ポリシーで一括処理する。
  // パイプライン（生入力の型/長さゲート → サニタイズ → 可視性 → URL検出）と
  // 不可視のみの扱い（name は拒否、address/floorInfo/description は既定値へ
  // フォールバック）は TEXT_FIELDS が宣言する。
  const nameField = validateRequiredText(body.name, TEXT_FIELDS.toiletName);
  if (nameField.ok === false) return nameField;
  const addressField = validateFallbackText(body.address, TEXT_FIELDS.toiletAddress);
  if (addressField.ok === false) return addressField;
  const floorInfoField = validateOptionalText(body.floorInfo, TEXT_FIELDS.toiletFloorInfo);
  if (floorInfoField.ok === false) return floorInfoField;
  const descriptionField = validateFallbackText(body.description, TEXT_FIELDS.toiletDescription);
  if (descriptionField.ok === false) return descriptionField;

  const a = body.attributes;
  if (a !== undefined && (a === null || typeof a !== "object" || Array.isArray(a)))
    return { ok: false, error: "invalid attributes" };
  for (const k of [
    "hasWashlet",
    "hasMultipurpose",
    "hasBabyTable",
    "hasPowderRoom",
    "isOpen24h",
  ] as const) {
    if (
      a !== undefined &&
      a[k] !== undefined &&
      a[k] !== null &&
      typeof a[k] !== "boolean"
    )
      return { ok: false, error: `invalid attributes.${k}` };
  }

  return {
    ok: true,
    value: {
      id: body.id,
      name: nameField.value,
      category: body.category,
      address: addressField.value,
      floorInfo: floorInfoField.value,
      description: descriptionField.value,
      lat: body.lat,
      lng: body.lng,
      attributes: {
        hasWashlet: a?.hasWashlet ?? null,
        hasMultipurpose: a?.hasMultipurpose ?? null,
        hasBabyTable: a?.hasBabyTable ?? null,
        hasPowderRoom: a?.hasPowderRoom ?? null,
        isOpen24h: a?.isOpen24h ?? null,
      },
    },
  };
}

export interface ReviewInput {
  userName: string;
  overallScore: number;
  cleanlinessScore: number;
  odorScore: number;
  suppliesScore: number;
  comment: string;
}

export function validateReviewInput(body: any): ValidationResult<ReviewInput> {
  if (!body || typeof body !== "object")
    return { ok: false, error: "invalid body" };
  const r = body.review ?? body;
  if (r.rating !== undefined && !isInt1to5(r.rating))
    return { ok: false, error: "invalid rating" };
  if (r.overallScore !== undefined && !isInt1to5(r.overallScore))
    return { ok: false, error: "invalid overallScore" };
  const overall = r.overallScore ?? r.rating;
  if (!isInt1to5(overall))
    return {
      ok: false,
      error: r.rating === undefined ? "invalid overallScore" : "invalid rating",
    };
  if (!isInt1to5(r.cleanlinessScore))
    return { ok: false, error: "invalid cleanlinessScore" };
  if (!isInt1to5(r.odorScore))
    return { ok: false, error: "invalid odorScore" };
  if (!isInt1to5(r.suppliesScore))
    return { ok: false, error: "invalid suppliesScore" };
  // テキスト欄は textPolicy の宣言的ポリシーで一括処理する。
  const commentField = validateRequiredText(r.comment, TEXT_FIELDS.comment);
  if (commentField.ok === false) return commentField;
  const userNameField = validateFallbackText(r.userName, TEXT_FIELDS.userName);
  if (userNameField.ok === false) return userNameField;

  return {
    ok: true,
    value: {
      userName: userNameField.value,
      overallScore: overall,
      cleanlinessScore: r.cleanlinessScore,
      odorScore: r.odorScore,
      suppliesScore: r.suppliesScore,
      comment: commentField.value,
    },
  };
}

export function validateReportInput(
  body: any
): ValidationResult<{ reason: string }> {
  if (!body || typeof body !== "object")
    return { ok: false, error: "invalid body" };
  const reasonField = validateRequiredText(body.reason, TEXT_FIELDS.reason);
  if (reasonField.ok === false) return reasonField;
  return { ok: true, value: { reason: reasonField.value } };
}

export function hashIp(ip: string, salt: string): string {
  return crypto.createHash("sha256").update(`${salt}|${ip}`).digest("hex");
}

export type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => void | Promise<void>;

export function asyncRoute(handler: AsyncRouteHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export type ReportStatus = "open" | "resolved";

export interface StoredReport {
  id: string;
  toiletId: string;
  reviewId: string;
  reason: string;
  createdAt: string;
  /** createdAt のミリ秒比較用（旧データは parse 時に createdAt から補完）。 */
  at?: number;
  status?: ReportStatus;
  resolvedAt?: string;
  resolution?: string;
  adminNote?: string;
}

export interface ListReportsOptions {
  status?: ReportStatus | "all";
  limit?: number;
  offset?: number;
}

export interface ReviewKey {
  ipHash: string;
  at: number;
}

export interface CommunityDB {
  version: 2;
  toilets: ToiletFacility[];
  helpfulVotes: Record<string, string[]>;
  reports: StoredReport[];
  reviewKeys: Record<string, ReviewKey>;
  externalReviews: Record<string, ToiletReview[]>;
}

export function publicToilets(toilets: ToiletFacility[]): ToiletFacility[] {
  return toilets.map((t) => ({
    ...t,
    reviews: (Array.isArray(t.reviews) ? t.reviews : []).flatMap((raw: unknown) => {
      const r = normalizePersistedReview(raw);
      if (!r) return [];
      const { ipHash: _dropped, ...pub } = r as ToiletReview & { ipHash?: unknown };
      return [pub];
    }),
  }));
}

function normalizePersistedReview(raw: unknown): ToiletReview | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id || typeof value.comment !== "string") {
    return null;
  }
  const score = (key: string, fallback: number): number => {
    const n = value[key];
    return typeof n === "number" && Number.isFinite(n) ? n : fallback;
  };
  return {
    ...value,
    id: value.id,
    userName: typeof value.userName === "string" ? value.userName : "匿名",
    rating: score("rating", score("overallScore", 0)),
    overallScore: score("overallScore", score("rating", 0)),
    cleanlinessScore: score("cleanlinessScore", 0),
    odorScore: score("odorScore", 0),
    suppliesScore: score("suppliesScore", 0),
    comment: value.comment,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    helpfulCount: score("helpfulCount", 0),
  } as ToiletReview;
}

const EMPTY_DB: CommunityDB = {
  version: 2,
  toilets: [],
  helpfulVotes: {},
  reports: [],
  reviewKeys: {},
  externalReviews: {},
};

interface MutationResult<T> {
  result: T;
  changed: boolean;
}

// コミュニティ登録トイレ＋外部施設レビューの JSON ファイルストア。
// 書き込みはクロスプロセスのファイルロック下で行い、欠落が出ないようにする。
// 読み取り（GET）はロックを取らず、mtime+size でディスクとの一致を検証したキャッシュを
// 返す。すべての書き込みは atomicWriteFile（rename）で行われるため、内容が変われば
// mtime か size が必ず変わり、キャッシュは自動で無効化される。
// Cloud Run 等の ephemeral FS では再起動で消える。本格運用は Firestore/Postgres
// への差し替えを想定（README参照）。
export class CommunityStore {
  private cache: { data: CommunityDB; mtimeMs: number; size: number } | null = null;

  constructor(private filePath: string) {}

  private parse(raw: string): CommunityDB {
    const parsed = JSON.parse(raw) as CommunityDB;
    if (!Array.isArray(parsed.toilets)) throw new Error("corrupt db");
    const isPlainObject = (v: unknown): v is Record<string, unknown> =>
      !!v && typeof v === "object" && !Array.isArray(v);
    const helpfulVotes: Record<string, string[]> = {};
    if (isPlainObject(parsed.helpfulVotes)) {
      for (const [k, v] of Object.entries(parsed.helpfulVotes)) {
        helpfulVotes[k] = Array.isArray(v)
          ? (v as unknown[]).filter((x): x is string => typeof x === "string")
          : [];
      }
    }
    const reviewKeys: Record<string, ReviewKey> =
      isPlainObject(parsed.reviewKeys)
        ? (parsed.reviewKeys as Record<string, ReviewKey>)
        : {};
    const externalReviews: Record<string, ToiletReview[]> = {};
    if (isPlainObject(parsed.externalReviews)) {
      for (const [k, v] of Object.entries(parsed.externalReviews)) {
        externalReviews[k] = Array.isArray(v) ? (v as ToiletReview[]) : [];
      }
    }
    const reportsRaw: unknown[] = Array.isArray(parsed.reports)
      ? (parsed.reports as unknown[])
      : [];
    const reports: StoredReport[] = [];
    for (const r of reportsRaw) {
      if (!r || typeof r !== "object") continue;
      const rr = r as Partial<StoredReport> & Record<string, unknown>;
      if (typeof rr.id !== "string" || typeof rr.reviewId !== "string") continue;
      const createdAt =
        typeof rr.createdAt === "string" ? rr.createdAt : new Date().toISOString();
      const at =
        typeof rr.at === "number" && Number.isFinite(rr.at)
          ? rr.at
          : Date.parse(createdAt) || Date.now();
      reports.push({
        id: rr.id,
        toiletId: typeof rr.toiletId === "string" ? rr.toiletId : "",
        reviewId: rr.reviewId,
        reason: typeof rr.reason === "string" ? rr.reason : "",
        createdAt,
        at,
        status: rr.status === "resolved" ? "resolved" : "open",
        ...(typeof rr.resolvedAt === "string" ? { resolvedAt: rr.resolvedAt } : {}),
        ...(typeof rr.resolution === "string" ? { resolution: rr.resolution } : {}),
        ...(typeof rr.adminNote === "string" ? { adminNote: rr.adminNote } : {}),
      });
    }
    const toiletsRaw = parsed.toilets as unknown[];
    const toilets = toiletsRaw.filter(
      (t): t is ToiletFacility =>
        !!t &&
        typeof t === "object" &&
        typeof (t as { id?: unknown }).id === "string" &&
        typeof (t as { lat?: unknown }).lat === "number" &&
        Number.isFinite((t as { lat?: number }).lat) &&
        typeof (t as { lng?: unknown }).lng === "number" &&
        Number.isFinite((t as { lng?: number }).lng)
    ).map((t) => ({
      ...t,
      reviews: (Array.isArray(t.reviews) ? t.reviews : []).flatMap((raw) => {
        const normalized = normalizePersistedReview(raw);
        return normalized ? [normalized] : [];
      }),
    })) as ToiletFacility[];
    const dropped =
      toiletsRaw.length -
      toilets.length +
      (reportsRaw.length - reports.length);
    const fallbackUsed =
      !isPlainObject(parsed.helpfulVotes) ||
      !Array.isArray(parsed.reports) ||
      !isPlainObject(parsed.reviewKeys) ||
      !isPlainObject(parsed.externalReviews);
    if (dropped > 0 || fallbackUsed) {
      console.error(`[community] dropped ${dropped} corrupt entries on load`);
    }

    // 読み込み時サニタイズ（自己修復マイグレーション）: #67以前に書かれた行には
    // 制御・書式文字が残っている可能性がある。すべての読み出し経路（GETはキャッシュ
    // 経由でこの parse() を通る）と次回の書き込み（readDisk → atomicWriteFile）が
    // この正規形を通るため、レガシー行は初回読み込みで浄化され、最初の書き込みで
    // ファイル全体が正規形に置き換わる。sanitizeText は冪等で清浄データを変更しない
    // （fuzzテストで保証）ため、2回目以降の読み込みでデータが動くことはない。
    // parse() は id/lat/lng しか検証しないため、文字列以外の値・欠損配列にも耐える。
    let sanitizedCount = 0;
    const sanitizeField = (obj: Record<string, unknown>, key: string): void => {
      const v = obj[key];
      if (typeof v !== "string") return;
      const cleaned = sanitizeText(v);
      if (cleaned !== v) {
        obj[key] = cleaned;
        sanitizedCount++;
      }
    };
    for (const t of toilets as unknown as Record<string, unknown>[]) {
      sanitizeField(t, "name");
      sanitizeField(t, "address");
      sanitizeField(t, "floorInfo");
      sanitizeField(t, "description");
      for (const r of (Array.isArray(t.reviews) ? t.reviews : []) as unknown as Record<string, unknown>[]) {
        if (!r || typeof r !== "object") continue;
        sanitizeField(r, "userName");
        sanitizeField(r, "comment");
      }
    }
    for (const [facilityId, list] of Object.entries(externalReviews)) {
      externalReviews[facilityId] = list.flatMap((raw) => {
        const normalized = normalizePersistedReview(raw);
        return normalized ? [normalized] : [];
      });
    }
    for (const list of Object.values(externalReviews)) {
      for (const r of list as unknown as Record<string, unknown>[]) {
        if (!r || typeof r !== "object") continue;
        sanitizeField(r, "userName");
        sanitizeField(r, "comment");
      }
    }
    for (const report of reports as unknown as Record<string, unknown>[]) {
      sanitizeField(report, "reason");
    }
    if (sanitizedCount > 0) {
      console.error(
        `[community] sanitized ${sanitizedCount} legacy text fields on load`
      );
    }
    return {
      version: 2,
      toilets,
      helpfulVotes,
      reports,
      reviewKeys,
      externalReviews,
    };
  }

  private async readDisk(): Promise<CommunityDB> {
    try {
      return this.parse(await fs.readFile(this.filePath, "utf-8"));
    } catch (e: any) {
      if (e?.code === "ENOENT") return structuredClone(EMPTY_DB);
      throw e;
    }
  }

  /**
   * ロックなしの読み取り経路。まず stat でディスクの mtime+size を取得し、
   * キャッシュと一致すればファイル読み込み・パースを省略する。不一致ならロックを
   * 取らずに読み直す（読み取りは常に rename 済みの完全なファイルを見るため安全）。
   */
  private async snapshotForRead(): Promise<CommunityDB> {
    let stat: { mtimeMs: number; size: number };
    try {
      const s = await fs.stat(this.filePath);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        this.cache = null;
        return structuredClone(EMPTY_DB);
      }
      throw e;
    }
    const cached = this.cache;
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.data;
    }
    try {
      const db = await this.readDisk();
      this.cache = { data: db, mtimeMs: stat.mtimeMs, size: stat.size };
      return db;
    } catch (e) {
      // パース失敗等ではキャッシュを残さない（壊れた状態を永久に返さない）。
      this.cache = null;
      throw e;
    }
  }

  /** 書き込み後にキャッシュを最新のディスク内容へ同期する（書き込みはロック内）。 */
  private async refreshCacheAfterWrite(db: CommunityDB): Promise<void> {
    try {
      const stat = await fs.stat(this.filePath);
      this.cache = { data: db, mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      this.cache = null;
    }
  }

  async load(): Promise<CommunityDB> {
    return structuredClone(await this.snapshotForRead());
  }

  async getToilets(): Promise<ToiletFacility[]> {
    return structuredClone((await this.snapshotForRead()).toilets);
  }

  async addToilet(t: ToiletFacility): Promise<{ added: boolean }> {
    return withFileLock(this.filePath, async () => {
      const db = await this.readDisk();
      if (db.toilets.some((x) => x.id === t.id)) return { added: false };
      db.toilets.unshift(t);
      await atomicWriteFile(this.filePath, JSON.stringify(db));
      await this.refreshCacheAfterWrite(db);
      return { added: true };
    });
  }

  private buildReview(input: ReviewInput): ToiletReview {
    return {
      id: `rev-${crypto.randomUUID()}`,
      userName: input.userName,
      rating: input.overallScore,
      overallScore: input.overallScore,
      cleanlinessScore: input.cleanlinessScore,
      odorScore: input.odorScore,
      suppliesScore: input.suppliesScore,
      comment: input.comment,
      createdAt: new Date().toISOString().split("T")[0],
      helpfulCount: 0,
    };
  }

  // 重複投稿ガード: 同一IP＋正規化コメント一致が24h以内は拒否
  private hasDuplicate(
    db: CommunityDB,
    reviews: ToiletReview[],
    comment: string,
    ipHash: string
  ): boolean {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const norm = normalizeDedupText(comment);
    return reviews.some((r) => {
      const key = db.reviewKeys[r.id];
      return (
        key !== undefined &&
        key.ipHash === ipHash &&
        normalizeDedupText(String((r as { comment?: unknown }).comment ?? "")) ===
          norm &&
        key.at >= dayAgo
      );
    });
  }

  // コミュニティ登録トイレに加え、外部施設（OSM/Google/自治体OD）のレビューも共有対象（M5）
  async addReview(
    toiletId: string,
    input: ReviewInput,
    ipHash: string
  ): Promise<AddReviewResult> {
    return withFileLock(this.filePath, async () => {
      const db = await this.readDisk();
      const t = db.toilets.find((x) => x.id === toiletId);

      if (t) {
        if (this.hasDuplicate(db, t.reviews, input.comment, ipHash)) {
          return { error: "duplicate" as const };
        }
        const review = this.buildReview(input);
        db.reviewKeys[review.id] = { ipHash, at: Date.now() };
        const reviews = [review, ...t.reviews];
        const summary = summarizeReviews(reviews)!; // reviews.length >= 1
        t.reviews = reviews;
        t.reviewCount = reviews.length;
        t.cleanlinessScore = summary.cleanlinessScore;
        t.cleanlinessGrade = summary.cleanlinessGrade;
        t.overallScore = summary.overallScore;
        t.lastCleaned = "たった今（利用者が確認）";
        await atomicWriteFile(this.filePath, JSON.stringify(db));
        await this.refreshCacheAfterWrite(db);
        return { toilet: t };
      }

      // コミュニティ登録外は施設ID形式（osm-* / google-* / od-*）でのみ受け付ける
      if (!isExternalFacilityId(toiletId)) return { error: "not_found" as const };
      const existing = db.externalReviews[toiletId] ?? [];
      if (this.hasDuplicate(db, existing, input.comment, ipHash)) {
        return { error: "duplicate" as const };
      }
      const review = this.buildReview(input);
      db.reviewKeys[review.id] = { ipHash, at: Date.now() };
      const reviews = [review, ...existing];
      db.externalReviews[toiletId] = reviews;
      const summary = summarizeReviews(reviews);
      await atomicWriteFile(this.filePath, JSON.stringify(db));
      await this.refreshCacheAfterWrite(db);
      return {
        facilityId: toiletId,
        reviews,
        reviewCount: reviews.length,
        cleanlinessScore: summary?.cleanlinessScore,
        cleanlinessGrade: summary?.cleanlinessGrade,
        overallScore: summary?.overallScore,
      };
    });
  }

  // コミュニティ登録トイレ＋外部施設の両方からレビューを探す
  private findReview(
    db: CommunityDB,
    reviewId: string
  ): { review: ToiletReview } | null {
    for (const t of db.toilets) {
      const r = t.reviews.find((x) => x.id === reviewId);
      if (r) return { review: r };
    }
    for (const list of Object.values(db.externalReviews)) {
      const r = list.find((x) => x.id === reviewId);
      if (r) return { review: r };
    }
    return null;
  }

  // 外部施設（OSM/Google/OD）への共有レビュー一覧（クライアントがシード施設に重ねる用）
  async getExternalReviews(): Promise<Record<string, ToiletReview[]>> {
    const db = await this.snapshotForRead();
    return Object.fromEntries(
      Object.entries(db.externalReviews).map(([k, v]) => [k, structuredClone(v)])
    );
  }

  async voteHelpful(
    reviewId: string,
    ipHash: string
  ): Promise<{ helpfulCount: number; voted: boolean; found: boolean }> {
    return withFileLock(this.filePath, async () => {
      const db = await this.readDisk();
      const hit = this.findReview(db, reviewId);
      if (!hit) return { helpfulCount: 0, voted: false, found: false };
      const { review } = hit;
      const voters = db.helpfulVotes[reviewId] ?? [];
      if (voters.includes(ipHash)) {
        return { helpfulCount: review.helpfulCount, voted: false, found: true };
      }
      voters.push(ipHash);
      db.helpfulVotes[reviewId] = voters;
      review.helpfulCount += 1;
      await atomicWriteFile(this.filePath, JSON.stringify(db));
      await this.refreshCacheAfterWrite(db);
      return { helpfulCount: review.helpfulCount, voted: true, found: true };
    });
  }

  async addReport(
    toiletId: string,
    reviewId: string,
    reason: string
  ): Promise<{ ok: boolean; found: boolean; duplicate?: boolean }> {
    return withFileLock(this.filePath, async () => {
      const db = await this.readDisk();
      const t = db.toilets.find((x) => x.id === toiletId);
      const reviews = t ? t.reviews : db.externalReviews[toiletId];
      if (!reviews || !reviews.some((r) => r.id === reviewId)) {
        return { ok: false, found: false };
      }
      const now = Date.now();
      const dayAgo = now - 24 * 60 * 60 * 1000;
      const normReason = normalizeReportReason(reason);
      const dup = db.reports.some(
        (r) =>
          r.reviewId === reviewId &&
          normalizeReportReason(r.reason ?? "") === normReason &&
          (typeof r.at === "number" ? r.at : Date.parse(r.createdAt) || 0) >=
            dayAgo &&
          r.status !== "resolved"
      );
      if (dup) return { ok: false, found: true, duplicate: true };
      db.reports.push({
        id: `report-${crypto.randomUUID()}`,
        toiletId,
        reviewId,
        reason,
        createdAt: new Date(now).toISOString(),
        at: now,
        status: "open",
      });
      await atomicWriteFile(this.filePath, JSON.stringify(db));
      await this.refreshCacheAfterWrite(db);
      return { ok: true, found: true };
    });
  }

  async listReports(opts: ListReportsOptions = {}): Promise<StoredReport[]> {
    const db = await this.load();
    const status = opts.status ?? "all";
    const rawOffset = Number(opts.offset ?? 0);
    const rawLimit = Number(opts.limit ?? 50);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
    const limit = Number.isFinite(rawLimit)
      ? Math.max(0, Math.min(100, Math.floor(rawLimit)))
      : 50;
    let list = [...db.reports].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    if (status === "open" || status === "resolved") {
      list = list.filter((r) => (r.status ?? "open") === status);
    }
    return list.slice(offset, offset + limit);
  }

  async resolveReport(
    reportId: string,
    note?: string
  ): Promise<{ found: boolean; report?: StoredReport }> {
    return withFileLock(this.filePath, async () => {
      const db = await this.readDisk();
      const r = db.reports.find((x) => x.id === reportId);
      if (!r) return { found: false };
      r.status = "resolved";
      r.resolvedAt = new Date().toISOString();
      if (typeof note === "string" && note.trim()) {
        r.resolution = note.trim().slice(0, 500);
        r.adminNote = r.resolution;
      }
      await atomicWriteFile(this.filePath, JSON.stringify(db));
      await this.refreshCacheAfterWrite(db);
      return { found: true, report: { ...r } };
    });
  }

  async deleteReview(
    reviewId: string,
    reason?: string
  ): Promise<{
    found: boolean;
    facilityId?: string;
    kind?: "community" | "external";
    reviewCount?: number;
  }> {
    return withFileLock(this.filePath, async () => {
      const db = await this.readDisk();
      const now = new Date().toISOString();
      const resolution =
        typeof reason === "string" && reason.trim()
          ? reason.trim().slice(0, 500)
          : "admin delete";
      const markReports = () => {
        for (const r of db.reports) {
          if (r.reviewId === reviewId && r.status !== "resolved") {
            r.status = "resolved";
            r.resolvedAt = now;
            r.resolution = resolution;
          }
        }
      };
      const t = db.toilets.find((x) =>
        Array.isArray(x.reviews) && x.reviews.some((r) => r.id === reviewId)
      );
      if (t) {
        t.reviews = t.reviews.filter((r) => r.id !== reviewId);
        t.reviewCount = t.reviews.length;
        const summary = summarizeReviews(t.reviews);
        if (!summary) {
          t.cleanlinessScore = t.equipmentScore;
          t.cleanlinessGrade = t.equipmentGrade;
          delete (t as { overallScore?: number }).overallScore;
          delete (t as { lastCleaned?: string }).lastCleaned;
        } else {
          t.cleanlinessScore = summary.cleanlinessScore;
          t.cleanlinessGrade = summary.cleanlinessGrade;
          t.overallScore = summary.overallScore;
        }
        delete db.reviewKeys[reviewId];
        delete db.helpfulVotes[reviewId];
        markReports();
        await atomicWriteFile(this.filePath, JSON.stringify(db));
        await this.refreshCacheAfterWrite(db);
        return {
          found: true,
          facilityId: t.id,
          kind: "community" as const,
          reviewCount: t.reviews.length,
        };
      }
      for (const [fid, list] of Object.entries(db.externalReviews)) {
        if (Array.isArray(list) && list.some((r) => r.id === reviewId)) {
          db.externalReviews[fid] = list.filter((r) => r.id !== reviewId);
          delete db.reviewKeys[reviewId];
          delete db.helpfulVotes[reviewId];
          markReports();
          await atomicWriteFile(this.filePath, JSON.stringify(db));
          await this.refreshCacheAfterWrite(db);
          return {
            found: true,
            facilityId: fid,
            kind: "external" as const,
            reviewCount: db.externalReviews[fid].length,
          };
        }
      }
      return { found: false };
    });
  }

  // 外部施設（OSM/Google/OD）の既知IDを登録する。レビュー0件でもキーを残すことで、
  // 再起動後も server.ts の起動時 registration（externalReviews のキー一覧）で
  // 施設のレビュー可否が復元される（#53 で失われた OSM リストア経路の代替）。
  async registerExternalFacilities(facilities: ExternalFacilityObservation[]): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const db = await this.readDisk();
      let changed = false;
      for (const facility of facilities) {
        // 正準IDをキーにする（防御層）。runtime の観測経路で正準化済みだが、
        // CLI 等の直接呼び出しでもキー空間が正準に保たれるようにする。
        const id = canonicalizeExternalFacilityId(facility.id);
        if (!isExternalFacilityId(id)) continue;
        if (db.externalReviews[id]) continue;
        db.externalReviews[id] = [];
        changed = true;
      }
      if (changed) {
        await atomicWriteFile(this.filePath, JSON.stringify(db));
        await this.refreshCacheAfterWrite(db);
      }
    });
  }

  // 既知の外部施設ID一覧（レビュー有無に関係なく、externalReviews にキーがあるもの）。
  // 運用CLI（restore.ts）が curation 後の再登録に使う。
  async listKnownExternalFacilityIds(): Promise<string[]> {
    return Object.keys((await this.snapshotForRead()).externalReviews).sort();
  }
}

export function defaultStorePath(): string {
  return (
    process.env.COMMUNITY_STORE_PATH ||
    path.join(process.cwd(), "data", "community.json")
  );
}

export type ExternalFacilityValidator = (facilityId: string) => boolean | Promise<boolean>;

// ルーターはストレージの実装（JSON / Firestore / テスト用フェイク）に依存せず、
// CommunityRepository 契約のみを要求する（docs/durable-community-backend.md）。
export function createCommunityRouter(
  store: CommunityRepository,
  salt: string,
  isKnownExternalFacility: ExternalFacilityValidator = () => false,
  adminToken?: string
): Router {
  const router = Router();

  const postLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "too many requests" },
  });
  const voteLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "too many requests" },
  });

  const ipHashOf = (req: Request) => hashIp(req.ip || "?", salt);

  router.get(
    "/toilets",
    asyncRoute(async (_req: Request, res: Response) => {
      // toilets: コミュニティ登録トイレ。externalReviews: 外部施設（OSM/Google/OD）の
      // 共有レビュー（M5）。クライアントがローカルのシード施設に重ねて表示する
      res.json({
        toilets: publicToilets(await store.getToilets()),
        externalReviews: await store.getExternalReviews(),
      });
    })
  );

  router.post(
    "/toilets",
    postLimiter,
    asyncRoute(async (req: Request, res: Response) => {
      const v = validateToiletInput(req.body);
      if (!v.ok || !v.value) {
        res.status(400).json({ error: v.error });
        return;
      }

      const t = {
        id: v.value.id,
        name: v.value.name,
        facilityType:
          v.value.category === "department"
            ? "商業施設・デパート"
            : v.value.category === "station"
            ? "駅・交通施設"
            : v.value.category === "convenience"
            ? "コンビニ"
            : v.value.category === "park"
            ? "公衆トイレ"
            : "その他施設",
        category: v.value.category,
        dataSource: "community",
        lat: v.value.lat,
        lng: v.value.lng,
        address: v.value.address,
        floorInfo: v.value.floorInfo,
        attributes: {
          hasWashlet: v.value.attributes.hasWashlet,
          hasMultipurpose: v.value.attributes.hasMultipurpose,
          hasBabyTable: v.value.attributes.hasBabyTable,
          hasNursingRoom: null,
          hasPowderRoom: v.value.attributes.hasPowderRoom,
          hasOstomate: null,
          isFree: null,
          isOpen24h: v.value.attributes.isOpen24h,
          hasSoap: null,
          hasAlcohol: null,
          hasPaperTowelOrDryer: null,
          toiletStyle: null,
        },
        openingHours:
          v.value.attributes.isOpen24h === true
            ? "24時間営業"
            : v.value.attributes.isOpen24h === false
            ? "施設営業時間に準ずる"
            : "営業時間未確認",
        description: v.value.description,
        reviewCount: 0,
        reviews: [],
        facilityNote: "ユーザー報告に基づく新規登録トイレ情報。",
      } as unknown as ToiletFacility;

      const { added } = await store.addToilet(t);
      if (!added) {
        res.status(409).json({ error: "duplicate id" });
        return;
      }
      res.status(201).json({ toilet: t });
    })
  );

  router.post(
    "/toilets/:id/reviews",
    postLimiter,
    asyncRoute(async (req: Request, res: Response) => {
      const v = validateReviewInput(req.body);
      if (!v.ok || !v.value) {
        res.status(400).json({ error: v.error });
        return;
      }

      // NFC正準化: 分解済み入力（Jamo等）を登録済みの正準IDへ写像してから照合する。
      const facilityId = canonicalizeExternalFacilityId(req.params.id);
      if (
        isExternalFacilityId(facilityId) &&
        !(await isKnownExternalFacility(facilityId))
      ) {
        res.status(404).json({ error: "toilet not found" });
        return;
      }

      const r = await store.addReview(facilityId, v.value, ipHashOf(req));
      if (r.error === "not_found") {
        res.status(404).json({ error: "toilet not found" });
        return;
      }
      if (r.error === "duplicate") {
        res.status(409).json({ error: "duplicate review" });
        return;
      }
      if (r.toilet) {
        res.status(201).json({ toilet: publicToilets([r.toilet])[0] });
        return;
      }
      // 外部施設（OSM/Google/OD）: 施設ごとレビュー一覧を返し、クライアントが重ねる
      res.status(201).json({
        facilityId: r.facilityId,
        reviewCount: r.reviewCount,
        cleanlinessScore: r.cleanlinessScore,
        cleanlinessGrade: r.cleanlinessGrade,
        reviews: r.reviews,
      });
    })
  );

  router.post(
    "/reviews/:reviewId/helpful",
    voteLimiter,
    asyncRoute(async (req: Request, res: Response) => {
      const r = await store.voteHelpful(req.params.reviewId, ipHashOf(req));
      if (!r.found) {
        res.status(404).json({ error: "review not found" });
        return;
      }
      res.json({ helpfulCount: r.helpfulCount, voted: r.voted });
    })
  );

  router.post(
    "/reviews/:reviewId/report",
    postLimiter,
    asyncRoute(async (req: Request, res: Response) => {
      const v = validateReportInput(req.body);
      if (!v.ok || !v.value) {
        res.status(400).json({ error: v.error });
        return;
      }
      const { toiletId } = req.body ?? {};
      if (typeof toiletId !== "string") {
        res.status(400).json({ error: "toiletId required" });
        return;
      }
      const r = await store.addReport(
        canonicalizeExternalFacilityId(toiletId),
        req.params.reviewId,
        v.value.reason
      );
      if (!r.found) {
        res.status(404).json({ error: "review not found" });
        return;
      }
      if ((r as { duplicate?: boolean }).duplicate) {
        res.status(409).json({ error: "duplicate report" });
        return;
      }
      res.status(201).json({ ok: true });
    })
  );

  const adminGuard: RequestHandler = (req, res, next) => {
    if (!adminToken) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const presented = Buffer.from(header.slice(7));
    const expected = Buffer.from(adminToken);
    if (
      presented.length !== expected.length ||
      !crypto.timingSafeEqual(presented, expected)
    ) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  router.get(
    "/admin/reports",
    adminGuard,
    asyncRoute(async (req: Request, res: Response) => {
      if (!store.listReports) {
        res.status(501).json({ error: "not implemented" });
        return;
      }
      const statusRaw =
        typeof req.query.status === "string" ? req.query.status : "all";
      const status: ListReportsOptions["status"] =
        statusRaw === "open" || statusRaw === "resolved" ? statusRaw : "all";
      const limit =
        typeof req.query.limit === "string" && req.query.limit.trim() !== ""
          ? Number(req.query.limit)
          : 50;
      const offset =
        typeof req.query.offset === "string" && req.query.offset.trim() !== ""
          ? Number(req.query.offset)
          : 0;
      const reports = await store.listReports({ status, limit, offset });
      const toilets = await store.getToilets();
      const names = new Map(toilets.map((t) => [t.id, t.name] as const));
      res.json({
        reports: reports.map((r) => ({
          ...r,
          facilityName: names.get(r.toiletId),
        })),
      });
    })
  );

  router.post(
    "/admin/reports/:id/resolve",
    adminGuard,
    postLimiter,
    asyncRoute(async (req: Request, res: Response) => {
      if (!store.resolveReport) {
        res.status(501).json({ error: "not implemented" });
        return;
      }
      const body = req.body as { note?: unknown; adminNote?: unknown } | undefined;
      const note =
        typeof body?.note === "string"
          ? body.note
          : typeof body?.adminNote === "string"
            ? body.adminNote
            : undefined;
      const r = await store.resolveReport(req.params.id, note);
      if (!r.found) {
        res.status(404).json({ error: "report not found" });
        return;
      }
      res.json({ ok: true, report: r.report });
    })
  );

  router.delete(
    "/admin/reviews/:reviewId",
    adminGuard,
    postLimiter,
    asyncRoute(async (req: Request, res: Response) => {
      if (!store.deleteReview) {
        res.status(501).json({ error: "not implemented" });
        return;
      }
      const body = req.body as { reason?: unknown } | undefined;
      const reason = typeof body?.reason === "string" ? body.reason : undefined;
      const r = await store.deleteReview(req.params.reviewId, reason);
      if (!r.found) {
        res.status(404).json({ error: "review not found" });
        return;
      }
      res.json({ ok: true, ...r });
    })
  );

  router.use((err: unknown, _req: Request, res: Response, _next: (err?: unknown) => void) => {
    console.error("[community] request failed:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal server error" });
  });

  return router;
}
