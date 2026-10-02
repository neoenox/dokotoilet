/**
 * G: 本番バンドルに対する最小E2Eスモーク。
 * `bun run build` 後の `dist/server.cjs` を一時ポートで起動し、
 * health / community GET / admin 404-guard / osm バリデーションを実HTTPで検証する。
 * 使い方: `bun run smoke`（内部で build 前提。PORTは自動割当）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const SERVER = path.join(ROOT, 'dist', 'server.cjs');
const PORT = String(4100 + Math.floor(Math.random() * 1000));

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function get(p: string, headers?: Record<string, string>): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers });
  return { status: res.status, body: await res.text() };
}

async function main(): Promise<void> {
  // 本番は COMMUNITY_BACKEND の明示指定が必須。スモークは一時JSONで実行する
  const storePath = path.join(ROOT, 'tmp', `smoke-community-${Date.now()}.json`);
  const child: ChildProcess = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT,
      NODE_ENV: 'production',
      COMMUNITY_BACKEND: 'json',
      COMMUNITY_SALT: 'smoke-test-salt',
      COMMUNITY_STORE_PATH: storePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d) => { out += String(d); });
  child.stderr?.on('data', (d) => { out += String(d); });
  const kill = () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } };
  process.on('exit', kill);

  // 起動待ち（最大20秒）
  let ready = false;
  for (let i = 0; i < 100; i++) {
    await wait(200);
    if (out.includes(`:${PORT}`) || out.includes(PORT)) {
      try {
        const h = await get('/api/health');
        if (h.status === 200 && JSON.parse(h.body).status === 'ok') { ready = true; break; }
      } catch { /* retry */ }
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(`server exited early (code=${child.exitCode}):\n${out}`);
    }
  }
  if (!ready) {
    kill();
    throw new Error(`server did not become ready on :${PORT}:\n${out}`);
  }

  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) console.log(`ok - ${name}`);
    else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  };

  const health = await get('/api/health');
  check('GET /api/health → 200 {status:ok}', health.status === 200 && JSON.parse(health.body).status === 'ok', health.body);

  const community = await get('/api/community/toilets');
  let communityOk = community.status === 200;
  try {
    const j = JSON.parse(community.body) as { toilets?: unknown[] };
    communityOk &&= Array.isArray(j.toilets);
  } catch { communityOk = false; }
  check('GET /api/community/toilets → 200 + toilets[]', communityOk, community.body.slice(0, 200));

  const adminNoToken = await get('/api/community/admin/reports');
  check('GET /api/community/admin/reports (no token) → 401/404', adminNoToken.status === 401 || adminNoToken.status === 404, `got ${adminNoToken.status}`);

  const osmBad = await get('/api/osm/toilets?lat=999&lng=999&radius=99999');
  check('GET /api/osm/toilets (invalid) → 400', osmBad.status === 400, `got ${osmBad.status}`);

  // 未登録の /api/* は SPAフォールバックに落ちず JSON 404 を返す
  const unknownApi = await get('/api/definitely-unknown-path');
  let unknownApiOk = unknownApi.status === 404;
  try {
    unknownApiOk &&= (JSON.parse(unknownApi.body) as { error?: unknown }).error != null;
  } catch { unknownApiOk = false; }
  check('GET /api/definitely-unknown-path → 404 JSON', unknownApiOk, `got ${unknownApi.status}: ${unknownApi.body.slice(0, 120)}`);

  const index = await get('/');
  check('GET / → 200', index.status === 200 && index.body.length > 0, `got ${index.status}`);

  kill();
  if (failures.length > 0) {
    console.error(`SMOKE FAIL (${failures.length}):\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log('SMOKE PASS');
}

main().catch((e) => {
  console.error('SMOKE ERROR:', e instanceof Error ? e.message : e);
  process.exit(1);
});
