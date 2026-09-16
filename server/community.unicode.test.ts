// Adversarial Unicode audit for the user-facing text validators:
// validateReviewInput (userName / comment) and validateReportInput (reason).
//
// Same method as PR #61's external-facility-id table tests: probe the real
// implementation empirically, then pin the observed behavior row by row. This
// suite deliberately does NOT change validator behavior — it freezes what is
// and is not protected today, so any future hardening is a conscious, reviewed
// change that updates these tables deliberately.
//
// ─── Audit summary ──────────────────────────────────────────────
// Protections (current):
//   P1 UTF-16 length caps per field (MAX.userName/comment/reason), checked on
//      the raw input before sanitizing (sanitize never grows the string)
//   P2 non-empty check requires visible content after sanitizing (G2 closed);
//      applies to review/report text AND to toilet-registration fields (name
//      required-visible, address/floorInfo/description fall back to defaults),
//      plus a load-time sanitization migration in CommunityStore.parse() that
//      self-heals legacy rows (persisted on next write)
//   P3 URL-likeness detection via containsUrlLike (shared/textPolicy.ts): NFKC +
//      \p{Cf}/\p{Cc} + Default_Ignorable_Code_Point stripping before URL_RE —
//      G1 closed; URL_RE's over-blocking quirks (bare "http" in prose, TLD-like
//      mentions) are inherited & pinned. DI stripping (found by the property
//      fuzz suite) closes the invisible-character seam for variation selectors
//      and Hangul fillers, which are \p{Mn}/\p{Lo} and survive the sanitizer
//   P4 sanitizeText strips lone surrogates before the JSON persistence layer
//
// Gaps history (originally pinned by PR #62; G1–G3 closed in follow-ups):
//   G1 URL_RE evasion — CLOSED by textPolicy normalization (PR #65)
//   G2 invisible-only content — CLOSED by shared/textPolicy.ts: inputs that
//      leave no visible content after sanitizing (ZWSP/LRM runs) are rejected,
//      and an invisible-only userName falls back to 匿名の利用者
//   G3 control/bidi/tag characters stored verbatim — CLOSED: sanitizeText()
//      strips category-C characters (NUL/BEL/DEL/bidi/tag/surrogates) and
//      rewrites newline controls to spaces before storage. Combining marks,
//      fullwidth forms and emoji are preserved (no normalization)
//   G4 length limits count UTF-16 code units — astral glyphs cost 2 units,
//      so emoji-heavy names get half the perceived budget
//   G5 no NFC normalization: NFD input passes through un-normalized
// ────────────────────────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import {
  validateToiletInput,
  validateReviewInput,
  validateReportInput,
} from "./community";
import { normalizeForUrlScan, containsUrlLike } from "../src/lib/textPolicy";
import { sanitizeText, hasVisibleContent } from "../src/lib/textPolicy";

const goodReview = () => ({
  userName: "たろう",
  overallScore: 4,
  cleanlinessScore: 4,
  odorScore: 4,
  suppliesScore: 4,
  comment: "普通のトイレでした",
});

const goodToilet = () => ({
  id: "toilet-user-abc123",
  name: "テストトイレ",
  category: "park",
  lat: 35.66,
  lng: 139.7,
  cleanlinessScore: 4.5,
});

