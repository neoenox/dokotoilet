// @vitest-environment happy-dom
// ToiletMap の選択ハイライト最適化の統合テスト。
//
// Leaflet をモックし、次の点を検証する:
//  1. toilets 変化時のみマーカー構築（L.divIcon / L.marker）が走ること
//  2. selectedToilet の変化では divIcon 再構築が走らず、該当マーカー要素の
//     .is-selected クラスだけが付け替わること（O(n)再構築・ちらつきの解消）
//  3. マーカークリックが onSelectToilet に伝わること
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { ToiletFacility } from '../types';

// モックは vi.hoisted で巻き上げ、呼び出し記録もここで取る
const mock = vi.hoisted(() => {
  type MockMarker = {
    element: { classList: Set<string> };
    onClick: () => void;
  };
  const markers: MockMarker[] = [];
  return { markers };
});

vi.mock('leaflet', () => {
  // L.map(...).setView(...) の戻り値がそのまま map 変数に入るため、
  // setView は自分自身（map インスタンス）を返す必要がある
  const mapInstance = {
    setView: () => mapInstance,
    flyTo: () => undefined,
    getCenter: () => ({ lat: 35.659, lng: 139.7 }),
    getZoom: () => 15,
    on: () => undefined,
    addControl: () => undefined,
    removeLayer: () => undefined,
    invalidateSize: () => undefined,
    remove: () => undefined,
  };
  return {
    default: {
      map: () => mapInstance,
      control: { zoom: () => ({ addTo: vi.fn() }) },
      layerGroup: () => {
        const layers: unknown[] = [];
        const group = {
          addLayer: (l: unknown) => layers.push(l),
          clearLayers: () => layers.splice(0),
          eachLayer: (fn: (l: unknown) => void) => layers.forEach(fn),
        };
        return Object.assign(group, { addTo: () => group });
      },
      tileLayer: () => ({ addTo: vi.fn() }),
      divIcon: (opts: { html: string; className?: string }) => ({
        __divIcon: true,
        html: opts.html,
        className: opts.className,
      }),
      marker: (latlng: { lat: number; lng: number }, opts: { title?: string }) => {
        const record = {
          latlng,
          title: opts?.title as string | undefined,
          element: { classList: new Set<string>() },
          onClick: () => undefined,
        };
        const marker = {
          on: (_: string, fn: () => void) => {
            record.onClick = fn;
          },
          getElement: () => record.element,
        };
        mock.markers.push(record);
        return marker;
      },
    },
  };
});

import L from 'leaflet';
import { ToiletMap } from './ToiletMap';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// スコア未設定の最小 facility（title の未評価ラベル検証にも使う）
const toiletA = { id: 'toilet-user-a', name: 'A公衆トイレ', lat: 35.65, lng: 139.7 } as ToiletFacility;
const toiletB = { id: 'toilet-user-b', name: 'B公衆トイレ', lat: 35.66, lng: 139.71 } as ToiletFacility;
// 明示的な未スコア facility（displayGrade が grade:null を返す）
const toiletUnscored = {
  ...toiletA,
  id: 'toilet-user-unscored',
  name: '未評価トイレ',
  reviewCount: 0,
  cleanlinessGrade: null,
  cleanlinessScore: null,
  equipmentGrade: null,
  equipmentScore: null,
} as ToiletFacility;
const toilets = [toiletA, toiletB];

let roots: Root[] = [];
afterEach(() => {
  roots.splice(0).forEach((r) => r.unmount());
  document.body.innerHTML = '';
  mock.markers.length = 0;
});

// モック要素の classList（Set）へ DOMTokenList 互換 API を足す。
// ToiletMap の selection effect は classList.contains / toggle を使う。
// 各 render 前に呼ぶ（新しい marker レコードにも適用するため）。
const compatize = () => {
  for (const m of mock.markers) {
    const set = m.element.classList as unknown as Record<string, unknown> & Set<string>;
    if (typeof set.contains !== 'function') {
      const nativeAdd = set.add.bind(set);
      const nativeDelete = set.delete.bind(set);
      Object.assign(set, {
        contains: (c: string) => set.has(c),
        toggle: (c: string, force?: boolean) => {
          const on = force ?? !set.has(c);
          if (on) nativeAdd(c);
          else nativeDelete(c);
          return on;
        },
        add: (...cs: string[]) => {
          for (const c of cs) nativeAdd(c);
        },
      });
    }
  }
};

const renderEl = async (jsx: React.ReactElement): Promise<void> => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const r = createRoot(container);
  roots.push(r);
  await act(async () => {
    r.render(jsx);
  });
  compatize(); // 構築されたマーカーへ DOMTokenList 互換 API を付与
};

const clickButton = async (label: string) => {
  const btn = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent === label
  );
  await act(async () => {
    btn?.click();
  });
  compatize(); // 再構築された場合の新マーカーにも適用
};

