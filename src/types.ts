export type CleanlinessGrade = 'S' | 'A' | 'B' | 'C' | 'D';

export type FacilityCategory =
  | 'department' // 百貨店・商業施設
  | 'station'    // 駅・地下鉄
  | 'convenience'// コンビニ
  | 'park'       // 公園・公衆トイレ
  | 'hotel'      // ホテル・オフィス
  | 'cafe';      // カフェ・飲食店

export type DataSourceType =
  | 'google'    // Google Maps / Places API
  | 'osm'       // OpenStreetMap (amenity=toilets)
  | 'opendata'  // 自治体オープンデータ (東京都等)
  | 'manual'    // 手動調査（公式フロアガイド・現地確認ベース。OD/OSM由来ではない）
  | 'community';// コミュニティ・ユーザー報告

/** 設備の存在状態: true=あり / false=なし / null=未確認（不明）。
 * 「設備がない」と「まだ調べていない」は明確に区別する（レビューP1対応）。 */
export type TriState = boolean | null;

export interface ToiletAttributes {
  hasWashlet: TriState;            // 温水洗浄便座（ウォシュレット）
  hasMultipurpose: TriState;       // 多機能・だれでもトイレ
  hasBabyTable: TriState;          // おむつ交換台 / ベビーシート
  hasNursingRoom: TriState;        // 授乳室
  hasPowderRoom: TriState;         // パウダールーム・ドレッサー
  hasOstomate: TriState;           // オストメイト対応
  isFree: TriState;                // 無料で利用可能
  isOpen24h: TriState;             // 24時間利用可能
  hasSoap: TriState;               // ハンドソープあり
  hasAlcohol: TriState;            // 除菌アルコール設置
  hasPaperTowelOrDryer: TriState;  // ペーパータオルまたはハンドドライヤー
  toiletStyle: 'western' | 'japanese' | 'both' | null; // 洋式・和式（null=未確認）
}

export interface SubScores {
  cleanliness: number | null; // 便器・床の清潔度 (1.0 - 5.0)。null=未評価
  odor: number | null;        // におい・消臭状態 (1.0 - 5.0)。null=未評価
  supplies: number | null;    // 備品充実度 (石鹸・ペーパー・除菌) (1.0 - 5.0)。null=未評価
  comfort: number | null;     // 快適度・広さ・照明 (1.0 - 5.0)。null=未評価
}

export interface ToiletReview {
  id: string;
  userName: string;
  // 引用の出所（例：「Google Maps」「Yahoo!マップ」）。取込データのみ。
  // undefined＝出所未確認。Google確認分以外をGoogle表記してはならない
  source?: string;
  userRole?: string;
  /** 総合満足度 1-5（正式フィールド。旧データは無く rating のみ持つ） */
  overallScore?: number;
  /** 総合満足度 1-5 の旧名（overallScore 導入前の保存データ互換用の別名） */
  rating: number;
  /** 便器・床の清潔さ 1-5（独立に集計して cleanlinessScore へ） */
  cleanlinessScore: number;
  /** におい・換気状態 1-5（独立に集計） */
  odorScore: number;
  /** 備品（石鹸・ペーパー・除菌）1-5（独立に集計） */
  suppliesScore: number;
  comment: string;
  createdAt: string;
  lastCleanedTime?: string;
  tags?: string[];
  helpfulCount: number;
}

export interface ToiletFacility {
  id: string;
  name: string;
  facilityType: string;
  category: FacilityCategory;
  dataSource: DataSourceType;
  lat: number;
  lng: number;
  address: string;
  floorInfo?: string;
  // 実測レビューの「清潔さ次元」平均のランク・スコア。reviewCount === 0 の場合は
  // 設備推定値/Google手動調査値を表示用に入れ、UI上は「調査」「推定」タグ付きの
  // グレードとして扱うこと（displayGrade/evaluationKind参照）。
  // null は未評価（コミュニティ登録直後など口コミ0件で推定値も無い状態）。
  // 呼び出し側は必ず null を「未評価」表示として扱うこと。
  cleanlinessGrade: CleanlinessGrade | null;
  cleanlinessScore: number | null; // 1.0 - 5.0（便器・床の清潔さの実測平均）。null=未評価
  /** 総合満足度の実測平均（口コミ1件以上で設定。0件は未定義＝未評価） */
  overallScore?: number;
  // 設備タグからの推定ランク・スコア（実測ではない）。null=未評価
  equipmentGrade: CleanlinessGrade | null;
  equipmentScore: number | null; // 1.0 - 5.0
  // 設備推定の内訳（口コミ表示は reviews から次元別に導出。comfort は入力項目が
  // ないため常にこの推定値）
  subScores: SubScores;
  attributes: ToiletAttributes;
  openingHours: string;
  description: string;
  lastCleaned?: string;
  photos?: string[];
  reviewCount: number;
  reviews: ToiletReview[];
  // 外部（Google Maps等）のlisting上に表示される口コミ総数。未取得でも件数だけ
  // 記録し、「口コミなし」と「未取込」を区別するために使う。undefined＝不明。
  // 注意：大型商業施設の件数は建物全体の口コミ数（トイレ単体ではない）の場合が
  // ある。UIでは「関連口コミ」と表記し、1000件以上は建物全体の可能性を注記する。
  externalReviewCount?: number;
  externalReviewSource?: string;
  // 手動調査の実施日（YYYY-MM-DD）。調査評価の鮮度表示に使う。undefined＝不明
  surveyedAt?: string;
  // 推定グレードの根拠（src/lib/estimate.ts の basis）。実測レビューが付くまでの
  // 暫定目安であることをUIで開示するために使う。undefined＝推定根拠なし
  estimateBasis?: string[];
  facilitySummary?: string;
  // 施設メモ。旧aiSummary（AIが生成したものではないため改名）
  facilityNote?: string;
  pros?: string[];
  cons?: string[];
  tips?: string;
  googleMapsUrl?: string;
  officialOpenDataId?: string;
}

export type QuickPresetType =
  | 'all'
  | 'baby'
  | 'barrier_free'
  | 'female_safe'
  | 'night_24h'
  | 'favorites';

export interface FilterState {
  dataSource: DataSourceType | 'all';
  onlyHighCleanliness: boolean; // Grade S & A (score >= 4.0)。実測口コミあり（reviewCount > 0）のみ対象
  onlyWashlet: boolean;
  onlyMultipurpose: boolean;
  onlyPowderRoom: boolean;
  only24h: boolean;
  onlyFavorites?: boolean;
  quickPreset?: QuickPresetType;
  searchQuery: string;
}

export type ToiletSortOption = 'cleanliness' | 'distance' | 'reviews';

export interface CityPreset {
  name: string;
  lat: number;
  lng: number;
  zoom: number;
}
