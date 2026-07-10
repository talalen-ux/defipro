import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// One-off config for a fully self-contained single-file build of the
// dashboard (used for design import / offline preview). Normal builds use
// vite.config.js. The landing page is already a single static file.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist-single",
    rollupOptions: {
      input: "app.html",
      // WalletConnect loads via dynamic import; fold it into the one file.
      output: { inlineDynamicImports: true },
    },
  },
});
