import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiProxyTarget = process.env.AGENTHUB_DEV_API_PROXY ?? "http://127.0.0.1:3100";
const realtimeProxyTarget = apiProxyTarget.replace(/^http/, "ws");

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom", "@tanstack/react-query", "zustand"],
          "vendor-markdown": ["react-markdown", "remark-gfm", "rehype-highlight"],
          "vendor-flow": ["@xyflow/react"],
          "vendor-icons": ["lucide-react"]
        }
      }
    }
  },
  server: {
    port: 5173,
    host: "0.0.0.0",
    watch: {
      ignored: ["**/coverage/**", "**/dist/**"]
    },
    proxy: {
      "/api": {
        target: apiProxyTarget,
        xfwd: true
      },
      "/realtime": {
        target: realtimeProxyTarget,
        ws: true,
        xfwd: true
      }
    }
  }
});
