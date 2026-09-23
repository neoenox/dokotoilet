// @vitest-environment happy-dom
// ToiletMap マーカー描画ロジック（toiletMapMarkers.ts）のテスト。
//
// 検証方針:
//  - buildMarkerHtml / markerTitleFor が旧実装（ToiletMap.tsx インライン版）と
//    同等の出所開示（実測/調査/推定の薄め表示・未スコアの「?」）を保つこと
//  - マーカーHTMLが選択状態に依存しないこと（同一施設なら常に同一HTML。
//    これが「選択変更で divIcon を再構築しない」最適化の前提）
//  - selectionChangedMarkerClasses が旧→新の選択差分を正しく返すこと
//    （同値なら空、片側 null の扱いを含む）
//  - happy-dom 上で識別クラス + .is-selected の DOM 付け替えが実際に動くこと
import { describe, expect, it } from 'vitest';
import type { ToiletFacility } from '../types';
import {
  MARKER_CLASS_PREFIX,
  MARKER_SELECTED_CLASS,
  buildMarkerHtml,
  markerClassForId,
  markerTitleFor,
  selectionChangedMarkerClasses,
} from './toiletMapMarkers';

const baseToilet = (overrides: Partial<ToiletFacility> = {}): ToiletFacility =>
  ({
    id: 'toilet-user-test',
    name: 'テストトイレ',
    facilityType: '公衆トイレ',
    category: 'park',
    dataSource: 'community',
    lat: 35.659,
    lng: 139.7,
    address: 'x',
    cleanlinessGrade: 'B',
    cleanlinessScore: 3.2,
    equipmentGrade: 'B',
    equipmentScore: 3.0,
    subScores: { cleanliness: 3, odor: 3, supplies: 3, comfort: 3 },
    attributes: {},
    openingHours: 'unknown',
    description: '',
    reviewCount: 2,
    reviews: [],
    ...overrides,
  }) as ToiletFacility;

describe('markerClassForId', () => {
  it('prefixes and keeps canonical id characters', () => {
    expect(markerClassForId('osm-node-123')).toBe(
      `${MARKER_CLASS_PREFIX}osm-node-123`
    );
  });

  it('sanitizes characters that are invalid in CSS classes', () => {
    const cls = markerClassForId('od-熊谷/市立 1番');
    expect(cls).toMatch(/^marker-toilet-[A-Za-z0-9_-]+$/);
  });
});

describe('buildMarkerHtml', () => {
  it('is selection-independent: identical HTML for any selection state', () => {
    // 旧実装は isSelected を HTML に織り込んでいたため選択のたびに全再構築が必要だった。
    // 新実装の前提として、HTML は選択状態に依存してはならない。
    const html = buildMarkerHtml(baseToilet());
    expect(html).toBe(buildMarkerHtml(baseToilet()));
  });

  it('shows the measured grade letter without dimming', () => {
    const html = buildMarkerHtml(baseToilet());
    expect(html).toMatch(/\n\s+B\n/); // プレート中央にグレード文字
    expect(html).toContain('bg-amber-500');
    expect(html).not.toContain('opacity-80');
  });

  it('dims non-measured kinds (survey/estimated)', () => {
    const html = buildMarkerHtml(baseToilet({ reviewCount: 0 }));
    expect(html).toContain('opacity-80');
    expect(html).toContain('saturate-[.65]');
  });

  it('renders "?" for unscored facilities', () => {
    const html = buildMarkerHtml(
      baseToilet({
        reviewCount: 0,
        cleanlinessGrade: null,
        cleanlinessScore: null,
        equipmentGrade: null,
        equipmentScore: null,
      })
    );
    expect(html).toMatch(/\n\s+\?\n/); // 未スコアは「?」表示
    expect(html).toContain('bg-slate-500');
  });
});

describe('markerTitleFor', () => {
  it('labels measured facilities with their grade', () => {
    expect(markerTitleFor(baseToilet())).toBe('テストトイレ（実測 B級）');
  });

  it('labels unscored facilities as unreviewed', () => {
    expect(
      markerTitleFor(
        baseToilet({
          reviewCount: 0,
          cleanlinessGrade: null,
          cleanlinessScore: null,
          equipmentGrade: null,
          equipmentScore: null,
        })
      )
    ).toBe('テストトイレ（未評価・口コミ募集中）');
  });
});

describe('selectionChangedMarkerClasses', () => {
  it('returns an empty diff when the selection is unchanged', () => {
    expect(selectionChangedMarkerClasses('a', 'a')).toEqual([]);
    expect(selectionChangedMarkerClasses(null, null)).toEqual([]);
    expect(selectionChangedMarkerClasses(undefined, null)).toEqual([]);
  });

  it('deselects the previous marker and selects the next one', () => {
    expect(selectionChangedMarkerClasses('a', 'b')).toEqual([
      { className: markerClassForId('a'), selected: false },
      { className: markerClassForId('b'), selected: true },
    ]);
  });

  it('handles selecting from nothing and deselecting to nothing', () => {
    expect(selectionChangedMarkerClasses(null, 'x')).toEqual([
      { className: markerClassForId('x'), selected: true },
    ]);
    expect(selectionChangedMarkerClasses('x', null)).toEqual([
      { className: markerClassForId('x'), selected: false },
    ]);
  });
});

describe('DOM class toggling (happy-dom)', () => {
  it('toggles the selected class on marker elements identified by marker class', () => {
    const elA = document.createElement('div');
    const elB = document.createElement('div');
    elA.classList.add(markerClassForId('a'));
    elB.classList.add(markerClassForId('b'));

    // ToiletMap の selection effect と同じ操作
    elB.classList.toggle(MARKER_SELECTED_CLASS, true);
    expect(elB.classList.contains(MARKER_SELECTED_CLASS)).toBe(true);
    expect(elA.classList.contains(MARKER_SELECTED_CLASS)).toBe(false);

    // 選択を b → a へ移す
    elB.classList.toggle(MARKER_SELECTED_CLASS, false);
    elA.classList.toggle(MARKER_SELECTED_CLASS, true);
    expect(elA.classList.contains(MARKER_SELECTED_CLASS)).toBe(true);
    expect(elB.classList.contains(MARKER_SELECTED_CLASS)).toBe(false);

    // 同一施設の再選択では差分なし（DOM更新が起きないことの担保に対応）
    expect(selectionChangedMarkerClasses('a', 'a')).toEqual([]);
  });
});
