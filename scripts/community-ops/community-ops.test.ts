import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
// Windows の npm shim (bun.ps1/bun.cmd) は shell なしでは spawn できないため、
// win32 では shell 経由で起動する。bun実体がある環境ではそれを優先する。
const BUN_BIN = process.execPath.toLowerCase().includes("bun") ? process.execPath : "bun";
const NEED_SHELL = process.platform === "win32" && !process.execPath.toLowerCase().includes("bun");
// shell:true の場合、スペース入りパスは手動で引用符化する (Nodeは自動引用しない)。
function bunArgs(args: string[]): string[] {
  if (!NEED_SHELL) return args;
  return args.map((a) => (/[\s"]/.test(a) && !/^".*"$/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
}
const BUN_SHELL_OPT = NEED_SHELL ? { shell: true } as const : {} as const;
import { CommunityStore } from "../../server/community";
import type { DbFile, FacilityEntry, ReportEntry, ReviewEntry } from "./store";
import {
  buildCommitBody,
  buildCommitSubject,
  countDiff,
  diffStores,
  emptyDb,
  formatDiff,
  formatStats,
  isDiffEmpty,
  loadDbFile,
  parseDb,
  stats,
} from "./store";

// ── フィクスチャ ──

const rev = (id: string, over: Partial<ReviewEntry> = {}): ReviewEntry => ({
  id,
  userName: "たろう",
  rating: 5,
  comment: "きれいでした",
  createdAt: "2026-09-04",
  ...over,
});

const facility = (
  id: string,
  name: string,
  reviews: ReviewEntry[] = []
): FacilityEntry => ({ id, name, reviews });

const report = (id: string, over: Partial<ReportEntry> = {}): ReportEntry => ({
  id,
  reviewId: "rev-x",
  reason: "スパム",
  createdAt: "2026-09-04",
  ...over,
});

const db = (over: Partial<DbFile> = {}): DbFile => ({
  version: 2,
  toilets: [],
  helpfulVotes: {},
  reports: [],
  reviewKeys: {},
  externalReviews: {},
  ...over,
});

// ── parseDb / loadDbFile ──

describe("parseDb", () => {
  it("parses a valid file tolerantly and drops junk entries", () => {
    const raw = {
      version: 2,
      toilets: [
        {
          id: "toilet-user-1",
          name: "渋谷トイレ",
          reviews: [
            {
              id: "rev-1",
              userName: "たろう",
              rating: 4,
              comment: "きれい",
              createdAt: "2026-09-01",
              ipHash: "deadbeefcafe", // 保存ファイルに含まれる秘密フィールド
            },
          ],
        },
        null, // 壊れた要素 → 捨てる
        { id: "toilet-user-2" }, // name欠落 → id を name に
        { reviews: [] }, // idなし → 捨てる
      ],
      helpfulVotes: { "rev-1": ["aabbccddee"] },
      reports: [{ id: "rep-1", reviewId: "rev-1", reason: "不適切", createdAt: "2026-09-02" }],
      externalReviews: { "osm-1": [{ id: "e1", userName: "はなこ", rating: 3 }] },
    };
    const d = parseDb(JSON.stringify(raw));
    expect(d.toilets).toHaveLength(2);
    expect(d.toilets[0].reviews[0].comment).toBe("きれい");
    expect(d.toilets[1].name).toBe("toilet-user-2");
    expect(d.helpfulVotes["rev-1"]).toEqual(["aabbccddee"]);
    expect(d.reports).toHaveLength(1);
    expect(d.externalReviews["osm-1"]).toHaveLength(1);
  });

  it("treats a v1 file (externalReviewsなし) as empty externalReviews", () => {
    const d = parseDb(JSON.stringify({ version: 1, toilets: [] }));
    expect(d.version).toBe(1);
    expect(d.externalReviews).toEqual({});
    expect(d.helpfulVotes).toEqual({});
    expect(d.reports).toEqual([]);
  });

  it("throws on broken JSON or a missing toilets array", () => {
    expect(() => parseDb("{not json")).toThrow();
    expect(() => parseDb(JSON.stringify({ version: 2 }))).toThrow();
    expect(() => parseDb("[]")).toThrow();
  });

  it("emptyDb is a valid, empty database", () => {
    const e = emptyDb();
    expect(e.toilets).toEqual([]);
    expect(e.externalReviews).toEqual({});
    expect(() => parseDb(JSON.stringify(e))).not.toThrow();
  });
});

describe("loadDbFile", () => {
  it("throws a readable error for a missing file", async () => {
    await expect(loadDbFile("data/__no_such_community__.json")).rejects.toThrow();
  });
});

describe("export CLI", () => {
  it("round-trips complete raw JSON fields while rejecting malformed input before writing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dokotoilet-export-"));
    const source = path.join(dir, "community.json");
    const destination = path.join(dir, "backup.json");
    const raw = {
      version: 2,
      toilets: [{ id: "toilet-user-full", name: "全項目", lat: 35.1, lng: 139.2, category: "park", dataSource: "community", equipmentScore: 3.5, subScores: { cleanliness: 4, odor: 2, supplies: 5, comfort: 3 }, attributes: { hasWashlet: true }, reviews: [{ id: "review-full", overallScore: 4, rating: 5, cleanlinessScore: 4, odorScore: 2, suppliesScore: 5, helpfulCount: 7, comment: "本文", ipHash: "secret", extraReviewField: { x: 1 } }] }],
      helpfulVotes: { "review-full": ["vote-a", "vote-b"] },
      reports: [{ id: "report-full", reviewId: "review-full", reason: "理由", extraReportField: true }],
      reviewKeys: { "review-full": { createdAt: "now", extra: "kept" } },
      externalReviews: { "osm-full": [{ id: "external-full", overallScore: 3, rating: 2, comment: "外部", extraExternalField: "kept" }] },
      unknownTopLevel: { preserve: true },
    };
    await writeFile(source, JSON.stringify(raw), "utf8");
    const original = JSON.stringify(raw);
    execFileSync(BUN_BIN, bunArgs([path.resolve("scripts/community-ops/export.ts"), "--out", destination]), { cwd: process.cwd(), env: { ...process.env, COMMUNITY_STORE_PATH: source }, encoding: "utf8", ...BUN_SHELL_OPT });
    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual(raw);

    await writeFile(source, "{broken", "utf8");
    await writeFile(destination, original, "utf8");
    expect(() => execFileSync(BUN_BIN, bunArgs([path.resolve("scripts/community-ops/export.ts"), "--out", destination]), { cwd: process.cwd(), env: { ...process.env, COMMUNITY_STORE_PATH: source }, encoding: "utf8", stdio: "pipe", ...BUN_SHELL_OPT })).toThrow();
    expect(await readFile(destination, "utf8")).toBe(original);
  });
});

