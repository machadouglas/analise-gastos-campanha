/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base da API do servidor (src/mcp/api.py), ex.: https://api.<domínio>.
   *  Vazia = as páginas consultam só pelo DuckDB-WASM (ver lib/dados.ts). */
  readonly VITE_RADAR_API?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
