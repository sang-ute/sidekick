// Runs before every UI test file.
import { cleanup } from "@testing-library/react";
import { clearMocks } from "@tauri-apps/api/mocks";
import { afterEach, vi } from "vitest";

// Browser APIs the windows use that jsdom doesn't have.
const stubs: Record<string, () => unknown> = {
  scrollIntoView: () => undefined,
  setPointerCapture: () => undefined,
  releasePointerCapture: () => undefined,
  hasPointerCapture: () => false,
};
for (const [name, value] of Object.entries(stubs)) {
  if (!(name in Element.prototype)) Object.defineProperty(Element.prototype, name, { value, configurable: true });
}

afterEach(() => {
  cleanup();
  clearMocks();
  vi.useRealTimers();
  sessionStorage.clear();
  delete document.documentElement.dataset.theme;
});
