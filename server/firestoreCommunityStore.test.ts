import { describe, expect, it } from "vitest";
import type { ToiletFacility } from "../src/types";
import {
  FirestoreCommunityStore,
  type FirestoreCollectionLike,
  type FirestoreDocumentRefLike,
  type FirestoreDocumentSnapshotLike,
  type FirestoreLike,
  type FirestoreQueryLike,
  type FirestoreQuerySnapshotLike,
  type FirestoreTransactionLike,
} from "./firestoreCommunityStore";

type Plain = Record<string, any>;

class Snap implements FirestoreDocumentSnapshotLike {
  constructor(public id: string, private value: Plain | undefined) {}
  get exists() { return this.value !== undefined; }
  data() { return this.value === undefined ? undefined : structuredClone(this.value); }
}

class FakeFirestore implements FirestoreLike {
  readonly data = new Map<string, Map<string, Plain>>();
  private queue: Promise<void> = Promise.resolve();
  queryGetCount = 0;

  bucket(name: string) {
    let bucket = this.data.get(name);
    if (!bucket) {
      bucket = new Map();
      this.data.set(name, bucket);
    }
    return bucket;
  }

  collection(name: string): FirestoreCollectionLike {
    return new Collection(this, name, []);
  }

  async runTransaction<T>(fn: (tx: FirestoreTransactionLike) => Promise<T>): Promise<T> {
    let result!: T;
    const op = this.queue.then(async () => {
      const tx = new Tx(this);
      result = await fn(tx);
      tx.commit();
    });
    this.queue = op.catch(() => undefined);
    await op;
    return result;
  }
}

class DocRef implements FirestoreDocumentRefLike {
  constructor(private db: FakeFirestore, private col: string, public id: string) {}
  async get() { return new Snap(this.id, this.db.bucket(this.col).get(this.id)); }
  async create(data: Plain) {
    const bucket = this.db.bucket(this.col);
    if (bucket.has(this.id)) {
      const e = new Error("already exists") as Error & { code?: number };
      e.code = 6;
      throw e;
    }
    bucket.set(this.id, structuredClone(data));
  }
  async set(data: Plain, options?: Plain) {
    const bucket = this.db.bucket(this.col);
    const current = bucket.get(this.id);
    bucket.set(
      this.id,
      options?.merge && current ? { ...current, ...structuredClone(data) } : structuredClone(data)
    );
  }
}

class Collection implements FirestoreCollectionLike {
  constructor(
    private db: FakeFirestore,
    private name: string,
    private filters: Array<[string, unknown]>
  ) {}
  doc(id = `auto-${Math.random()}`) { return new DocRef(this.db, this.name, id); }
  where(field: string, _op: "==", value: unknown): FirestoreQueryLike {
    return new Collection(this.db, this.name, [...this.filters, [field, value]]);
  }
  async get(): Promise<FirestoreQuerySnapshotLike> {
    this.db.queryGetCount += 1;
    const docs: FirestoreDocumentSnapshotLike[] = [];
    for (const [id, value] of this.db.bucket(this.name)) {
      if (this.filters.every(([field, expected]) => value[field] === expected)) {
        docs.push(new Snap(id, value));
      }
    }
    return { docs };
  }
}

class Tx implements FirestoreTransactionLike {
  private writes: Array<() => void> = [];
  constructor(private db: FakeFirestore) {}
  async get(ref: FirestoreDocumentRefLike): Promise<FirestoreDocumentSnapshotLike>;
  async get(query: FirestoreQueryLike): Promise<FirestoreQuerySnapshotLike>;
  async get(ref: FirestoreDocumentRefLike | FirestoreQueryLike) {
    return ref.get();
  }
  create(ref: FirestoreDocumentRefLike, data: Plain) {
    this.writes.push(() => {
      const r = ref as DocRef;
      const col = (r as any).col as string;
      const bucket = this.db.bucket(col);
      if (bucket.has(ref.id)) throw new Error(`already exists: ${ref.id}`);
      bucket.set(ref.id, structuredClone(data));
    });
    return this;
  }
  set(ref: FirestoreDocumentRefLike, data: Plain, options?: Plain) {
    this.writes.push(() => {
      const r = ref as DocRef;
      const col = (r as any).col as string;
      const bucket = this.db.bucket(col);
      const current = bucket.get(ref.id);
      bucket.set(
        ref.id,
        options?.merge && current ? { ...current, ...structuredClone(data) } : structuredClone(data)
      );
    });
    return this;
  }
  update(ref: FirestoreDocumentRefLike, data: Plain) {
    this.writes.push(() => {
      const r = ref as DocRef;
      const col = (r as any).col as string;
      const bucket = this.db.bucket(col);
      const current = bucket.get(ref.id);
      if (!current) throw new Error(`missing document: ${ref.id}`);
      bucket.set(ref.id, { ...current, ...structuredClone(data) });
    });
    return this;
  }
  commit() { for (const write of this.writes) write(); }
}

function facility(id = "toilet-user-a"): ToiletFacility {
  return {
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
    openingHours: "unknown",
    description: "x",
    reviewCount: 0,
    reviews: [],
  };
}

const review = (comment: string) => ({
  userName: "u",
  overallScore: 5,
  cleanlinessScore: 4,
  odorScore: 3,
  suppliesScore: 2,
  comment,
});

