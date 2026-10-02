/**
 * server.ts のエントリーレベル動作のうち、単体テスト可能な部分。
 *
 * - readJsonWithLimit: reader 無し経路のサイズ上限判定が「UTF-16 コード単位」ではなく
 *   「実バイト数」で行われること（マルチバイト応答で上限超過を見逃さない）。
 *   未知 /api/* の JSON 404 ルーティングは E2E（scripts/smoke-check.ts）が
 *   実HTTPで検証するため、ここでは server.ts のソース上の配置・実装を固定する
 *   （server.ts は top-level startServer() を実行するため import できない）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const serverSource = readFileSync(
  path.join(import.meta.dirname, "..", "server.ts"),
  "utf-8"
);

/**
 * server.ts は読み込み時にサーバーを起動するため import できない。
 * 関数定義部分をソースから抽出し、型注釈を剥がして JavaScript として評価する
 * （#109 レビュー対応の回帰固定。関数が server/ 以下に分離されたら
 * 通常の import に置き換える）。
 */
function extractFunction(name: string): string {
  // "async function" 宣言の async も含めて切り出す（await を含む関数のため必須）
  const marker = serverSource.includes(`async function ${name}(`)
    ? `async function ${name}(`
    : `function ${name}(`;
  const start = serverSource.indexOf(marker);
  if (start < 0) throw new Error(`${name} not found in server.ts`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < serverSource.length; i++) {
    const ch = serverSource[i];
    if (ch === "{") {
      depth++;
      opened = true;
    } else if (ch === "}") {
      depth--;
      if (opened && depth === 0) {
        return serverSource.slice(start, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// TypeScript の注釈を JS に変換してから Function コンストラクタで評価する。
// 旧実装の回帰（text.length と maxBytes の単位不一致）をここで固定する。
const readJsonWithLimit: (
  res: globalThis.Response,
  maxBytes: number
) => Promise<unknown> = (() => {
  const js = extractFunction("readJsonWithLimit")
    .replace(": globalThis.Response", "")
    .replace(": number", "")
    .replace(/: Promise<unknown>/g, "")
    .replace(/: Promise<never>/g, "")
    .replace(/const chunks: Uint8Array\[\] = \[\];/, "const chunks = [];");
  return new Function(`"use strict";${js}\nreturn readJsonWithLimit;`)();
})();

describe("readJsonWithLimit (reader-less path)", () => {
  // body が null の Response（reader 無し経路）を text のみで模倣する。
  // 実 Response を arrayBuffer() で消費すると body が locked のまま残り
  // getReader() が例外を投げるため、モックで reader 無し経路を直接再現する。
  const makeReaderLessResponse = (text: string): globalThis.Response =>
    ({ text: async () => text }) as unknown as globalThis.Response;

  it("parses a valid JSON body", async () => {
    const parsed = (await readJsonWithLimit(
      makeReaderLessResponse('{"ok":1}'),
      1024
    )) as { ok: number };
    expect(parsed.ok).toBe(1);
  });

  it("rejects oversized multibyte payloads measured in bytes, not UTF-16 code units", async () => {
    // 「あ」は3バイト/文字（BMP・UTF-16では1コード単位）。1000文字 = 3000バイト、
    // text.length は 1000。旧実装（UTF-16 コード単位比較）は 1500 の上限を
    // 素通りしてしまうが、バイト比較なら正しく拒否される。
    const body = "あ".repeat(1000);
    expect(Buffer.byteLength(body)).toBe(3000);
    expect(body.length).toBe(1000);

    await expect(
      readJsonWithLimit(makeReaderLessResponse(body), 1500)
    ).rejects.toThrow(/too large \(3000 bytes\)/);
  });

  it("accepts payloads within the byte limit", async () => {
    const body = '{"data":"あ"}';
    const parsed = (await readJsonWithLimit(
      makeReaderLessResponse(body),
      Buffer.byteLength(body)
    )) as { data: string };
    expect(parsed.data).toBe("あ");
  });
});

describe("server.ts static guards", () => {
  it("registers the /api JSON 404 fallback before the SPA catch-all", () => {
    const apiGuard = serverSource.indexOf('app.use("/api"');
    const spaFallback = serverSource.indexOf('app.get("*"');
    expect(apiGuard).toBeGreaterThan(-1);
    expect(spaFallback).toBeGreaterThan(-1);
    expect(apiGuard).toBeLessThan(spaFallback);
  });

  it("compares byte length in the reader-less path", () => {
    expect(extractFunction("readJsonWithLimit")).toContain(
      "Buffer.byteLength(text)"
    );
  });
});
