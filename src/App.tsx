import React, { useState, useEffect, useMemo, useRef, Suspense, lazy } from 'react';
import {
  ToiletFacility,
  FilterState,
  CityPreset,
  ToiletReview,
  ToiletSortOption,
} from './types';
import { INITIAL_TOILETS, CITY_PRESETS } from './data/toilets';
import { GOOGLE_SEED } from './data/googleSeed';
import { KUMAGAYA_SEED } from './data/kumagayaSeed';
import { TERMINAL_STATIONS_SEED } from './data/terminalStationsSeed';
import { filterAndSortToilets } from './lib/filter';
import { gradeForScore } from './lib/scoring';
import { displayGrade, getGradeColor } from './lib/grade';
import { calculateDistanceMeters, formatDistance, formatWalkingTime } from './lib/geo';
import { adjustHelpfulCount, setHelpfulCount } from './lib/helpfulVote';
import { overlayExternalReviews } from './lib/externalReviews';
import { classifyReviewResponse, findSelectedToilet } from './lib/uiState';
import {
  canonicalizeExternalFacilityId,
  canonicalizeExternalReviewKeys,
} from './lib/facilityIds';
import { mergeOsmBatch } from './lib/osmMerge';
import { mergeSeedLists } from './lib/seed';
import {
  buildFacilityIdAliases,
  canonicalizeSeedOsmFacility,
  externalReviewsForFacility,
  legacyOsmIdForTyped,
  remapReviewDeltaKeys,
} from './lib/osmIds';
import {
  applyDeltaToSeeds,
  emptyDelta,
  enqueuePendingReview,
  enqueuePendingVote,
  extractDelta,
  loadPendingReviews,
  loadPendingVotes,
  removePendingReview,
  removePendingVote,
  LOCAL_DELTA_KEY,
  LEGACY_TOILETS_V2_KEY,
  LEGACY_TOILETS_V3_KEY,
  mergeFacilityLists,
  migrateLegacyArray,
  OSM_CACHE_KEY,
  OSM_CACHE_MAX,
  parseLocalDelta,
  parseToiletArray,
  recomputeFromReviews,
  unionServerToilet,
  VOTED_REVIEWS_KEY,
} from './lib/localDeltas';
import { Header } from './components/Header';
import { ToiletMap } from './components/ToiletMap';
import { ToiletList } from './components/ToiletList';
// A: モーダル・詳細パネルは遅延ロード（メイン結月削減）。直接テストする側は
// 各コンポーネントを直接importするため影響なし
const ToiletDetails = lazy(() =>
  import('./components/ToiletDetails').then((m) => ({ default: m.ToiletDetails }))
);
const DataSourceModal = lazy(() =>
  import('./components/DataSourceModal').then((m) => ({ default: m.DataSourceModal }))
);
const ReviewModal = lazy(() =>
  import('./components/ReviewModal').then((m) => ({ default: m.ReviewModal }))
);
const AddToiletModal = lazy(() =>
  import('./components/AddToiletModal').then((m) => ({ default: m.AddToiletModal }))
);
const AdminPanel = lazy(() =>
  import('./components/AdminPanel').then((m) => ({ default: m.AdminPanel }))
);
import { BdiText } from './components/BdiText';
import { OfflineIndicator } from './components/OfflineIndicator';
import { useFavorites } from './hooks/useFavorites';
import {
  List,
  Map as MapIcon,
  Sparkles,
  Info,
  Footprints,
  Navigation,
  ChevronUp,
  X,
  Star,
  Zap,
} from 'lucide-react';

const RAW_SEED_TOILETS = mergeSeedLists(
  TERMINAL_STATIONS_SEED,
  mergeSeedLists(
    GOOGLE_SEED,
    mergeSeedLists(KUMAGAYA_SEED, INITIAL_TOILETS)
  )
);
const SEED_TOILETS = RAW_SEED_TOILETS.map(canonicalizeSeedOsmFacility);
const SEED_ID_ALIASES = buildFacilityIdAliases(RAW_SEED_TOILETS, SEED_TOILETS);

const SEED_ID_SET = new Set(SEED_TOILETS.map((t) => t.id));