describe("FirestoreCommunityStore", () => {
  it("atomically creates a community facility and updates aggregate score fields", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreCommunityStore(db);
    expect(await store.addToilet(facility())).toEqual({ added: true });
    expect(await store.addToilet(facility())).toEqual({ added: false });

    const result = await store.addReview("toilet-user-a", review("clean"), "ip-a");
    expect(result.error).toBeUndefined();
    expect(result.toilet?.reviewCount).toBe(1);
    expect(result.toilet?.cleanlinessScore).toBe(4);
    expect(result.toilet?.overallScore).toBe(5);
  });

  it("loads all community facilities with two collection queries instead of N+1", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreCommunityStore(db);
    await store.addToilet(facility("toilet-user-a"));
    await store.addToilet(facility("toilet-user-b"));
    await store.addReview("toilet-user-a", review("a"), "ip-a");
    await store.addReview("toilet-user-b", review("b"), "ip-b");

    db.queryGetCount = 0;
    const toilets = await store.getToilets();

    expect(db.queryGetCount).toBe(2);
    expect(toilets).toHaveLength(2);
    expect(toilets.every((toilet) => toilet.reviewCount === 1)).toBe(true);
  });

  it("rejects unknown external ids and enforces 24h duplicate review guards", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreCommunityStore(db);
    expect((await store.addReview("osm-node-1", review("clean"), "ip-a")).error).toBe("not_found");

    await store.registerExternalFacilities!([
      { id: "osm-node-1", source: "osm", origin: "live-osm" },
    ]);
    expect((await store.addReview("osm-node-1", review("clean"), "ip-a")).error).toBeUndefined();
    expect((await store.addReview("osm-node-1", review("clean"), "ip-a")).error).toBe("duplicate");
    // 正規化ガード（JSON バックエンドと同一規約）: 大文字小文字・空白違いも重複扱い
    expect((await store.addReview("osm-node-1", review("  CLEAN  "), "ip-a")).error).toBe("duplicate");
    expect((await store.addReview("osm-node-1", review("Clean\t"), "ip-a")).error).toBe("duplicate");
    expect((await store.addReview("osm-node-1", review("different"), "ip-a")).error).toBeUndefined();
    expect((await store.getExternalReviews())["osm-node-1"]).toHaveLength(2);
  });

  it("allows only one helpful increment under concurrent duplicate votes", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreCommunityStore(db);
    await store.registerExternalFacilities!([
      { id: "osm-node-1", source: "osm", origin: "live-osm" },
    ]);
    const added = await store.addReview("osm-node-1", review("clean"), "ip-a");
    const reviewId = added.reviews![0].id;

    const results = await Promise.all([
      store.voteHelpful(reviewId, "same-ip"),
      store.voteHelpful(reviewId, "same-ip"),
    ]);
    expect(results.filter((r) => r.voted)).toHaveLength(1);
    expect(results.every((r) => r.helpfulCount === 1)).toBe(true);
  });

  it("creates reports only when the review belongs to the supplied facility", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreCommunityStore(db);
    await store.registerExternalFacilities!([
      { id: "osm-node-1", source: "osm", origin: "migration" },
    ]);
    const added = await store.addReview("osm-node-1", review("clean"), "ip-a");
    const reviewId = added.reviews![0].id;
    expect(await store.addReport("wrong", reviewId, "reason")).toEqual({ ok: false, found: false });
    expect(await store.addReport("osm-node-1", reviewId, "reason")).toEqual({ ok: true, found: true });
    expect(db.bucket("reports").size).toBe(1);
  });

  it("serializes duplicate reports and permits a new report after resolution", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreCommunityStore(db);
    await store.registerExternalFacilities!([{ id: "osm-node-1", source: "osm", origin: "migration" }]);
    const added = await store.addReview("osm-node-1", review("clean"), "ip-a");
    const reviewId = added.reviews![0].id;
    const results = await Promise.all([
      store.addReport("osm-node-1", reviewId, "same reason"),
      store.addReport("osm-node-1", reviewId, "same reason"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    const reportId = [...db.bucket("reports").keys()][0];
    expect((await store.resolveReport(reportId)).found).toBe(true);
    expect((await store.addReport("osm-node-1", reviewId, "same reason")).ok).toBe(true);
  });

  it("deletes a review and recomputes its aggregate in the same transaction", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreCommunityStore(db);
    await store.addToilet(facility());
    const added = await store.addReview("toilet-user-a", review("clean"), "ip-a");
    const reviewId = added.toilet!.reviews[0].id;
    expect((await store.deleteReview(reviewId)).reviewCount).toBe(0);
    expect(await store.voteHelpful(reviewId, "after-delete")).toEqual({
      helpfulCount: 0,
      voted: false,
      found: false,
    });
    expect(db.bucket("facility_aggregates").get("toilet-user-a")).toMatchObject({ reviewCount: 0 });
    expect((await store.getToilets())[0].reviewCount).toBe(0);
  });

  it("lists known external facility ids after registration", async () => {
    const db = new FakeFirestore();
    const store = new FirestoreCommunityStore(db);
    expect(await store.listKnownExternalFacilityIds()).toEqual([]);
    await store.registerExternalFacilities!([
      { id: "osm-node-b", source: "osm", origin: "restore" },
      { id: "google-node-a", source: "google", origin: "restore" },
    ]);
    expect(await store.listKnownExternalFacilityIds()).toEqual(["google-node-a", "osm-node-b"]);
  });
});