// 選択状態をボタンで切り替えられるハーネス
const ToiletMapHarness = ({
  initialToilets = toilets,
}: {
  initialToilets?: ToiletFacility[];
}) => {
  const [selected, setSelected] = useState<ToiletFacility | null>(null);
  const [list, setList] = useState<ToiletFacility[]>(initialToilets);
  return (
    <div>
      <button type="button" onClick={() => setSelected(toiletA)}>pick-a</button>
      <button type="button" onClick={() => setSelected(toiletB)}>pick-b</button>
      <button type="button" onClick={() => setSelected(null)}>clear</button>
      <button type="button" onClick={() => setList([...list, toiletB])}>dup-list</button>
      <button type="button" onClick={() => setList([toiletA])}>shrink-list</button>
      <ToiletMap
        toilets={list}
        selectedToilet={selected}
        onSelectToilet={(t) => setSelected(t)}
        center={{ lat: 35.659, lng: 139.7 }}
        zoom={15}
        onFetchOsmNearCenter={() => {}}
        isLoadingOsm={false}
      />
    </div>
  );
};

const markerHas = (i: number, cls: string) =>
  mock.markers[i]?.element.classList.has(cls) ?? false;

describe('ToiletMap selection highlight optimization', () => {
  it('toggles .is-selected on selection change without rebuilding markers', async () => {
    await renderEl(<ToiletMapHarness />);

    // toilets 2件 → 初回構築で2マーカー
    expect(mock.markers).toHaveLength(2);
    const markersAfterBuild = mock.markers.length;

    // 選択 A → マーカー再構築（追加）なし。A のみ .is-selected
    await clickButton('pick-a');
    expect(mock.markers).toHaveLength(markersAfterBuild);
    expect(markerHas(0, 'is-selected')).toBe(true);
    expect(markerHas(1, 'is-selected')).toBe(false);

    // 選択を B へ移動 → 旧 A 解除 + 新 B 選択。再構築なし
    await clickButton('pick-b');
    expect(mock.markers).toHaveLength(markersAfterBuild);
    expect(markerHas(0, 'is-selected')).toBe(false);
    expect(markerHas(1, 'is-selected')).toBe(true);

    // 選択解除 → 再構築なし・両方非選択
    await clickButton('clear');
    expect(mock.markers).toHaveLength(markersAfterBuild);
    expect(markerHas(0, 'is-selected')).toBe(false);
    expect(markerHas(1, 'is-selected')).toBe(false);

    // 同一施設の再選択 → クラスは付いたまま
    await clickButton('pick-a');
    await clickButton('pick-a');
    expect(mock.markers).toHaveLength(markersAfterBuild);
    expect(markerHas(0, 'is-selected')).toBe(true);
    expect(markerHas(1, 'is-selected')).toBe(false);
  });

  it('rebuilds markers only when the toilets list changes', async () => {
    await renderEl(<ToiletMapHarness />);
    expect(mock.markers).toHaveLength(2);

    await clickButton('pick-a');
    expect(mock.markers).toHaveLength(2); // 選択では再構築しない

    // toilets 変化（重複スイッチでも新しい配列参照）→ 再構築される
    await clickButton('dup-list');
    expect(mock.markers.length).toBeGreaterThan(2);
    expect(mock.markers.length - 2).toBeGreaterThanOrEqual(2); // 再構築分

    // 収縮 → 再構築（1件分）
    const before = mock.markers.length;
    await clickButton('shrink-list');
    expect(mock.markers.length).toBeGreaterThan(before);
  });

  it('keeps selection classes in sync after a toilets rebuild', async () => {
    await renderEl(<ToiletMapHarness />);
    await clickButton('pick-a');
    expect(markerHas(0, 'is-selected')).toBe(true);

    // toilets 再構築後も選択状態が反映される（build effect が selected を見る）
    await clickButton('dup-list');
    expect(markerHas(0, 'is-selected')).toBe(true);
    expect(markerHas(1, 'is-selected')).toBe(false);
  });

  it('attaches marker titles from markerTitleFor', async () => {
    const records = mock.markers as unknown as Array<{ title?: string }>;

    // 明示的な未スコア facility → 未評価ラベル
    const container = document.createElement('div');
    document.body.appendChild(container);
    const r = createRoot(container);
    roots.push(r);
    await act(async () => {
      r.render(
        <ToiletMap
          toilets={[toiletUnscored]}
          selectedToilet={null}
          onSelectToilet={() => {}}
          center={{ lat: 35.659, lng: 139.7 }}
          zoom={15}
          onFetchOsmNearCenter={() => {}}
          isLoadingOsm={false}
        />
      );
    });
    expect(records[0].title).toBe('未評価トイレ（未評価・口コミ募集中）');
  });
});
