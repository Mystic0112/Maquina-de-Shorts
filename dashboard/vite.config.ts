import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dashboardDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: dashboardDir,
  plugins: [react()],
  // The client never reads env files; secrets live only in the server process.
  envDir: false,
  server: {
    fs: { strict: true, allow: [dashboardDir] },
  },
  // Local-only tool: one bundle (Recharts makes it ~600 kB) is fine.
  build: { outDir: "dist/client", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
