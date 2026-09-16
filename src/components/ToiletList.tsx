import React from 'react';
import { ToiletFacility, ToiletSortOption } from '../types';
import { displayGrade, evaluationKindLabel, getGradeColor, isEvaluated } from '../lib/grade';
import { calculateDistanceMeters, formatDistance, formatWalkingTime } from '../lib/geo';
import { BdiText } from './BdiText';
import {
  Search,
  Building2,
  Store,
  Trees,
  Train,
  Star,
  Footprints,
  RotateCcw,
  Sparkles,
  ArrowUpDown,
} from 'lucide-react';

interface ToiletListProps {
  toilets: ToiletFacility[];
  selectedToilet: ToiletFacility | null;
  onSelectToilet: (toilet: ToiletFacility) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  sortOption?: ToiletSortOption;
  onSortChange?: (option: ToiletSortOption) => void;
  referenceLocation?: { lat: number; lng: number } | null;
  onResetFilters?: () => void;
  isFavorite?: (toiletId: string) => boolean;
  onToggleFavorite?: (toiletId: string) => void;
}

export const ToiletList: React.FC<ToiletListProps> = ({
  toilets,
  selectedToilet,
  onSelectToilet,
  searchQuery,
  setSearchQuery,
  sortOption = 'cleanliness',
  onSortChange,
  referenceLocation,
  onResetFilters,
  isFavorite,
  onToggleFavorite,
}) => {
  const getCategoryIcon = (cat: string) => {
    switch (cat) {
      case 'department':
        return <Building2 className="w-3.5 h-3.5 text-purple-500" />;
      case 'station':
        return <Train className="w-3.5 h-3.5 text-sky-500" />;
      case 'convenience':
        return <Store className="w-3.5 h-3.5 text-emerald-600" />;
      case 'park':
        return <Trees className="w-3.5 h-3.5 text-emerald-500" />;
      default:
        return <Building2 className="w-3.5 h-3.5 text-muted" />;
    }
  };

  return (
    <div className="flex flex-col h-full bg-canvas border-r border-line">
      {/* Search Header */}
      <div className="p-3 bg-surface border-b border-line">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input
            type="text"
            aria-label="施設名・駅名・地名で検索"
            placeholder="施設名・駅名・地名で検索..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-surface-2 border border-line rounded-lg text-ink placeholder-faint focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent transition-colors"
          />
        </div>

        {/* Sort and Count Bar */}
        <div className="flex items-center justify-between text-[11px] text-faint mt-2.5 px-0.5">
          <span>
            該当件数: <strong className="text-ink font-semibold">{toilets.length}</strong> 件
          </span>

          {onSortChange ? (
            <div className="inline-flex items-center p-0.5 bg-surface-2 rounded-lg border border-line">
              <button
                type="button"
                onClick={() => onSortChange('cleanliness')}
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                  sortOption === 'cleanliness'
                    ? 'bg-white text-accent font-bold shadow-xs'
                    : 'text-muted hover:text-ink'
                }`}
              >
                清潔度順
              </button>
              <button
                type="button"
                onClick={() => onSortChange('distance')}
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                  sortOption === 'distance'
                    ? 'bg-white text-accent font-bold shadow-xs'
                    : 'text-muted hover:text-ink'
                }`}
              >
                近い順
              </button>
              <button
                type="button"
                onClick={() => onSortChange('reviews')}
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                  sortOption === 'reviews'
                    ? 'bg-white text-accent font-bold shadow-xs'
                    : 'text-muted hover:text-ink'
                }`}
              >
                口コミ順
              </button>
            </div>
          ) : (
            <span className="text-accent font-medium">清潔度順にソート</span>
          )}
        </div>
      </div>

      {/* Toilet Card List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {toilets.length === 0 ? (
          <div className="text-center py-12 px-4 text-xs text-faint flex flex-col items-center">
            <div className="w-10 h-10 rounded-full bg-surface-2 border border-line flex items-center justify-center text-faint mb-3">
              <Search className="w-5 h-5" />
            </div>
            <p className="font-semibold text-ink-soft text-sm">該当するトイレが見つかりません</p>
            <p className="mt-1 text-faint max-w-xs leading-relaxed">
              検索ワードや設備フィルターの条件を緩めるか、マップの「この周辺の公衆トイレをOSM取得」をお試しください。
            </p>
            {onResetFilters && (
              <button
                type="button"
                onClick={onResetFilters}
                className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface border border-line text-accent hover:bg-surface-2 hover:border-line-strong font-medium shadow-xs transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>フィルター条件をリセット</span>
              </button>
            )}
          </div>
        ) : (
          toilets.map((toilet) => {
            const evaluated = isEvaluated(toilet);
            // 口コミ0件でも調査/推定グレードを表示する。実測以外は出所タグを添える
            const shown = displayGrade(toilet);
            // 未スコア（コミュニティ登録直後）はグレード自体が無いため「未評価」表示
            const unscored = shown.grade === null || shown.score === null;
            const gradeColor = getGradeColor(shown.grade);
            const isSelected = selectedToilet?.id === toilet.id;
            const attrs = toilet.attributes ?? {
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
            };

            const distMeters = referenceLocation
              ? calculateDistanceMeters(
                  referenceLocation.lat,
                  referenceLocation.lng,
                  toilet.lat,
                  toilet.lng
                )
              : null;

            return (
              <div
                key={toilet.id}
                role="button"
                tabIndex={0}
                aria-label={`${toilet.name}の詳細を表示`}
                onClick={() => onSelectToilet(toilet)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectToilet(toilet);
                  }
                }}
                className={`p-3 rounded-xl border cursor-pointer transition-all duration-150 text-xs ${
                  isSelected
                    ? 'bg-surface border-accent shadow-[0_4px_14px_rgba(11,110,82,0.14)] ring-1 ring-accent'
                    : 'bg-surface border-line hover:border-line-strong hover:shadow-sm'
                }`}
              >
                <div className="flex items-start justify-between gap-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-2 text-muted">
                        {getCategoryIcon(toilet.category)}
                        {toilet.facilityType}
                      </span>
                      {distMeters !== null && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-sky-50 text-sky-800 border border-sky-200">
                          <Footprints className="w-3 h-3 text-sky-600" />
                          {formatWalkingTime(distMeters)} ({formatDistance(distMeters)})
                        </span>
                      )}
                      {attrs.isOpen24h && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
                          24h
                        </span>
                      )}
                    </div>
                    <h3 className="font-bold text-ink text-xs leading-snug line-clamp-1">
                      <BdiText text={toilet.name} />
                    </h3>
                    <p className="text-[11px] text-faint line-clamp-1 mt-0.5">
                      {toilet.floorInfo ? (
                        <span className="text-accent font-medium mr-1">[{toilet.floorInfo}]</span>
                      ) : null}
                      <BdiText text={toilet.address} />
                    </p>
                  </div>

                  {/* Cleanliness Grade Box & Favorite */}
                  <div className="flex flex-col items-center gap-1 shrink-0">
                    <div
                      className={`stamp-plate w-9 h-9 ${gradeColor.bg} text-white ${
                        evaluated ? '' : 'opacity-80 saturate-[.65]'
                      }`}
                      title={
                        evaluated
                          ? gradeColor.label
                          : unscored
                            ? '未評価（口コミ募集中）'
                            : `${evaluationKindLabel(shown.kind)} ${shown.grade}相当（口コミ募集中）`
                      }
                    >
                      <span className="text-base font-black leading-none">
                        {unscored ? '?' : shown.grade}
                      </span>
                    </div>
                    {!evaluated && (
                      <span className="text-[9px] font-medium text-faint leading-none">
                        {unscored ? '未評価' : evaluationKindLabel(shown.kind)}
                      </span>
                    )}
                    {onToggleFavorite && isFavorite && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleFavorite(toilet.id);
                        }}
                        className={`p-1 rounded-md transition-colors ${
                          isFavorite(toilet.id)
                            ? 'text-amber-500 hover:text-amber-600 bg-amber-50'
                            : 'text-faint hover:text-amber-400 hover:bg-surface-2'
                        }`}
                        title={isFavorite(toilet.id) ? 'お気に入りを解除' : 'お気に入りに保存'}
                      >
                        <Star className={`w-3.5 h-3.5 ${isFavorite(toilet.id) ? 'fill-amber-400 text-amber-500' : ''}`} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Score & Attributes Chips */}
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-line text-[11px]">
                  <div className="flex items-center gap-1 text-ink-soft">
                    <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                    <span className="font-bold">
                      {evaluated
                        ? (toilet.cleanlinessScore != null ? Number(toilet.cleanlinessScore).toFixed(1) : '–')
                        : unscored
                          ? '未評価'
                          : `${evaluationKindLabel(shown.kind)} ${Number(shown.score).toFixed(1)}`}
                    </span>
                    <span className="text-faint">({toilet.reviewCount ?? 0})</span>
                  </div>

                  <div className="flex items-center gap-1 text-[10px] text-faint">
                    {attrs.hasWashlet && (
                      <span className="px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 font-medium border border-sky-200">
                        洗浄便座
                      </span>
                    )}
                    {attrs.hasMultipurpose && (
                      <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-medium border border-indigo-200">
                        多機能
                      </span>
                    )}
                    {attrs.hasPowderRoom && (
                      <span className="px-1.5 py-0.5 rounded bg-pink-50 text-pink-700 font-medium border border-pink-200">
                        パウダー
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
