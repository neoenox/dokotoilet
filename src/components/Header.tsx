import React from 'react';
import {
  Sparkles,
  PlusCircle,
  Database,
  Navigation,
  CheckCircle2,
  RotateCcw,
  Zap,
  Baby,
  Accessibility,
  Clock,
  Star,
} from 'lucide-react';
import { FilterState, CityPreset, QuickPresetType } from '../types';
import { CITY_PRESETS } from '../data/toilets';
import { PWAInstallButton } from './PWAInstallButton';

interface HeaderProps {
  filter: FilterState;
  setFilter: React.Dispatch<React.SetStateAction<FilterState>>;
  onOpenAddModal: () => void;
  onOpenDataSourcesModal: () => void;
  onCitySelect: (city: CityPreset) => void;
  onLocateUser: () => void;
  isLocating: boolean;
  onResetFilters?: () => void;
  onGoToBestToilet?: () => void;
  favoritesCount?: number;
}

export const Header: React.FC<HeaderProps> = ({
  filter,
  setFilter,
  onOpenAddModal,
  onOpenDataSourcesModal,
  onCitySelect,
  onLocateUser,
  isLocating,
  onResetFilters,
  onGoToBestToilet,
  favoritesCount = 0,
}) => {
  const isFilterActive =
    filter.onlyHighCleanliness ||
    filter.onlyWashlet ||
    filter.onlyMultipurpose ||
    filter.onlyPowderRoom ||
    filter.only24h ||
    filter.onlyFavorites ||
    (filter.quickPreset && filter.quickPreset !== 'all') ||
    filter.dataSource !== 'all' ||
    Boolean(filter.searchQuery.trim());

  const handlePresetSelect = (preset: QuickPresetType) => {
    setFilter((prev) => ({
      ...prev,
      quickPreset: prev.quickPreset === preset ? 'all' : preset,
    }));
  };

  return (
    <header className="bg-surface border-b border-line-strong sticky top-0 z-30 shadow-sm">
      {/* Top Bar */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-3">
        {/* Logo & Title */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-accent text-white flex items-center justify-center shadow-[0_3px_10px_rgba(11,110,82,0.28)] ring-1 ring-inset ring-white/50 shrink-0">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg sm:text-xl font-bold text-ink tracking-tight font-display">
                きれいトイレ
              </h1>
              <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-accent-soft text-accent border border-accent/30">
                <CheckCircle2 className="w-3.5 h-3.5" /> 実在データ (OSM & 口コミ)
              </span>
            </div>
            <p className="text-xs text-faint hidden md:block">
              実在する公衆便所オープンデータ（OpenStreetMap）と実際の利用者の清潔度評価
            </p>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="flex items-center flex-wrap gap-2">
          {/* Emergency Direct Navigation Button */}
          {onGoToBestToilet && (
            <button
              id="btn-goto-best-toilet"
              type="button"
              onClick={onGoToBestToilet}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-gradient-to-r from-amber-500 to-emerald-600 rounded-lg shadow-sm hover:brightness-105 active:scale-95 transition-all cursor-pointer"
              title="現在地またはマップ中心から最も清潔で高評価なトイレを自動案内"
            >
              <Zap className="w-3.5 h-3.5 fill-white text-white" />
              <span>最寄りベストへ直行</span>
            </button>
          )}

          {/* PWA Install Button */}
          <PWAInstallButton />

          {/* Data Source Comparison */}
          <button
            type="button"
            onClick={onOpenDataSourcesModal}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-ink-soft bg-surface border border-line rounded-lg hover:bg-surface-2 hover:border-line-strong transition-colors"
          >
            <Database className="w-3.5 h-3.5 text-indigo-500" />
            <span className="hidden sm:inline">データ元比較</span>
          </button>

          {/* Add Toilet / Review */}
          <button
            type="button"
            onClick={onOpenAddModal}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-accent rounded-lg hover:bg-accent-strong shadow-[0_3px_10px_rgba(11,110,82,0.25)] transition-all"
          >
            <PlusCircle className="w-3.5 h-3.5" />
            <span>きれい度を投稿</span>
          </button>
        </div>
      </div>

      {/* Filter & Presets Bar */}
      <div className="bg-canvas border-t border-line px-4 sm:px-6 py-2 space-y-2">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-2">
          {/* City Presets & GPS Locate */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 text-xs scrollbar-none">
            <button
              type="button"
              onClick={onLocateUser}
              disabled={isLocating}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-surface border border-line text-ink-soft hover:bg-surface-2 hover:border-line-strong font-medium whitespace-nowrap shrink-0 transition-colors"
            >
              <Navigation className={`w-3 h-3 text-sky-500 ${isLocating ? 'animate-spin' : ''}`} />
              {isLocating ? '測位中...' : '現在地'}
            </button>
            <span className="text-line-strong mx-0.5">|</span>
            {CITY_PRESETS.map((city) => (
              <button
                key={city.name}
                type="button"
                onClick={() => onCitySelect(city)}
                className="px-2.5 py-1 rounded-md bg-surface border border-line text-muted hover:border-line-strong hover:text-ink hover:bg-surface-2 whitespace-nowrap shrink-0 transition-colors"
              >
                {city.name.split(' ')[0]}
              </button>
            ))}
          </div>

          {/* Scene Presets & Attributes Bar */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 text-xs scrollbar-none">
            {/* Baby friendly */}
            <button
              type="button"
              onClick={() => handlePresetSelect('baby')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-medium whitespace-nowrap transition-colors ${
                filter.quickPreset === 'baby'
                  ? 'bg-purple-600 text-white font-semibold shadow-xs'
                  : 'bg-surface border border-line text-muted hover:text-ink hover:bg-surface-2'
              }`}
            >
              <Baby className="w-3.5 h-3.5" />
              <span>おむつ・授乳</span>
            </button>

            {/* Barrier free */}
            <button
              type="button"
              onClick={() => handlePresetSelect('barrier_free')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-medium whitespace-nowrap transition-colors ${
                filter.quickPreset === 'barrier_free'
                  ? 'bg-indigo-600 text-white font-semibold shadow-xs'
                  : 'bg-surface border border-line text-muted hover:text-ink hover:bg-surface-2'
              }`}
            >
              <Accessibility className="w-3.5 h-3.5" />
              <span>だれでも多機能</span>
            </button>

            {/* Female safe / powder room */}
            <button
              type="button"
              onClick={() => handlePresetSelect('female_safe')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-medium whitespace-nowrap transition-colors ${
                filter.quickPreset === 'female_safe'
                  ? 'bg-pink-600 text-white font-semibold shadow-xs'
                  : 'bg-surface border border-line text-muted hover:text-ink hover:bg-surface-2'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>女性安心・パウダー</span>
            </button>

            {/* 24 hours */}
            <button
              type="button"
              onClick={() => handlePresetSelect('night_24h')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-medium whitespace-nowrap transition-colors ${
                filter.quickPreset === 'night_24h'
                  ? 'bg-amber-600 text-white font-semibold shadow-xs'
                  : 'bg-surface border border-line text-muted hover:text-ink hover:bg-surface-2'
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              <span>24時間</span>
            </button>

            {/* Favorites filter */}
            <button
              type="button"
              onClick={() => handlePresetSelect('favorites')}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-medium whitespace-nowrap transition-colors ${
                filter.quickPreset === 'favorites'
                  ? 'bg-amber-500 text-white font-semibold shadow-xs'
                  : 'bg-surface border border-line text-muted hover:text-ink hover:bg-surface-2'
              }`}
            >
              <Star className={`w-3.5 h-3.5 ${filter.quickPreset === 'favorites' ? 'fill-white text-white' : 'text-amber-500 fill-amber-400'}`} />
              <span>お気に入り ({favoritesCount})</span>
            </button>

            {/* S/A Grade */}
            <button
              type="button"
              onClick={() =>
                setFilter((prev) => ({
                  ...prev,
                  onlyHighCleanliness: !prev.onlyHighCleanliness,
                }))
              }
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-medium whitespace-nowrap transition-colors ${
                filter.onlyHighCleanliness
                  ? 'bg-accent text-white font-semibold shadow-sm'
                  : 'bg-surface border border-line text-muted hover:text-ink hover:border-line-strong hover:bg-surface-2'
              }`}
            >
              <Sparkles className="w-3 h-3" />
              S・A級
            </button>

            {/* Washlet */}
            <button
              type="button"
              onClick={() =>
                setFilter((prev) => ({
                  ...prev,
                  onlyWashlet: !prev.onlyWashlet,
                }))
              }
              className={`px-2.5 py-1 rounded-full whitespace-nowrap transition-colors ${
                filter.onlyWashlet
                  ? 'bg-[#0284c7] text-white font-medium'
                  : 'bg-surface border border-line text-muted hover:text-ink hover:border-line-strong hover:bg-surface-2'
              }`}
            >
              ウォシュレット
            </button>

            {/* Data Source Filter */}
            <select
              value={filter.dataSource}
              onChange={(e) => {
                const v = e.target.value;
                if (v !== 'all' && v !== 'osm' && v !== 'google' && v !== 'opendata' && v !== 'manual' && v !== 'community') return;
                setFilter((prev) => ({ ...prev, dataSource: v }));
              }}
              className="bg-surface border border-line text-ink-soft rounded-md px-2 py-1 text-xs focus:ring-1 focus:ring-accent focus:outline-none shrink-0"
            >
              <option value="all">全データ元</option>
              <option value="osm">OpenStreetMap</option>
              <option value="google">Google（手動調査）</option>
              <option value="opendata">自治体オープンデータ</option>
              <option value="manual">手動調査</option>
              <option value="community">ユーザー投稿</option>
            </select>

            {/* Clear all filters when active */}
            {isFilterActive && onResetFilters && (
              <button
                type="button"
                onClick={onResetFilters}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-200 hover:bg-rose-100 whitespace-nowrap shrink-0 transition-colors"
                title="フィルター条件をすべてリセット"
              >
                <RotateCcw className="w-3 h-3" />
                <span>条件クリア</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
