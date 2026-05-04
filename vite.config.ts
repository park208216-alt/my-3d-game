import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE_URL ?? '/',
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
