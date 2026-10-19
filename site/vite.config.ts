import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Relative base so the build works from any path (GitHub Pages, a subfolder, a CDN).
export default defineConfig({ plugins: [react()], base: "./" });
