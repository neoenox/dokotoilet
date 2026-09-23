import React, { useEffect, useRef, useState } from 'react';
import { ToiletFacility } from '../types';
import {
  RefreshCw,
  Layers,
  MapPin,
  Check,
  Globe,
  Map as MapIcon,
  Moon,
  ChevronDown,
} from 'lucide-react';
import L from 'leaflet';
import { isViewportAlreadyAt } from '../lib/uiState';
import { calculateDistanceMeters } from '../lib/geo';

export type MapTileStyle = 'osm' | 'gsi' | 'gsi_pale' | 'osm_dark';

interface TileConfig {
  id: MapTileStyle;
  label: string;
  shortLabel: string;
  description: string;
  url: string;
  attribution: string;
  maxZoom: number;
  isDarkFilter: boolean;
}

const TILE_STYLES: TileConfig[] = [
  {
    id: 'osm',
    label: 'OpenStreetMap (標準公式)',
    shortLabel: 'OSM標準',
    description: '公式OSMタイル・全世界対応・完全無料・APIキー不要',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    maxZoom: 19,
    isDarkFilter: false,
  },
  {
    id: 'gsi',
    label: '国土地理院 (日本詳細地図)',
    shortLabel: '国土地理院',
    description: '日本の公的機関による詳細地図・建物/番地明瞭・キー不要',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">国土地理院</a>',
    maxZoom: 18,
    isDarkFilter: false,
  },
  {
    id: 'gsi_pale',
    label: '国土地理院 (淡色地図)',
    shortLabel: '地理院(淡色)',
    description: '目に優しいすっきりとした淡色・トイレピンが見やすい',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">国土地理院</a>',
    maxZoom: 18,
    isDarkFilter: false,
  },
  {
    id: 'osm_dark',
    label: 'OSM (ダーク調)',
    shortLabel: 'OSMダーク',
    description: '公式OSMに安全なCSS夜間フィルターを適用・キー不要',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    maxZoom: 19,
    isDarkFilter: true,
  },
];

interface ToiletMapProps {
  toilets: ToiletFacility[];
  selectedToilet: ToiletFacility | null;
  onSelectToilet: (toilet: ToiletFacility) => void;
  center: { lat: number; lng: number };
  zoom: number;
  userLocation?: { lat: number; lng: number } | null;
  onFetchOsmNearCenter: (lat: number, lng: number) => void;
  onViewportChange?: (center: { lat: number; lng: number }, zoom: number) => void;
  isLoadingOsm: boolean;
  /** 詳細パネル（drawer）が開いているか。開閉で地図コンテナ幅が変わるため
   *  Leaflet に invalidateSize を伝える（灰色タイル欠けの防止） */
  detailsOpen?: boolean;
  /** モバイルタブ切替等のレイアウト変化キー。変化時にも invalidateSize を走らせる */
  layoutKey?: string;
}

// 実測評価判定とグレード配色は src/lib/grade.ts へ移動（ToiletList / ToiletDetails と共有）
// マーカーHTML・選択ハイライトの付け替えは src/lib/toiletMapMarkers.ts へ一本化
import {
  MARKER_SELECTED_CLASS,
  buildMarkerHtml,
  markerClassForId,
  markerTitleFor,
  selectionChangedMarkerClasses,
} from '../lib/toiletMapMarkers';

