/**
 * ToiletMap のマーカー描画ロジック（Leaflet に依存しない純関数群）。
 *
 * パフォーマンス方針（選択ハイライトの最適化）:
 * 以前は選択変更のたびに全マーカーの divIcon を再生成していた（O(n) のHTML構築 +
 * Leaflet への再アタッチで全ピンが一瞬消えてちらつく）。現在は:
 *  - toilets 変化時のみマーカーを構築し、各要素に `marker-toilet-<id>` クラスを付与
 *  - 選択変更時は該当2要素（旧選択・新選択）の DOM クラスだけを付け替える
 *    （`.is-selected` の有無で拡大・リング・影を表現）
 */
import type { ToiletFacility } from '../types';
import { displayGrade, evaluationKindLabel, getGradeColor } from './grade';

/** マーカー要素（divIcon のルート div）に付ける識別クラスの接頭辞。 */
export const MARKER_CLASS_PREFIX = 'marker-toilet-';
/** 選択中マーカーに付与するクラス（CSS は index.css の .custom-toilet-marker 参照）。 */
export const MARKER_SELECTED_CLASS = 'is-selected';

/** id → マーカー識別クラス。id は英数とハイフン等に正規化してから使う。 */
export function markerClassForId(id: string): string {
  // CSSクラスに使えない文字（id由来の区切り等）はアンダースコアへ潰す。
  // id 自体は facilityIds/osmIds の正準形なので衝突は実用上起きないが、
  // 潰した結果の衝突は安全側（同一クラス＝同時ハイライト）として扱う。
  return `${MARKER_CLASS_PREFIX}${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/**
 * マーカー内HTML（divIcon の html 引数）を1件分組み立てる。
 * 選択状態は含めない（選択は .is-selected クラスの付け替えで表現するため）。
 */
export function buildMarkerHtml(toilet: ToiletFacility): string {
  // 口コミ0件でも調査/推定グレードを表示する（初期状態のマップに意味を持たせる）。
  // 実測以外は少し薄くして出所の違いが分かるようにする
  const shown = displayGrade(toilet);
  const colorInfoBg = gradeBgClass(shown.grade);
  // 未スコア（コミュニティ登録直後）はグレード無し。 plate には「?」を出す
  const unscored = shown.grade === null || shown.score === null;
  const gradeLetter = unscored ? '?' : shown.grade;
  const dimmed = shown.kind !== 'measured' ? 'opacity-80 saturate-[.65]' : '';
  const ring =
    shown.kind !== 'measured' ? 'ring-slate-200' : 'ring-white';

  return `
    <div class="toilet-marker-root relative group cursor-pointer transition-transform duration-200 ${dimmed}">
      <div class="toilet-marker-plate flex items-center justify-center w-8 h-8 rounded-full shadow-lg text-white font-bold text-xs ${colorInfoBg} ring-2 ${ring}">
        ${gradeLetter}
      </div>
      <div class="toilet-marker-tip absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 ${colorInfoBg}"></div>
    </div>
  `;
}

/** グレード → 背景色クラス。getGradeColor().bg への一本化（二重実装の防止）。 */
function gradeBgClass(grade: string | null): string {
  return getGradeColor(grade as ToiletFacility['cleanlinessGrade']).bg;
}

/**
 * マーカーの title 属性（アクセシビリティ用ラベル）。旧実装と同じ文言。
 */
export function markerTitleFor(toilet: ToiletFacility): string {
  const shown = displayGrade(toilet);
  const unscored = shown.grade === null || shown.score === null;
  const gradeLetter = unscored ? '?' : shown.grade;
  return unscored
    ? `${toilet.name}（未評価・口コミ募集中）`
    : `${toilet.name}（${evaluationKindLabel(shown.kind)} ${gradeLetter}級）`;
}

/**
 * 選択変更時にクラスを付け替えるべき要素を特定するためのヘルパー:
 * 旧選択IDと新選択ID（どちらも null 可）から「更新対象のマーカー識別クラス」一覧を返す。
 * 同一選択なら空配列（DOM更新不要）を返す。
 */
export function selectionChangedMarkerClasses(
  prevId: string | null | undefined,
  nextId: string | null | undefined
): Array<{ className: string; selected: boolean }> {
  if ((prevId ?? null) === (nextId ?? null)) return [];
  const out: Array<{ className: string; selected: boolean }> = [];
  if (prevId) out.push({ className: markerClassForId(prevId), selected: false });
  if (nextId) out.push({ className: markerClassForId(nextId), selected: true });
  return out;
}
