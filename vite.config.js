import { defineConfig } from "vite";

// Relative base so the build works at any path — required for GitHub Pages
// project sites (https://<user>.github.io/<repo>/).
export default defineConfig({
  base: "./",
});