export function sanitizeToiletFacility(raw: any): ToiletFacility {
  const unscoredCommunityRegistration =
    raw?.dataSource === 'community' && raw?.reviewCount === 0 &&
    raw?.cleanlinessScore == null && raw?.equipmentScore == null;
  const cleanlinessScore = unscoredCommunityRegistration
    ? null
    : typeof raw?.cleanlinessScore === 'number' && !isNaN(raw.cleanlinessScore)
      ? raw.cleanlinessScore
      : typeof raw?.equipmentScore === 'number' && !isNaN(raw.equipmentScore)
      ? raw.equipmentScore
      : 3.0;

  const cleanlinessGrade = unscoredCommunityRegistration
    ? null
    : raw?.cleanlinessGrade || gradeForScore(cleanlinessScore);

  const equipmentScore = unscoredCommunityRegistration
    ? null
    : typeof raw?.equipmentScore === 'number' && !isNaN(raw.equipmentScore)
      ? raw.equipmentScore
      : cleanlinessScore;

  const equipmentGrade = unscoredCommunityRegistration
    ? null
    : raw?.equipmentGrade || gradeForScore(equipmentScore);

  const subScores = {
    cleanliness: unscoredCommunityRegistration ? null :
      typeof raw?.subScores?.cleanliness === 'number' && !isNaN(raw.subScores.cleanliness)
        ? raw.subScores.cleanliness : cleanlinessScore,
    odor: unscoredCommunityRegistration ? null :
      typeof raw?.subScores?.odor === 'number' && !isNaN(raw.subScores.odor)
        ? raw.subScores.odor : cleanlinessScore,
    supplies: unscoredCommunityRegistration ? null :
      typeof raw?.subScores?.supplies === 'number' && !isNaN(raw.subScores.supplies)
        ? raw.subScores.supplies : cleanlinessScore,
    comfort: unscoredCommunityRegistration ? null :
      typeof raw?.subScores?.comfort === 'number' && !isNaN(raw.subScores.comfort)
        ? raw.subScores.comfort : cleanlinessScore,
  };

  const rawAttrs = (raw?.attributes ?? {}) as Record<string, unknown>;
  const tri = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  const attributes = {
    hasWashlet: tri(rawAttrs.hasWashlet),
    hasMultipurpose: tri(rawAttrs.hasMultipurpose),
    hasBabyTable: tri(rawAttrs.hasBabyTable),
    hasNursingRoom: tri(rawAttrs.hasNursingRoom),
    hasPowderRoom: tri(rawAttrs.hasPowderRoom),
    hasOstomate: tri(rawAttrs.hasOstomate),
    isFree: tri(rawAttrs.isFree),
    isOpen24h: tri(rawAttrs.isOpen24h),
    hasSoap: tri(rawAttrs.hasSoap),
    hasAlcohol: tri(rawAttrs.hasAlcohol),
    hasPaperTowelOrDryer: tri(rawAttrs.hasPaperTowelOrDryer),
    toiletStyle:
      rawAttrs.toiletStyle === 'western' ||
      rawAttrs.toiletStyle === 'both' ||
      rawAttrs.toiletStyle === 'japanese'
        ? rawAttrs.toiletStyle
        : null,
  };

  const reviews = Array.isArray(raw?.reviews) ? raw.reviews : [];
  const reviewCount =
    typeof raw?.reviewCount === 'number' && !isNaN(raw.reviewCount)
      ? raw.reviewCount
      : reviews.length;

  return {
    ...raw,
    cleanlinessScore,
    cleanlinessGrade,
    equipmentScore,
    equipmentGrade,
    subScores,
    attributes,
    reviewCount,
    reviews,
  };
}

