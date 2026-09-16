import React, { useEffect } from 'react';
import { DATA_SOURCES_INFO } from '../data/dataSourcesInfo';
import {
  Database,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Sparkles,
  ShieldCheck,
  Zap,
  Globe2,
  Users,
  Building,
} from 'lucide-react';

interface DataSourceModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DataSourceModal: React.FC<DataSourceModalProps> = ({
  isOpen,
  onClose,
}) => {
  // Esc で閉じる（#107 a11y）
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="きれいトイレのデータ元 徹底比較ガイド">
      <div className="bg-surface border border-line-strong rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="p-5 border-b border-line flex items-center justify-between bg-canvas">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-accent text-white flex items-center justify-center shadow-[0_3px_10px_rgba(11,110,82,0.25)]">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">
                きれいトイレのデータ元 徹底比較ガイド
              </h2>
              <p className="text-xs text-faint">
                各データソースの特徴・ライセンス・きれい度抽出手法（Google Mapsは有料のため不採用）
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-faint hover:text-ink p-1.5 rounded-lg text-sm transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6 text-xs text-ink-soft">
          {/* Executive Summary Recommendation */}
          <div className="bg-accent-soft border border-accent/25 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1.5 text-accent-strong font-bold">
              <Sparkles className="w-4 h-4" />
              <span>おすすめのハイブリッド構築戦略</span>
            </div>
            <p className="text-ink-soft leading-relaxed">
              「きれい度」を正確に評価するマップを作る場合、単一のデータ元だけに頼るのではなく、
              <strong className="text-accent-strong">「OpenStreetMap（街頭・公園の無料オープンデータ）」＋「ユーザーのリアルタイム評価投稿（CGM）」</strong>
              を組み合わせる構成が最も費用対効果と鮮度が高くなります。本アプリではGoogle Maps（有料）を採用せず、この2層構造を標準実装しています。
            </p>
          </div>

          {/* Cards of Data Sources */}
          <div className="space-y-4">
            {DATA_SOURCES_INFO.map((source) => (
              <div
                key={source.id}
                className="border border-line rounded-xl p-4 bg-surface-2/60 hover:border-line-strong transition-colors shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-sm text-ink">
                      {source.name}
                    </h3>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
                      {source.badge}
                    </span>
                  </div>
                  <span className="text-[11px] text-faint font-mono">
                    きれい度データ親和性: <strong className="text-ink-soft">{source.cleanlinessDataLevel}</strong>
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] mb-3 bg-white p-2.5 rounded-lg border border-line">
                  <div>
                    <span className="text-faint">カバー範囲:</span>{' '}
                    <span className="font-medium text-ink">{source.coverage}</span>
                  </div>
                  <div>
                    <span className="text-faint">コスト / 利用条件:</span>{' '}
                    <span className="font-medium text-ink">{source.cost}</span>
                  </div>
                  <div className="sm:col-span-2">
                    <span className="text-faint">おすすめの役割:</span>{' '}
                    <span className="font-semibold text-accent">{source.recommendedRole}</span>
                  </div>
                </div>

                {/* Pros and Cons */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <h4 className="font-semibold text-emerald-700 flex items-center gap-1 mb-1">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                      メリット・強み
                    </h4>
                    <ul className="space-y-1 text-ink-soft">
                      {source.pros.map((p, i) => (
                        <li key={i} className="flex items-start gap-1">
                          <span className="text-accent">•</span>
                          <span>{p}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div>
                    <h4 className="font-semibold text-rose-700 flex items-center gap-1 mb-1">
                      <AlertCircle className="w-3.5 h-3.5 text-rose-500" />
                      注意点・制約
                    </h4>
                    <ul className="space-y-1 text-ink-soft">
                      {source.cons.map((c, i) => (
                        <li key={i} className="flex items-start gap-1">
                          <span className="text-rose-600">•</span>
                          <span>{c}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* How Cleanliness Evaluation Works */}
          <div className="border border-line rounded-xl p-4 bg-surface-2/60">
            <h3 className="font-bold text-ink mb-2 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-accent" />
              「トイレのきれい度」はどうやって判定・算出するか？
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px]">
              <div className="bg-white p-3 rounded-lg border border-line">
                <h4 className="font-bold text-ink mb-1">1. ユーザー口コミの集計</h4>
                <p className="text-muted leading-relaxed">
                  アプリ内のきれい度評価投稿（清潔さ・におい・備品の3軸＋コメント）を集計し、1.0〜5.0点にスコア化。将来的にLLMによる自然言語解析の導入も検討中。
                </p>
              </div>

              <div className="bg-white p-3 rounded-lg border border-line">
                <h4 className="font-bold text-ink mb-1">2. 施設カテゴリのベース配点</h4>
                <p className="text-muted leading-relaxed">
                  百貨店上層階・高級複合施設は定期巡回清掃があるため初期評点高め（S/A）。古い公園公衆トイレは清掃頻度に応じた評点に設定。
                </p>
              </div>

              <div className="bg-white p-3 rounded-lg border border-line">
                <h4 className="font-bold text-ink mb-1">3. ユーザー確認（CGM投票）</h4>
                <p className="text-muted leading-relaxed">
                  「今使ったら綺麗だった」「石鹸があった」のリアルタイムチェックインを集計し、最新の清潔度を動的に更新。
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-line bg-canvas flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-white hover:bg-surface-2 text-ink border border-line-strong rounded-lg text-xs font-semibold transition-colors"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
};
