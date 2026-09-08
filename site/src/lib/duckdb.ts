import * as duckdb from '@duckdb/duckdb-wasm';
import { carregarResumo } from '@/lib/resumo';
import { validarLeitura } from '@/lib/sql-gate';

// Os Parquet são servidos pela mesma origem via Pages Function (/dados/*).
// O boot registra só o que as páginas consomem; o restante (tabelas que só o
// console SQL usa) entra sob demanda via garantirTabelasCompletas().
const TABELAS_BOOT = [
  'candidatos',
  'serie_diaria',
  'benchmark_precos',
  'benchmark_indicadores',
  'benchmark_categorias',
  'norma_documento',
  'indicadores',
  'rede',
  'fornecedores',
  'bens',
  // FEFC por partido × gênero × cor/raça (ficha do partido; agregado pequeno)
  'cota_fefc',
  // retificações com o antes/depois pronto (v_alteradas_pares_* no backend).
  // Não há derivação de fallback: parear versões é a MESMA régua que decide o
  // que não é remoção, e uma terceira cópia dela no front é justamente o tipo
  // de divergência silenciosa que esse projeto já pagou caro. Sem o parquet, a
  // seção não aparece.
  'despesas_alteradas',
  'receitas_alteradas',
] as const;
const TABELAS_SOB_DEMANDA = ['despesas_pagas', 'receitas_doador_originario'] as const;
export const TABELAS = [
  'despesas',
  'receitas',
  ...TABELAS_BOOT,
  ...TABELAS_SOB_DEMANDA,
] as const;

/** Tabelas que de fato conseguiram registrar (um parquet pode ainda não existir no release). */
export const tabelasDisponiveis = new Set<string>();

let conexao: Promise<duckdb.AsyncDuckDBConnection> | null = null;

// Preenchidos no boot a partir do resumo.json (compartilhado com a Home via
// carregarResumo — uma busca só por sessão).
let arquivosPublicados: Record<string, string> | null = null;
let urlParquet = (nome: string) => `${window.location.origin}/dados/${nome}.parquet`;

/** Registra a view 1:1 sobre o parquet homônimo; false se o arquivo não existe
 *  no release (o mapa `arquivos` evita até a tentativa de rede). Idempotente. */
async function registrarParquet(
  con: duckdb.AsyncDuckDBConnection,
  nome: string,
): Promise<boolean> {
  if (tabelasDisponiveis.has(nome)) return true;
  if (arquivosPublicados && !(`${nome}.parquet` in arquivosPublicados)) return false;
  try {
    await con.query(
      `CREATE OR REPLACE VIEW ${nome} AS SELECT * FROM read_parquet('${urlParquet(nome)}')`,
    );
    tabelasDisponiveis.add(nome);
    return true;
  } catch {
    // parquet ainda não publicado — a página degrada sem essa visão
    return false;
  }
}

/** Cria as views em UM statement múltiplo (menos round-trips JS↔worker). Só é
 *  seguro em lote quando o mapa `arquivos` diz quais parquet existem; sem o
 *  mapa (resumo.json indisponível), cai no caminho um-a-um com try/catch. */
async function registrarLote(con: duckdb.AsyncDuckDBConnection, nomes: readonly string[]) {
  if (arquivosPublicados) {
    const presentes = nomes.filter(
      (n) => `${n}.parquet` in arquivosPublicados! && !tabelasDisponiveis.has(n),
    );
    if (presentes.length === 0) return;
    try {
      await con.query(
        presentes
          .map((n) => `CREATE OR REPLACE VIEW ${n} AS SELECT * FROM read_parquet('${urlParquet(n)}')`)
          .join(';\n'),
      );
      for (const n of presentes) tabelasDisponiveis.add(n);
      return;
    } catch {
      // lote falhou (parcialmente aplicado, talvez) — repete um-a-um abaixo
    }
  }
  for (const n of nomes) await registrarParquet(con, n);
}

async function iniciar(): Promise<duckdb.AsyncDuckDBConnection> {
  // O motor (~10 MB gzip) vem do CDN oficial do duckdb-wasm em runtime:
  // o Cloudflare Pages limita arquivos do build a 25 MiB e o wasm passa disso.
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const urlWorker = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
  );
  const worker = new Worker(urlWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const con = await db.connect();

  const origem = window.location.origin;
  // Cache-buster por arquivo: o hash de conteúdo (resumo.arquivos) entra na URL
  // de cada parquet — arquivo novo = URL nova, sem servir versão velha do cache
  // de 1h nem misturar arquivos de publicações diferentes. Sem o mapa
  // (resumo.json indisponível), o carimbo de publicação.
  const resumo = await carregarResumo();
  arquivosPublicados = resumo?.arquivos ?? null;
  const carimbo = String(resumo?.publicado_em ?? '');
  urlParquet = (nome) => {
    const versao = arquivosPublicados?.[`${nome}.parquet`] ?? carimbo;
    return `${origem}/dados/${nome}.parquet${versao ? `?v=${encodeURIComponent(versao)}` : ''}`;
  };

  await registrarLote(con, [
    ...TABELAS_BOOT,
    'despesas_atual',
    'receitas_atual',
    'despesas_removidas',
    'receitas_removidas',
  ]);

  // despesas_atual/receitas_atual e *_removidas chegam prontos de src/exportar.py
  // (mesmos filtros das views do backend); o site não deriva nada.
  // Nome de urna por candidato, para o COALESCE de exibição das páginas
  // (NOME_EXIBICAO em consultas.ts): a prestação só traz o nome civil. Mesma
  // definição de src/mcp/dados.py (tests/test_sincronia_site.py confere).
  await con.query(`CREATE OR REPLACE VIEW nomes_urna AS
    SELECT SQ_CANDIDATO, ANY_VALUE(NULLIF(NM_URNA_CANDIDATO, '#NULO')) AS NM_URNA_CANDIDATO
    FROM candidatos GROUP BY 1`);
  return con;
}

export function obterConexao(): Promise<duckdb.AsyncDuckDBConnection> {
  conexao ??= iniciar();
  return conexao;
}

let completas: Promise<void> | null = null;

/** Registra as tabelas que só o console SQL usa (histórico bruto incluso, se o
 *  boot resolveu tudo pelos parquet dedicados). Chamar antes da 1ª consulta livre. */
export function garantirTabelasCompletas(): Promise<void> {
  completas ??= (async () => {
    const con = await obterConexao();
    for (const nome of ['despesas', 'receitas', ...TABELAS_SOB_DEMANDA]) {
      await registrarParquet(con, nome);
    }
  })();
  return completas;
}

export interface ResultadoConsulta {
  colunas: string[];
  linhas: unknown[][];
  total: number;
  ms: number;
}

export async function executarSQL(sql: string): Promise<ResultadoConsulta> {
  // o duckdb-wasm executa statements múltiplos — cada um precisa ser leitura
  const proibido = validarLeitura(sql);
  if (proibido) throw new Error(proibido);
  const con = await obterConexao();
  const inicio = performance.now();
  const tabela = await con.query(sql);
  const ms = performance.now() - inicio;
  const colunas = tabela.schema.fields.map((f) => f.name);
  const linhas = tabela.toArray().map((linha) => colunas.map((c) => linha[c]));
  return { colunas, linhas, total: linhas.length, ms };
}
