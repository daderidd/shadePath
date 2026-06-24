import { defineConfig } from "vite";

// Relative base so the static build works on GitHub Pages subpaths, Netlify, or
// any plain file host without reconfiguration.
export default defineConfig({
  base: "./",
  build: { target: "es2020", chunkSizeWarningLimit: 1500 },
  worker: { format: "es" },
});
