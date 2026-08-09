import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      'better-sqlite3': resolve(__dirname, 'src/mocks/better-sqlite3.ts'),
      // Alias Node.js built-ins to empty modules for browser
      fs: resolve(__dirname, 'src/mocks/empty.ts'),
      path: resolve(__dirname, 'src/mocks/empty.ts'),
      crypto: resolve(__dirname, 'src/mocks/empty.ts'),
      // Alias real container to mock container for browser
      './container': resolve(__dirname, 'src/container.mock.ts'),
      '../container': resolve(__dirname, 'src/container.mock.ts'),
      '../../container': resolve(__dirname, 'src/container.mock.ts'),
    },
  },
  define: {
    'process.env': {},
  },
  preview: {
    port: 5173,
  },
  server: {
    port: 5173,
    watch: {
      ignored: ['**/dist-electron/**', '**/dist/**', '**/server/dist/**', '**/node_modules/**'],
    },
  },
  build: {
    rollupOptions: {
      external: ['better-sqlite3', 'serialport', 'fs', 'path', 'crypto'],
    },
  },
});