describe("restore", () => {
  // 動的 import + クロスプロセスファイルロック（loadRawDb → withFileLock）を含むため
  // 兄弟テストと同じく明示タイムアウトを付ける（並列実行下での fs 遅延対策）。
  it(
    "collects external facility ids from externalReviews, reports, and toilets",
    { timeout: 20_000 },
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "dokotoilet-restore-"));
      const source = path.join(dir, "community.json");
      await writeFile(
        source,
        JSON.stringify({
          version: 2,
          toilets: [{ id: "toilet-user-1", name: "通常", reviews: [] }],
          helpfulVotes: {},
          reports: [{ id: "rep-1", reviewId: "gone", toiletId: "od-通報のみ" }],
          reviewKeys: {},
          externalReviews: {
            "osm-キーだけ": [],
            "google-ChIJxxx": [{ id: "r1", rating: 3 }],
            "invalid-id": [],
          },
        }),
        "utf8"
      );
      const { collectExternalFacilityIds } = await import("./restore");
      expect(await collectExternalFacilityIds(source)).toEqual([
        "google-ChIJxxx",
        "od-通報のみ",
        "osm-キーだけ",
      ]);
    }
  );

  it("treats a missing data file as nothing to restore", async () => {
    const { collectExternalFacilityIds } = await import("./restore");
    expect(await collectExternalFacilityIds(path.join(os.tmpdir(), "dokotoilet-restore-missing", "community.json"))).toEqual([]);
  });

  it("plans and applies restoration through the repository contract", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dokotoilet-restore-cli-"));
    const source = path.join(dir, "community.json");
    await writeFile(
      source,
      JSON.stringify({
        version: 2,
        toilets: [],
        helpfulVotes: {},
        reports: [],
        reviewKeys: {},
        externalReviews: { "osm-消えた": [] },
      }),
      "utf8"
    );
    const { createConfiguredCommunityStore } = await import("../../server/communityStoreFactory");
    const { applyRestore, planRestore } = await import("./restore");

    const store = createConfiguredCommunityStore({ nodeEnv: "test", jsonPath: path.join(dir, "server-store.json") });
    const before = await planRestore(store, source);
    expect(before.restored).toEqual(["osm-消えた"]);
    const after = await applyRestore(store, source);
    // applyRestore は登録前の計画を返す。restored = 今回登録したID。
    expect(after.restored).toEqual(["osm-消えた"]);
    // repository 経由で書き込まれたことを JSON store で検証
    const verify = new CommunityStore(path.join(dir, "server-store.json"));
    expect(await verify.listKnownExternalFacilityIds()).toContain("osm-消えた");
    // 再実行すればもう復元対象はない
    const rerun = await planRestore(store, source);
    expect(rerun.restored).toEqual([]);
    expect(rerun.alreadyKnown).toEqual(["osm-消えた"]);
  });

  it("restores via the CLI with dry-run by default and --apply writing", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dokotoilet-restore-cli2-"));
    // 実運用どおり store ファイルとデータファイルを同一パスにする
    const source = path.join(dir, "community.json");
    await writeFile(
      source,
      JSON.stringify({
        version: 2,
        toilets: [],
        helpfulVotes: {},
        reports: [],
        reviewKeys: {},
        externalReviews: { "google-復元": [] },
      }),
      "utf8"
    );
    const env = { ...process.env, COMMUNITY_STORE_PATH: source };
    const run = (args: string[]) =>
      execFileSync(BUN_BIN, bunArgs([path.resolve("scripts/community-ops/restore.ts"), ...args]), {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
        ...BUN_SHELL_OPT,
      });

    const dry = run([]);
    expect(dry).toContain("dry-run");
    expect(dry).toContain("google-復元");
    expect(dry).toContain("すでに既知: 1件");
    // dry-run では書き込まない（データファイルは無傷）
    expect(JSON.parse(await readFile(source, "utf8"))).toMatchObject({
      externalReviews: { "google-復元": [] },
    });

    // curation で痕跡ごと消えた施設は、バックアップ（--from）から復元する
    const backup = path.join(dir, "backup.json");
    await writeFile(
      backup,
      JSON.stringify({
        version: 2,
        toilets: [],
        helpfulVotes: {},
        reports: [],
        reviewKeys: {},
        externalReviews: { "osm-curation-消滅": [{ id: "r-old", rating: 4 }] },
      }),
      "utf8"
    );
    const fromBackup = run(["--from", backup]);
    expect(fromBackup).toContain("osm-curation-消滅");
    expect(fromBackup).toContain("復元対象: 1件");

    run(["--apply", "--from", backup]);
    const verify = new CommunityStore(source);
    const ids = await verify.listKnownExternalFacilityIds();
    expect(ids).toContain("google-復元");
    expect(ids).toContain("osm-curation-消滅");
  });
});

