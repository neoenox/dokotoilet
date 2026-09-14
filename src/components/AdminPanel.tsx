import { useCallback, useEffect, useState } from 'react';

interface AdminReport {
  id: string;
  toiletId: string;
  reviewId: string;
  reason: string;
  createdAt: string;
  facilityName?: string;
}

const TOKEN_KEY = 'kirei-toilet-admin-token';

/**
 * C: 最小管理UI。`#admin` ハッシュで開く隠しパネル。
 * 通報一覧（GET /api/community/admin/reports）→ 解決・レビュー削除の薄ラッパー。
 * 認証は既存 ADMIN_TOKEN の Bearer のみ。トークンはこの端末の localStorage に保存。
 */
export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState<string>(() => {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const authHeaders = useCallback(
    (extra?: Record<string, string>): Record<string, string> => ({
      ...(extra ?? {}),
      Authorization: `Bearer ${token}`,
    }),
    [token]
  );

  const saveToken = (v: string) => {
    setToken(v);
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  };

  const fetchReports = useCallback(async () => {
    if (!token) {
      setStatus('ADMIN_TOKEN を入力してください。');
      return;
    }
    setLoading(true);
    setStatus('');
    try {
      const res = await fetch('/api/community/admin/reports?status=all&limit=50', {
        headers: authHeaders(),
      });
      if (res.status === 404) {
        setStatus('管理APIが無効です（サーバーの ADMIN_TOKEN 未設定）。');
        return;
      }
      if (!res.ok) {
        setStatus(`取得失敗: HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { reports?: AdminReport[] };
      setReports(Array.isArray(data.reports) ? data.reports : []);
      if (!Array.isArray(data.reports) || data.reports.length === 0) {
        setStatus('未対応の通報はありません。');
      }
    } catch {
      setStatus('取得できませんでした（オフライン）。');
    } finally {
      setLoading(false);
    }
  }, [token, authHeaders]);

  useEffect(() => {
    if (token) fetchReports();
  }, [fetchReports, token]);

  const resolveReport = async (id: string) => {
    try {
      const res = await fetch(
        `/api/community/admin/reports/${encodeURIComponent(id)}/resolve`,
        {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({}),
        }
      );
      if (!res.ok) {
        setStatus(`解決に失敗: HTTP ${res.status}`);
        return;
      }
      setReports((prev) => prev.filter((r) => r.id !== id));
      setStatus('通報を解決済みにしました。');
    } catch {
      setStatus('解決できませんでした（オフライン）。');
    }
  };

  const deleteReview = async (reviewId: string, reportId: string) => {
    if (!window.confirm('このレビューを削除しますか？ 集計・投票・通報も掃除されます。')) return;
    try {
      const res = await fetch(
        `/api/community/admin/reviews/${encodeURIComponent(reviewId)}`,
        {
          method: 'DELETE',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({}),
        }
      );
      if (!res.ok) {
        setStatus(`削除に失敗: HTTP ${res.status}`);
        return;
      }
      setReports((prev) => prev.filter((r) => r.id !== reportId));
      setStatus('レビューを削除しました。');
    } catch {
      setStatus('削除できませんでした（オフライン）。');
    }
  };

  const closeAndClearHash = () => {
    try {
      if (window.location.hash === '#admin') {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    } catch {
      /* ignore */
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-label="管理パネル"
    >
      <div className="bg-surface rounded-2xl border border-line-strong shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <h2 className="text-sm font-bold text-ink">通報管理（admin）</h2>
          <button
            type="button"
            onClick={closeAndClearHash}
            className="text-faint hover:text-ink px-2 py-1 text-sm"
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>
        <div className="px-4 py-3 border-b border-line flex gap-2 items-center">
          <input
            type="password"
            value={token}
            onChange={(e) => saveToken(e.target.value)}
            placeholder="ADMIN_TOKEN"
            className="flex-1 text-xs border border-line-strong rounded-lg px-2 py-1.5 bg-surface-2 text-ink"
            aria-label="管理トークン"
          />
          <button
            type="button"
            onClick={fetchReports}
            disabled={loading}
            className="text-xs font-bold bg-accent text-white px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            {loading ? '取得中…' : '更新'}
          </button>
        </div>
        {status && <p className="px-4 py-2 text-xs text-muted">{status}</p>}
        <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2">
          {reports.map((r) => (
            <div key={r.id} className="border border-line rounded-xl p-3 text-xs">
              <p className="font-bold text-ink break-words">
                {r.facilityName ?? r.toiletId}
              </p>
              <p className="text-faint break-all mt-0.5">
                {r.toiletId} / {r.reviewId}
              </p>
              <p className="text-ink-soft mt-1 break-words">理由: {r.reason}</p>
              <p className="text-faint mt-0.5">{r.createdAt}</p>
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => resolveReport(r.id)}
                  className="px-2.5 py-1 rounded-lg border border-line-strong text-ink-soft font-semibold"
                >
                  解決済みにする
                </button>
                <button
                  type="button"
                  onClick={() => deleteReview(r.reviewId, r.id)}
                  className="px-2.5 py-1 rounded-lg bg-red-600 text-white font-semibold"
                >
                  レビューを削除
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="px-4 py-2 text-[11px] text-faint border-t border-line">
          本格的な精査は `bun scripts/community-ops/curate.ts` も併用してください。
        </p>
      </div>
    </div>
  );
}
