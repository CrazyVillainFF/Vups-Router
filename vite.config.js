import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Same backend as the production Vercel proxy. Override for a local backend:
// VITE_API_PROXY_TARGET=http://localhost:4000 npm run dev
export const RENDER_API_ORIGIN =
	process.env.VITE_API_PROXY_TARGET || "https://vups-router-be.onrender.com";

export const apiProxy = {
	"/api": {
		target: RENDER_API_ORIGIN,
		changeOrigin: true,
		secure: true
	}
};

export default defineConfig({
	plugins: [react()],
	server: { port: 5173, proxy: apiProxy },
	preview: { port: 4173, proxy: apiProxy }
});