describe("commit CLI", () => {
  it("commits only the selected data file and preserves unrelated staged changes", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dokotoilet-commit-"));
    const selected = path.join(dir, "community data.json");
    const unrelated = path.join(dir, "unrelated.txt");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    await writeFile(selected, JSON.stringify({ version: 2, toilets: [], helpfulVotes: {}, reports: [], reviewKeys: {}, externalReviews: {} }), "utf8");
    await writeFile(unrelated, "baseline\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "baseline"], { cwd: dir });
    await writeFile(selected, JSON.stringify({ version: 2, toilets: [{ id: "toilet-user-1", name: "追加", reviews: [] }], helpfulVotes: {}, reports: [], reviewKeys: {}, externalReviews: {} }), "utf8");
    await writeFile(unrelated, "staged unrelated\n", "utf8");
    execFileSync("git", ["add", "--", unrelated, selected], { cwd: dir });
    await writeFile(selected, JSON.stringify({ version: 2, toilets: [{ id: "toilet-user-1", name: "追加（未ステージ変更）", reviews: [] }], helpfulVotes: {}, reports: [], reviewKeys: {}, externalReviews: {} }), "utf8");
    await writeFile(unrelated, "staged unrelated plus unstaged\n", "utf8");
    execFileSync(BUN_BIN, bunArgs([path.resolve("scripts/community-ops/commit.ts"), "--commit", "--new", selected]), { cwd: dir, env: { ...process.env, COMMUNITY_STORE_PATH: selected }, encoding: "utf8", ...BUN_SHELL_OPT });
    const committed = execFileSync("git", ["show", "HEAD:community data.json"], { cwd: dir, encoding: "utf8" });
    expect(JSON.parse(committed).toilets[0].name).toBe("追加（未ステージ変更）");
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf8" }).trim()).toBe("unrelated.txt");
    expect(await readFile(unrelated, "utf8")).toBe("staged unrelated plus unstaged\n");
  });
});

