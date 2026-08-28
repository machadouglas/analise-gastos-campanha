import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// Bibliotecas do grafo de força (react-force-graph-2d e sua cadeia) num chunk
// próprio — só as fichas usam; d3-* cobre também o d3-force importado direto.
const PACOTES_GRAFO = new Set([
  'react-force-graph-2d',
  'force-graph',
  'kapsule',
  'accessor-fn',
  'bezier-js',
  'canvas-color-tracker',
  'float-tooltip',
  'jerrypick',
]);
const PACOTES_VENDOR = new Set(['react', 'react-dom', 'react-router', 'react-router-dom', 'scheduler']);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id);
          const pacote = (m?.[1] ?? '').replace('\\', '/');
          if (pacote === '@duckdb/duckdb-wasm' || pacote === 'apache-arrow' || pacote === 'flatbuffers') {
            return 'duckdb';
          }
          if (PACOTES_GRAFO.has(pacote) || pacote.startsWith('d3-')) return 'grafo';
          if (PACOTES_VENDOR.has(pacote)) return 'vendor';
        },
      },
    },
  },
});
