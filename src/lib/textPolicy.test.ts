// textPolicy の単体テスト。欄ごとのポリシーテーブル（TEXT_FIELDS）と
// 3つの入り口（validateRequiredText / validateFallbackText / validateOptionalText）
// の挙動を固定する。バリデータ経由の挙動は community.unicode.test.ts と
// community.fuzz.test.ts が網羅しているため、ここではポリシー宣言そのものと
// 分岐の対応を検証する。
import { describe, expect, it } from "vitest";
import {
  TEXT_FIELDS,
  validateFallbackText,
  validateOptionalText,
  validateRequiredText,
} from "./textPolicy";

describe("TEXT_FIELDS policy table", () => {
  // 旧 community.ts の MAX 定数と同じ値であることを固定（長さ上限の後戻り防止）
  it("keeps the legacy MAX values", () => {
    expect(TEXT_FIELDS.toiletName.max).toBe(100);
    expect(TEXT_FIELDS.toiletAddress.max).toBe(200);
    expect(TEXT_FIELDS.toiletFloorInfo.max).toBe(50);
    expect(TEXT_FIELDS.toiletDescription.max).toBe(2000);
    expect(TEXT_FIELDS.comment.max).toBe(1000);
    expect(TEXT_FIELDS.userName.max).toBe(30);
    expect(TEXT_FIELDS.reason.max).toBe(500);
  });

  it("declares the legacy fallback values and URL errors", () => {
    expect(TEXT_FIELDS.toiletAddress.fallback).toBe("現在地周辺");
    expect(TEXT_FIELDS.toiletDescription.fallback).toBe(
      "ユーザーによって登録されたトイレ情報です。"
    );
    expect(TEXT_FIELDS.userName.fallback).toBe("匿名の利用者");
    expect(TEXT_FIELDS.toiletFloorInfo.fallback).toBeUndefined();
    expect(TEXT_FIELDS.comment.urlError).toBe("comment must not contain URLs");
    expect(TEXT_FIELDS.reason.urlError).toBe("reason must not contain URLs");
    expect(TEXT_FIELDS.toiletName.urlError).toBe("name must not contain URLs");
    // userName はURL検出の対象（#108: 表示名スパム対策。検出時は拒否する）
    expect(TEXT_FIELDS.userName.urlError).toBe("userName must not contain URLs");
  });

  it("uses unique field labels and consistent dispositions", () => {
    const entries = Object.values(TEXT_FIELDS);
    const labels = entries.map((p) => p.field);
    expect(new Set(labels).size).toBe(labels.length);
    for (const p of entries) {
      if (p.onInvisibleOnly === "fallback" && p.fallback !== undefined) {
        expect(typeof p.fallback).toBe("string");
      }
    }
  });
});

describe("validateRequiredText", () => {
  const policy = TEXT_FIELDS.comment;

  it("rejects undefined, null, and non-string input", () => {
    expect(validateRequiredText(undefined, policy)).toEqual({
      ok: false,
      error: "invalid comment",
    });
    expect(validateRequiredText(null, policy).ok).toBe(false);
    expect(validateRequiredText(42, policy).ok).toBe(false);
  });

  it("rejects over-length raw input even if sanitizing would shorten it", () => {
    // 生入力1001文字（NULを含む）。サニタイズ後は1000文字以下になるが、
    // 長さゲートは生入力に対して先に見る（パイプラインの順序固定）。
    const raw = "a".repeat(1000) + "\u0000";
    expect(validateRequiredText(raw, policy)).toEqual({
      ok: false,
      error: "invalid comment",
    });
  });

  it("rejects invisible-only input and URL-bearing input", () => {
    expect(validateRequiredText("\u200B".repeat(10), policy)).toEqual({
      ok: false,
      error: "invalid comment",
    });
    expect(validateRequiredText("see https://spam.example", policy)).toEqual({
      ok: false,
      error: "comment must not contain URLs",
    });
  });

  it("sanitizes and trims the stored value", () => {
    const r = validateRequiredText("  きれい\u0000でした\n ", policy);
    expect(r).toEqual({ ok: true, value: "きれいでした" });
  });
});

describe("validateFallbackText", () => {
  const policy = TEXT_FIELDS.toiletAddress;

  it("falls back for absent and invisible-only input", () => {
    expect(validateFallbackText(undefined, policy)).toEqual({
      ok: true,
      value: "現在地周辺",
    });
    expect(validateFallbackText("\u200B".repeat(10), policy)).toEqual({
      ok: true,
      value: "現在地周辺",
    });
  });

  it("rejects null and over-length input (undefined だけが欠落扱い)", () => {
    expect(validateFallbackText(null, policy).ok).toBe(false);
    expect(validateFallbackText("a".repeat(201), policy).ok).toBe(false);
  });

  it("sanitizes visible values", () => {
    expect(validateFallbackText("渋谷区\u0085神南", policy)).toEqual({
      ok: true,
      value: "渋谷区 神南",
    });
  });
});

describe("validateOptionalText", () => {
  const policy = TEXT_FIELDS.toiletFloorInfo;

  it("resolves to undefined for absent and invisible-only input", () => {
    expect(validateOptionalText(undefined, policy)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(validateOptionalText("\u200B", policy)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("keeps visible values sanitized", () => {
    expect(validateOptionalText(" 2階\u202Erev ", policy)).toEqual({
      ok: true,
      value: "2階rev",
    });
  });

  it("rejects URL-bearing values", () => {
    expect(validateOptionalText("2階 www.spam.example", policy)).toEqual({
      ok: false,
      error: "floorInfo must not contain URLs",
    });
  });
});

describe("policy-kind tripwires", () => {
  it("rejecting the wrong entry-point pairing is a type-level error", () => {
    // これはコンパイル時に保証される（onInvisibleOnly のリテラル型が合致しないと
    // 呼び出せない）。実行時の確認として、テーブル宣言が一致していることを
    // 再チェックする。
    expect(TEXT_FIELDS.toiletName.onInvisibleOnly).toBe("reject");
    expect(TEXT_FIELDS.comment.onInvisibleOnly).toBe("reject");
    expect(TEXT_FIELDS.reason.onInvisibleOnly).toBe("reject");
    expect(TEXT_FIELDS.toiletAddress.onInvisibleOnly).toBe("fallback");
    expect(TEXT_FIELDS.toiletDescription.onInvisibleOnly).toBe("fallback");
    expect(TEXT_FIELDS.userName.onInvisibleOnly).toBe("fallback");
    expect(TEXT_FIELDS.toiletFloorInfo.onInvisibleOnly).toBe("fallback");
  });
});
