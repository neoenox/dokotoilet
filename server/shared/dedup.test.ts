import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  dedupCommentHash,
  normalizeDedupText,
  normalizeReportReason,
  reviewDedupId,
} from "./dedup";

describe("normalizeDedupText", () => {
  it("collapses whitespace runs to single spaces, trims, lowercases", () => {
    expect(normalizeDedupText("  Clean   toilet  ")).toBe("clean toilet");
    expect(normalizeDedupText("Clean\t\ntoilet")).toBe("clean toilet");
    expect(normalizeDedupText("きれい　でした")).toBe("きれい でした"); // 全角空白も圧縮
    expect(normalizeDedupText("Clean TOILET")).toBe("clean toilet");
  });

  it("treats case/whitespace variants of the same comment as equal", () => {
    const variants = ["clean toilet", "Clean  Toilet", "  CLEAN\tTOILET ", "clean toilet"];
    const forms = new Set(variants.map(normalizeDedupText));
    expect(forms.size).toBe(1);
  });

  it("keeps distinct comments distinct", () => {
    expect(normalizeDedupText("clean toilet")).not.toBe(normalizeDedupText("dirty toilet"));
  });

  it("canonicalizes composed/decomposed forms to the same key (NFC)", () => {
    // é（合成済み U+00E9）と e + 結合鋭アクセント（U+0065 U+0301）は同一視する
    expect(normalizeDedupText("caf\u00e9")).toBe(normalizeDedupText("cafe\u0301"));
    // ハングル Jamo 分解形と合成済みも同一視する
    expect(normalizeDedupText("가")).toBe(normalizeDedupText("\u1100\u1161"));
  });
});

describe("reviewDedupId", () => {
  it("matches the documented formula over the normalized comment", () => {
    // docs/durable-community-backend.md: sha256(facilityId|ipHash|normalizedComment)
    const expected = crypto
      .createHash("sha256")
      .update("osm-node-1|ip-a|clean toilet")
      .digest("hex");
    expect(reviewDedupId("osm-node-1", "ip-a", "  Clean  TOILET ")).toBe(expected);
  });

  it("gives case/whitespace variants the same dedup doc (Firestore parity with JSON)", () => {
    const a = reviewDedupId("osm-node-1", "ip-a", "clean toilet");
    const b = reviewDedupId("osm-node-1", "ip-a", "CLEAN   toilet ");
    expect(a).toBe(b);
  });

  it("separates by facility and ipHash", () => {
    const base = reviewDedupId("osm-node-1", "ip-a", "clean");
    expect(reviewDedupId("osm-node-2", "ip-a", "clean")).not.toBe(base);
    expect(reviewDedupId("osm-node-1", "ip-b", "clean")).not.toBe(base);
  });
});

describe("dedupCommentHash / normalizeReportReason", () => {
  it("hashes the normalized form, not the raw comment", () => {
    const expected = crypto
      .createHash("sha256")
      .update("clean toilet")
      .digest("hex");
    expect(dedupCommentHash("  Clean  TOILET ")).toBe(expected);
  });

  it("normalizes report reasons with the same rule as comments", () => {
    expect(normalizeReportReason(" Same  Reason ")).toBe("same reason");
    expect(normalizeReportReason("Same\tREASON")).toBe(normalizeDedupText("same reason"));
  });
});