export const ToiletMap: React.FC<ToiletMapProps> = ({
  toilets,
  selectedToilet,
  onSelectToilet,
  center,
  zoom,
  userLocation,
  onFetchOsmNearCenter,
  onViewportChange,
  isLoadingOsm,
  detailsOpen = false,
  layoutKey,
}) => {
  const leafletContainerRef = useRef<HTMLDivElement>(null);
  const leafletMapRef = useRef<L.Map | null>(null);
  const markersGroupRef = useRef<L.LayerGroup | null>(null);
  const userLocationGroupRef = useRef<L.LayerGroup | null>(null);
  const currentTileLayerRef = useRef<L.TileLayer | null>(null);
  // 最新のハンドラを ref で保持（マーカー再構築を親の再レンダー毎に走らせない）
  const onSelectToiletRef = useRef(onSelectToilet);
  onSelectToiletRef.current = onSelectToilet;
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;

  const [currentMapCenter, setCurrentMapCenter] = useState(center);
  const [currentTileStyle, setCurrentTileStyle] = useState<MapTileStyle>('osm');
  const [showTileSelector, setShowTileSelector] = useState(false);
  const [showMobileLegend, setShowMobileLegend] = useState(false);
  const [showSearchThisArea, setShowSearchThisArea] = useState(false);
  const lastSearchedCenterRef = useRef(center);

  // When center prop updates from outside (city selector or emergency navigation), reset search trigger
  useEffect(() => {
    lastSearchedCenterRef.current = center;
    setShowSearchThisArea(false);
  }, [center.lat, center.lng]);

  const handleSearchThisArea = () => {
    const c = leafletMapRef.current ? leafletMapRef.current.getCenter() : currentMapCenter;
    const newCenter = { lat: c.lat, lng: c.lng };
    lastSearchedCenterRef.current = newCenter;
    setShowSearchThisArea(false);
    onFetchOsmNearCenter(newCenter.lat, newCenter.lng);
  };

  // Initialize Leaflet Map
  useEffect(() => {
    if (!leafletContainerRef.current) return;

    if (!leafletMapRef.current) {
      const map = L.map(leafletContainerRef.current, {
        zoomControl: false,
      }).setView([center.lat, center.lng], zoom);

      L.control.zoom({ position: 'bottomright' }).addTo(map);

      markersGroupRef.current = L.layerGroup().addTo(map);
      userLocationGroupRef.current = L.layerGroup().addTo(map);
      leafletMapRef.current = map;

      map.on('moveend', () => {
        const c = map.getCenter();
        const nextCenter = { lat: c.lat, lng: c.lng };
        setCurrentMapCenter(nextCenter);
        onViewportChangeRef.current?.(nextCenter, map.getZoom());

        // Check distance from last searched center. Show search button if > 350m
        const dist = calculateDistanceMeters(
          lastSearchedCenterRef.current.lat,
          lastSearchedCenterRef.current.lng,
          nextCenter.lat,
          nextCenter.lng
        );
        if (dist > 350) {
          setShowSearchThisArea(true);
        }
      });
    }

    return () => {
      // アンマウント時に破棄しないとインスタンスが残存する
      leafletMapRef.current?.remove();
      leafletMapRef.current = null;
      markersGroupRef.current = null;
      userLocationGroupRef.current = null;
      currentTileLayerRef.current = null;
    };
  }, []);

  // Handle TileLayer switching (100% Free - Official OSM & GSI Japan)
  useEffect(() => {
    if (!leafletMapRef.current) return;
    const config =
      TILE_STYLES.find((s) => s.id === currentTileStyle) || TILE_STYLES[0];

    // Remove previous tile layer
    if (currentTileLayerRef.current) {
      leafletMapRef.current.removeLayer(currentTileLayerRef.current);
    }

    // Add new authentic tile layer
    const newLayer = L.tileLayer(config.url, {
      attribution: config.attribution,
      maxZoom: config.maxZoom,
    }).addTo(leafletMapRef.current);
    currentTileLayerRef.current = newLayer;

    // Toggle dark filter class on container (only applies to tile pane, pins stay vibrant)
    if (leafletContainerRef.current) {
      if (config.isDarkFilter) {
        leafletContainerRef.current.classList.add('leaflet-dark-tiles');
      } else {
        leafletContainerRef.current.classList.remove('leaflet-dark-tiles');
      }
    }
  }, [currentTileStyle]);

  // Update center when prop changes
  useEffect(() => {
    if (leafletMapRef.current) {
      const map = leafletMapRef.current;
      const current = map.getCenter();
      const currentZoom = map.getZoom();
      if (isViewportAlreadyAt(
        { lat: current.lat, lng: current.lng, zoom: currentZoom },
        { lat: center.lat, lng: center.lng, zoom }
      )) {
        return;
      }
      map.flyTo([center.lat, center.lng], zoom, {
        duration: 1.2,
      });
    }
  }, [center.lat, center.lng, zoom]);

  // Render Leaflet Markers
  // toilets 変化時のみ（再）構築する（deps に selectedToilet を含めない）。
  // 選択変更は下の selection effect が該当2要素の DOM クラスだけを付け替える
  // （O(n)再構築・全ピンの一瞬消えるちらつきを防ぐ）。
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!leafletMapRef.current || !markersGroupRef.current) return;
    markersGroupRef.current.clearLayers();

    toilets.forEach((toilet) => {
      const customIcon = L.divIcon({
        className: 'custom-toilet-marker',
        html: buildMarkerHtml(toilet),
        iconSize: [32, 36],
        iconAnchor: [16, 36],
      });

      const marker = L.marker([toilet.lat, toilet.lng], {
        icon: customIcon,
        title: markerTitleFor(toilet),
      });
      marker.on('click', () => {
        // 最新のハンドラを使う（ref経由。effectの再実行を防ぐため deps に入れない）
        onSelectToiletRef.current(toilet);
      });
      markersGroupRef.current?.addLayer(marker);
      // Leaflet が生成した要素へ識別クラスを付与（selection effect の検索キー）
      marker.getElement()?.classList.add(markerClassForId(toilet.id));
    });
    // 選択状態は selection effect が現在の selectedIdRef との差分で再適用するため、
    // ここでは触らない（選択中の施設がリストから消えた場合も次の effect で解決）
  }, [toilets]);

  // 選択変更の反映: 旧・新の2要素だけクラスを付け替える（toilets 再構築後も走るので、
  // 新しく作られたマーカー要素にも選択状態が正しく反映される）。
  useEffect(() => {
    const group = markersGroupRef.current;
    if (!group) return;
    const prevId = selectedIdRef.current;
    const nextId = selectedToilet?.id ?? null;
    if (prevId === nextId) return; // 変化なし
    const updates = selectionChangedMarkerClasses(prevId, nextId);
    for (const { className, selected } of updates) {
      group.eachLayer((layer) => {
        const el = (layer as L.Marker).getElement?.();
        if (el?.classList.contains(className)) {
          el.classList.toggle(MARKER_SELECTED_CLASS, selected);
        }
      });
    }
    selectedIdRef.current = nextId;
  }, [toilets, selectedToilet?.id]);

  // Render User Location Marker (Pulsing GPS dot)
  useEffect(() => {
    if (!leafletMapRef.current || !userLocationGroupRef.current) return;
    userLocationGroupRef.current.clearLayers();

    if (!userLocation) return;

    const userIcon = L.divIcon({
      className: 'user-location-marker-container',
      html: `
        <div class="relative flex items-center justify-center w-8 h-8 pointer-events-none">
          <div class="absolute w-8 h-8 rounded-full bg-blue-500/30 animate-ping"></div>
          <div class="relative w-4 h-4 rounded-full bg-blue-600 border-2 border-white shadow-md ring-2 ring-blue-400"></div>
        </div>
      `,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });

    const userMarker = L.marker([userLocation.lat, userLocation.lng], {
      icon: userIcon,
      zIndexOffset: 1000,
      title: '現在地',
    });
    userLocationGroupRef.current.addLayer(userMarker);
  }, [userLocation?.lat, userLocation?.lng]);

  // 詳細パネル（drawer）開閉で地図コンテナ幅が変わる → Leaflet にサイズを伝える
  useEffect(() => {
    const map = leafletMapRef.current;
    if (!map) return;
    // レイアウト確定後に再計測（描画直後と少し遅らせての2回で欠けを防ぐ）
    const raf = requestAnimationFrame(() => map.invalidateSize());
    const timer = setTimeout(() => map.invalidateSize(), 250);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [detailsOpen, layoutKey]);

  const activeTileConfig =
    TILE_STYLES.find((s) => s.id === currentTileStyle) || TILE_STYLES[0];

  return (
    <div className="relative w-full h-full min-h-[420px] bg-canvas overflow-hidden isolate z-0">
      <div ref={leafletContainerRef} className="w-full h-full" />

      {/* Search This Area Pill (Google Maps Style) */}
      {showSearchThisArea && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 pointer-events-auto animate-in fade-in slide-in-from-top-2 duration-200">
          <button
            id="btn-search-this-area"
            type="button"
            onClick={handleSearchThisArea}
            disabled={isLoadingOsm}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-accent text-white font-bold text-xs shadow-xl hover:bg-accent-strong active:scale-95 transition-all cursor-pointer ring-2 ring-white/80"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingOsm ? 'animate-spin' : ''}`} />
            <span>{isLoadingOsm ? '公衆トイレを取得中...' : 'このエリアを再検索'}</span>
          </button>
        </div>
      )}

      {/* Floating Map Controls & Overlays */}
      <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-2 pointer-events-none">
        {/* Fetch OpenStreetMap in this Area */}
        <button
          type="button"
          onClick={() => {
            const lat = leafletMapRef.current
              ? leafletMapRef.current.getCenter().lat
              : currentMapCenter.lat;
            const lng = leafletMapRef.current
              ? leafletMapRef.current.getCenter().lng
              : currentMapCenter.lng;
            onFetchOsmNearCenter(lat, lng);
          }}
          disabled={isLoadingOsm}
          className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/95 backdrop-blur-md text-ink-soft text-xs font-semibold shadow-xl border border-line hover:bg-surface-2 hover:border-line-strong transition-all disabled:opacity-50"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 text-accent ${
              isLoadingOsm ? 'animate-spin' : ''
            }`}
          />
          <span>
            {isLoadingOsm
              ? 'OSMから公衆トイレを取得中...'
              : 'この周辺の公衆トイレをOSM取得'}
          </span>
        </button>

        {/* Tile Style Selector (100% Free & No API Key) */}
        <div className="pointer-events-auto relative">
            <button
              type="button"
              onClick={() => setShowTileSelector(!showTileSelector)}
              className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-white/95 backdrop-blur-md text-ink-soft text-xs font-medium shadow-xl border border-line hover:bg-surface-2 hover:border-line-strong transition-all"
              title="地図の種類を切り替え (すべて完全無料・APIキー不要)"
            >
              <Layers className="w-3.5 h-3.5 text-sky-500" />
              <span>{activeTileConfig.shortLabel}</span>
              <ChevronDown className="w-3 h-3 text-faint" />
            </button>

            {showTileSelector && (
              <div className="absolute top-full left-0 mt-1.5 w-64 bg-surface border border-line rounded-xl shadow-2xl p-1.5 z-50 text-xs space-y-1">
                <div className="px-2 py-1 text-[10px] text-faint font-medium border-b border-line flex items-center justify-between">
                  <span>地図スタイル (キー不要・無料)</span>
                  <span className="text-accent">No Key Needed</span>
                </div>
                {TILE_STYLES.map((style) => {
                  const isCurrent = style.id === currentTileStyle;
                  return (
                    <button
                      key={style.id}
                      type="button"
                      onClick={() => {
                        setCurrentTileStyle(style.id);
                        setShowTileSelector(false);
                      }}
                      className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors flex items-start justify-between gap-2 ${
                        isCurrent
                          ? 'bg-accent-soft text-accent font-semibold'
                          : 'text-ink-soft hover:bg-surface-2 hover:text-ink'
                      }`}
                    >
                      <div>
                        <div className="flex items-center gap-1.5 text-xs">
                          {style.id === 'osm' && <Globe className="w-3 h-3 text-sky-500" />}
                          {style.id.startsWith('gsi') && (
                            <MapIcon className="w-3 h-3 text-emerald-600" />
                          )}
                          {style.id === 'osm_dark' && (
                            <Moon className="w-3 h-3 text-purple-500" />
                          )}
                          <span>{style.label}</span>
                        </div>
                        <p className="text-[10px] text-faint mt-0.5 font-normal leading-tight">
                          {style.description}
                        </p>
                      </div>
                      {isCurrent && (
                        <Check className="w-4 h-4 text-accent shrink-0 mt-0.5" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
        </div>
      </div>

      {/* Grade Legend in Bottom Left */}
      <div className="absolute bottom-4 left-3 z-10 pointer-events-auto">
        {/* Desktop full legend */}
        <div className="hidden sm:block bg-white/95 backdrop-blur-md border border-line rounded-xl p-2.5 shadow-xl text-xs">
          <div className="text-[11px] font-bold text-ink-soft mb-1.5 flex items-center justify-between gap-2">
            <span>きれい度ランク判定</span>
            <span className="text-[10px] text-faint font-normal">基準</span>
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-4 rounded-full bg-emerald-500 text-white font-bold text-[10px] flex items-center justify-center shadow-xs">
                S
              </span>
              <span className="text-ink-soft text-[11px]">極上 (4.6+)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-4 rounded-full bg-sky-500 text-white font-bold text-[10px] flex items-center justify-center shadow-xs">
                A
              </span>
              <span className="text-ink-soft text-[11px]">清潔 (4.0+)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-4 rounded-full bg-amber-500 text-white font-bold text-[10px] flex items-center justify-center shadow-xs">
                B
              </span>
              <span className="text-ink-soft text-[11px]">普通 (3.0+)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-4 rounded-full bg-orange-500 text-white font-bold text-[10px] flex items-center justify-center shadow-xs">
                C
              </span>
              <span className="text-ink-soft text-[11px]">要注意 (2.0+)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-4 h-4 rounded-full bg-rose-500 text-white font-bold text-[10px] flex items-center justify-center shadow-xs">
                D
              </span>
              <span className="text-ink-soft text-[11px]">緊急用 (&lt;2.0)</span>
            </div>
          </div>
        </div>

        {/* Mobile compact button & popover */}
        <div className="sm:hidden relative">
          <button
            type="button"
            onClick={() => setShowMobileLegend(!showMobileLegend)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-white/95 backdrop-blur-md border border-line shadow-lg text-[11px] font-semibold text-ink-soft hover:bg-surface-2 transition-all"
          >
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span>ランク基準</span>
            <ChevronDown className={`w-3 h-3 text-faint transition-transform ${showMobileLegend ? 'rotate-180' : ''}`} />
          </button>

          {showMobileLegend && (
            <div className="absolute bottom-full left-0 mb-1.5 w-64 bg-surface border border-line rounded-xl shadow-2xl p-2.5 text-xs animate-in fade-in slide-in-from-bottom-2 duration-150">
              <div className="text-[11px] font-bold text-ink-soft mb-2 flex items-center justify-between">
                <span>きれい度ランク基準</span>
                <button
                  type="button"
                  onClick={() => setShowMobileLegend(false)}
                  className="text-faint hover:text-ink text-[11px]"
                >
                  ✕
                </button>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between py-0.5">
                  <div className="flex items-center gap-2">
                    <span className="w-4 h-4 rounded-full bg-emerald-500 text-white font-bold text-[10px] flex items-center justify-center">S</span>
                    <span className="font-semibold text-ink">極上・ホテル級</span>
                  </div>
                  <span className="text-muted text-[11px]">4.6以上</span>
                </div>
                <div className="flex items-center justify-between py-0.5">
                  <div className="flex items-center gap-2">
                    <span className="w-4 h-4 rounded-full bg-sky-500 text-white font-bold text-[10px] flex items-center justify-center">A</span>
                    <span className="font-semibold text-ink">清潔・安心</span>
                  </div>
                  <span className="text-muted text-[11px]">4.0〜4.5</span>
                </div>
                <div className="flex items-center justify-between py-0.5">
                  <div className="flex items-center gap-2">
                    <span className="w-4 h-4 rounded-full bg-amber-500 text-white font-bold text-[10px] flex items-center justify-center">B</span>
                    <span className="text-muted">普通・使用可</span>
                  </div>
                  <span className="text-muted text-[11px]">3.0〜3.9</span>
                </div>
                <div className="flex items-center justify-between py-0.5">
                  <div className="flex items-center gap-2">
                    <span className="w-4 h-4 rounded-full bg-orange-500 text-white font-bold text-[10px] flex items-center justify-center">C</span>
                    <span className="text-muted">要注意・やや汚れ</span>
                  </div>
                  <span className="text-muted text-[11px]">2.0〜2.9</span>
                </div>
                <div className="flex items-center justify-between py-0.5">
                  <div className="flex items-center gap-2">
                    <span className="w-4 h-4 rounded-full bg-rose-500 text-white font-bold text-[10px] flex items-center justify-center">D</span>
                    <span className="text-danger font-medium">緊急用のみ</span>
                  </div>
                  <span className="text-muted text-[11px]">2.0未満</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
