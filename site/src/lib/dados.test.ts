/* A camada de dados das páginas: API do servidor primeiro, DuckDB-WASM em
 * contingência. O que este arquivo prova, cenário a cenário:
 * - com a API configurada, a consulta vai num GET (comprimida em `q`, com a
 *   versão do dado em `v`) e volta no formato do console, sem tocar no WASM;
 * - 5xx, rede e timeout caem para o WASM com o MESMO SQL e grudam;
 * - 400 é erro da consulta: propaga, não cai;
 * - sem VITE_RADAR_API, tudo é WASM, como antes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wasm = vi.hoisted(() => ({
  executarSQL: vi.fn(),
  obterConexao: vi.fn(async () => ({})),
  tabelasDisponiveis: new Set<string>(),
}));
vi.mock('@/lib/duckdb', () => wasm);

const resumo = vi.hoisted(() => ({
  carregarResumo: vi.fn(),
}));
vi.mock('@/lib/resumo', () => resumo);

const RESUMO = {
  gerado_em: '2026-09-06',
  publicado_em: '20260906T101804Z',
  arquivos: { 'indicadores.parquet': 'aa', 'despesas_atual.parquet': 'bb', 'resumo.json': 'cc' },
};

function respostaApi(corpo: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(corpo), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

async function carregar(api = 'https://api.teste') {
  vi.resetModules();
  vi.stubEnv('VITE_RADAR_API', api);
  return import('@/lib/dados');
}

beforeEach(() => {
  wasm.executarSQL.mockReset();
  wasm.obterConexao.mockClear();
  wasm.executarSQL.mockResolvedValue({ colunas: ['w'], linhas: [['wasm']], total: 1, ms: 0 });
  wasm.tabelasDisponiveis.clear();
  wasm.tabelasDisponiveis.add('indicadores');
  wasm.tabelasDisponiveis.add('despesas_atual');
  resumo.carregarResumo.mockReset();
  resumo.carregarResumo.mockResolvedValue(RESUMO);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('com a API configurada', () => {
  it('consulta o servidor (q comprimido + v) e devolve o formato do console', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return respostaApi({ colunas: ['a', 'b'], linhas: [[1, 'x']], duracao_ms: 7 });
    }));
    const dados = await carregar();

    const r = await dados.executarSQL('SELECT 1 AS a');
    expect(r).toEqual({ colunas: ['a', 'b'], linhas: [[1, 'x']], total: 1, ms: 7 });

    const url = new URL(urls[0]);
    expect(url.origin + url.pathname).toBe('https://api.teste/api/v1/consulta');
    expect(url.searchParams.get('v')).toBe(RESUMO.publicado_em);
    // comprimida em `q` (base64url) onde há CompressionStream; crua em `sql`
    // onde não há (o jsdom tem a classe, mas não o Blob.stream() por trás)
    const q = url.searchParams.get('q');
    if (q) expect(q).toMatch(/^[A-Za-z0-9_-]+$/);
    else expect(url.searchParams.get('sql')).toBe('SELECT 1 AS a');
    expect(wasm.executarSQL).not.toHaveBeenCalled();
    expect(dados.estadoAtual()).toBe('api');
  });

  it('tabelasDisponiveis vem do mapa de arquivos do resumo, sem bootar o WASM', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const dados = await carregar();
    await dados.obterConexao();
    expect([...dados.tabelasDisponiveis].sort()).toEqual(['despesas_atual', 'indicadores']);
    expect(wasm.obterConexao).not.toHaveBeenCalled();
  });

  it.each([
    ['5xx', async () => respostaApi({ erro: 'ocupado' }, { status: 503 })],
    ['404 (imagem sem a rota)', async () => new Response('', { status: 404 })],
    ['falha de rede', async () => { throw new TypeError('Failed to fetch'); }],
  ])('%s cai para o WASM com o mesmo SQL e gruda', async (_nome, impl) => {
    const fetchFalso = vi.fn(impl);
    vi.stubGlobal('fetch', fetchFalso);
    const dados = await carregar();
    const avisos: string[] = [];
    dados.assinarEstado(() => avisos.push(dados.estadoAtual()));

    const r = await dados.executarSQL('SELECT 1 AS a');
    expect(r.linhas).toEqual([['wasm']]);
    expect(wasm.executarSQL).toHaveBeenCalledWith('SELECT 1 AS a');
    expect(dados.estadoAtual()).toBe('contingencia');
    expect(avisos).toEqual(['contingencia']);

    // grudou: a consulta seguinte nem tenta o servidor
    await dados.executarSQL('SELECT 2');
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    expect(wasm.executarSQL).toHaveBeenCalledTimes(2);
  });

  it('timeout do servidor cai para o WASM', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('abortado', 'AbortError')));
      })));
    const dados = await carregar();
    const pendente = dados.executarSQL('SELECT 1');
    await vi.advanceTimersByTimeAsync(4500);
    const r = await pendente;
    expect(r.linhas).toEqual([['wasm']]);
    expect(dados.estadoAtual()).toBe('contingencia');
  });

  it('429 da borda espera o Retry-After e repete, sem cair para o WASM', async () => {
    vi.useFakeTimers();
    const fetchFalso = vi
      .fn()
      .mockResolvedValueOnce(respostaApi({ erro: 'rate' }, { status: 429, headers: { 'Retry-After': '3' } }))
      .mockResolvedValueOnce(respostaApi({ colunas: ['a'], linhas: [[7]] }));
    vi.stubGlobal('fetch', fetchFalso);
    const dados = await carregar();
    const pendente = dados.executarSQL('SELECT 1');
    await vi.advanceTimersByTimeAsync(3_500);
    const r = await pendente;
    expect(r.linhas).toEqual([[7]]);
    expect(fetchFalso).toHaveBeenCalledTimes(2);
    expect(wasm.executarSQL).not.toHaveBeenCalled();
    expect(dados.estadoAtual()).toBe('api');
  });

  it('429 que persiste depois das tentativas cai para o WASM', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => respostaApi({ erro: 'rate' }, { status: 429 })));
    const dados = await carregar();
    const pendente = dados.executarSQL('SELECT 1');
    await vi.advanceTimersByTimeAsync(30_000);
    const r = await pendente;
    expect(r.linhas).toEqual([['wasm']]);
    expect(dados.estadoAtual()).toBe('contingencia');
  });

  it('volta a tentar o servidor depois da janela de contingência', async () => {
    vi.useFakeTimers();
    const fetchFalso = vi
      .fn()
      .mockResolvedValueOnce(respostaApi({ erro: 'x' }, { status: 502 }))
      .mockResolvedValue(respostaApi({ colunas: ['a'], linhas: [[1]] }));
    vi.stubGlobal('fetch', fetchFalso);
    const dados = await carregar();
    await dados.executarSQL('SELECT 1');
    expect(dados.estadoAtual()).toBe('contingencia');
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    const r = await dados.executarSQL('SELECT 1');
    expect(r.linhas).toEqual([[1]]);
    expect(dados.estadoAtual()).toBe('api');
  });

  it('400 é erro da consulta: propaga a mensagem e não cai para o WASM', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      respostaApi({ erro: 'erro do DuckDB: coluna X não existe' }, { status: 400 })));
    const dados = await carregar();
    await expect(dados.executarSQL('SELECT X')).rejects.toThrow('coluna X não existe');
    expect(wasm.executarSQL).not.toHaveBeenCalled();
    expect(dados.estadoAtual()).toBe('api');
  });

  it('resumo.json indisponível (429 no GitHub): lê a versão e o mapa da API e segue sem WASM', async () => {
    resumo.carregarResumo.mockResolvedValue(null);
    const fetchFalso = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/v1/resumo')) {
        return respostaApi({
          gerado_em: '2026-09-07',
          publicado_em: '20260908T100039Z',
          arquivos: { 'indicadores.parquet': 'x', 'rede.parquet': 'y', 'resumo.json': 'z' },
        });
      }
      return respostaApi({ colunas: ['a'], linhas: [[1]] });
    });
    vi.stubGlobal('fetch', fetchFalso);
    const dados = await carregar();

    const r = await dados.executarSQL('SELECT 1');
    expect(r.linhas).toEqual([[1]]);
    expect(dados.estadoAtual()).toBe('api');
    expect([...dados.tabelasDisponiveis].sort()).toEqual(['indicadores', 'rede']);
    const consulta = new URL(String(fetchFalso.mock.calls[1][0]));
    expect(consulta.searchParams.get('v')).toBe('20260908T100039Z');
    expect(wasm.obterConexao).not.toHaveBeenCalled();
  });

  it('sem resumo.json E sem /api/v1/resumo cai para o WASM (não dá para saber o que existe)', async () => {
    resumo.carregarResumo.mockResolvedValue({ gerado_em: '2026-09-06' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    const dados = await carregar();
    await dados.obterConexao();
    expect(dados.estadoAtual()).toBe('contingencia');
    expect([...dados.tabelasDisponiveis].sort()).toEqual(['despesas_atual', 'indicadores']);
  });
});

describe('sem VITE_RADAR_API', () => {
  it('tudo roda no WASM, como antes', async () => {
    const fetchFalso = vi.fn();
    vi.stubGlobal('fetch', fetchFalso);
    const dados = await carregar('');
    expect(dados.estadoAtual()).toBe('wasm');
    const r = await dados.executarSQL('SELECT 1');
    expect(r.linhas).toEqual([['wasm']]);
    expect(fetchFalso).not.toHaveBeenCalled();
    expect(dados.tabelasDisponiveis.has('indicadores')).toBe(true);
  });
});
