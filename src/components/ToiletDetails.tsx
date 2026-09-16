import React from 'react';
import {
  ToiletFacility,
  CleanlinessGrade,
  DataSourceType,
} from '../types';
import { displayGrade, evaluationKindLabel, getGradeColor, isEvaluated } from '../lib/grade';
import { summarizeReviews } from '../lib/scoring';
import { calculateDistanceMeters, formatDistance, formatWalkingTime } from '../lib/geo';
import { BdiText } from './BdiText';
import {
  Sparkles,
  MapPin,
  Clock,
  Navigation,
  ThumbsUp,
  AlertTriangle,
  Lightbulb,
  CheckCircle2,
  XCircle,
  HelpCircle,
  MessageSquare,
  Baby,
  Accessibility,
  HeartHandshake,
  Star,
  ExternalLink,
  ShieldCheck,
  Building2,
  Store,
  Trees,
  Train,
  Footprints,
  PlusCircle,
} from 'lucide-react';

interface ToiletDetailsProps {
  toilet: ToiletFacility;
  onClose: () => void;
  onOpenReviewModal: () => void;
  onVoteHelpful?: (toiletId: string, reviewId: string) => void;
  onReportReview?: (toiletId: string, reviewId: string) => void;
  votedReviewIds?: string[];
  referenceLocation?: { lat: number; lng: number } | null;
  isFavorite?: (toiletId: string) => boolean;
  onToggleFavorite?: (toiletId: string) => void;
}

/** 設備1項目の3状態セル: あり(✓) / なし(✗) / 未確認(?) — 「ない」と「まだ調べてない」を区別する */
function AmenityCell({
  label,
  state,
  trueClass,
  trueIcon,
}: {
  label: string;
  state: boolean | null;
  trueClass: string;
  trueIcon: React.ReactNode;
}) {
  const present = state === true;
  const unknown = state === null;
  return (
    <div
      className={`flex items-center gap-2 p-2 rounded-lg border ${
        present
          ? trueClass
          : unknown
          ? 'bg-canvas border-dashed border-line text-faint'
          : 'bg-surface-2 border-line text-faint'
      }`}
    >
      {present ? (
        trueIcon
      ) : unknown ? (
        <HelpCircle className="w-4 h-4 text-faint shrink-0" />
      ) : (
        <XCircle className="w-4 h-4 text-faint shrink-0" />
      )}
      <span>{label}</span>
      {unknown && (
        <span className="ml-auto text-[10px] font-medium text-faint">未確認</span>
      )}
    </div>
  );
}

