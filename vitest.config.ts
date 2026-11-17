import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

// UI unit and component tests: React in jsdom, with the Rust core faked through Tauri's
// own IPC mocks (src/test/tauri.ts).
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
      setupFiles: ["src/test/setup.ts"],
      restoreMocks: true,
      // Typing with user-event is slow on a busy machine (e.g. right after a Rust build).
      testTimeout: 20_000,
    },
  }),
);
