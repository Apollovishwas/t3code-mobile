/// <reference types="vite/client" />

import type { DesktopBridge, LocalApi } from "@t3tools/contracts";

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly VITE_HOSTED_APP_CHANNEL: string;
  readonly APP_VERSION: string;
  /** Per-deploy build counter, injected by vite.config.ts from $BUILD_ID. */
  readonly BUILD_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    nativeApi?: LocalApi;
    desktopBridge?: DesktopBridge;
  }
}
