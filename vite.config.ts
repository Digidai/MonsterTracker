import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "client",
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    sourcemap: true
  },
  server: {
    port: 5173
  }
});
