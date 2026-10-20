import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Root base: the dashboard pages (/login, /dashboard) load the same assets as the landing page.
export default defineConfig({ plugins: [react()], base: "/" });
