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
 *  mapa (publicação antiga), cai no caminho um-a-um com try/catch. */
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
  // de 1h nem misturar arquivos de publicações diferentes. Resumos antigos sem
  // o mapa caem no carimbo global de publicação (comportamento anterior).
  const resumo = await carregarResumo();
  arquivosPublicados = resumo?.arquivos ?? null;
  // publicado_em (carimbo por publicação); gerado_em (data da extração)
  // cobre resumos antigos que ainda não trazem o carimbo
  const carimbo = String(resumo?.publicado_em ?? resumo?.gerado_em ?? '');
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

  // Atalhos com o estado atual das declarações e valor numérico pronto.
  // Preferimos o parquet dedicado (despesas_atual.parquet/receitas_atual.parquet,
  // gerado por src/exportar.py com os mesmos filtros — bem menor que o histórico);
  // sem ele, derivamos do histórico completo. Linhas-placeholder do SPCE
  // (contraparte '-1'/'#NULO' E valor zero = prestação sem movimento) ficam de
  // fora nos dois caminhos — sincronia com filtro_placeholder em src/carga.py.
  const atuais = [
    {
      nome: 'despesas_atual',
      base: 'despesas',
      derivada: `
        SELECT *, TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE) * qt_linhas AS valor
        FROM despesas
        WHERE dt_ultima_extracao = (SELECT MAX(dt_ultima_extracao) FROM despesas)
          AND NOT (NR_CPF_CNPJ_FORNECEDOR IN ('-1', '#NULO')
                   AND COALESCE(TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE), 0) = 0)`,
    },
    {
      nome: 'receitas_atual',
      base: 'receitas',
      derivada: `
        SELECT *, TRY_CAST(REPLACE(VR_RECEITA, ',', '.') AS DOUBLE) * qt_linhas AS valor
        FROM receitas
        WHERE dt_ultima_extracao = (SELECT MAX(dt_ultima_extracao) FROM receitas)
          AND NOT (NR_CPF_CNPJ_DOADOR IN ('-1', '#NULO')
                   AND COALESCE(TRY_CAST(REPLACE(VR_RECEITA, ',', '.') AS DOUBLE), 0) = 0)`,
    },
    // Remoções com o MESMO critério do backend (sincronia com IDENTIDADE e
    // VARIAVEIS em src/historico.py): retransmitir a prestação renumera as notas
    // e às vezes corrige um campo. Só é remoção o conteúdo cuja contraparte não
    // reaparece no estado atual com PELO MENOS dois dos três campos variáveis
    // iguais — 3 de 3 é a mesma declaração retransmitida, 2 de 3 é uma edição
    // (valor, descrição OU data corrigidos), e nenhuma das duas é apagar nada.
    // Também aqui preferimos o parquet dedicado (despesas_removidas.parquet),
    // já filtrado no backend com esta mesma régua; a derivação abaixo é o
    // fallback para publicações que ainda não o trazem.
    {
      nome: 'despesas_removidas',
      base: 'despesas',
      derivada: `
        SELECT d.*, TRY_CAST(REPLACE(d.VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE) * d.qt_linhas AS valor
        FROM despesas d
        WHERE d.dt_ultima_extracao < (SELECT MAX(dt_ultima_extracao) FROM despesas)
          AND NOT (d.NR_CPF_CNPJ_FORNECEDOR IN ('-1', '#NULO')
                   AND COALESCE(TRY_CAST(REPLACE(d.VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE), 0) = 0)
          AND NOT EXISTS (
            SELECT 1 FROM despesas_atual v
            -- IS NOT DISTINCT FROM também na identidade (sincronia com
            -- src/historico.py): campo NULL precisa casar, senão a
            -- retransmissão vira falsa remoção
            WHERE v.SQ_CANDIDATO IS NOT DISTINCT FROM d.SQ_CANDIDATO
              AND v.NR_CPF_CNPJ_FORNECEDOR IS NOT DISTINCT FROM d.NR_CPF_CNPJ_FORNECEDOR
              AND (CASE WHEN v.DS_DESPESA IS NOT DISTINCT FROM d.DS_DESPESA THEN 1 ELSE 0 END
                 + CASE WHEN v.VR_DESPESA_CONTRATADA IS NOT DISTINCT FROM d.VR_DESPESA_CONTRATADA THEN 1 ELSE 0 END
                 + CASE WHEN v.DT_DESPESA IS NOT DISTINCT FROM d.DT_DESPESA THEN 1 ELSE 0 END) >= 2)`,
    },
    // mesma régua para receitas: sincronia com IDENTIDADE/VARIAVEIS['receitas']
    {
      nome: 'receitas_removidas',
      base: 'receitas',
      derivada: `
        SELECT r.*, TRY_CAST(REPLACE(r.VR_RECEITA, ',', '.') AS DOUBLE) * r.qt_linhas AS valor
        FROM receitas r
        WHERE r.dt_ultima_extracao < (SELECT MAX(dt_ultima_extracao) FROM receitas)
          AND NOT (r.NR_CPF_CNPJ_DOADOR IN ('-1', '#NULO')
                   AND COALESCE(TRY_CAST(REPLACE(r.VR_RECEITA, ',', '.') AS DOUBLE), 0) = 0)
          AND NOT EXISTS (
            SELECT 1 FROM receitas_atual v
            WHERE v.SQ_CANDIDATO IS NOT DISTINCT FROM r.SQ_CANDIDATO
              AND v.NR_CPF_CNPJ_DOADOR IS NOT DISTINCT FROM r.NR_CPF_CNPJ_DOADOR
              AND (CASE WHEN v.DS_ORIGEM_RECEITA IS NOT DISTINCT FROM r.DS_ORIGEM_RECEITA THEN 1 ELSE 0 END
                 + CASE WHEN v.VR_RECEITA IS NOT DISTINCT FROM r.VR_RECEITA THEN 1 ELSE 0 END
                 + CASE WHEN v.DT_RECEITA IS NOT DISTINCT FROM r.DT_RECEITA THEN 1 ELSE 0 END) >= 2)`,
    },
  ];
  // ordem importa: as removidas derivadas referenciam a view *_atual
  for (const { nome, base, derivada } of atuais) {
    if (await registrarParquet(con, nome)) continue;
    await registrarParquet(con, base);
    try {
      await con.query(`CREATE OR REPLACE VIEW ${nome} AS ${derivada}`);
      tabelasDisponiveis.add(nome);
    } catch {
      // nem o parquet dedicado nem o histórico publicados — a página degrada
    }
  }
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