// ── stats ──

describe("stats", () => {
  it("counts facilities, reviews, reports and votes", () => {
    const d = db({
      toilets: [
        facility("toilet-user-1", "A", [rev("r1")]),
        facility("toilet-user-2", "B", [rev("r2"), rev("r3")]),
        facility("osm-x", "C", []), // 通常は無いが念のためother扱い
      ],
      helpfulVotes: { r1: ["h1", "h2"], r2: ["h3"] },
      reports: [report("rep-1")],
      externalReviews: { "osm-1": [rev("e1")], "osm-2": [rev("e2"), rev("e3")] },
    });
    const s = stats(d);
    expect(s.communityToilets).toBe(2);
    expect(s.otherToilets).toBe(1);
    expect(s.toiletReviews).toBe(3);
    expect(s.externalReviewFacilities).toBe(2);
    expect(s.externalReviews).toBe(3);
    expect(s.reports).toBe(1);
    expect(s.voteReviews).toBe(2);
    expect(s.votes).toBe(3);
  });
});

describe("formatStats", () => {
  it("renders a one-line summary", () => {
    const line = formatStats(db({ toilets: [facility("toilet-user-1", "A", [rev("r1")])] }), "data/community.json");
    expect(line).toContain("data/community.json");
    expect(line).toContain("施設 1");
    expect(line).toContain("口コミ 1");
  });
});

// ── diffStores ──

describe("diffStores", () => {
  const before = db({
    toilets: [
      facility("toilet-user-A", "既存A", [rev("r1")]),
      facility("toilet-user-B", "消えるB", [rev("r2")]),
    ],
    helpfulVotes: { rv1: ["hash-old-1"] },
    reports: [report("rep-1")],
    externalReviews: { "osm-1": [rev("e1")], "osm-2": [rev("e2")] },
  });

  it("reports added/removed toilets, review deltas, reports and votes", () => {
    const after = db({
      toilets: [
        facility("toilet-user-A", "既存A", [rev("r1"), rev("r3", { userName: "はなこ", rating: 4, comment: "追加コメント", createdAt: "2026-09-05" })]),
        facility("toilet-user-C", "新しいC", []),
      ],
      helpfulVotes: { rv1: ["hash-old-1", "hash-new-2"], rv2: ["hash-new-3"] },
      reports: [report("rep-1"), report("rep-2", { reviewId: "r3", reason: "いたずら" })],
      externalReviews: {
        "osm-1": [rev("e1"), rev("e4", { userName: "じろう", comment: "外部追加" })],
        "osm-3": [rev("e5")],
      },
    });
    const diff = diffStores(before, after);

    expect(diff.addedToilets.map((t) => t.id)).toEqual(["toilet-user-C"]);
    expect(diff.removedToilets.map((t) => t.id)).toEqual(["toilet-user-B"]);
    expect(diff.toiletReviewChanges["toilet-user-A"].added.map((r) => r.id)).toEqual(["r3"]);
    expect(diff.toiletReviewChanges["toilet-user-A"].removed).toEqual([]);

    expect(diff.externalReviewChanges["osm-1"].added.map((r) => r.id)).toEqual(["e4"]);
    // osm-2 のレビューが消えた（＝手動キュレーションによる外部レビュー削除）
    expect(diff.externalReviewChanges["osm-2"].removed.map((r) => r.id)).toEqual(["e2"]);
    expect(diff.externalReviewChanges["osm-3"].added.map((r) => r.id)).toEqual(["e5"]);

    expect(diff.addedReports.map((r) => r.id)).toEqual(["rep-2"]);
    expect(diff.removedReports).toEqual([]);

    expect(diff.addedVotes).toBe(2); // rv1 に1票 + rv2 に1票
    expect(diff.removedVotes).toBe(0);
    expect(diff.addedVoteReviewIds).toContain("rv1");
    expect(diff.addedVoteReviewIds).toContain("rv2");
    expect(isDiffEmpty(diff)).toBe(false);
  });

  it("is empty when the databases are identical", () => {
    const d = db({ toilets: [facility("toilet-user-A", "A", [rev("r1")])] });
    const diff = diffStores(d, d);
    expect(isDiffEmpty(diff)).toBe(true);
    expect(buildCommitSubject(diff)).toBeNull();
  });

  it("detects same-id content changes as modified, not silent (#111)", () => {
    const beforeOnly = db({
      toilets: [
        facility("toilet-user-A", "既存A", [rev("r1"), rev("r9", { comment: "元の本文", rating: 5 })]),
      ],
      helpfulVotes: {},
      reports: [],
      externalReviews: {},
    });
    const afterOnly = db({
      toilets: [
        facility("toilet-user-A", "既存A", [rev("r1"), rev("r9", { comment: "改竄された本文", rating: 1 })]),
      ],
      helpfulVotes: {},
      reports: [],
      externalReviews: {},
    });
    const diff = diffStores(beforeOnly, afterOnly);
    expect(diff.toiletReviewChanges["toilet-user-A"].added).toEqual([]);
    expect(diff.toiletReviewChanges["toilet-user-A"].removed).toEqual([]);
    const mod = diff.toiletReviewChanges["toilet-user-A"].modified;
    expect(mod).toHaveLength(1);
    expect(mod[0].before.comment).toBe("元の本文");
    expect(mod[0].after.comment).toBe("改竄された本文");
    expect(isDiffEmpty(diff)).toBe(false);
    expect(countDiff(diff).modifiedReviews).toBe(1);
    expect(buildCommitSubject(diff)).toContain("内容変更");
  });

  it("detects vote removal (manual curation)", () => {
    const after = db({
      helpfulVotes: {},
      toilets: [facility("toilet-user-A", "A", [rev("r1")])],
    });
    const diff = diffStores(before, after);
    expect(diff.removedVotes).toBe(1);
    expect(diff.addedVotes).toBe(0);
  });
});