export default function App() {
  const serverFacilityIdsRef = useRef<Set<string>>(new Set());
  const serverKnownReviewsRef = useRef<Map<string, Set<string>>>(new Map());
  const externalReviewsRef = useRef<Record<string, ToiletReview[]>>({});
  const noteServerFacility = (facilityId: string, reviewIds: string[]) => {
    serverFacilityIdsRef.current.add(facilityId);
    const set = serverKnownReviewsRef.current.get(facilityId) ?? new Set<string>();
    for (const rid of reviewIds) set.add(rid);
    serverKnownReviewsRef.current.set(facilityId, set);
  };
  const noteReviewsKnown = (facilityId: string, reviewIds: string[]) => {
    const set = serverKnownReviewsRef.current.get(facilityId) ?? new Set<string>();
    for (const rid of reviewIds) set.add(rid);
    serverKnownReviewsRef.current.set(facilityId, set);
  };

  const [toilets, setToilets] = useState<ToiletFacility[]>(() => {
    try {
      let delta = parseLocalDelta(localStorage.getItem(LOCAL_DELTA_KEY));
      if (!delta) {
        const legacy =
          localStorage.getItem(LEGACY_TOILETS_V3_KEY) ??
          localStorage.getItem(LEGACY_TOILETS_V2_KEY);
        if (legacy) {
          delta = migrateLegacyArray(JSON.parse(legacy));
          localStorage.removeItem(LEGACY_TOILETS_V3_KEY);
          localStorage.removeItem(LEGACY_TOILETS_V2_KEY);
        }
      }
      if (delta) delta = remapReviewDeltaKeys(delta, SEED_ID_ALIASES);
      const cachedOsm = parseToiletArray(localStorage.getItem(OSM_CACHE_KEY));
      const seeded = applyDeltaToSeeds(SEED_TOILETS, delta ?? emptyDelta());
      return mergeFacilityLists(seeded, cachedOsm);
    } catch (e) {
      console.warn('Failed to load saved toilets from localStorage:', e);
    }
    return SEED_TOILETS.map(sanitizeToiletFacility);
  });

  const [selectedToiletId, setSelectedToiletId] = useState<string | null>(
    SEED_TOILETS[0]?.id ?? null
  );
  const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number }>({
    lat: 35.6590,
    lng: 139.7034,
  });
  const [mapZoom, setMapZoom] = useState<number>(15);
  // 最新のtoiletsをrefで保持し、非同期ハンドラ内のstale参照を防ぐ。
  const toiletsRef = useRef<ToiletFacility[]>(toilets);
  useEffect(() => {
    toiletsRef.current = toilets;
  }, [toilets]);
  // Keep the drawer selection as an ID so shared GET updates replace the
  // selected facility object instead of leaving a stale startup snapshot.
  const selectedToilet = useMemo(
    () => findSelectedToilet(toilets, selectedToiletId),
    [toilets, selectedToiletId]
  );
  const [isLocating, setIsLocating] = useState<boolean>(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [sortOption, setSortOption] = useState<ToiletSortOption>('cleanliness');
  const [mobileDetailsExpanded, setMobileDetailsExpanded] = useState<boolean>(false);
  const [isLoadingOsm, setIsLoadingOsm] = useState<boolean>(false);
  const [mobileTab, setMobileTab] = useState<'map' | 'list'>('map');
  const [isDataSourcesModalOpen, setIsDataSourcesModalOpen] = useState(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);
  // C: 隠し管理パネル。URL末尾に #admin を付けて開く（ADMIN_TOKEN はパネル内で入力）
  const [isAdminOpen, setIsAdminOpen] = useState<boolean>(() =>
    typeof window !== 'undefined' && window.location.hash === '#admin'
  );
  useEffect(() => {
    const onHash = () => setIsAdminOpen(window.location.hash === '#admin');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (message: string) => {
    setToastMessage(message);
    if (toastTimeoutRef.current !== null) {
      clearTimeout(toastTimeoutRef.current);
    }
    toastTimeoutRef.current = setTimeout(() => {
      setToastMessage((current) => (current === message ? null : current));
      toastTimeoutRef.current = null;
    }, 4000);
  };
  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current !== null) {
        clearTimeout(toastTimeoutRef.current);
      }
    };
  }, []);

  const [filter, setFilter] = useState<FilterState>({
    dataSource: 'all',
    onlyHighCleanliness: false,
    onlyWashlet: false,
    onlyMultipurpose: false,
    onlyPowderRoom: false,
    only24h: false,
    quickPreset: 'all',
    searchQuery: '',
  });

  const { favoriteIds, isFavorite, toggleFavorite } = useFavorites();
  const favoriteIdSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);

  useEffect(() => {
    try {
      localStorage.setItem(
        LOCAL_DELTA_KEY,
        JSON.stringify(
          extractDelta(toilets, {
            facilityIds: serverFacilityIdsRef.current,
            reviewIdsByFacility: serverKnownReviewsRef.current,
          })
        )
      );
      const known = serverKnownReviewsRef.current;
      const osmCache = toilets
        .filter((t) => t.dataSource === 'osm' && !SEED_ID_SET.has(t.id))
        .map((t) => {
          const knownIds = known.get(t.id);
          const reviews = t.reviews ?? [];
          if (!knownIds || knownIds.size === 0 || reviews.length === 0) return t;
          const kept = reviews.filter((r) => !knownIds.has(r.id));
          return kept.length === reviews.length
            ? t
            : recomputeFromReviews(t, kept);
        })
        .slice(-OSM_CACHE_MAX);
      localStorage.setItem(OSM_CACHE_KEY, JSON.stringify(osmCache));
    } catch (e) {
      console.warn('Failed to save user data:', e);
    }
  }, [toilets]);

  const [votedReviewIds, setVotedReviewIds] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(VOTED_REVIEWS_KEY);
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(VOTED_REVIEWS_KEY, JSON.stringify(votedReviewIds));
    } catch {
      /* ignore */
    }
  }, [votedReviewIds]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/community/toilets');
        if (!res.ok) return;
        const data = await res.json();
        const serverItems = Array.isArray(data.toilets)
          ? (data.toilets as any[]).map(sanitizeToiletFacility)
          : [];
        const externalReviews =
          data.externalReviews && typeof data.externalReviews === 'object'
            ? (data.externalReviews as Record<string, ToiletReview[]>)
            : {};
        // キーを正準形へ寄せる（旧データに分解形キーが混在していても1バケツに統合）
        externalReviewsRef.current = canonicalizeExternalReviewKeys(externalReviews);
        for (const s of serverItems) {
          noteServerFacility(s.id, (s.reviews ?? []).map((r) => r.id));
        }
        for (const [fid, revs] of Object.entries(externalReviews)) {
          if (revs && revs.length > 0) noteReviewsKnown(fid, revs.map((r) => r.id));
        }
        if (serverItems.length === 0 && Object.keys(externalReviews).length === 0) {
          return;
        }
        setToilets((prev) => {
          const prevById = new Map<string, ToiletFacility>(prev.map((t) => [t.id, t]));
          const serverIds = new Set(serverItems.map((t) => t.id));
          const merged = serverItems.map((s) => {
            const local = prevById.get(s.id);
            return local ? unionServerToilet(local, s) : s;
          });
          const localOnly = prev.filter((t) => !serverIds.has(t.id));
          const base = [...merged, ...localOnly];
          const knownFacilityIds = base.map((t) => t.id);
          return base.map((t) => {
            const reviews = externalReviewsForFacility(t.id, externalReviews, knownFacilityIds);
            if (reviews && reviews.length > 0) {
              noteReviewsKnown(t.id, reviews.map((r) => r.id));
              return overlayExternalReviews(t, reviews);
            }
            return t;
          });
        });
      } catch {
        /* offline / static hosting: local-only mode */
      }
    })();
  }, []);

  const referenceLocation = useMemo(
    () => userLocation || mapCenter,
    [userLocation, mapCenter]
  );

  const handleResetFilters = () => {
    setFilter({
      dataSource: 'all',
      onlyHighCleanliness: false,
      onlyWashlet: false,
      onlyMultipurpose: false,
      onlyPowderRoom: false,
      only24h: false,
      onlyFavorites: false,
      quickPreset: 'all',
      searchQuery: '',
    });
  };

  const filteredToilets = useMemo(
    () => filterAndSortToilets(toilets, filter, sortOption, referenceLocation, favoriteIdSet),
    [toilets, filter, sortOption, referenceLocation, favoriteIdSet]
  );

  const handleGoToBestToilet = () => {
    const origin = userLocation ?? mapCenter;
    if (toilets.length === 0) return;

    // Score facilities taking into account cleanliness and proximity
    const scored = toilets.map((t) => {
      const dist = calculateDistanceMeters(origin.lat, origin.lng, t.lat, t.lng);
      const gradeInfo = displayGrade(t);
      const cleanliness = gradeInfo.score;
      // Proximity penalty: 1km = -0.4 score equivalent
      const proximityScore = cleanliness - (dist / 1000) * 0.4;
      return { toilet: t, dist, cleanliness, proximityScore, grade: gradeInfo.grade };
    });

    // Prefer facilities within 2.5km if any exist, otherwise check closest overall
    const nearby = scored.filter((item) => item.dist <= 2500);
    const pool = nearby.length > 0 ? nearby : scored;

    pool.sort((a, b) => b.proximityScore - a.proximityScore);
    const best = pool[0]?.toilet;

    if (best) {
      setSelectedToiletId(best.id);
      setMapCenter({ lat: best.lat, lng: best.lng });
      setMapZoom(16);
      setMobileTab('map');
      const gradeInfo = displayGrade(best);
      showToast(`最寄りの清潔トイレ「${best.name}」(清潔度: Grade ${gradeInfo.grade}) を案内中`);
    } else {
      showToast('最寄りのトイレが見つかりませんでした。');
    }
  };

  const handleFetchOsmNearCenter = async (
    lat: number,
    lng: number,
    notifyUser: boolean = true
  ) => {
    setIsLoadingOsm(true);
    try {
      const res = await fetch(`/api/osm/toilets?lat=${lat}&lng=${lng}&radius=2000`);
      if (!res.ok) {
        if (notifyUser) {
          showToast('OpenStreetMapの取得に失敗しました（サーバーエラー）。時間をおいて再度お試しください。');
        }
        return;
      }
      const data = await res.json();

      // サーバーが正規化済みの toilets を必ず返すので、クライアント側の
      // elements→施設 変換（旧フォールバック二重実装）は廃止した。
      const incoming: ToiletFacility[] = Array.isArray(data.toilets)
        ? (data.toilets as any[]).map(sanitizeToiletFacility)
        : [];

      if (incoming.length === 0) {
        if (notifyUser) {
          showToast('この周辺（半径2km）のOpenStreetMap公衆トイレは見つかりませんでした。');
        }
        return;
      }

      // マージは setToilets 内で mergeOsmBatch を1回だけ実行する。
      // トースト用の件数は軽量なID差分で近似する（O(n*m)のpreviewマージは行わない）。
      const prevIds = new Set(toiletsRef.current.map((t) => t.id));
      const approxAdded = incoming.filter((t) => !prevIds.has(t.id)).length;
      setToilets((prev) => {
        const knownIds = [...prev.map((t) => t.id), ...incoming.map((t) => t.id)];
        const prevById = new Map<string, ToiletFacility>(prev.map((t) => [t.id, t]));
        const overlayShared = (facility: ToiletFacility): ToiletFacility => {
          const shared = externalReviewsForFacility(
            facility.id,
            externalReviewsRef.current,
            knownIds
          );
          if (shared && shared.length > 0) {
            noteReviewsKnown(facility.id, shared.map((r) => r.id));
            const legacyId = legacyOsmIdForTyped(facility.id);
            const legacy = legacyId ? prevById.get(legacyId) : undefined;
            const migrated =
              legacy && legacy.reviews.length > 0
                ? recomputeFromReviews(facility, legacy.reviews)
                : facility;
            return overlayExternalReviews(migrated, shared);
          }
          return facility;
        };
        return mergeOsmBatch(prev, incoming, overlayShared).facilities;
      });

      if (approxAdded > 0) {
        if (notifyUser) {
          showToast(`新たに ${approxAdded} 件の実在公衆トイレをOpenStreetMapから取得しました！`);
        }
      } else if (notifyUser) {
        showToast('この周辺の実在公衆トイレはすでに取得済みです。');
      }
    } catch {
      if (notifyUser) {
        showToast('OpenStreetMapの取得に失敗しました。通信環境をご確認のうえ、時間をおいて再度お試しください。');
      }
    } finally {
      setIsLoadingOsm(false);
    }
  };

  useEffect(() => {
    handleFetchOsmNearCenter(mapCenter.lat, mapCenter.lng, false);
  }, []);

  const handleCitySelect = (city: CityPreset) => {
    setMapCenter({ lat: city.lat, lng: city.lng });
    setMapZoom(city.zoom);
    handleFetchOsmNearCenter(city.lat, city.lng, false);

    const nearest = toiletsRef.current.find(
      (t) =>
        Math.abs(t.lat - city.lat) < 0.05 && Math.abs(t.lng - city.lng) < 0.05
    );
    if (nearest) {
      setSelectedToiletId(nearest.id);
    }
  };

  const handleLocateUser = () => {
    if (!navigator.geolocation) {
      alert('お使いのブラウザは位置情報に対応していません。');
      return;
    }
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setIsLocating(false);
        const { latitude, longitude } = pos.coords;
        setUserLocation({ lat: latitude, lng: longitude });
        setMapCenter({ lat: latitude, lng: longitude });
        setMapZoom(16);
        handleFetchOsmNearCenter(latitude, longitude, false);
      },
      (err) => {
        setIsLocating(false);
        console.warn('Geolocation error:', err);
        alert('現在地を取得できませんでした。ブラウザの位置情報権限をご確認ください。');
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  };

  const applyLocalReview = (toiletId: string, newReview: ToiletReview) => {
    setToilets((prev) =>
      prev.map((item) => {
        if (item.id !== toiletId) return item;

        const updatedReviews = [newReview, ...item.reviews];
        const updated = {
          ...recomputeFromReviews(item, updatedReviews),
          lastCleaned: 'たった今（利用者が確認）',
        };

        return updated;
      })
    );
  };

  // Submit new review (server first, local fallback for offline/static hosting)
  // HTTP応答を受信した場合はサーバー判定を正とし、ローカル保存へフォールバックしない。
  // ローカル保存は fetch 自体が失敗したオフライン/到達不能時だけ許可する。
  const handleSubmitReview = async (rawToiletId: string, newReview: ToiletReview): Promise<boolean> => {
    // 外部施設IDは正準形（NFC）で送る（サーバーのキー空間と揃える。PR #64）
    const toiletId = canonicalizeExternalFacilityId(rawToiletId);
    let res: Response;
    try {
      res = await fetch(`/api/community/toilets/${encodeURIComponent(toiletId)}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review: newReview }),
      });
    } catch {
      // D: 通信断時は端末保存 + 再送キューへ（起動時・online復帰時に flush）
      showToast('サーバーに接続できないため、この端末に保存し、後で再送します。');
      enqueuePendingReview({
        facilityId: toiletId,
        review: newReview,
        queuedAt: new Date().toISOString(),
      });
      applyLocalReview(toiletId, newReview);
      return true;
    }
    try {
      const outcome = await classifyReviewResponse(res, toiletId);
      if (outcome.kind === 'server-toilet') {
        const updated = outcome.toilet;
        noteServerFacility(updated.id, (updated.reviews ?? []).map((r) => r.id));
        setToilets((prev) =>
          prev.map((t) => (t.id === toiletId ? unionServerToilet(t, updated) : t))
        );
        return true;
      }
      // 外部施設（OSM/Google/OD）: サーバーが共有レビュー一覧を返すので重ねる（M5）
      if (outcome.kind === 'server-external') {
        const serverReviews = outcome.reviews;
        // この施設の最新スナップショットを反映（同じ施設の再取得時にも使えるように）
        externalReviewsRef.current = {
          ...externalReviewsRef.current,
          [toiletId]: serverReviews,
        };
        // 旧ID/新IDの型エイリアス互換を確認してから重ねる（混在防止）
        const knownFacilityIds = toiletsRef.current.map((t) => t.id);
        const compatibleReviews =
          externalReviewsForFacility(toiletId, externalReviewsRef.current, knownFacilityIds) ?? serverReviews;
        noteReviewsKnown(toiletId, compatibleReviews.map((r) => r.id));
        setToilets((prev) =>
          prev.map((t) =>
            t.id === toiletId ? overlayExternalReviews(t, compatibleReviews) : t
          )
        );
        return true;
      }
      if (outcome.kind === 'local') {
        showToast(outcome.message);
        applyLocalReview(toiletId, newReview);
        return true;
      }
      if (outcome.kind === 'rejected' || outcome.kind === 'invalid') {
        showToast(outcome.message);
        return false;
      }
      showToast('サーバーの応答処理に失敗しました。入力内容を保持しています。');
      return false;
    } catch {
      showToast('サーバーの応答処理に失敗しました。入力内容を保持しています。');
      return false;
    }
  };

  // Add new toilet (server first, local fallback)
  const handleAddToilet = async (newFacility: ToiletFacility) => {
    const sanitized = sanitizeToiletFacility(newFacility);
    setToilets((prev) => [sanitized, ...prev]);
    setSelectedToiletId(sanitized.id);
    setMapCenter({ lat: sanitized.lat, lng: sanitized.lng });
    setMapZoom(16);
    try {
      const res = await fetch('/api/community/toilets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: newFacility.id,
          name: newFacility.name,
          category: newFacility.category,
          address: newFacility.address,
          floorInfo: newFacility.floorInfo,
          description: newFacility.description,
          lat: newFacility.lat,
          lng: newFacility.lng,
          attributes: {
            hasWashlet: newFacility.attributes.hasWashlet,
            hasMultipurpose: newFacility.attributes.hasMultipurpose,
            hasBabyTable: newFacility.attributes.hasBabyTable,
            hasPowderRoom: newFacility.attributes.hasPowderRoom,
            isOpen24h: newFacility.attributes.isOpen24h,
          },
        }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as {
          toilet?: ToiletFacility;
        } | null;
        const serverToilet = data?.toilet;
        if (serverToilet) {
          noteServerFacility(serverToilet.id, []);
          setToilets((prev) =>
            prev.map((t) =>
              t.id === serverToilet.id ? unionServerToilet(t, serverToilet) : t
            )
          );
          return;
        }
      } else {
        const err = await res.json().catch(() => null);
        if (err?.error) showToast(`共有登録できませんでした: ${err.error}（この端末のみに保存）`);
      }
    } catch {
      /* offline: local-only */
    }
  };

  const handleVoteHelpful = async (toiletId: string, reviewId: string) => {
    if (votedReviewIds.includes(reviewId)) return;
    setVotedReviewIds((prev) => [...prev, reviewId]);
    setToilets((prev) =>
      prev.map((t) => adjustHelpfulCount(t, toiletId, reviewId, 1))
    );

    // 失敗時は楽観カウントと投票済み印を巻き戻す
    const rollback = () => {
      setVotedReviewIds((prev) => prev.filter((id) => id !== reviewId));
      setToilets((prev) =>
        prev.map((t) => adjustHelpfulCount(t, toiletId, reviewId, -1))
      );
    };

    try {
      const res = await fetch(`/api/community/reviews/${encodeURIComponent(reviewId)}/helpful`, {
        method: 'POST',
      });
      if (!res.ok) {
        rollback();
        showToast('「役に立った」を送信できませんでした。再度お試しください。');
        return;
      }

      const data = await res.json();
      // サーバー確定値で同期（投票済みなら楽観カウントは巻き戻る）
      setToilets((prev) =>
        prev.map((t) => setHelpfulCount(t, toiletId, reviewId, data.helpfulCount))
      );
    } catch {
      // D: 投票のオフライン時は巻き戻さずキューへ（再送時に確定値で同期）
      enqueuePendingVote({
        toiletId,
        reviewId,
        queuedAt: new Date().toISOString(),
      });
      showToast('オフラインのため「役に立った」を後で再送します。');
    }
  };

  // D: 未同期キューの再送（起動1回 + online復帰時）。成功分だけキューから外す
  useEffect(() => {
    let cancelled = false;
    const flush = async () => {
      for (const p of loadPendingReviews()) {
        if (cancelled) return;
        try {
          const res = await fetch(
            `/api/community/toilets/${encodeURIComponent(p.facilityId)}/reviews`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ review: p.review }),
            }
          );
          if (!res.ok) continue;
          const outcome = await classifyReviewResponse(res, p.facilityId);
          if (outcome.kind === 'server-toilet') {
            const updated = outcome.toilet;
            noteServerFacility(updated.id, (updated.reviews ?? []).map((r) => r.id));
            setToilets((prev) =>
              prev.map((t) => (t.id === p.facilityId ? unionServerToilet(t, updated) : t))
            );
            removePendingReview(p.review.id);
          } else if (outcome.kind === 'server-external') {
            externalReviewsRef.current = {
              ...externalReviewsRef.current,
              [p.facilityId]: outcome.reviews,
            };
            noteReviewsKnown(p.facilityId, outcome.reviews.map((r) => r.id));
            setToilets((prev) =>
              prev.map((t) =>
                t.id === p.facilityId ? overlayExternalReviews(t, outcome.reviews) : t
              )
            );
            removePendingReview(p.review.id);
          }
        } catch {
          /* まだオフライン: 次回に持ち越し */
        }
      }
      for (const v of loadPendingVotes()) {
        if (cancelled) return;
        try {
          const res = await fetch(
            `/api/community/reviews/${encodeURIComponent(v.reviewId)}/helpful`,
            { method: 'POST' }
          );
          if (!res.ok) continue;
          const data = await res.json().catch(() => null);
          if (data && typeof data.helpfulCount === 'number') {
            setToilets((prev) =>
              prev.map((t) => setHelpfulCount(t, v.toiletId, v.reviewId, data.helpfulCount))
            );
          }
          removePendingVote(v.reviewId);
        } catch {
          /* 次回に持ち越し */
        }
      }
    };
    flush();
    const onOnline = () => flush();
    window.addEventListener('online', onOnline);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
    };
  }, []);

  const handleReportReview = async (toiletId: string, reviewId: string) => {
    const reason = window.prompt('通報理由を入力してください（不適切な内容・いたずら等）');
    if (!reason || !reason.trim()) return;
    try {
      const res = await fetch(`/api/community/reviews/${encodeURIComponent(reviewId)}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toiletId: canonicalizeExternalFacilityId(toiletId), reason: reason.trim() }),
      });
      showToast(res.ok ? '通報を受け付けました。確認します。' : '通報できませんでした。');
    } catch {
      showToast('通報できませんでした（オフライン）。');
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas text-ink-soft font-sans antialiased">
      <OfflineIndicator />
      <Header
        filter={filter}
        setFilter={setFilter}
        onOpenAddModal={() => setIsAddModalOpen(true)}
        onOpenDataSourcesModal={() => setIsDataSourcesModalOpen(true)}
        onCitySelect={handleCitySelect}
        onLocateUser={handleLocateUser}
        isLocating={isLocating}
        onResetFilters={handleResetFilters}
        onGoToBestToilet={handleGoToBestToilet}
        favoritesCount={favoriteIds.length}
      />

      <div className="flex-1 flex overflow-hidden relative">
        <div
          className={`w-full md:w-80 lg:w-96 shrink-0 h-full z-10 ${
            mobileTab === 'list' ? 'block' : 'hidden md:block'
          }`}
        >
          <ToiletList
            toilets={filteredToilets}
            selectedToilet={selectedToilet}
            onSelectToilet={(t) => {
              setSelectedToiletId(t.id);
              setMapCenter({ lat: t.lat, lng: t.lng });
              if (mobileTab === 'list') {
                setMobileTab('map');
                setMobileDetailsExpanded(false);
              }
            }}
            searchQuery={filter.searchQuery}
            setSearchQuery={(q) => setFilter((prev) => ({ ...prev, searchQuery: q }))}
            sortOption={sortOption}
            onSortChange={setSortOption}
            referenceLocation={referenceLocation}
            onResetFilters={handleResetFilters}
            isFavorite={isFavorite}
            onToggleFavorite={toggleFavorite}
          />
        </div>

        <div
          className={`flex-1 h-full relative ${
            mobileTab === 'map' ? 'block' : 'hidden md:block'
          }`}
        >
          <ToiletMap
            toilets={filteredToilets}
            selectedToilet={selectedToilet}
            onSelectToilet={(t) => {
              setSelectedToiletId(t.id);
              setMobileDetailsExpanded(false);
            }}
            center={mapCenter}
            zoom={mapZoom}
            onViewportChange={(nextCenter, nextZoom) => {
              setMapCenter(nextCenter);
              setMapZoom(nextZoom);
            }}
            onFetchOsmNearCenter={handleFetchOsmNearCenter}
            isLoadingOsm={isLoadingOsm}
            detailsOpen={selectedToilet !== null}
            layoutKey={mobileTab + (selectedToilet !== null ? ':open' : ':closed')}
            userLocation={userLocation}
          />

          {/* Mobile Bottom Sheet Preview Card (when map is active and details not fully expanded) */}
          {selectedToilet && mobileTab === 'map' && !mobileDetailsExpanded && (
            <div className="md:hidden absolute bottom-3 left-3 right-3 z-20 bg-surface/95 backdrop-blur-md border border-line-strong rounded-2xl p-3.5 shadow-2xl animate-in slide-in-from-bottom duration-200">
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] font-semibold text-accent bg-accent-soft px-2 py-0.5 rounded-md">
                    {selectedToilet.facilityType}
                  </span>
                  {selectedToilet.floorInfo && (
                    <span className="text-[11px] text-muted font-medium bg-surface-2 px-1.5 py-0.5 rounded-md">
                      <BdiText text={selectedToilet.floorInfo} />
                    </span>
                  )}
                  {referenceLocation && (
                    <span className="text-[11px] font-bold text-sky-700 bg-sky-50 border border-sky-200 px-2 py-0.5 rounded-md inline-flex items-center gap-1">
                      <Footprints className="w-3 h-3 text-sky-600" />
                      {formatWalkingTime(calculateDistanceMeters(referenceLocation.lat, referenceLocation.lng, selectedToilet.lat, selectedToilet.lng))}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => toggleFavorite(selectedToilet.id)}
                    className={`p-1 rounded-md transition-colors ${
                      isFavorite(selectedToilet.id)
                        ? 'text-amber-500 bg-amber-50'
                        : 'text-faint hover:text-amber-400'
                    }`}
                    title={isFavorite(selectedToilet.id) ? 'お気に入りを解除' : 'お気に入りに保存'}
                  >
                    <Star className={`w-4 h-4 ${isFavorite(selectedToilet.id) ? 'fill-amber-400 text-amber-500' : ''}`} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedToiletId(null)}
                    className="text-faint hover:text-ink p-1 rounded-md"
                    aria-label="閉じる"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div
                className="flex items-center justify-between gap-3 cursor-pointer select-none py-0.5"
                onClick={() => setMobileDetailsExpanded(true)}
              >
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-bold text-ink truncate">
                    <BdiText text={selectedToilet.name} />
                  </h3>
                  <p className="text-[11px] text-faint line-clamp-1 mt-0.5">
                    <BdiText text={selectedToilet.address} />
                  </p>
                </div>

                {(() => {
                  const shown = displayGrade(selectedToilet);
                  const gradeColor = getGradeColor(shown.grade);
                  return (
                    <div className={`stamp-plate w-10 h-10 shrink-0 ${gradeColor.bg} text-white font-black text-sm`}>
                      {shown.grade}
                    </div>
                  );
                })()}
              </div>

              <div className="grid grid-cols-2 gap-2 mt-2.5 pt-2.5 border-t border-line">
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${selectedToilet.lat},${selectedToilet.lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-1 py-2 px-3 bg-accent hover:bg-accent-strong text-white text-xs font-bold rounded-lg shadow-sm text-center"
                >
                  <Navigation className="w-3.5 h-3.5 fill-white text-white" />
                  <span>ここへ行く</span>
                </a>
                <button
                  type="button"
                  onClick={() => setMobileDetailsExpanded(true)}
                  className="inline-flex items-center justify-center gap-1 py-2 px-3 bg-surface hover:bg-surface-2 border border-line-strong text-ink-soft text-xs font-semibold rounded-lg shadow-xs text-center"
                >
                  <ChevronUp className="w-3.5 h-3.5 text-accent" />
                  <span>詳細・口コミ ({selectedToilet.reviewCount})</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Desktop Side Panel */}
        {selectedToilet && (
          <div className="hidden md:block w-96 lg:w-[420px] shrink-0 h-full border-l border-line bg-surface">
            <Suspense fallback={<div className="p-4 text-sm text-faint">読み込み中…</div>}>
            <ToiletDetails
              toilet={selectedToilet}
              onClose={() => setSelectedToiletId(null)}
              onOpenReviewModal={() => setIsReviewModalOpen(true)}
              onVoteHelpful={handleVoteHelpful}
              onReportReview={handleReportReview}
              votedReviewIds={votedReviewIds}
              referenceLocation={referenceLocation}
              isFavorite={isFavorite}
              onToggleFavorite={toggleFavorite}
            />
            </Suspense>
          </div>
        )}

        {/* Mobile Fullscreen / Expanded Bottom Sheet */}
        {selectedToilet && mobileDetailsExpanded && (
          <div className="md:hidden fixed inset-0 z-40 flex flex-col justify-end bg-black/40 backdrop-blur-xs animate-in fade-in duration-150">
            <div
              className="flex-1 w-full"
              onClick={() => setMobileDetailsExpanded(false)}
            />
            <div className="bg-surface rounded-t-2xl shadow-2xl border-t border-line flex flex-col h-[84vh] max-h-[84vh] overflow-hidden animate-in slide-in-from-bottom duration-200">
              <div
                className="pt-2.5 pb-2 flex flex-col items-center justify-center cursor-pointer border-b border-line/60 bg-surface shrink-0 hover:bg-surface-2 transition-colors"
                onClick={() => setMobileDetailsExpanded(false)}
              >
                <div className="w-10 h-1.5 bg-line-strong rounded-full mb-1" />
                <span className="text-[10px] text-faint font-medium">タップしてマップに戻る</span>
              </div>
              <div className="flex-1 overflow-hidden">
                <Suspense fallback={<div className="p-4 text-sm text-faint">読み込み中…</div>}>
                <ToiletDetails
                  toilet={selectedToilet}
                  onClose={() => {
                    setMobileDetailsExpanded(false);
                    setSelectedToiletId(null);
                  }}
                  onOpenReviewModal={() => setIsReviewModalOpen(true)}
                  onVoteHelpful={handleVoteHelpful}
                  onReportReview={handleReportReview}
                  votedReviewIds={votedReviewIds}
                  referenceLocation={referenceLocation}
                  isFavorite={isFavorite}
                  onToggleFavorite={toggleFavorite}
                />
                </Suspense>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="md:hidden flex items-center justify-around border-t border-line bg-surface py-2 px-4 z-30">
        <button
          type="button"
          onClick={() => setMobileTab('map')}
          className={`flex flex-col items-center gap-1 text-xs font-medium ${
            mobileTab === 'map' ? 'text-accent' : 'text-faint hover:text-ink-soft'
          }`}
        >
          <MapIcon className="w-5 h-5" />
          <span>マップ表示</span>
        </button>

        <button
          type="button"
          onClick={() => setMobileTab('list')}
          className={`flex flex-col items-center gap-1 text-xs font-medium ${
            mobileTab === 'list' ? 'text-accent' : 'text-faint hover:text-ink-soft'
          }`}
        >
          <List className="w-5 h-5" />
          <span>リスト ({filteredToilets.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setIsDataSourcesModalOpen(true)}
          className="flex flex-col items-center gap-1 text-xs font-medium text-faint hover:text-ink-soft"
        >
          <Info className="w-5 h-5" />
          <span>データ元比較</span>
        </button>
      </div>

      <Suspense fallback={null}>
      <DataSourceModal
        isOpen={isDataSourcesModalOpen}
        onClose={() => setIsDataSourcesModalOpen(false)}
      />

      <ReviewModal
        toilet={selectedToilet}
        isOpen={isReviewModalOpen}
        onClose={() => setIsReviewModalOpen(false)}
        onSubmitReview={handleSubmitReview}
      />

      <AddToiletModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onAddToilet={handleAddToilet}
        defaultLocation={mapCenter}
      />
      {isAdminOpen && (
        <AdminPanel onClose={() => setIsAdminOpen(false)} />
      )}
      </Suspense>

      {toastMessage && (
        <div className="fixed bottom-16 sm:bottom-6 left-1/2 -translate-x-1/2 z-[3000] bg-ink/95 backdrop-blur-md text-white text-xs font-medium px-4 py-2.5 rounded-xl border border-white/10 shadow-2xl flex items-center gap-2 pointer-events-auto">
          <Sparkles className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
