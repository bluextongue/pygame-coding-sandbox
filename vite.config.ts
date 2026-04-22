import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import monacoCjs from "vite-plugin-monaco-editor";

// CJS: default import is a namespace; the plugin is .default
const monacoPlugin =
  typeof monacoCjs === "function"
    ? (monacoCjs as (o?: import("vite-plugin-monaco-editor").IMonacoEditorOpts) => import("vite").Plugin)
    : (monacoCjs as { default: (o?: import("vite-plugin-monaco-editor").IMonacoEditorOpts) => import("vite").Plugin })
        .default;

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  root: "frontend",
  plugins: [react(), monacoPlugin({})],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
