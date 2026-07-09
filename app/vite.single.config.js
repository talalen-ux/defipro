import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// One-off config for a fully self-contained single-file build (used for
// design import / offline preview). Normal builds use vite.config.js.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist-single",
    // WalletConnect is loaded via dynamic import; a single-file bundle
    // must fold that chunk in.
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
