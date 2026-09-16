// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { AdminPanel } from './AdminPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  localStorage.clear();
});

describe('AdminPanel (C)', () => {
  it('renders dialog with token input', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<AdminPanel onClose={() => {}} />);
    });
    expect(container?.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container?.querySelector('input[aria-label="管理トークン"]')).not.toBeNull();
  });

  it('prompts for token when empty', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<AdminPanel onClose={() => {}} />);
    });
    // placeholder に ADMIN_TOKEN と表示される
    const input = container?.querySelector<HTMLInputElement>('input[aria-label="管理トークン"]');
    expect(input?.placeholder).toBe('ADMIN_TOKEN');
    // 更新ボタンを押すとトークン入力を促すメッセージが出る
    const updateBtn = Array.from(container?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent?.includes('更新')
    );
    await act(async () => {
      updateBtn?.click();
    });
    expect(container?.textContent ?? '').toContain('ADMIN_TOKEN');
  });
});