describe("adversarial Unicode: URL filter (URL_RE)", () => {
  it.each([
    ["https URL", "see https://spam.example"],
    ["uppercase HTTPS URL", "see HTTPS://SPAM.EXAMPLE"],
    ["www host", "see www.spam.example"],
    ["uppercase WWW host", "see WWW.SPAM.EXAMPLE"],
    // RLO *before* the scheme does not help the spammer: URL_RE still sees
    // the literal "https://" — pinned so this stays true.
    ["RLO-prefixed https URL", "\u202Ehttps://spam.example"],
    // 以下は元監査（PR #62）で「G1: 見逃す」と固定されていた行。URL_RE の拡張
    // （h\s*t\s*t\s*p は任意の ASCII "http" に一致、加えてTLDパターン）により
    // 拒否に変わった。意図的な強化であり、この固定により検知された。
    ["ZWSP between ':' and '//' (https:\u200B//)", "https:\u200B//spam.example"],
    ["fullwidth colon", "https\uFF1A//spam.example"],
    // 副作用として、URLでない本文中の "http" やTLD風表記も拒否される（過剰拒否）
    ["bare word http in prose", "これはhttpです"],
    ["TLD-like mention without scheme", "見て spam.example.com"],
    // 以下も元監査（PR #62）で「G1: 見逃す」と固定されていた行。判定前の正規化
    // （NFKC + \p{Cf}/\p{Cc} 除去、shared/textPolicy.ts）により検出に変わった。
    ["LRM inside the scheme (h\u200Ettps://)", "h\u200Ettps://spam.example"],
    ["fullwidth scheme letters", "\uFF48\uFF54\uFF54\uFF50\uFF53://spam.example"],
    ["fullwidth www host", "\uFF57\uFF57\uFF57.\uFF53\uFF50\uFF41\uFF4D.example"],
    // Default_Ignorable_Code_Point な不可視文字（\p{Mn}/\p{Lo} のため sanitizer は
    // 保持するが、表示上まったく見えない）。プロパティファズが Alphabet の網羅性
    // を突いて発見したシームで、textPolicy の DI 除去により検出に変わった。
    ["variation selector 15 inside scheme", "h\uFE0Ettp://spam.example"],
    ["variation selector 16 inside scheme", "h\uFE0Fttp://spam.example"],
    ["Hangul filler inside scheme", "h\u115Fttp://spam.example"],
  ])("rejects %s", (_label, comment) => {
    const r = validateReviewInput({ ...goodReview(), comment });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("comment must not contain URLs");
  });

  it("rejects the LRM-obfuscated URL in report reason too (G1 closed)", () => {
    const r = validateReportInput({ reason: "h\u200Ettps://spam.example" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("reason must not contain URLs");
  });

  it("treats a NEL-split www host in reason as visible prose, aligned with the comment policy", () => {
    // textPolicy 統一までは reason の URL 検出は生入力（urlGuard が NEL を剥がして
    // 検出）だったが、統一により「保存値に対して検出」に揃った。NEL は可視空白へ
    // 置換されるため検出されない（コメント欄と同一ポリシー。不可視難匿ではなく
    // 目に見える区切りの本文として受理する）。
    const r = validateReportInput({ reason: "ww\u0085w.spam.example" });
    expect(r.ok).toBe(true);
    expect(r.value!.reason).toBe("ww w.spam.example");
  });

  it("rejects obfuscated URLs in toilet registration fields too", () => {
    expect(validateToiletInput({ ...goodToilet(), name: "h\u200Ettps://spam.example" }).ok).toBe(false);
    expect(validateToiletInput({ ...goodToilet(), description: "\uFF48\uFF54\uFF54\uFF50\uFF53://spam.example" }).ok).toBe(false);
  });
});

describe("shared/textPolicy normalization semantics", () => {
  it("folds fullwidth forms and strips format characters before matching", () => {
    expect(normalizeForUrlScan("\uFF48\uFF54\uFF54\uFF50")).toBe("http");
    expect(normalizeForUrlScan("h\u200Ettp")).toBe("http");
    // NFKC は本文の互換文字も畳む（検出専用であり、保存値には影響しない）
    expect(normalizeForUrlScan("１２３")).toBe("123");
  });

  it("strips Default_Ignorable_Code_Point invisibles (variation selectors, Hangul fillers)", () => {
    // \p{C} ではないため sanitizer は保持するが、URL 判定の前には除去される
    expect(normalizeForUrlScan("h\uFE0Ettp")).toBe("http");
    expect(normalizeForUrlScan("h\uFE0Fttp")).toBe("http");
    expect(normalizeForUrlScan("h\u115Fttp")).toBe("http");
    expect(normalizeForUrlScan("h\u1160ttp")).toBe("http");
  });

  it("preserves legitimate emoji uses of variation selectors in the stored text", () => {
    // DI 除去は「判定前の一時文字列」だけに適用され、保存値は変更しない。
    // 例: ❤️ (U+2764 + VS16) はサニタイズ後もそのまま保存される。
    const r = validateReviewInput({ ...goodReview(), comment: "きれいなトイレ ❤\uFE0F" });
    expect(r.ok).toBe(true);
    expect(r.value!.comment).toContain("\uFE0F");
    // 一方で同じ文字をURL判定に通すと VS16 は見える位置にないので、検出は
    // URL_RE 本来の挙動に従う（ここでは URL を含まないコメントの例）。
    expect(containsUrlLike("きれいなトイレ ❤\uFE0F")).toBe(false);
  });

  it("is safe on lone surrogates and non-strings", () => {
    expect(() => normalizeForUrlScan("a\uD800b")).not.toThrow();
    expect(containsUrlLike(42)).toBe(false);
    expect(containsUrlLike(null)).toBe(false);
  });
});

describe("adversarial Unicode: invisible-only content is rejected (G2 closed)", () => {
  it.each([
    ["comment of 10 ZWSP", () =>
      validateReviewInput({ ...goodReview(), comment: "\u200B".repeat(10) })],
    ["reason of a single LRM", () => validateReportInput({ reason: "\u200E" })],
    ["reason of two ZWSP", () => validateReportInput({ reason: "\u200B\u200B" })],
  ])("%s is rejected — sanitize leaves no visible content", (_label, run) => {
    const r = run();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid (comment|reason)/);
  });

  it("a ZWSP-only userName falls back to the anonymous default", () => {
    const r = validateReviewInput({ ...goodReview(), userName: "\u200B\u200B" });
    expect(r.ok).toBe(true);
    expect(r.value?.userName).toBe("匿名の利用者");
  });

  it("ZWSP padding around a userName is stripped by the sanitizer", () => {
    const r = validateReviewInput({ ...goodReview(), userName: "\u200Babc\u200B" });
    expect(r.value?.userName).toBe("abc");
  });

  it("a URL-like userName is rejected, not fallen back (#108 display-name spam)", () => {
    for (const spam of [
      "https://spam.example",
      "h\u200Ettps://spam.example",
      "ｈｔｔｐｓ://spam.example",
      "see www.spam-example.com",
    ]) {
      const r = validateReviewInput({ ...goodReview(), userName: spam });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("userName must not contain URLs");
    }
  });
});

describe("adversarial Unicode: control / bidi / unpaired characters are sanitized (G3 closed)", () => {
  it.each([
    ["NUL", "a\u0000b", "ab"],
    ["BEL and DEL", "a\u0007b\u007F", "ab"],
    ["bidi isolate (PDI)", "a\u2069b", "ab"],
    ["Unicode tag character", "a\u{E0041}b", "ab"],
    ["lone high surrogate", "a\uD800b", "ab"],
    ["embedded RLO", "abc\u202Exyz", "abcxyz"],
    ["CRLF and tab become spaces", "line1\r\nline2\tend", "line1 line2 end"],
  ])("comment with %s is sanitized on storage", (_label, comment, expected) => {
    const r = validateReviewInput({ ...goodReview(), comment });
    expect(r.ok).toBe(true);
    expect(r.value?.comment).toBe(expected);
  });

  it.each([
    ["NUL", "a\u0000b", "ab"],
    ["embedded RLO", "abc\u202Exyz", "abcxyz"],
    ["leading combining mark", "\u0301abc", "\u0301abc"], // 結合記号は保持
  ])("userName with %s is sanitized on storage", (_label, userName, expected) => {
    const r = validateReviewInput({ ...goodReview(), userName });
    expect(r.ok).toBe(true);
    expect(r.value?.userName).toBe(expected);
  });

  it("a lone surrogate is stripped before it could reach the JSON persistence layer (P4)", () => {
    const r = validateReviewInput({ ...goodReview(), comment: "a\uD800b" });
    expect(r.value?.comment).toBe("ab");
    const parsed = JSON.parse(JSON.stringify({ comment: r.value?.comment })) as {
      comment: string;
    };
    expect(parsed.comment).toBe("ab");
  });
});

describe("shared/textPolicy sanitizeText semantics", () => {
  it("strips category-C characters and keeps visible text intact", () => {
    expect(sanitizeText("a\u0000b\u200Ex")).toBe("abx");
    expect(sanitizeText("cafe\u0301 desu")).toBe("cafe\u0301 desu"); // 結合記号保持
    expect(sanitizeText("清潔\u{1F600}！")).toBe("清潔\u{1F600}！"); // 絵文字保持
    expect(sanitizeText("\u200B\u200B")).toBe("");
  });

  it("normalizes newline controls to single spaces", () => {
    expect(sanitizeText("line1\r\nline2\tend")).toBe("line1 line2 end");
    expect(sanitizeText("a\u2028b")).toBe("a b");
  });

  it("never grows the string", () => {
    const input = "a\u0000\u200Ebc\u202Dd\r\ne";
    expect(sanitizeText(input).length).toBeLessThanOrEqual(input.length);
  });

  it("hasVisibleContent distinguishes invisible-only from real text", () => {
    expect(hasVisibleContent("\u200B\u200E\u0000")).toBe(false);
    expect(hasVisibleContent("\u200Babc\u200B")).toBe(true);
  });
});

describe("adversarial Unicode: toilet-registration fields", () => {
  it.each([
    ["ZWSP-only name", "\u200B".repeat(10), "invalid name"],
    ["NUL in name (stripped, not stored)", "A\u0000B toilet", undefined],
    ["RLO in name (stripped)", "トイレ\u202Erev", undefined],
    ["LRM-obfuscated URL in name", "h\u200Ettps://spam.example", "name must not contain URLs"],
  ])("%s", (_label, name, error) => {
    const r = validateToiletInput({ ...goodToilet(), name });
    if (error) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe(error);
    } else {
      expect(r.ok).toBe(true);
      expect(r.value!.name).not.toMatch(/\p{C}/u);
    }
  });

  it("falls back to default address when the input is invisible-only", () => {
    const r = validateToiletInput({ ...goodToilet(), address: "\u200B".repeat(10) });
    expect(r.ok).toBe(true);
    expect(r.value!.address).toBe("現在地周辺");
  });

  it("keeps visible emoji and variation selectors in the name", () => {
    const r = validateToiletInput({ ...goodToilet(), name: "きれいなトイレ ❤\uFE0F" });
    expect(r.ok).toBe(true);
    expect(r.value!.name).toContain("\uFE0F");
  });
});

