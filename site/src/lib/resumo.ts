export interface Totais {
  candidatos_com_gastos: number;
  total_contratado: number;
  total_receitas: number;
  itens_declarados: number;
  candidaturas_registradas: number;
}

export interface DespesaResumo {
  /** ids para linkar às fichas (resumos antigos podem não trazer) */
  SQ_CANDIDATO?: string;
  NR_CPF_CNPJ_FORNECEDOR?: string;
  NM_CANDIDATO: string;
  SG_PARTIDO: string;
  DS_CARGO?: string;
  SG_UF: string;
  fornecedor?: string;
  NM_DOADOR?: string;
  DS_ORIGEM_DESPESA?: string;
  DS_ORIGEM_RECEITA?: string;
  DS_DESPESA?: string;
  valor: number;
  DT_DESPESA?: string;
  dt_primeira_extracao?: string;
  dt_ultima_extracao?: string;
}

export interface FornecedorCompartilhado {
  fornecedor: string;
  cnpj: string;
  candidatos: number;
  partidos: number;
  ufs: string;
  total: number;
}

export interface TopCandidato {
  SQ_CANDIDATO?: string;
  NM_CANDIDATO: string;
  SG_PARTIDO: string;
  DS_CARGO: string;
  SG_UF: string;
  contratado: number;
  receita: number | null;
}

export interface SinalForaDaCurva {
  metrica: string;
  valor: number;
  mediana: number;
  p95: number;
  grupo_n: number;
  grupo_ambito: string;
}

export interface CandidatoForaDaCurva {
  SQ_CANDIDATO: string;
  NM_CANDIDATO: string;
  SG_PARTIDO: string;
  DS_CARGO: string;
  SG_UF: string;
  total_contratado: number;
  total_receitas: number | null;
  /** metadados da foto oficial no TSE (resumos antigos podem não trazer) */
  cd_eleicao?: string | null;
  sg_ue?: string | null;
  sinais: SinalForaDaCurva[];
}

export interface TotaisMudancas {
  despesas_removidas_qtd: number;
  despesas_removidas_valor: number;
  receitas_removidas_qtd: number;
  receitas_removidas_valor: number;
}

export interface PontoSerieNacional {
  dt: string;
  contratado: number;
  receitas: number;
  candidatos: number;
}

/** FEFC por partido: fatia do fundo que chegou a candidatas / candidaturas
 *  negras, ao lado da fatia que elas são das candidaturas (espelho de
 *  _cota_fefc em src/resumo.py). */
export interface CotaPartido {
  SG_PARTIDO: string;
  fefc: number;
  candidatos_fefc: number;
  candidaturas: number;
  /** true = fatia das candidaturas vem do registro do TSE; false = só de quem recebeu fundo */
  base_registro: boolean;
  pct_fefc_feminino: number | null;
  pct_candidaturas_femininas: number | null;
  pct_fefc_negros: number | null;
  pct_candidaturas_negras: number | null;
}

export interface Resumo {
  gerado_em: string;
  /** carimbo por publicação (resumos antigos podem não trazer) */
  publicado_em?: string;
  /** hash de conteúdo de cada parquet publicado ('despesas.parquet' → md5) —
   *  cache-buster por arquivo; resumos antigos não trazem */
  arquivos?: Record<string, string>;
  primeira_extracao: boolean;
  totais: Totais;
  mudancas?: TotaisMudancas;
  novas_despesas: DespesaResumo[];
  despesas_removidas: DespesaResumo[];
  receitas_removidas: DespesaResumo[];
  fornecedores_compartilhados: FornecedorCompartilhado[];
  top_candidatos: TopCandidato[];
  fora_da_curva?: CandidatoForaDaCurva[];
  /** totais do país por dia de extração (sparklines da Home); resumos antigos não trazem */
  serie_nacional?: PontoSerieNacional[];
  /** FEFC por partido × gênero/cor (resumos antigos não trazem) */
  cota_fefc?: CotaPartido[];
}

let promessa: Promise<Resumo | null> | null = null;

/** Busca única por sessão: Home e DuckDB compartilham a mesma promessa
 *  (sem invalidação — recarregar a página é o que atualiza). */
export function carregarResumo(): Promise<Resumo | null> {
  promessa ??= (async () => {
    try {
      const r = await fetch('/dados/resumo.json', { cache: 'no-cache' });
      if (r.ok) return (await r.json()) as Resumo;
    } catch {
      /* segue para o retorno nulo */
    }
    return null;
  })();
  return promessa;
}
