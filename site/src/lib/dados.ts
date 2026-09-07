/** Camada de dados das páginas (fichas e Explorar): a API do servidor primeiro,
 *  o DuckDB-WASM no navegador como contingência.
 *
 *  As páginas montam o SQL (consultas.ts e os próprios arquivos) e chamam
 *  `executarSQL` exatamente como faziam com @/lib/duckdb — a assinatura é a
 *  mesma de propósito. A diferença é ONDE a consulta roda:
 *
 *  1. `VITE_RADAR_API` apontando para o servidor (src/mcp/api.py): a consulta
 *     vai num GET com a versão do dado na URL, a borda cacheia a resposta
 *     imutável e o visitante recebe ~10 KB de JSON em vez de baixar o motor
 *     (~10 MB) e pedaços dos Parquet.
 *  2. Servidor fora (rede, 5xx, timeout, fila cheia): a página importa o
 *     @/lib/duckdb sob demanda e roda o MESMO texto de SQL sobre os Parquet
 *     do release — o caminho de sempre, que não depende do servidor. A
 *     contingência "gruda" por alguns minutos para não pagar o timeout em
 *     cada consulta da página.
 *  3. Sem `VITE_RADAR_API` (fork, prévia local): só WASM, como antes.
 *
 *  Erro da PRÓPRIA consulta (4xx: SQL recusado, coluna que não existe num
 *  parquet antigo) NÃO é contingência — o WASM devolveria o mesmo erro, e há
 *  página que tenta uma variante e recua no catch (Explorar).
 *
 *  O console SQL livre não passa por aqui: continua no WASM, no CPU de quem
 *  digita a consulta (ver consultar.tsx).
 */
import { carregarResumo } from '@/lib/resumo';
import type { ResultadoConsulta } from '@/lib/duckdb';

/** Base da API (sem barra final); vazia = só WASM. Definida no build (Pages). */
export const API = String(import.meta.env.VITE_RADAR_API ?? '').replace(/\/+$/, '');

/** Espera por uma resposta do servidor. A borda devolve 5xx em menos de 1 s
 *  quando o túnel está fora; o timeout cobre o servidor engasgado. */
const TIMEOUT_MS = 4000;
/** Depois de uma falha, quanto tempo a página fica no WASM antes de tentar a API de novo. */
const REPROVAR_APOS_MS = 5 * 60 * 1000;

export type EstadoDados = 'api' | 'contingencia' | 'wasm';

/** Erro da consulta em si (4xx): propaga, não cai para o WASM. */
export class ErroDaConsulta extends Error {}
/** Servidor indisponível (rede, 5xx, timeout): cai para o WASM. */
export class ServidorIndisponivel extends Error {}

/** Tabelas publicadas (nome do parquet sem extensão) — preenchido pelo mapa
 *  `arquivos` do resumo.json; em contingência, pelo boot do WASM. As páginas
 *  leem depois de `await obterConexao()`, como sempre. */
export const tabelasDisponiveis = new Set<string>();

let estado: EstadoDados = API ? 'api' : 'wasm';
let contingenciaDesde = 0;
let versaoDoDado = '';
let preparo: Promise<void> | null = null;
const ouvintes = new Set<() => void>();

function mudarEstado(novo: EstadoDados) {
  if (estado === novo) return;
  estado = novo;
  for (const cb of ouvintes) cb();
}

/** Para useSyncExternalStore (aviso de contingência no layout). */
export function assinarEstado(cb: () => void): () => void {
  ouvintes.add(cb);
  return () => ouvintes.delete(cb);
}
export function estadoAtual(): EstadoDados {
  return estado;
}

function entrarEmContingencia(motivo: unknown) {
  contingenciaDesde = Date.now();
  if (estado === 'contingencia') return;
  console.warn('[dados] servidor de consultas indisponível; usando DuckDB no navegador:', motivo);
  mudarEstado('contingencia');
}

async function prepararWasm(): Promise<void> {
  const d = await import('@/lib/duckdb');
  await d.obterConexao();
  for (const t of d.tabelasDisponiveis) tabelasDisponiveis.add(t);
}

