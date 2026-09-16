// data/community.json（CommunityDB v2）の読み込み・統計・差分計算。
// git運用（バックアップ・差分レビュー・手動キュレーション）の共通ロジック。
// このファイルは実行しない。CLI は同ディレクトリの export.ts / summarize.ts / commit.ts。
//
// プライバシー方針: 保存データにはソルト付きIPハッシュ（helpfulVotes / reviewKeys /
// レビュー内 ipHash）が含まれるが、これは集計（件数）にのみ使い、本文には一切出さない。
// 差分表示に出るのは施設名・口コミ本文・通報理由など、キュレーションに必要な情報のみ。
import { readFile } from "node:fs/promises";

// ── 表示・差分に必要な最小フィールドだけを型で持つ ──

export interface ReviewEntry {
  id: string;
  userName?: string;
  /** 総合満足度（新フィールド。旧データは rating のみ） */
  overallScore?: number;
  /** 総合満足度の旧名（別名） */
  rating?: number;
  comment?: string;
  createdAt?: string;
}

export interface FacilityEntry {
  id: string;
  name: string;
  reviews: ReviewEntry[];
}

export interface ReportEntry {
  id: string;
  toiletId?: string;
  reviewId?: string;
  reason?: string;
  createdAt?: string;
}

export interface DbFile {
  version: number;
  toilets: FacilityEntry[];
  helpfulVotes: Record<string, string[]>;
  reports: ReportEntry[];
  reviewKeys: Record<string, unknown>;
  externalReviews: Record<string, ReviewEntry[]>;
}

export function emptyDb(): DbFile {
  return {
    version: 2,
    toilets: [],
    helpfulVotes: {},
    reports: [],
    reviewKeys: {},
    externalReviews: {},
  };
}

// ── パース（サーバー側 load() と同等に寛容。壊れた要素は捨てる） ──

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function normReview(r: unknown): ReviewEntry | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== "string") return null;
  return {
    id: o.id,
    userName: str(o.userName),
    rating: num(o.rating),
    comment: str(o.comment),
    createdAt: str(o.createdAt),
  };
}

function normReviews(v: unknown): ReviewEntry[] {
  if (!Array.isArray(v)) return [];
  const out: ReviewEntry[] = [];
  for (const r of v) {
    const n = normReview(r);
    if (n) out.push(n);
  }
  return out;
}

function normFacility(t: unknown): FacilityEntry | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Record<string, unknown>;
  if (typeof o.id !== "string") return null;
  return { id: o.id, name: str(o.name) ?? o.id, reviews: normReviews(o.reviews) };
}

function normReport(r: unknown): ReportEntry | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== "string") return null;
  return {
    id: o.id,
    toiletId: str(o.toiletId),
    reviewId: str(o.reviewId),
    reason: str(o.reason),
    createdAt: str(o.createdAt),
  };
}

function normExternal(v: unknown): Record<string, ReviewEntry[]> {
  const out: Record<string, ReviewEntry[]> = {};
  if (!v || typeof v !== "object") return out;
  for (const [fid, revs] of Object.entries(v as Record<string, unknown>)) {
    const cleaned = normReviews(revs);
    if (cleaned.length > 0) out[fid] = cleaned;
  }
  return out;
}

function normVotes(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
    if (Array.isArray(list)) {
      const cleaned = list.filter((x): x is string => typeof x === "string");
      if (cleaned.length > 0) out[k] = cleaned;
    }
  }
  return out;
}

export function parseDb(text: string, label = "(inline)"): DbFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSONパース失敗: ${label}: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`不正なDBファイル: ${label}（オブジェクトではない）`);
  }
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p.toilets)) {
    throw new Error(`不正なDBファイル: ${label}（toilets が配列ではない）`);
  }
  const toilets: FacilityEntry[] = [];
  for (const t of p.toilets) {
    const n = normFacility(t);
    if (n) toilets.push(n);
  }
  return {
    version: typeof p.version === "number" ? p.version : 2,
    toilets,
    helpfulVotes: normVotes(p.helpfulVotes),
    reports: Array.isArray(p.reports)
      ? p.reports.map(normReport).filter((r): r is ReportEntry => r !== null)
      : [],
    reviewKeys:
      p.reviewKeys && typeof p.reviewKeys === "object" && !Array.isArray(p.reviewKeys)
        ? (p.reviewKeys as Record<string, unknown>)
        : {},
    externalReviews: normExternal(p.externalReviews),
  };
}

