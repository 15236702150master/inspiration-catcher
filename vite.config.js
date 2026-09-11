import { defineConfig } from "vite";

export default defineConfig({
  // Relative assets keep the built application portable in a project Pages path.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022"
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4173",
      "/covers": "http://127.0.0.1:4173"
    }
  }
});