describe("adversarial Unicode: what does work", () => {
  it("trims NBSP and ideographic space (both are Unicode White_Space)", () => {
    const nbsp = validateReviewInput({ ...goodReview(), userName: "\u00A0abc\u00A0" });
    const ideographic = validateReviewInput({ ...goodReview(), userName: "\u3000abc\u3000" });
    expect(nbsp.value?.userName).toBe("abc");
    expect(ideographic.value?.userName).toBe("abc");
  });

  it.each([
    ["userName at exactly 30 UTF-16 units", "userName", "x".repeat(30), true],
    ["userName at 31 UTF-16 units", "userName", "x".repeat(31), false],
    ["userName of 15 astral emoji (30 units)", "userName", "\u{1F600}".repeat(15), true],
    ["userName of 16 astral emoji (32 units)", "userName", "\u{1F600}".repeat(16), false],
    ["comment of 500 astral emoji (1000 units)", "comment", "\u{1F600}".repeat(500), true],
    ["comment of 501 astral emoji (1002 units)", "comment", "\u{1F600}".repeat(501), false],
  ] as const)("%s", (_label, field, value, ok) => {
    const r = validateReviewInput({ ...goodReview(), [field]: value });
    expect(r.ok).toBe(ok);
  });

  it.each([
    ["reason of 250 astral emoji (500 units)", "\u{1F600}".repeat(250), true],
    ["reason of 251 astral emoji (502 units)", "\u{1F600}".repeat(251), false],
  ] as const)("reason length: %s", (_label, reason, ok) => {
    expect(validateReportInput({ reason }).ok).toBe(ok);
  });

  it("accepts NFD text un-normalized (G5) and fullwidth characters as-is", () => {
    const nfd = validateReviewInput({ ...goodReview(), comment: "cafe\u0301 desu" });
    expect(nfd.ok).toBe(true);
    expect(nfd.value?.comment).toBe("cafe\u0301 desu");
    const fullwidth = validateReviewInput({ ...goodReview(), userName: "ＡＢＣ" });
    expect(fullwidth.value?.userName).toBe("ＡＢＣ");
  });

  it("rejects non-string text fields", () => {
    expect(validateReviewInput({ ...goodReview(), userName: 42 }).error).toBe("invalid userName");
    expect(validateReviewInput({ ...goodReview(), comment: ["x"] }).error).toBe("invalid comment");
    expect(validateReportInput({ reason: null }).error).toBe("invalid reason");
  });
});