export async function loadDbFile(filePath: string): Promise<DbFile> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(`ファイルが存在しません: ${filePath}`);
    }
    throw new Error(`読み込み失敗: ${filePath}: ${(e as Error).message}`);
  }
  return parseDb(text, filePath);
}

/** バックアップ用の原文。表示・差分用の parseDb と違い、未知フィールドを保持する。 */
export async function loadRawDbFile(filePath: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(filePath, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") throw new Error(`ファイルが存在しません: ${filePath}`);
    throw new Error(`読み込み失敗: ${filePath}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSONパース失敗: ${filePath}: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`不正なDBファイル: ${filePath}（オブジェクトではない）`);
  }
  const raw = parsed as Record<string, unknown>;
  if (!Array.isArray(raw.toilets)) {
    throw new Error(`不正なDBファイル: ${filePath}（toilets が配列ではない）`);
  }
  return raw;
}

// ── 統計 ──

export interface DbStats {
  communityToilets: number; // toilet-user-* のコミュニティ登録施設
  otherToilets: number; // それ以外（通常は存在しないが念のため）
  toiletReviews: number; // コミュニティ施設に付いたレビュー数
  externalReviewFacilities: number; // レビューが1件以上ある外部施設数
  externalReviews: number; // 外部施設レビュー総数
  reports: number; // 通報数
  voteReviews: number; // 投票の付いたレビュー数
  votes: number; // 投票総数
}

export function stats(db: DbFile): DbStats {
  let communityToilets = 0;
  let otherToilets = 0;
  let toiletReviews = 0;
  for (const t of db.toilets) {
    if (t.id.startsWith("toilet-user-")) communityToilets += 1;
    else otherToilets += 1;
    toiletReviews += t.reviews.length;
  }
  let externalReviewFacilities = 0;
  let externalReviews = 0;
  for (const revs of Object.values(db.externalReviews)) {
    if (revs.length > 0) externalReviewFacilities += 1;
    externalReviews += revs.length;
  }
  let votes = 0;
  for (const list of Object.values(db.helpfulVotes)) votes += list.length;
  return {
    communityToilets,
    otherToilets,
    toiletReviews,
    externalReviewFacilities,
    externalReviews,
    reports: db.reports.length,
    voteReviews: Object.keys(db.helpfulVotes).length,
    votes,
  };
}

// ── 差分 ──

export interface ReviewDelta {
  added: ReviewEntry[];
  removed: ReviewEntry[];
  /** 同一IDで内容が変わったもの（本文・スコア改竄の検出用。#111） */
  modified: { before: ReviewEntry; after: ReviewEntry }[];
}

export interface DbDiff {
  addedToilets: FacilityEntry[];
  removedToilets: FacilityEntry[];
  // 両方に存在するコミュニティ施設の、レビューの増減（施設id → delta）
  toiletReviewChanges: Record<string, ReviewDelta>;
  // 外部施設（osm-* / google-* / od-*）レビューの増減（施設id → delta）
  externalReviewChanges: Record<string, ReviewDelta>;
  addedReports: ReportEntry[];
  removedReports: ReportEntry[];
  addedVotes: number;
  removedVotes: number;
  addedVoteReviewIds: string[];
  removedVoteReviewIds: string[];
}

/** 内容比較用の安定シリアライズ（キー順に依存しない） */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const rec = v as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`)
    .join(",")}}`;
}

function diffReviewsById(
  oldList: ReviewEntry[] | undefined,
  newList: ReviewEntry[] | undefined
): ReviewDelta {
  const oldById = new Map((oldList ?? []).map((r) => [r.id, r]));
  const newById = new Map((newList ?? []).map((r) => [r.id, r]));
  const added: ReviewEntry[] = [];
  const removed: ReviewEntry[] = [];
  const modified: { before: ReviewEntry; after: ReviewEntry }[] = [];
  for (const r of newById.values()) {
    const old = oldById.get(r.id);
    if (!old) {
      added.push(r);
    } else if (stableStringify(old) !== stableStringify(r)) {
      modified.push({ before: old, after: r });
    }
  }
  for (const r of oldById.values()) if (!newById.has(r.id)) removed.push(r);
  return { added, removed, modified };
}

function collectRecordChanges(
  before: Record<string, ReviewEntry[]>,
  after: Record<string, ReviewEntry[]>
): Record<string, ReviewDelta> {
  const out: Record<string, ReviewDelta> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const d = diffReviewsById(before[key], after[key]);
    if (d.added.length > 0 || d.removed.length > 0 || d.modified.length > 0) out[key] = d;
  }
  return out;
}

export function diffStores(before: DbFile, after: DbFile): DbDiff {
  const beforeById = new Map(before.toilets.map((t) => [t.id, t]));
  const afterById = new Map(after.toilets.map((t) => [t.id, t]));

  const addedToilets: FacilityEntry[] = [];
  const removedToilets: FacilityEntry[] = [];
  const toiletReviewChanges: Record<string, ReviewDelta> = {};
  for (const t of after.toilets) {
    const old = beforeById.get(t.id);
    if (!old) {
      addedToilets.push(t);
      continue;
    }
    const d = diffReviewsById(old.reviews, t.reviews);
    if (d.added.length > 0 || d.removed.length > 0 || d.modified.length > 0)
      toiletReviewChanges[t.id] = d;
  }
  for (const t of before.toilets) {
    if (!afterById.has(t.id)) removedToilets.push(t);
  }

  const beforeReports = new Map(before.reports.map((r) => [r.id, r]));
  const afterReports = new Map(after.reports.map((r) => [r.id, r]));
  const addedReports = after.reports.filter((r) => !beforeReports.has(r.id));
  const removedReports = before.reports.filter((r) => !afterReports.has(r.id));

  let addedVotes = 0;
  let removedVotes = 0;
  const addedVoteReviewIds: string[] = [];
  const removedVoteReviewIds: string[] = [];
  for (const [rid, list] of Object.entries(after.helpfulVotes)) {
    const prev = before.helpfulVotes[rid] ?? [];
    const delta = list.length - prev.length;
    if (delta > 0) {
      addedVotes += delta;
      addedVoteReviewIds.push(rid);
    } else if (delta < 0) {
      removedVotes += -delta;
      removedVoteReviewIds.push(rid);
    }
  }
  for (const rid of Object.keys(before.helpfulVotes)) {
    if (!(rid in after.helpfulVotes)) {
      removedVotes += before.helpfulVotes[rid].length;
      removedVoteReviewIds.push(rid);
    }
  }

  return {
    addedToilets,
    removedToilets,
    toiletReviewChanges,
    externalReviewChanges: collectRecordChanges(
      before.externalReviews,
      after.externalReviews
    ),
    addedReports,
    removedReports,
    addedVotes,
    removedVotes,
    addedVoteReviewIds,
    removedVoteReviewIds,
  };
}

export function isDiffEmpty(diff: DbDiff): boolean {
  const noReviewChange = (d: ReviewDelta) =>
    d.added.length === 0 && d.removed.length === 0 && d.modified.length === 0;
  return (
    diff.addedToilets.length === 0 &&
    diff.removedToilets.length === 0 &&
    Object.values(diff.toiletReviewChanges).every(noReviewChange) &&
    Object.values(diff.externalReviewChanges).every(noReviewChange) &&
    diff.addedReports.length === 0 &&
    diff.removedReports.length === 0 &&
    diff.addedVotes === 0 &&
    diff.removedVotes === 0
  );
}

export interface CountSummary {
  addedToilets: number;
  removedToilets: number;
  addedReviews: number; // コミュニティ + 外部
  removedReviews: number;
  modifiedReviews: number; // 同一IDの内容変更（#111）
  addedReports: number;
  removedReports: number;
  addedVotes: number;
  removedVotes: number;
}

export function countDiff(diff: DbDiff): CountSummary {
  let addedReviews = 0;
  let removedReviews = 0;
  let modifiedReviews = 0;
  for (const d of Object.values(diff.toiletReviewChanges)) {
    addedReviews += d.added.length;
    removedReviews += d.removed.length;
    modifiedReviews += d.modified.length;
  }
  for (const d of Object.values(diff.externalReviewChanges)) {
    addedReviews += d.added.length;
    removedReviews += d.removed.length;
    modifiedReviews += d.modified.length;
  }
  return {
    addedToilets: diff.addedToilets.length,
    removedToilets: diff.removedToilets.length,
    addedReviews,
    removedReviews,
    modifiedReviews,
    addedReports: diff.addedReports.length,
    removedReports: diff.removedReports.length,
    addedVotes: diff.addedVotes,
    removedVotes: diff.removedVotes,
  };
}

// ── 整形（日本語・プレーンテキスト。行は \n 結合） ──

export function formatStats(db: DbFile, label: string): string {
  const s = stats(db);
  const parts = [
    `施設 ${s.communityToilets}`,
    `口コミ ${s.toiletReviews}`,
    `外部施設レビュー ${s.externalReviewFacilities}施設/${s.externalReviews}件`,
    `通報 ${s.reports}`,
    `投票 ${s.votes}票/${s.voteReviews}レビュー`,
  ];
  return `${label}: ${parts.join(" / ")}`;
}

function oneLine(v: string | undefined, max = 100): string {
  if (!v) return "";
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function fmtReview(r: ReviewEntry): string {
  const name = r.userName?.trim() ? ` ${r.userName}` : "";
  const stars = typeof r.overallScore === "number" ? r.overallScore : r.rating;
  const rating = typeof stars === "number" ? ` ★${stars}` : "";
  const at = r.createdAt ? ` (${r.createdAt})` : "";
  return `${name}${rating}${at}: ${oneLine(r.comment, 120)}`.trim();
}

export interface FormatOptions {
  /** true のとき口コミ本文・ユーザー名・通報理由を出さず件数のみ（自動化向け） */
  countsOnly?: boolean;
}

const LINE = "-".repeat(60);

export function formatDiff(diff: DbDiff, opts: FormatOptions = {}): string {
  const c = countDiff(diff);
  const countsOnly = opts.countsOnly === true;
  const out: string[] = [];
  out.push("=== コミュニティデータ差分 ===");
  out.push(
    `施設: +${c.addedToilets} / -${c.removedToilets}   口コミ: +${c.addedReviews} / -${c.removedReviews}   通報: +${c.addedReports} / -${c.removedReports}   投票: +${c.addedVotes} / -${c.removedVotes}`
  );

  if (!countsOnly) {
    if (diff.addedToilets.length > 0) {
      out.push("");
      out.push(`[追加施設 ${diff.addedToilets.length}件]`);
      for (const t of diff.addedToilets) {
        out.push(`  + ${t.id}「${oneLine(t.name, 60)}」（レビュー ${t.reviews.length}件）`);
        for (const r of t.reviews) out.push(`    + ${fmtReview(r)}`);
      }
    }
    if (diff.removedToilets.length > 0) {
      out.push("");
      out.push(`[削除施設 ${diff.removedToilets.length}件]`);
      for (const t of diff.removedToilets) {
        out.push(`  - ${t.id}「${oneLine(t.name, 60)}」`);
        for (const r of t.reviews) out.push(`    - ${fmtReview(r)}`);
      }
    }
  }

  for (const [section, changes] of [
    ["コミュニティ施設の口コミ", diff.toiletReviewChanges],
    ["外部施設（OSM/Google/OD）レビュー", diff.externalReviewChanges],
  ] as const) {
    const ids = Object.keys(changes);
    if (ids.length === 0) continue;
    out.push("");
    out.push(`[${section} ${ids.length}施設]`);
    for (const fid of ids) {
      const d = changes[fid];
      const name = section.startsWith("外部")
        ? fid
        : diff.addedToilets.find((t) => t.id === fid)?.name ?? fid;
      out.push(`  ${fid}（${name}）: +${d.added.length} / -${d.removed.length}${d.modified.length > 0 ? ` / ~${d.modified.length}変更` : ""}`);
      if (!countsOnly) {
        for (const r of d.added) out.push(`    + ${fmtReview(r)}`);
        for (const r of d.removed) out.push(`    - ${fmtReview(r)}`);
        for (const m of d.modified)
          out.push(`    ~ ${fmtReview(m.before)}  =>  ${fmtReview(m.after)}`);
      }
    }
  }

  if (diff.addedReports.length > 0) {
    out.push("");
    out.push(`[新規通報 ${diff.addedReports.length}件]`);
    for (const rp of diff.addedReports) {
      const parts = [`  + ${rp.id}`, `reviewId=${rp.reviewId ?? "?"}`];
      if (!countsOnly && rp.reason) parts.push(`理由: ${oneLine(rp.reason, 80)}`);
      out.push(parts.join(" "));
    }
  }
  if (!countsOnly && diff.removedReports.length > 0) {
    out.push("");
    out.push(`[削除された通報 ${diff.removedReports.length}件]`);
    for (const rp of diff.removedReports) out.push(`  - ${rp.id} reviewId=${rp.reviewId ?? "?"}`);
  }
  if (diff.addedVotes > 0 || diff.removedVotes > 0) {
    out.push("");
    out.push(
      `[投票の増減] +${diff.addedVotes} / -${diff.removedVotes}` +
        (diff.addedVoteReviewIds.length > 0
          ? `（増: ${diff.addedVoteReviewIds.slice(0, 5).join(", ")}${diff.addedVoteReviewIds.length > 5 ? "…" : ""}）`
          : "")
    );
  }
  out.push("");
  out.push(LINE);
  return out.join("\n");
}

// ── コミットメッセージ生成 ──

export function buildCommitSubject(diff: DbDiff): string | null {
  const c = countDiff(diff);
  if (isDiffEmpty(diff)) return null;
  const parts: string[] = [];
  if (c.addedToilets > 0 || c.removedToilets > 0) {
    parts.push(`施設+${c.addedToilets}/-${c.removedToilets}`);
  }
  if (c.addedReviews > 0 || c.removedReviews > 0) {
    parts.push(`口コミ+${c.addedReviews}/-${c.removedReviews}`);
  }
  if (c.modifiedReviews > 0) {
    parts.push(`口コミ内容変更${c.modifiedReviews}件`);
  }
  if (c.addedReports > 0 || c.removedReports > 0) {
    parts.push(`通報+${c.addedReports}/-${c.removedReports}`);
  }
  if (c.addedVotes > 0 || c.removedVotes > 0) {
    parts.push(`投票+${c.addedVotes}/-${c.removedVotes}`);
  }
  return `chore(data): コミュニティデータ更新（${parts.join(", ")}）`;
}

const MAX_BODY_LINES = 15;

export function buildCommitBody(diff: DbDiff): string {
  const lines: string[] = [];
  for (const t of diff.addedToilets.slice(0, 8)) {
    lines.push(`- 追加施設: ${t.id}「${oneLine(t.name, 60)}」（レビュー${t.reviews.length}件）`);
  }
  if (diff.addedToilets.length > 8) lines.push(`- ほか追加施設 ${diff.addedToilets.length - 8}件`);
  for (const t of diff.removedToilets.slice(0, 8)) {
    lines.push(`- 削除施設: ${t.id}「${oneLine(t.name, 60)}」`);
  }
  if (diff.removedToilets.length > 8) lines.push(`- ほか削除施設 ${diff.removedToilets.length - 8}件`);
  for (const [fid, d] of Object.entries(diff.toiletReviewChanges).slice(0, 8)) {
    lines.push(`- 口コミ増減: ${fid}（+${d.added.length}/-${d.removed.length}）`);
  }
  if (Object.keys(diff.toiletReviewChanges).length > 8) {
    lines.push(`- ほか口コミ増減施設 ${Object.keys(diff.toiletReviewChanges).length - 8}件`);
  }
  for (const [fid, d] of Object.entries(diff.externalReviewChanges).slice(0, 8)) {
    lines.push(`- 外部レビュー増減: ${fid}（+${d.added.length}/-${d.removed.length}）`);
  }
  if (Object.keys(diff.externalReviewChanges).length > 8) {
    lines.push(`- ほか外部レビュー増減施設 ${Object.keys(diff.externalReviewChanges).length - 8}件`);
  }
  for (const rp of diff.addedReports.slice(0, 5)) {
    lines.push(`- 新規通報: ${rp.id}（reviewId=${rp.reviewId ?? "?"}${rp.reason ? ` / ${oneLine(rp.reason, 60)}` : ""}）`);
  }
  if (diff.addedReports.length > 5) lines.push(`- ほか通報 ${diff.addedReports.length - 5}件`);
  if (lines.length === 0) lines.push("- 件数のみの変化（投票など）");
  if (lines.length > MAX_BODY_LINES) {
    return lines.slice(0, MAX_BODY_LINES).join("\n") + `\n- （ほか ${lines.length - MAX_BODY_LINES} 行省略）`;
  }
  return lines.join("\n");
}
