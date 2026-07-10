import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['vibecheck.local'],
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: ['vibecheck.local'],
  },
});
