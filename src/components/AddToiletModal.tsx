import React, { useState, useEffect } from 'react';
import {
  ToiletFacility,
  FacilityCategory,
  TriState,
} from '../types';

import { facilityTypeForCategory } from '../lib/grade';
import { newReviewId } from '../lib/ids';
import { toiletFormFeedback } from '../lib/reviewForm';
import { BdiText } from './BdiText';
import { PlusCircle } from 'lucide-react';

/** あり / 不明 / なし の3値ピッカー（不明=未確認。「なし」と区別する） */
function TriPicker({
  value,
  onChange,
}: {
  value: TriState;
  onChange: (v: TriState) => void;
}) {
  const options: { v: TriState; label: string; active: string }[] = [
    { v: true, label: 'あり', active: 'bg-accent text-white border-accent' },
    { v: null, label: '不明', active: 'bg-line-strong text-ink border-line-strong' },
    { v: false, label: 'なし', active: 'bg-muted text-white border-muted' },
  ];
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          onClick={() => onChange(o.v)}
          aria-pressed={value === o.v}
          className={`flex-1 px-2 py-1 rounded-md text-[11px] font-semibold border transition-colors ${
            value === o.v
              ? o.active
              : 'bg-white border-line text-faint hover:text-ink hover:border-line-strong'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface AddToiletModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddToilet: (toilet: ToiletFacility) => void;
  defaultLocation: { lat: number; lng: number };
}

export const AddToiletModal: React.FC<AddToiletModalProps> = ({
  isOpen,
  onClose,
  onAddToilet,
  defaultLocation,
}) => {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<FacilityCategory>('department');
  const [address, setAddress] = useState('');
  const [floorInfo, setFloorInfo] = useState('');

  // 設備は「あり/なし/不明」の3値。未確認を false（なし）と断定しない
  const [hasWashlet, setHasWashlet] = useState<TriState>(null);
  const [hasMultipurpose, setHasMultipurpose] = useState<TriState>(null);
  const [hasBabyTable, setHasBabyTable] = useState<TriState>(null);
  const [hasPowderRoom, setHasPowderRoom] = useState<TriState>(null);
  const [isOpen24h, setIsOpen24h] = useState<TriState>(null);
  const [description, setDescription] = useState('');

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

  // 事前バリデーション（サーバー textPolicy と同一判定）。送信前に日本語 copy で理由を提示。
  const formError = toiletFormFeedback({ name, address, floorInfo, description });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || formError) return;

    const newFacility: ToiletFacility = {
      id: `toilet-user-${newReviewId()}`,
      name: name.trim(),
      facilityType: facilityTypeForCategory(category),
      category,
      dataSource: 'community',
      // 地図中心の正確な位置で登録する（ずらさない）
      lat: defaultLocation.lat,
      lng: defaultLocation.lng,
      address: address.trim() || '現在地周辺',
      floorInfo: floorInfo.trim() || undefined,
      // 施設登録はメタデータだけを保存する。清潔度は登録後の通常レビューで評価する。
      // 未評価は null（ToiletFacility の nullable 契約）。as any による隠蔽はしない。
      cleanlinessGrade: null,
      cleanlinessScore: null,
      equipmentGrade: null,
      equipmentScore: null,
      subScores: { cleanliness: null, odor: null, supplies: null, comfort: null },
      attributes: {
        hasWashlet,
        hasMultipurpose,
        hasBabyTable,
        // フォームで確認していない項目は true と断定せず null（未確認）で保存する
        hasNursingRoom: null,
        hasPowderRoom,
        hasOstomate: null,
        isFree: null,
        isOpen24h,
        hasSoap: null,
        hasAlcohol: null,
        hasPaperTowelOrDryer: null,
        toiletStyle: null,
      },
      openingHours: isOpen24h === true ? '24時間営業' : isOpen24h === false ? '施設営業時間に準ずる' : '営業時間未確認',
      description: description.trim() || 'ユーザーによって登録されたトイレ情報です。',
      reviewCount: 0,
      reviews: [],
      facilityNote: 'ユーザー報告に基づく新規登録トイレ情報。',
    };

    onAddToilet(newFacility);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="トイレを新しく登録">
      <div className="bg-surface border border-line-strong rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-line flex items-center justify-between bg-canvas">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent text-white flex items-center justify-center shadow-[0_3px_8px_rgba(11,110,82,0.25)]">
              <PlusCircle className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-bold text-ink">
                新しいトイレのきれい度を登録
              </h2>
              <p className="text-xs text-faint">
                マップにまだない綺麗なトイレ・穴場スポットを追加
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="text-faint hover:text-ink p-1 rounded-md text-sm transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 text-xs text-ink-soft">
          <div>
            <label className="block text-ink-soft font-semibold mb-1">
              施設名・場所名 <span className="text-danger">*</span>
            </label>
            <input
              required
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 新宿マルイ本館 4F レストルーム"
              className="w-full px-3 py-2 bg-surface-2 border border-line rounded-lg text-ink placeholder-faint focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent transition-colors"
            />
            {formError && (
              <p role="alert" className="text-danger text-xs mt-1">{formError}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-ink-soft font-semibold mb-1">
                カテゴリ
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as FacilityCategory)}
                className="w-full px-3 py-2 bg-surface-2 border border-line rounded-lg text-ink focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent transition-colors"
              >
                <option value="department" className="bg-white text-ink">百貨店・商業施設</option>
                <option value="station" className="bg-white text-ink">駅・交通機関</option>
                <option value="convenience" className="bg-white text-ink">コンビニ</option>
                <option value="park" className="bg-white text-ink">公園・公衆トイレ</option>
                <option value="hotel" className="bg-white text-ink">ホテル・オフィス</option>
              </select>
            </div>

            <div>
              <label className="block text-ink-soft font-semibold mb-1">
                フロア・階数 (任意)
              </label>
              <input
                type="text"
                value={floorInfo}
                onChange={(e) => setFloorInfo(e.target.value)}
                placeholder="例: 3F 南側奥"
                className="w-full px-3 py-2 bg-surface-2 border border-line rounded-lg text-ink placeholder-faint focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-ink-soft font-semibold mb-1">
              住所・ランドマーク
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="例: 東京都新宿区新宿3-30-13"
              className="w-full px-3 py-2 bg-surface-2 border border-line rounded-lg text-ink placeholder-faint focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent transition-colors"
            />
          </div>

          <p className="text-[11px] text-faint bg-surface-2 p-3 rounded-xl border border-line">
            清潔度・におい・備品・快適度は、施設登録とは分離した通常のレビューで評価します。未確認の項目は推測して保存しません。
          </p>

          {/* Equipment (tri-state: あり / 不明 / なし) */}
          <div>
            <label className="block text-ink-soft font-semibold mb-1.5">
              備え付け設備
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(
                [
                  ['ウォシュレット', hasWashlet, setHasWashlet],
                  ['多目的・車椅子', hasMultipurpose, setHasMultipurpose],
                  ['おむつ替え台', hasBabyTable, setHasBabyTable],
                  ['パウダールーム', hasPowderRoom, setHasPowderRoom],
                  ['24時間利用可', isOpen24h, setIsOpen24h],
                ] as [string, TriState, (v: TriState) => void][]
              ).map(([label, value, setter]) => (
                <div
                  key={label}
                  className="p-2.5 bg-surface-2 border border-line rounded-lg space-y-1.5"
                >
                  <span className="text-ink-soft font-medium">{label}</span>
                  <TriPicker value={value} onChange={setter} />
                </div>
              ))}
            </div>
            <p className="text-[11px] text-faint mt-1.5">
              実際に確認できた設備だけ「あり/なし」を選んでください。「不明」は未確認の意味で「なし」とは区別して表示されます。
            </p>
          </div>

          <div>
            <label className="block text-ink-soft font-semibold mb-1">
              清潔感の特徴・メモ
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="清掃頻度、におい、アメニティ、空いている時間帯など..."
              className="w-full px-3 py-2 bg-surface-2 border border-line rounded-lg text-ink placeholder-faint focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={!!formError}
            title={formError ?? undefined}
            className="w-full py-2.5 px-4 bg-accent hover:bg-accent-strong text-white font-bold rounded-lg shadow-[0_3px_10px_rgba(11,110,82,0.22)] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <PlusCircle className="w-4 h-4" />
            <span>マップにトイレを追加登録</span>
          </button>
        </form>
      </div>
    </div>
  );
};