// ── formatDiff / buildCommit ──

describe("formatDiff / buildCommit", () => {
  const after = db({
    toilets: [
      facility("toilet-user-A", "既存A", [
        rev("r1"),
        rev("r3", { userName: "はなこ", rating: 4, comment: "先週よりきれい", createdAt: "2026-09-05" }),
      ]),
      facility("toilet-user-C", "新しいC", []),
    ],
    helpfulVotes: { rv1: ["iphash-aaaaaaaaaaaaaaaa"] },
    reports: [report("rep-9", { reviewId: "r3", reason: "不適切な表現" })],
  });
  const diff = diffStores(db({ toilets: [facility("toilet-user-A", "既存A", [rev("r1")])] }), after);

  it("shows review text by default and never leaks ipHash values", () => {
    const text = formatDiff(diff);
    expect(text).toContain("=== コミュニティデータ差分 ===");
    expect(text).toContain("はなこ");
    expect(text).toContain("先週よりきれい");
    expect(text).toContain("不適切な表現"); // 通報理由
    expect(text).toContain("追加施設");
    expect(text).not.toContain("iphash-aaaaaaaaaaaaaaaa"); // ipHash は出力しない
    expect(text).not.toContain("hash");
  });

  it("counts-only mode hides bodies but keeps counts", () => {
    const text = formatDiff(diff, { countsOnly: true });
    expect(text).toContain("施設: +1 / -0");
    expect(text).toContain("口コミ: +1 / -0");
    expect(text).toContain("通報: +1 / -0");
    expect(text).not.toContain("はなこ");
    expect(text).not.toContain("先週よりきれい");
    expect(text).not.toContain("不適切な表現");
  });

  it("builds a conventional commit message from the diff", () => {
    const subject = buildCommitSubject(diff);
    expect(subject).toBe("chore(data): コミュニティデータ更新（施設+1/-0, 口コミ+1/-0, 通報+1/-0, 投票+1/-0）");
    const body = buildCommitBody(diff);
    expect(body).toContain("追加施設: toilet-user-C");
    expect(body).toContain("新規通報: rep-9");
  });
});
