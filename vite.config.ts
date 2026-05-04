import { defineConfig } from 'vite';

export default defineConfig({
  base: '/my-3d-game/',
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
