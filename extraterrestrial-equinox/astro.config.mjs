// @ts-check
import { defineConfig } from 'astro/config';
import localCms from './scripts/local-cms.mjs';

// https://astro.build/config
export default defineConfig({
  vite: { plugins: [localCms()] },
});