/** Mesmo papel de obterConexao() em @/lib/duckdb: depois dela,
 *  `tabelasDisponiveis` está preenchido. No modo API não boota motor nenhum —
 *  só lê o resumo.json (uma busca por sessão, compartilhada com a Home). */
export function obterConexao(): Promise<void> {
  preparo ??= (async () => {
    const resumo = await carregarResumo();
    versaoDoDado = String(resumo?.publicado_em ?? resumo?.gerado_em ?? '');
    const arquivos = resumo?.arquivos;
    if (estado === 'api' && arquivos) {
      for (const nome of Object.keys(arquivos)) {
        if (nome.endsWith('.parquet')) tabelasDisponiveis.add(nome.slice(0, -'.parquet'.length));
      }
      return;
    }
    // sem o mapa de arquivos (resumo antigo) não dá para saber o que existe
    // sem abrir os parquet: cai no caminho de sempre
    if (estado === 'api') entrarEmContingencia('resumo.json sem o mapa `arquivos`');
    await prepararWasm();
  })();
  return preparo;
}

/** deflate-raw + base64url — o que src/mcp/api.py lê em `q`. null onde o
 *  navegador não tem CompressionStream (a consulta vai crua em `sql`). */
async function comprimir(texto: string): Promise<string | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const fluxo = new Blob([new TextEncoder().encode(texto)])
      .stream()
      .pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(fluxo).arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch {
    return null;
  }
}

export async function montarUrl(sql: string): Promise<string> {
  const q = await comprimir(sql);
  const consulta = q ? `q=${q}` : `sql=${encodeURIComponent(sql)}`;
  return `${API}/api/v1/consulta?${consulta}&v=${encodeURIComponent(versaoDoDado)}`;
}

interface CorpoApi {
  colunas: string[];
  linhas: unknown[][];
  duracao_ms?: number;
}

async function viaApi(sql: string): Promise<ResultadoConsulta> {
  const url = await montarUrl(sql);
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetch(url, { signal: controle.signal });
  } catch (e) {
    throw new ServidorIndisponivel(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(relogio);
  }
  // 400 = a consulta está errada (gate, DuckDB) — o mesmo erro que o WASM
  // daria. Qualquer outro fracasso (5xx, 404 de imagem antiga, 429 da borda,
  // 414 de URL longa) é o servidor não servindo: contingência.
  if (r.status === 400) {
    const corpo = (await r.json().catch(() => null)) as { erro?: string } | null;
    throw new ErroDaConsulta(corpo?.erro ?? `HTTP ${r.status}`);
  }
  if (!r.ok) throw new ServidorIndisponivel(`HTTP ${r.status}`);
  const corpo = (await r.json()) as CorpoApi;
  if (!Array.isArray(corpo.colunas) || !Array.isArray(corpo.linhas)) {
    throw new ServidorIndisponivel('resposta fora do formato esperado');
  }
  return { colunas: corpo.colunas, linhas: corpo.linhas, total: corpo.linhas.length, ms: corpo.duracao_ms ?? 0 };
}

async function viaWasm(sql: string): Promise<ResultadoConsulta> {
  if (!tabelasDisponiveis.size || estado !== 'wasm') await prepararWasm();
  const d = await import('@/lib/duckdb');
  return d.executarSQL(sql);
}

export async function executarSQL(sql: string): Promise<ResultadoConsulta> {
  await obterConexao();
  if (estado === 'contingencia' && Date.now() - contingenciaDesde > REPROVAR_APOS_MS) {
    mudarEstado('api'); // tenta o servidor de novo; falhando, volta a grudar
  }
  if (estado === 'api') {
    try {
      return await viaApi(sql);
    } catch (e) {
      if (e instanceof ErroDaConsulta) throw e;
      entrarEmContingencia(e);
    }
  }
  return viaWasm(sql);
}

/** Só para testes: zera o singleton do módulo. */
export function _reiniciarParaTestes() {
  estado = API ? 'api' : 'wasm';
  contingenciaDesde = 0;
  versaoDoDado = '';
  preparo = null;
  tabelasDisponiveis.clear();
  ouvintes.clear();
}
