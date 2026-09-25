// CommunityStore GET経路（ロックなし読み取り + mtime+size キャッシュ検証）のテスト。
//
// 検証方針:
//  - 読み取りはロックを取らないこと（残留ロックがあっても GET が完了することで証明。
//    もし読み取りがロックを取る実装に戻った場合、この TEST は 10 秒のロック待ちで
//    失敗する）
//  - キャッシュ検証は fs.readFile の呼び出し回数で確認（ヒット時は読み直さない）
//  - mtime か size のどちらか一方だけが変わった場合も無効化されること
//    （utimes で時刻を固定し、「mtime同一・size不同」「mtime不同・size同一」の
//    両極端を再現する）
//  - 別ストアハンドル・curation CLI 相当の書き込み（withFileLock + atomicWriteFile）
//    が即座に見えること（旧実装の「ライブキャッシュが削除を蘇らせる」問題の回帰防止）
import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommunityStore } from "./community";
import { atomicWriteFile, withFileLock } from "./shared/persistence";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function makeStore(): Promise<{ store: CommunityStore; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "community-cache-"));
  tempDirs.push(dir);
  const file = path.join(dir, "community.json");
  return { store: new CommunityStore(file), file };
}

const emptyDb = () => ({
  version: 2,
  toilets: [],
  helpfulVotes: {},
  reports: [],
  reviewKeys: {},
  externalReviews: {},
});

const toilet = (id: string): any => ({
  id,
  name: id,
  facilityType: "公衆トイレ",
  category: "park",
  dataSource: "community",
  lat: 35,
  lng: 139,
  address: "x",
  cleanlinessGrade: "B",
  cleanlinessScore: 3,
  equipmentGrade: "B",
  equipmentScore: 3,
  subScores: { cleanliness: 3, odor: 3, supplies: 3, comfort: 3 },
  attributes: {
    hasWashlet: false,
    hasMultipurpose: false,
    hasBabyTable: false,
    hasNursingRoom: false,
    hasPowderRoom: false,
    hasOstomate: false,
    isFree: true,
    isOpen24h: false,
    hasSoap: false,
    hasAlcohol: false,
    hasPaperTowelOrDryer: false,
    toiletStyle: "both",
  },
  openingHours: "x",
  description: "x",
  reviewCount: 0,
  reviews: [],
});

describe("CommunityStore lock-free GET with mtime+size validation", () => {
  it("serves GET while a leftover lock exists (reads never take the file lock)", async () => {
    const { store, file } = await makeStore();
    await atomicWriteFile(
      file,
      JSON.stringify({ ...emptyDb(), toilets: [toilet("toilet-user-a")] })
    );
    // 強制終了したプロセスが残したロックを再現。
    await fs.mkdir(`${file}.lock`);

    const started = Date.now();
    const toilets = await store.getToilets();
    expect(Date.now() - started).toBeLessThan(5_000); // ロック待ち（10秒）していない
    expect(toilets.map((t) => t.id)).toEqual(["toilet-user-a"]);
    expect((await store.getExternalReviews())["google-x"] ?? []).toEqual([]);
  });

  it("serves cache hits without re-reading and invalidates on an mtime-only change", async () => {
    const { store, file } = await makeStore();
    await store.addToilet(toilet("toilet-user-a"));
    await store.getToilets(); // ウォームアップ

    const readFileSpy = vi.spyOn(fs, "readFile");
    const first = await store.getToilets();
    const second = await store.getToilets();
    expect(second).toEqual(first);
    expect(readFileSpy).not.toHaveBeenCalled(); // size も mtime も不変 → 読み直さない

    // size を変えずに mtime だけ進める（touch 相当）
    const stat = await fs.stat(file);
    const later = new Date(stat.mtimeMs + 5_000);
    await fs.utimes(file, later, later);
    await store.getToilets();
    expect(readFileSpy).toHaveBeenCalledTimes(1); // mtime 不一致 → 読み直し
  });

  it("invalidates the cache when only the size changes", async () => {
    const { store, file } = await makeStore();
    // mtime を固定してからキャッシュを温める
    const past = new Date(Date.now() - 120_000);
    await atomicWriteFile(file, JSON.stringify(emptyDb()));
    await fs.utimes(file, past, past);
    await store.getToilets();

    const readFileSpy = vi.spyOn(fs, "readFile");
    // mtime を同じ値に戻したまま size のみ変える
    await fs.writeFile(
      file,
      JSON.stringify({ ...emptyDb(), toilets: [toilet("toilet-user-a")] }),
      "utf-8"
    );
    await fs.utimes(file, past, past);

    const toilets = await store.getToilets();
    expect(toilets.map((t) => t.id)).toEqual(["toilet-user-a"]);
    expect(readFileSpy).toHaveBeenCalledTimes(1); // size 不一致 → 読み直し
  });

  it("treats a deleted file as empty and recovers when it reappears", async () => {
    const { store, file } = await makeStore();
    await store.addToilet(toilet("toilet-user-a"));
    await store.registerExternalFacilities([
      { id: "osm-一時", source: "osm", origin: "restore" },
    ]);
    expect(await store.getToilets()).toHaveLength(1);

    await fs.rm(file);
    expect(await store.getToilets()).toEqual([]);
    expect(await store.listKnownExternalFacilityIds()).toEqual([]);

    await store.addToilet(toilet("toilet-user-a"));
    expect(await store.getToilets()).toHaveLength(1);
  });

  it("sees writes from another store handle immediately (no stale cache)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "community-cache-"));
    tempDirs.push(dir);
    const file = path.join(dir, "community.json");
    const serverStore = new CommunityStore(file);
    const cliStore = new CommunityStore(file);

    await serverStore.addToilet(toilet("toilet-user-a"));
    await cliStore.addToilet(toilet("toilet-user-b"));

    const serverView = await serverStore.getToilets();
    expect(serverView.map((t) => t.id).sort()).toEqual([
      "toilet-user-a",
      "toilet-user-b",
    ]);

    // CLI 側がサーバーの知らない外部施設を登録した場合も、次の読み取りで見える
    await cliStore.registerExternalFacilities([
      { id: "osm-外部追加", source: "osm", origin: "restore" },
    ]);
    expect(await serverStore.listKnownExternalFacilityIds()).toContain(
      "osm-外部追加"
    );
  });

  it("does not resurrect a curator deletion through the cache", async () => {
    const { store, file } = await makeStore();
    await store.addToilet(toilet("toilet-user-a"));
    await store.addReview(
      "toilet-user-a",
      {
        userName: "t",
        overallScore: 4,
        cleanlinessScore: 4,
        odorScore: 4,
        suppliesScore: 4,
        comment: "キャッシュ検証",
      } as any,
      "ip-a"
    );
    expect((await store.getToilets())[0].reviews).toHaveLength(1);

    // curation CLI と同じ経路（withFileLock + atomicWriteFile）でレビューを削除
    await withFileLock(file, async () => {
      const db = JSON.parse(await fs.readFile(file, "utf-8"));
      db.toilets[0].reviews = [];
      db.toilets[0].reviewCount = 0;
      await atomicWriteFile(file, JSON.stringify(db));
    });

    const after = await store.getToilets();
    expect(after[0].reviews).toEqual([]);
    expect(after[0].reviewCount).toBe(0);
  });

  it("returns isolated snapshots so callers cannot corrupt the cache", async () => {
    const { store } = await makeStore();
    await store.addToilet(toilet("toilet-user-a"));

    const snapshot = await store.load();
    snapshot.toilets.length = 0;
    (snapshot.externalReviews as any)["汚染"] = [{ id: "x" }];

    expect(await store.getToilets()).toHaveLength(1);
    expect((await store.getExternalReviews())["汚染"]).toBeUndefined();
  });
});

