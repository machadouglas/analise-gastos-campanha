/* Dublê do módulo @/lib/duckdb para os testes de renderização.
 *
 * As páginas montam os próprios dados dentro de useEffect, disparando SQL
 * contra o DuckDB-WASM; o dublê responde a cada consulta por casamento de
 * trecho do SQL, então o teste exercita a página inteira (efeito, estados,
 * render condicional) sem motor nenhum no navegador de mentira.
 *
 * Uso: `vi.mock('@/lib/duckdb', () => import('@/test/duckdb-falso'))` no topo
 * do arquivo de teste; o corpo do teste importa `responder`/`tabelasDisponiveis`
 * daqui e vê a MESMA instância que a página recebeu. */
import type { ResultadoConsulta } from '@/lib/duckdb';

export interface RespostaFalsa {
  colunas?: string[];
  linhas: unknown[][];
}

/** Rota: o 1º trecho que casar com o SQL decide a resposta. */
export type RotaFalsa = [trecho: string | RegExp, resposta: RespostaFalsa];

/** Mesmo Set que as páginas leem para decidir se um parquet foi publicado —
 *  o teste declara nele quais tabelas existem naquele cenário. */
export const tabelasDisponiveis = new Set<string>();

const SEM_LINHAS: RespostaFalsa = { linhas: [] };
let rotas: RotaFalsa[] = [];

export function responder(novas: RotaFalsa[]) {
  rotas = novas;
}

/** Chamar no beforeEach: o dublê é um singleton de módulo. */
export function limparDuckDBFalso() {
  rotas = [];
  tabelasDisponiveis.clear();
}

function casa(trecho: string | RegExp, sql: string): boolean {
  return typeof trecho === 'string' ? sql.includes(trecho) : trecho.test(sql);
}

export async function obterConexao(): Promise<unknown> {
  return {};
}

export async function executarSQL(sql: string): Promise<ResultadoConsulta> {
  const achada = rotas.find(([trecho]) => casa(trecho, sql))?.[1] ?? SEM_LINHAS;
  return {
    colunas: achada.colunas ?? [],
    linhas: achada.linhas,
    total: achada.linhas.length,
    ms: 0,
  };
}
