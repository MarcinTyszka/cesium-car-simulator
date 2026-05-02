import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

// Apply Cesium plugin to handle static assets and workers
export default defineConfig({
  plugins: [cesium()]
});