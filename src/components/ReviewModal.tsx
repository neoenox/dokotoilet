import React, { useState, useEffect } from 'react';
import { ToiletFacility, ToiletReview } from '../types';
import {
  canSubmitReview,
  commentFeedback,
  userNameFeedback,
} from '../lib/reviewForm';
import { sanitizeText } from '../lib/textPolicy';
import { newReviewId } from '../lib/ids';
import { BdiText } from './BdiText';
import {
  Sparkles,
  Star,
  ShieldCheck,
} from 'lucide-react';

interface ReviewModalProps {
  toilet: ToiletFacility | null;
  isOpen: boolean;
  onClose: () => void;
  onSubmitReview: (toiletId: string, review: ToiletReview) => Promise<boolean>;
}

const QUICK_REVIEW_TAGS = [
  '除菌液・ペーパー完備',
  '便座・床が清潔',
  'におい無く快適',
  '明るく安心感あり',
  '混雑していた',
  '個室が広め',
  '荷物置きあり',
  '清掃巡回直後',
];

export const ReviewModal: React.FC<ReviewModalProps> = ({
  toilet,
  isOpen,
  onClose,
  onSubmitReview,
}) => {
  // 総合満足度は未選択のまま送信できない（惰性的な満点投稿の防止）。
  // 細分化スコアは未調整なら選択済みの総合満足度を初期値として送信する。
  const [userName, setUserName] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [cleanlinessScore, setCleanlinessScore] = useState<number | null>(null);
  const [odorScore, setOdorScore] = useState<number | null>(null);
  const [suppliesScore, setSuppliesScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Esc で閉じる（#107 a11y）。フォーカストラップまでは踏み込まない。
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen || !toilet) return null;

  const toggleTag = (tag: string) => {
    if (comment.includes(tag)) {
      const cleaned = comment
        .replace(new RegExp(`(\\s*[、/・]?\\s*${tag})`), '')
        .replace(/^[、/・]\s*/, '')
        .trim();
      setComment(cleaned);
    } else {
      setComment((prev) => (prev.trim() ? `${prev.trim()}、${tag}` : tag));
    }
  };

  const canSubmit = canSubmitReview(rating, comment);

  // 事前バリデーション（サーバー textPolicy と同一判定）。送信前に日本語 copy で
  // 理由を提示する（サーバーの 400 を待たない）。
  const commentError = commentFeedback(comment);
  const userNameError = userNameFeedback(userName);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // この早期リターンで rating が number に絞り込まれる
    if (rating === null || !canSubmitReview(rating, comment) || isSubmitting) return;

    setSubmitError(null);
    setIsSubmitting(true);

    const newReview: ToiletReview = {
      id: `rev-${newReviewId()}`,
      // サーバーと同じ sanitizeText を適用（制御・書式文字は送信前に除去）
      userName: sanitizeText(userName).trim() || '匿名の利用者',
      rating,
      overallScore: rating, // 総合満足度（rating は旧名の別名として両方保存）
      cleanlinessScore: cleanlinessScore ?? rating,
      odorScore: odorScore ?? rating,
      suppliesScore: suppliesScore ?? rating,
      comment: sanitizeText(comment).trim(),
      createdAt: new Date().toISOString().split('T')[0],
      helpfulCount: 0,
    };

    try {
      const accepted = await onSubmitReview(toilet.id, newReview);
      if (accepted) {
        onClose();
        setComment('');
        setRating(null);
        setCleanlinessScore(null);
        setOdorScore(null);
        setSuppliesScore(null);
      } else {
        setSubmitError('投稿が拒否されました。内容を確認して、もう一度お試しください。');
      }
    } catch {
      setSubmitError('投稿に失敗しました。入力内容を保持しています。');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center p-4 bg-black/75 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="トイレのきれい度を評価・投稿">
      <div className="bg-surface border border-line-strong rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-line flex items-center justify-between bg-canvas">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent text-white flex items-center justify-center shadow-[0_3px_8px_rgba(11,110,82,0.25)]">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-bold text-ink">
                トイレのきれい度を評価・投稿
              </h2>
              <p className="text-xs text-faint line-clamp-1"><BdiText text={toilet.name} /></p>
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
              ニックネーム (任意)
            </label>
            <input
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="例: たろう / 匿名"
              className="w-full px-3 py-2 bg-surface-2 border border-line rounded-lg text-ink placeholder-faint focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent transition-colors"
            />
            {userNameError && (
              <p role="alert" className="text-danger text-xs mt-1">{userNameError}</p>
            )}
          </div>

          {/* Overall Stars（未選択のまま送信不可。rating は明示選択のみ） */}
          <div>
            <label className="block text-ink-soft font-semibold mb-1">
              総合満足度 <span className="text-danger">*</span>
            </label>
            <div className="flex items-center gap-1 text-[#f27d26]">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  type="button"
                  key={star}
                  onClick={() => setRating(star)}
                  className="p-1 hover:scale-110 transition-transform"
                >
                  <Star
                    className={`w-6 h-6 ${
                      rating !== null && star <= rating
                        ? 'fill-[#f27d26] text-[#f27d26]'
                        : 'text-line-strong'
                    }`}
                  />
                </button>
              ))}
              <span className="ml-2 font-bold text-ink">
                {rating === null ? '未選択' : `${rating} / 5`}
              </span>
            </div>
          </div>

          {/* Sub-Score Sliders（総合満足度を選ぶまで操作できない。未調整なら総合値を送信） */}
          <div className="space-y-2.5 bg-surface-2 p-3 rounded-xl border border-line">
            <div>
              <div className="flex justify-between font-medium text-muted mb-1">
                <span>便器・床の清潔さ</span>
                <span className="font-bold text-accent">
                  {cleanlinessScore === null ? '未調整' : `${cleanlinessScore}点`}
                </span>
              </div>
              <input
                type="range"
                min="1"
                max="5"
                step="1"
                value={cleanlinessScore ?? rating ?? 3}
                onChange={(e) => setCleanlinessScore(parseInt(e.target.value))}
                disabled={rating === null}
                className="w-full accent-[#0b6e52] cursor-pointer disabled:opacity-50"
              />
            </div>

            <div>
              <div className="flex justify-between font-medium text-muted mb-1">
                <span>におい・換気状態</span>
                <span className="font-bold text-sky-500">
                  {odorScore === null ? '未調整' : `${odorScore}点`}
                </span>
              </div>
              <input
                type="range"
                min="1"
                max="5"
                step="1"
                value={odorScore ?? rating ?? 3}
                onChange={(e) => setOdorScore(parseInt(e.target.value))}
                disabled={rating === null}
                className="w-full accent-[#38bdf8] cursor-pointer disabled:opacity-50"
              />
            </div>

            <div>
              <div className="flex justify-between font-medium text-muted mb-1">
                <span>石鹸・ペーパー・除菌</span>
                <span className="font-bold text-violet-500">
                  {suppliesScore === null ? '未調整' : `${suppliesScore}点`}
                </span>
              </div>
              <input
                type="range"
                min="1"
                max="5"
                step="1"
                value={suppliesScore ?? rating ?? 3}
                onChange={(e) => setSuppliesScore(parseInt(e.target.value))}
                disabled={rating === null}
                className="w-full accent-[#a78bfa] cursor-pointer disabled:opacity-50"
              />
            </div>
          </div>

          {/* Review Text */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-ink-soft font-semibold">
                口コミ・利用した感想 <span className="text-danger">*</span>
              </label>
              <span className="text-[10px] text-faint">タップで簡単入力</span>
            </div>

            {/* Quick tags pills */}
            <div className="flex flex-wrap gap-1.5 mb-2">
              {QUICK_REVIEW_TAGS.map((tag) => {
                const isSelected = comment.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    className={`px-2 py-1 rounded-full text-[11px] transition-colors ${
                      isSelected
                        ? 'bg-accent text-white font-semibold shadow-xs'
                        : 'bg-surface-2 text-ink-soft border border-line hover:border-line-strong hover:bg-surface'
                    }`}
                  >
                    {isSelected ? `✓ ${tag}` : `+ ${tag}`}
                  </button>
                );
              })}
            </div>

            <textarea
              required
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="便座や床の清潔さ、におい、混雑具合、穴場フロアなど..."
              className="w-full px-3 py-2 bg-surface-2 border border-line rounded-lg text-ink placeholder-faint focus:bg-white focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent transition-colors"
            />
            {commentError && (
              <p role="alert" className="text-danger text-xs mt-1">{commentError}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={isSubmitting || !canSubmit}
            title={canSubmit ? undefined : '総合満足度の選択と口コミの入力が必要です'}
            className="w-full py-2.5 px-4 bg-accent hover:bg-accent-strong text-white font-bold rounded-lg shadow-[0_3px_10px_rgba(11,110,82,0.22)] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>{isSubmitting ? '投稿中...' : 'きれい度評価を投稿する'}</span>
          </button>
          {submitError && <p role="alert" className="text-danger text-xs">{submitError}</p>}
        </form>
      </div>
    </div>
  );
};