export const ToiletDetails: React.FC<ToiletDetailsProps> = ({
  toilet,
  onClose,
  onOpenReviewModal,
  onVoteHelpful,
  onReportReview,
  votedReviewIds = [],
  referenceLocation,
  isFavorite,
  onToggleFavorite,
}) => {
  // 実測レビュー0件は設備推定値しかないため「未評価」表示にする
  const evaluated = isEvaluated(toilet);
  // 口コミ0件でも調査/推定グレードを表示する（初期状態のマップに意味を持たせる）
  const shown = displayGrade(toilet);
  // 外部に口コミがあるが未取込か（例：GoogleにN件）。undefined/0＝不明または無し
  const externalCount = toilet.externalReviewCount ?? 0;
  const hasUnfetched = !evaluated && externalCount > 0;
  const externalSource = toilet.externalReviewSource || 'Google Maps';
  const gradeColor = getGradeColor(shown.grade);
  // 未スコア（コミュニティ登録直後）は grade/score が null。数値表示・バー幅は
  // フォールバックし、「未評価」表示にする（ToiletList / ToiletMap と同じ扱い）
  const unscored = shown.grade === null || shown.score === null;
  const fmtScore = (v: number | null | undefined): string =>
    typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '–';
  const barWidthPct = (v: number | null | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) ? (v / 5) * 100 : 0;

  const distMeters = referenceLocation
    ? calculateDistanceMeters(referenceLocation.lat, referenceLocation.lng, toilet.lat, toilet.lng)
    : null;
  // 口コミがある施設は「清潔さ・におい・備品」のバーを口コミ集計値から導出して
  // 上部スコアとの表示不整合を防ぐ（comfort は入力項目が無いため設備推定値を維持）
  const measured =
    evaluated && toilet.reviews.length > 0 ? summarizeReviews(toilet.reviews) : null;
  const barScores = measured
    ? {
        cleanliness: measured.cleanlinessScore,
        odor: measured.odorScore,
        supplies: measured.suppliesScore,
        comfort: toilet.subScores.comfort,
      }
    : toilet.subScores;
  // 旧バージョンの保存データ互換（aiSummary → facilityNote 改名対応）
  const legacyNote = (toilet as unknown as { aiSummary?: string }).aiSummary;
  const facilityNote = toilet.facilitySummary || toilet.facilityNote || legacyNote;

  const getSourceBadge = (source: DataSourceType) => {
    switch (source) {
      case 'google':
        return { label: 'Google Maps & 口コミ', bg: 'bg-blue-50 text-blue-700 border-blue-200' };
      case 'osm':
        return { label: 'OpenStreetMap (OSM)', bg: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
      case 'opendata':
        return { label: '自治体オープンデータ', bg: 'bg-indigo-50 text-indigo-700 border-indigo-200' };
      case 'manual':
        return { label: '手動調査（公式ガイド等）', bg: 'bg-teal-50 text-teal-700 border-teal-200' };
      case 'community':
        return { label: 'コミュニティ・ユーザー投稿', bg: 'bg-amber-50 text-amber-700 border-amber-200' };
    }
  };

  const sourceBadge = getSourceBadge(toilet.dataSource);

  const getCategoryIcon = (cat: string) => {
    switch (cat) {
      case 'department':
        return <Building2 className="w-4 h-4 text-purple-500" />;
      case 'station':
        return <Train className="w-4 h-4 text-sky-500" />;
      case 'convenience':
        return <Store className="w-4 h-4 text-emerald-600" />;
      case 'park':
        return <Trees className="w-4 h-4 text-emerald-500" />;
      default:
        return <Building2 className="w-4 h-4 text-muted" />;
    }
  };

  return (
    <div className="flex flex-col h-full bg-surface text-ink-soft overflow-y-auto">
      {/* Header Info */}
      <div className="p-4 sm:p-5 border-b border-line">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-surface-2 text-muted">
              {getCategoryIcon(toilet.category)}
              {toilet.facilityType}
            </span>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${sourceBadge.bg}`}>
              {sourceBadge.label}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {onToggleFavorite && isFavorite && (
              <button
                type="button"
                onClick={() => onToggleFavorite(toilet.id)}
                className={`p-1.5 rounded-md transition-colors ${
                  isFavorite(toilet.id)
                    ? 'text-amber-500 bg-amber-50 hover:bg-amber-100'
                    : 'text-faint hover:text-amber-400 hover:bg-surface-2'
                }`}
                title={isFavorite(toilet.id) ? 'お気に入りを解除' : 'お気に入りに保存'}
                aria-label="お気に入り切り替え"
              >
                <Star className={`w-4 h-4 ${isFavorite(toilet.id) ? 'fill-amber-400 text-amber-500' : ''}`} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-faint hover:text-ink p-1.5 rounded-md hover:bg-surface-2 transition-colors"
              aria-label="閉じる"
            >
              ✕
            </button>
          </div>
        </div>

        <h2 className="text-lg sm:text-xl font-bold text-ink leading-snug">
          <BdiText text={toilet.name} />
        </h2>

        {/* Quick Highlights Bar (Distance / Floor / Hours) */}
        <div className="flex items-center gap-1.5 flex-wrap mt-2 text-xs">
          {distMeters !== null && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-sky-50 text-sky-800 font-bold border border-sky-200">
              <Footprints className="w-3.5 h-3.5 text-sky-600" />
              <span>{formatWalkingTime(distMeters)} ({formatDistance(distMeters)})</span>
            </span>
          )}

          {toilet.floorInfo && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-accent-soft text-accent font-semibold border border-accent/20">
              <MapPin className="w-3.5 h-3.5" />
              <span><BdiText text={toilet.floorInfo} /></span>
            </span>
          )}

          {toilet.openingHours ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-surface-2 text-ink-soft font-medium border border-line">
              <Clock className="w-3.5 h-3.5 text-muted" />
              <span>{toilet.openingHours}</span>
            </span>
          ) : toilet.attributes.isOpen24h ? (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-50 text-amber-800 font-semibold border border-amber-200">
              <Clock className="w-3.5 h-3.5 text-amber-600" />
              <span>24時間利用可能</span>
            </span>
          ) : null}
        </div>

        <p className="text-xs text-faint mt-1.5 flex items-center gap-1">
          <MapPin className="w-3.5 h-3.5 shrink-0 text-faint" />
          <span className="line-clamp-1"><BdiText text={toilet.address} /></span>
        </p>

        {/* Quick Instant Route & Review Action Buttons */}
        <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-line">
          <a
            href={`https://www.google.com/maps/dir/?api=1&destination=${toilet.lat},${toilet.lng}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 py-2 px-3 bg-accent hover:bg-accent-strong text-white text-xs font-bold rounded-lg shadow-sm transition-all text-center"
          >
            <Navigation className="w-3.5 h-3.5 fill-white text-white" />
            <span>ここへ行く (経路)</span>
          </a>
          <button
            type="button"
            onClick={onOpenReviewModal}
            className="inline-flex items-center justify-center gap-1.5 py-2 px-3 bg-surface hover:bg-surface-2 border border-line-strong text-ink-soft text-xs font-semibold rounded-lg shadow-xs transition-all"
          >
            <PlusCircle className="w-3.5 h-3.5 text-accent" />
            <span>きれい度を投稿</span>
          </button>
        </div>
      </div>

      {/* Main Cleanliness Score Card */}
      <div className="p-4 sm:p-5 bg-canvas border-b border-line">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={`stamp-plate w-16 h-16 ${gradeColor.bg} text-white ${
                evaluated ? '' : 'opacity-80 saturate-[.65]'
              }`}
              title={
                evaluated
                  ? gradeColor.label
                  : unscored
                    ? '未評価・口コミ募集中'
                    : `${evaluationKindLabel(shown.kind)} ${shown.grade}相当`
              }
            >
              <span className="text-2xl font-black leading-none">
                {unscored ? '?' : shown.grade}
              </span>
            </div>
            <div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-bold text-ink">
                  {fmtScore(shown.score)}
                </span>
                <span className="text-xs text-faint">/ 5.0</span>
                <div className="flex items-center text-amber-400 ml-1">
                  {[...Array(5)].map((_, i) => (
                    <Star
                      key={i}
                      className={`w-3.5 h-3.5 ${
                        evaluated && i < Math.round(toilet.cleanlinessScore)
                          ? 'fill-amber-400 text-amber-400'
                          : 'text-line-strong'
                      }`}
                    />
                  ))}
                </div>
              </div>
              <p className={`text-xs font-medium ${gradeColor.text}`}>
                {evaluated
                  ? gradeColor.label
                  : unscored
                    ? '未評価'
                    : shown.kind === 'survey'
                    ? `調査評価 ${shown.grade}相当（実測レビューなし${toilet.surveyedAt ? `・調査日 ${toilet.surveyedAt}` : ''}）`
                    : `設備推定 ${shown.grade}相当（実測レビューなし）`}
              </p>
              <p className="text-[11px] text-faint mt-0.5">
                {evaluated
                  ? `口コミ・評価 ${toilet.reviewCount}件`
                  : hasUnfetched
                    ? `${externalSource}に関連口コミ約${externalCount}件あり${externalCount >= 1000 ? '（建物全体の件数の可能性あり）' : ''}・口コミ投稿で実測に更新`
                    : `口コミ募集中・最初の投稿で実測に更新`}
              </p>
            </div>
          </div>

          {toilet.lastCleaned && (
            <div className="text-right">
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-accent-soft text-accent border border-accent/30">
                <ShieldCheck className="w-3 h-3" />
                清掃確認: {toilet.lastCleaned}
              </span>
            </div>
          )}
        </div>

        {/* Reassurance banner for estimated facilities */}
        {!evaluated && (
          <div className="mt-3.5 p-2.5 rounded-lg bg-emerald-50/80 border border-emerald-200/80 text-[11px] text-emerald-950 flex items-start gap-2">
            <Sparkles className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div className="flex-1 leading-relaxed">
              <span className="font-bold">設備仕様からの推定グレード</span>
              <p className="text-emerald-800 text-[10px] mt-0.5">
                温水洗浄便座や多機能設備、施設種別のデータから算出しています。実際に利用した感想を投稿すると、実測データへ切り替わります。
              </p>
            </div>
          </div>
        )}

        {/* Sub Scores Breakdown Progress Bars */}
        <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
          <div className="bg-white p-2.5 rounded-lg border border-line shadow-xs">
            <div className="flex justify-between text-muted mb-1">
              <span>便器・床の清潔感</span>
              <span className="font-semibold text-ink">{fmtScore(barScores.cleanliness)}</span>
            </div>
            <div className="w-full bg-line rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-accent h-1.5 rounded-full"
                style={{ width: `${barWidthPct(barScores.cleanliness)}%` }}
              />
            </div>
          </div>

          <div className="bg-white p-2.5 rounded-lg border border-line shadow-xs">
            <div className="flex justify-between text-muted mb-1">
              <span>におい・換気状態</span>
              <span className="font-semibold text-ink">{fmtScore(barScores.odor)}</span>
            </div>
            <div className="w-full bg-line rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-[#0284c7] h-1.5 rounded-full"
                style={{ width: `${barWidthPct(barScores.odor)}%` }}
              />
            </div>
          </div>

          <div className="bg-white p-2.5 rounded-lg border border-line shadow-xs">
            <div className="flex justify-between text-muted mb-1">
              <span>石鹸・ペーパー・除菌</span>
              <span className="font-semibold text-ink">{fmtScore(barScores.supplies)}</span>
            </div>
            <div className="w-full bg-line rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-[#6366f1] h-1.5 rounded-full"
                style={{ width: `${barWidthPct(barScores.supplies)}%` }}
              />
            </div>
          </div>

          <div className="bg-white p-2.5 rounded-lg border border-line shadow-xs">
            <div className="flex justify-between text-muted mb-1">
              <span>広さ・快適性・明るさ</span>
              <span className="font-semibold text-ink">{fmtScore(barScores.comfort)}</span>
            </div>
            <div className="w-full bg-line rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-[#f59e0b] h-1.5 rounded-full"
                style={{ width: `${barWidthPct(barScores.comfort)}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Equipment & Amenities Matrix */}
      <div className="p-4 sm:p-5 border-b border-line">
        <h3 className="text-xs font-bold text-ink uppercase tracking-wider mb-2.5">
          設備・アメニティチェック
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          <AmenityCell
            label="温水洗浄便座"
            state={toilet.attributes.hasWashlet}
            trueClass="bg-sky-50 border-sky-200 text-sky-700 font-medium"
            trueIcon={<CheckCircle2 className="w-4 h-4 text-sky-600 shrink-0" />}
          />

          <AmenityCell
            label="多目的・車椅子"
            state={toilet.attributes.hasMultipurpose}
            trueClass="bg-indigo-50 border-indigo-200 text-indigo-700 font-medium"
            trueIcon={<Accessibility className="w-4 h-4 text-indigo-600 shrink-0" />}
          />

          <AmenityCell
            label="おむつ替え台"
            state={toilet.attributes.hasBabyTable}
            trueClass="bg-pink-50 border-pink-200 text-pink-700 font-medium"
            trueIcon={<Baby className="w-4 h-4 text-pink-600 shrink-0" />}
          />

          <AmenityCell
            label="パウダールーム"
            state={toilet.attributes.hasPowderRoom}
            trueClass="bg-purple-50 border-purple-200 text-purple-700 font-medium"
            trueIcon={<Sparkles className="w-4 h-4 text-purple-500 shrink-0" />}
          />

          <AmenityCell
            label="ハンドソープ完備"
            state={toilet.attributes.hasSoap}
            trueClass="bg-emerald-50 border-emerald-200 text-emerald-700 font-medium"
            trueIcon={<CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />}
          />

          <AmenityCell
            label="除菌アルコール"
            state={toilet.attributes.hasAlcohol}
            trueClass="bg-emerald-50 border-emerald-200 text-emerald-700 font-medium"
            trueIcon={<CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />}
          />

          <div
            className={`flex items-center gap-2 p-2 rounded-lg border ${
              toilet.attributes.isOpen24h === true
                ? 'bg-amber-50 border-amber-200 text-amber-700 font-medium'
                : toilet.attributes.isOpen24h === null
                ? 'bg-canvas border-dashed border-line text-faint'
                : 'bg-surface-2 border-line text-faint'
            }`}
          >
            <Clock className="w-4 h-4 shrink-0 text-amber-500" />
            <span>
              {toilet.attributes.isOpen24h === true
                ? '24時間利用可'
                : toilet.openingHours}
            </span>
            {toilet.attributes.isOpen24h === null && (
              <span className="ml-auto text-[10px] font-medium text-faint">未確認</span>
            )}
          </div>

          <AmenityCell
            label="オストメイト対応"
            state={toilet.attributes.hasOstomate}
            trueClass="bg-blue-50 border-blue-200 text-blue-700 font-medium"
            trueIcon={<HeartHandshake className="w-4 h-4 shrink-0 text-blue-600" />}
          />

          <div
            className={`flex items-center gap-2 p-2 rounded-lg border ${
              toilet.attributes.toiletStyle === null
                ? 'bg-canvas border-dashed border-line text-faint'
                : 'bg-surface-2 border-line text-muted'
            }`}
          >
            <span className="font-medium text-xs">便座様式:</span>
            <span className="text-ink-soft">
              {toilet.attributes.toiletStyle === 'western'
                ? '洋式メイン'
                : toilet.attributes.toiletStyle === 'both'
                ? '和洋両方'
                : toilet.attributes.toiletStyle === 'japanese'
                ? '和式'
                : '未確認'}
            </span>
          </div>
        </div>
      </div>

      {/* Facility Summary Card */}
      {facilityNote && (
        <div className="p-4 sm:p-5 border-b border-line bg-canvas/60">
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck className="w-4 h-4 text-accent" />
            <h3 className="text-xs font-bold text-ink">
              施設・衛生管理ポイント
            </h3>
          </div>
          <p className="text-xs text-ink-soft leading-relaxed bg-white p-3 rounded-lg border border-line">
            {facilityNote}
          </p>
          {/* 推定グレードの根拠開示（実測レビューが付くまでの暫定目安） */}
          {!evaluated && toilet.estimateBasis && toilet.estimateBasis.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-faint hover:text-ink-soft font-medium">
                推定の根拠を見る（{evaluationKindLabel(shown.kind)}）
              </summary>
              <ul className="mt-1 space-y-0.5 bg-white p-3 rounded-lg border border-dashed border-line">
                {toilet.estimateBasis.map((b, i) => (
                  <li key={i} className="text-[11px] text-faint leading-relaxed">
                    • {b}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Highlights: Pros, Cons & Tips */}
      <div className="p-4 sm:p-5 border-b border-line space-y-3">
        {toilet.pros && toilet.pros.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-emerald-700 flex items-center gap-1.5 mb-1.5">
              <ThumbsUp className="w-3.5 h-3.5 text-emerald-600" />
              清潔・高評価ポイント
            </h4>
            <ul className="space-y-1">
              {toilet.pros.map((pro, i) => (
                <li key={i} className="text-xs text-ink-soft flex items-start gap-1.5">
                  <span className="text-accent font-bold">•</span>
                  <span>{pro}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {toilet.cons && toilet.cons.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-amber-600 flex items-center gap-1.5 mb-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
              注意点・混雑など
            </h4>
            <ul className="space-y-1">
              {toilet.cons.map((con, i) => (
                <li key={i} className="text-xs text-ink-soft flex items-start gap-1.5">
                  <span className="text-amber-500 font-bold">•</span>
                  <span>{con}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {toilet.tips && (
          <div className="bg-amber-50 p-3 rounded-lg border border-amber-200 text-xs text-amber-800 flex items-start gap-2">
            <Lightbulb className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-amber-900">利用のワンポイント: </span>
              {toilet.tips}
            </div>
          </div>
        )}
      </div>

      {/* Description */}
      <div className="p-4 sm:p-5 border-b border-line">
        <h3 className="text-xs font-bold text-ink uppercase tracking-wider mb-1.5">
          施設概要・管理状況
        </h3>
        <p className="text-xs text-muted leading-relaxed">
          <BdiText text={toilet.description} />
        </p>
      </div>

      {/* Recent User Reviews */}
      <div className="p-4 sm:p-5 border-b border-line">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold text-ink uppercase tracking-wider flex items-center gap-1.5">
            <MessageSquare className="w-3.5 h-3.5 text-faint" />
            利用者のきれい度口コミ ({toilet.reviews?.length || 0})
          </h3>
          <button
            type="button"
            onClick={onOpenReviewModal}
            className="text-xs text-accent hover:text-accent-strong font-semibold transition-colors"
          >
            ＋ 口コミを書く
          </button>
        </div>

        {toilet.reviews && toilet.reviews.length > 0 ? (
          <div className="space-y-3">
            {toilet.reviews.map((rev) => (
              <div
                key={rev.id}
                className="bg-surface-2 p-3 rounded-xl border border-line text-xs"
              >
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink">
                      <BdiText text={rev.userName} />
                      {rev.source && (
                        <span className="ml-1.5 font-normal text-faint">
                          （{rev.source}より引用）
                        </span>
                      )}
                    </span>
                    <div className="flex items-center text-amber-400">
                      {[...Array(5)].map((_, i) => (
                        <Star
                          key={i}
                          className={`w-3 h-3 ${
                            i < (rev.overallScore ?? rev.rating)
                              ? 'fill-amber-400 text-amber-400'
                              : 'text-line-strong'
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                  <span className="text-[11px] text-faint">{rev.createdAt}</span>
                </div>
                <p className="text-ink-soft leading-relaxed"><BdiText text={rev.comment} /></p>
                <div className="flex items-center gap-2 mt-2 pt-2 border-t border-line">
                  <button
                    type="button"
                    disabled={votedReviewIds.includes(rev.id)}
                    onClick={() => onVoteHelpful?.(toilet.id, rev.id)}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
                      votedReviewIds.includes(rev.id)
                        ? 'bg-accent-soft text-accent cursor-default'
                        : 'bg-white text-muted hover:text-ink hover:bg-canvas border border-line'
                    }`}
                  >
                    <ThumbsUp className="w-3 h-3" />
                    <span>
                      役に立った ({rev.helpfulCount})
                      {votedReviewIds.includes(rev.id) ? ' ✓' : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onReportReview?.(toilet.id, rev.id)}
                    className="ml-auto text-[11px] text-faint hover:text-danger transition-colors"
                  >
                    通報
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-faint italic py-2 text-center">
            まだ詳細な口コミはありません。最初の評価を投稿してみましょう！
          </p>
        )}
      </div>

      {/* Fixed Bottom Action Bar */}
      <div className="p-4 border-t border-line bg-surface sticky bottom-0 z-10 flex gap-2">
        <a
          href={`https://www.google.com/maps/dir/?api=1&destination=${toilet.lat},${toilet.lng}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[#2563eb] hover:bg-[#1d4ed8] text-white font-medium text-xs shadow-xs transition-colors"
        >
          <Navigation className="w-4 h-4" />
          <span>ルート案内</span>
          <ExternalLink className="w-3 h-3 opacity-70" />
        </a>

        <button
          type="button"
          onClick={onOpenReviewModal}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-accent hover:bg-accent-strong text-white font-semibold text-xs shadow-[0_3px_10px_rgba(11,110,82,0.22)] transition-all"
        >
          <Sparkles className="w-4 h-4" />
          <span>きれい度を投稿</span>
        </button>
      </div>
    </div>
  );
};
