import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-09-16",
        d1Databases: {
          DB: "00000000-0000-0000-0000-000000000001",
        },
        kvNamespaces: ["OSM_CACHE"],
      },
    }),
  ],
  test: {
    include: ["worker/**/*.workerd.test.mjs"],
  },
});