describe("curation writes refresh the mtime+size cache", () => {
  const reviewBody = {
    userName: "t",
    overallScore: 4,
    cleanlinessScore: 4,
    odorScore: 4,
    suppliesScore: 4,
    comment: "curation cache refresh",
  } as any;

  it("resolveReport reflects in subsequent reads without a cache miss", async () => {
    const { store } = await makeStore();
    await store.addToilet(toilet("toilet-user-a"));
    const added = await store.addReview("toilet-user-a", reviewBody, "ip-a");
    expect(added.toilet?.reviews?.[0]?.id).toBeTruthy();
    const reviewId = added.toilet!.reviews[0].id as string;
    await store.addReport("toilet-user-a", reviewId, "spam");

    const reports = await store.listReports();
    expect(reports).toHaveLength(1);
    const reportId = reports[0].id;

    // resolveReport 前にキャッシュをウォームアップ（旧実装の検証経路を再現）
    expect((await store.listReports())[0].status).toBe("open");

    const r = await store.resolveReport(reportId, "ok");
    expect(r.found).toBe(true);

    // refreshCacheAfterWrite 相当の整合: 次の読み取りで resolved が見える
    expect((await store.listReports())[0].status).toBe("resolved");
    expect((await store.load()).reports[0].status).toBe("resolved");
  });

  it("deleteReview reflects in subsequent reads without a cache miss", async () => {
    const { store } = await makeStore();
    await store.addToilet(toilet("toilet-user-a"));
    const added = await store.addReview("toilet-user-a", reviewBody, "ip-a");
    const reviewId = added.toilet!.reviews[0].id as string;
    expect((await store.getToilets())[0].reviewCount).toBe(1);

    const r = await store.deleteReview(reviewId, "admin delete");
    expect(r.found).toBe(true);
    expect(r.kind).toBe("community");

    // 削除がキャッシュ経由の読み取りでも見えること（レビュー・スコア・通報状態）
    const after = (await store.getToilets())[0];
    expect(after.reviewCount).toBe(0);
    expect(after.reviews).toEqual([]);
    expect((await store.load()).helpfulVotes[reviewId]).toBeUndefined();
  });

  it("deleteReview on an external review reflects in subsequent reads", async () => {
    const { store } = await makeStore();
    await store.registerExternalFacilities([
      { id: "osm-消したい", source: "osm", origin: "restore" },
    ]);
    const added = await store.addReview("osm-消したい", reviewBody, "ip-a");
    const reviewId = added.reviews?.[0]?.id;
    expect(reviewId).toBeTruthy();
    expect(Object.values(await store.getExternalReviews())[0]).toHaveLength(1);

    const r = await store.deleteReview(reviewId!, "admin delete");
    expect(r.found).toBe(true);
    expect(r.kind).toBe("external");

    const external = await store.getExternalReviews();
    expect(external["osm-消したい"]).toEqual([]);
    // レビューが0件でも外部施設のキーは保持される（再投稿可能維持）
    expect(Object.keys(external)).toContain("osm-消したい");
  });
});
