import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.png', 'apple-touch-icon.png', 'icon.svg'],
        manifest: {
          id: '/',
          name: 'きれいトイレ - 清潔な公衆トイレ検索',
          short_name: 'きれいトイレ',
          description: '現在地や駅周辺の清潔な公衆・商業施設トイレを評価・設備情報付きで素早く検索できるアプリ。',
          theme_color: '#059669',
          background_color: '#f0fdf4',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: '/pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/pwa-maskable-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
          // SPA オフライン対応: ナビゲーションは index.html へフォールバック（#112）。
          // API はフォールバック対象外（アプリ側の localStorage フォールバックが処理する）。
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api/],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'gstatic-fonts-cache',
                expiration: {
                  maxEntries: 10,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              // A/E: 地図タイルのオフライン閲覧（地下・圏外対策）。枚数と期間を絞る
              urlPattern: /^https:\/\/tile\.openstreetmap\.org\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'osm-tiles',
                expiration: {
                  maxEntries: 200,
                  maxAgeSeconds: 60 * 60 * 24 * 30,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              urlPattern: /^https:\/\/cyberjapandata\.gsi\.go\.jp\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'gsi-tiles',
                expiration: {
                  maxEntries: 200,
                  maxAgeSeconds: 60 * 60 * 24 * 30,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
            {
              // コミュニティ一覧は NetworkFirst（最新口コミ優先・オフライン時はキャッシュ表示）
              urlPattern: /^\/api\/community\/toilets.*/i,
              handler: 'NetworkFirst',
              options: {
                cacheName: 'community-api',
                networkTimeoutSeconds: 5,
                expiration: {
                  maxEntries: 5,
                  maxAgeSeconds: 60 * 60,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom'],
            leaflet: ['leaflet'],
            icons: ['lucide-react'],
            // A: シードデータ（約400件）をメイン結月から分離。静的importのままでも
            // Rollup が別チャンクに切り出し、初回JSを削減する
            seeds: [
              './src/data/googleSeed.ts',
              './src/data/kumagayaSeed.ts',
              './src/data/terminalStationsSeed.ts',
              './src/data/toilets.ts',
              './src/data/realOsmSeed.ts',
            ],
          },
        },
      },
    },
    server: {
      // DISABLE_HMR=true でHMR/ファイル監視を無効化 (エージェント編集時のちらつき・CPU対策)
      // その場合、ファイル監視も止めて CPU 消費を抑える。
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
