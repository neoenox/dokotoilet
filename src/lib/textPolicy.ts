// ユーザー入力テキスト欄の宣言的ポリシーモジュール。
//
// これまで urlGuard.ts（URL検出）と textSanitizer.ts（制御文字・不可視のみ判定）に
// 分かれていたプリミティブを1つに統合し、欄ごとの処理をポリシーテーブルで宣言する。
// バリデータ（server/community.ts）はこのテーブルを消費するだけで、パイプラインの
// 順序（生入力の型/長さゲート → サニタイズ → 可視性 → URL検出 → 保存値）は
// validateTextField が一意に決める。個別の欄ロジックは存在しない。
//
// ポリシー:
//   - サニタイズ: 改行系制御文字（\t\n\r\f\v, U+0085, U+2028/9）は半角スペースへ、
//     その他の \p{C}（制御・書式・双方向制御・サロゲート・私用・タグ文字）は除去。
//     結合記号・全角・絵文字（VS16を含む）は保持（NFC正規化はしない）。
//   - URL検出: 判定前に NFKC（全角→ASCII）と不可視文字（\p{Cf}\p{Cc} +
//     Default_Ignorable_Code_Point: バリエーションセレクタ・ハングルフィラー等）を
//     除去してから URL_RE を適用する。URL_RE 自体の過剰拒否性質（本文中の "http"
//     という語や TLD 風表記への反応）は PR #63 のポリシー判断としてそのまま引き継ぐ。
//   - 長さ上限は生入力（UTF-16コード単位）に対して先に見る。sanitize は長さを
//     増やさない（置換は1:1、それ以外は削除）ため、サニタイズ後の値も律する。
//
// unicode監査スイート（server/community.unicode.test.ts）とプロパティファズ
// （server/community.fuzz.test.ts）が挙動を固定している。このモジュールの変更は
// 両スイートを意図的に更新する形で行うこと。

const URL_RE =
  /(https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|io|jp|co|me|info|biz|dev|app|xyz|top|site|online|shop|click|link|tokyo|osaka)|h\s*t\s*t\s*p)/i;

/** URL_RE 本体。検出根拠の提示やテストのために公開する。 */
export function urlPattern(): RegExp {
  return URL_RE;
}

/**
 * 判定用の正規化: NFKC で互換文字（全角英数字など）を畳み込み、
 * 書式文字（不可視の双方向制御・ZWSP等）と制御文字、さらに
 * Default_Ignorable_Code_Point（バリエーションセレクタ・ハングルフィラー等の
 * 「無視される」不可視文字）を取り除く。これらは \p{C} ではないため
 * サニタイズでは保持されるが、URL 判定の前には不可視難匿に使えるため除く。
 * 単独サロゲートを含む文字列でも例外にはならない（NFKCは寛容）。
 */
export function normalizeForUrlScan(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]/gu, "");
}

/**
 * 文字列が URL 風（スキーム・www・TLD風ドメイン・ASCII綴りの "http"）を
 * 含むかを、正規化した上で判定する。文字列以外は常に false。
 */
export function containsUrlLike(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return URL_RE.test(normalizeForUrlScan(value));
}

// 空白として機能する制御文字（\p{Zs} には含まれないが、語の区切りに使われるもの）
const LINE_CONTROLS = /[\t\n\r\f\v\u0085\u2028\u2029]/g;
// Unicode カテゴリ C の全種（Cc 制御 / Cf 書式 / Cs サロゲート / Co 私用 / Cn 非割当）
const INVISIBLE = /\p{C}/gu;

/**
 * 制御・書式文字を取り除き、改行系は半角スペースに置換した本文を返す。
 * 見える文字（結合記号・全角・絵文字を含む）はそのまま保持する。
 */
export function sanitizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(LINE_CONTROLS, " ")
    .replace(INVISIBLE, "");
}

/**
 * サニタイズ後に1文字でも「見える」本文が残るか。
 * 不可視文字のみの入力（ZWSP・LRM 等）は false になる — G2 の拒否根拠。
 */
export function hasVisibleContent(value: string): boolean {
  return sanitizeText(value).trim().length > 0;
}

/** テキスト欄ごとの処理方針。 */
export interface TextFieldPolicy {
  /** 生入力の UTF-16 長の上限（バリデータの MAX と同じ値）。 */
  max: number;
  /** エラー文言の識別子（例: "comment", "name"）。 */
  field: string;
  /**
   * 不可視のみ（サニタイズ後に可視本文なし）だった入力の扱い。
   *  - "reject": 拒否する（必須欄）
   *  - "fallback": fallback 値へ置き換える（任意欄）
   */
  onInvisibleOnly: "reject" | "fallback";
  /** onInvisibleOnly === "fallback" のときに使う値（省略 = undefined）。 */
  fallback?: string;
  /** URL検出のエラー文言。欄がURL検出対象でなければ省略。 */
  urlError?: string;
}

