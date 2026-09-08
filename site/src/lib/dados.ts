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
 *  Antes da primeira consulta a página precisa da versão do dado e do mapa de
 *  arquivos publicados: vêm do resumo.json pela Pages Function (/dados/*, que
 *  busca no GitHub e toma 429 em hora de pico — medido em 08/09/2026) e, se ela
 *  falhar, de GET /api/v1/resumo no próprio servidor. Só sem os dois é que a
 *  página cai para o WASM.
 *
 *  Erro da PRÓPRIA consulta (4xx: SQL recusado, coluna que não existe num
 *  parquet antigo) NÃO é contingência — o WASM devolveria o mesmo erro, e há
 *  página que tenta uma variante e recua no catch (Explorar).
 *
 *  O console SQL livre não passa por aqui: continua no WASM, no CPU de quem
 *  digita a consulta (ver consultar.tsx).
 */
import { carregarResumo, type Resumo } from '@/lib/resumo';
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

type ResumoMinimo = Pick<Resumo, 'gerado_em' | 'publicado_em' | 'arquivos'>;

/** O que o servidor sabe do release que carregou — a mesma versão e o mesmo
 *  mapa de arquivos do resumo.json, sem passar pelo GitHub. */
async function resumoDaApi(): Promise<ResumoMinimo | null> {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${API}/api/v1/resumo`, { signal: controle.signal });
    if (!r.ok) return null;
    const corpo = (await r.json()) as ResumoMinimo;
    return corpo && typeof corpo === 'object' ? corpo : null;
  } catch {
    return null;
  } finally {
    clearTimeout(relogio);
  }
}

/** Mesmo papel de obterConexao() em @/lib/duckdb: depois dela,
 *  `tabelasDisponiveis` está preenchido. No modo API não boota motor nenhum —
 *  lê o resumo.json (uma busca por sessão, compartilhada com a Home) ou, se a
 *  Function falhar, o /api/v1/resumo do servidor. */
export function obterConexao(): Promise<void> {
  preparo ??= (async () => {
    let resumo: ResumoMinimo | null = await carregarResumo();
    let origem = 'resumo.json';
    if (estado === 'api' && !resumo?.arquivos) {
      const daApi = await resumoDaApi();
      if (daApi?.arquivos) {
        resumo = daApi;
        origem = 'api';
      }
    }
    versaoDoDado = String(resumo?.publicado_em ?? resumo?.gerado_em ?? '');
    const arquivos = resumo?.arquivos;
    if (estado === 'api' && arquivos) {
      for (const nome of Object.keys(arquivos)) {
        if (nome.endsWith('.parquet')) tabelasDisponiveis.add(nome.slice(0, -'.parquet'.length));
      }
      if (origem === 'api') console.info('[dados] resumo.json indisponível; versão do dado veio da API');
      return;
    }
    // sem o mapa de arquivos não dá para saber o que existe sem abrir os
    // parquet: cai no caminho de sempre
    if (estado === 'api') {
      entrarEmContingencia(resumo
        ? 'resumo.json sem o mapa `arquivos` e /api/v1/resumo sem resposta'
        : 'resumo.json indisponível (/dados/*) e /api/v1/resumo sem resposta');
    }
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

/** 429 da borda (rate limit por IP, bloqueio de ~10 s) não é o servidor fora
 *  do ar: esperar e repetir custa segundos; cair para o WASM custa o motor
 *  inteiro — e, sob 429, os Parquet costumam falhar também. */
const TENTATIVAS_429 = 3;
function esperaDo429(r: Response): number {
  const s = Number(r.headers.get('Retry-After') ?? '');
  return Math.min(12_000, Math.max(2_000, Number.isFinite(s) && s > 0 ? s * 1000 : 4_000));
}

async function viaApi(sql: string, tentativa = 1): Promise<ResultadoConsulta> {
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
  if (r.status === 429 && tentativa < TENTATIVAS_429) {
    await new Promise((ok) => setTimeout(ok, esperaDo429(r)));
    return viaApi(sql, tentativa + 1);
  }
  // 400 = a consulta está errada (gate, DuckDB) — o mesmo erro que o WASM
  // daria. Qualquer outro fracasso (5xx, 404 de imagem antiga, 429 que
  // persistiu, 414 de URL longa) é o servidor não servindo: contingência.
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