export type TextFieldOutcome<T extends string | undefined = string | undefined> =
  | { ok: true; value: T }
  | { ok: false; error: string };

type LooseOutcome = { ok: true; value: string | undefined } | { ok: false; error: string };

/**
 * 共通パイプライン。順序は固定: 生入力の型/長さゲート → サニタイズ → 可視性 →
 * URL検出。raw === undefined は「欄が存在しない」を意味し、fallback 付きの欄は
 * fallback 値、reject の欄は invalid エラーになる。undefined 以外の非文字列は
 * 常に invalid エラー（旧 validateToiletInput の address: null と同じ扱い）。
 */
function runTextField(
  raw: unknown,
  policy: TextFieldPolicy
): LooseOutcome {
  if (raw === undefined) {
    if (policy.onInvisibleOnly === "fallback") {
      return { ok: true, value: policy.fallback };
    }
    return { ok: false, error: `invalid ${policy.field}` };
  }
  if (typeof raw !== "string" || raw.length > policy.max) {
    return { ok: false, error: `invalid ${policy.field}` };
  }
  const sanitized = sanitizeText(raw);
  if (!hasVisibleContent(sanitized)) {
    if (policy.onInvisibleOnly === "reject") {
      return { ok: false, error: `invalid ${policy.field}` };
    }
    return { ok: true, value: policy.fallback };
  }
  const value = sanitized.trim();
  if (policy.urlError && containsUrlLike(value)) {
    return { ok: false, error: policy.urlError };
  }
  return { ok: true, value };
}

/**
 * 必須欄（不可視のみは拒否）。成功時の value は必ず文字列。
 * policy の onInvisibleOnly が "fallback" の欄を渡すと型エラーになる（テーブルの
 * 宣言と呼び出しの対応を強制するトリップワイヤ）。
 */
export function validateRequiredText(
  raw: unknown,
  policy: TextFieldPolicy & { onInvisibleOnly: "reject" }
): TextFieldOutcome<string> {
  const outcome = runTextField(raw, policy);
  // reject ポリシーでは成功 value が undefined になる経路は存在しない
  return outcome.ok
    ? { ok: true, value: outcome.value as string }
    : outcome;
}

/**
 * 不可視のみ／欄欠落で文字列の fallback 値へ置き換わる欄。
 * 成功時の value は必ず文字列。
 */
export function validateFallbackText(
  raw: unknown,
  policy: TextFieldPolicy & { onInvisibleOnly: "fallback"; fallback: string }
): TextFieldOutcome<string> {
  const outcome = runTextField(raw, policy);
  // fallback が文字列と宣言されているため成功 value は必ず文字列
  return outcome.ok
    ? { ok: true, value: outcome.value as string }
    : outcome;
}

/**
 * 不可視のみ／欄欠落で undefined になる任意欄（floorInfo 専用の形）。
 */
export function validateOptionalText(
  raw: unknown,
  policy: TextFieldPolicy & { onInvisibleOnly: "fallback" }
): TextFieldOutcome<string | undefined> {
  return runTextField(raw, policy);
}

/** 欄ごとのポリシーテーブル（MAX の値をここに一本化する）。 */
export const TEXT_FIELDS = {
  toiletName: {
    field: "name",
    max: 100,
    onInvisibleOnly: "reject",
    urlError: "name must not contain URLs",
  },
  toiletAddress: {
    field: "address",
    max: 200,
    onInvisibleOnly: "fallback",
    fallback: "現在地周辺",
    urlError: "address must not contain URLs",
  },
  toiletFloorInfo: {
    field: "floorInfo",
    max: 50,
    onInvisibleOnly: "fallback",
    fallback: undefined,
    urlError: "floorInfo must not contain URLs",
  },
  toiletDescription: {
    field: "description",
    max: 2000,
    onInvisibleOnly: "fallback",
    fallback: "ユーザーによって登録されたトイレ情報です。",
    urlError: "description must not contain URLs",
  },
  userName: {
    field: "userName",
    max: 30,
    onInvisibleOnly: "fallback",
    fallback: "匿名の利用者",
    // 表示名スパム（URLを表示名に入れて保存・配信する手口）を塞ぐ。
    // fallback欄だがURL検出時はフォールバックせず拒否する（runTextFieldの順序）。
    urlError: "userName must not contain URLs",
  },
  comment: {
    field: "comment",
    max: 1000,
    onInvisibleOnly: "reject",
    urlError: "comment must not contain URLs",
  },
  reason: {
    field: "reason",
    max: 500,
    onInvisibleOnly: "reject",
    urlError: "reason must not contain URLs",
  },
} as const satisfies Record<string, TextFieldPolicy>;

export type TextFieldName = keyof typeof TEXT_FIELDS;
