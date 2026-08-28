export interface Totais {
  candidatos_com_gastos: number;
  total_contratado: number;
  total_receitas: number;
  itens_declarados: number;
  candidaturas_registradas: number;
}

export interface DespesaResumo {
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
  sinais: SinalForaDaCurva[];
}

export interface Resumo {
  gerado_em: string;
  primeira_extracao: boolean;
  totais: Totais;
  novas_despesas: DespesaResumo[];
  despesas_removidas: DespesaResumo[];
  receitas_removidas: DespesaResumo[];
  fornecedores_compartilhados: FornecedorCompartilhado[];
  top_candidatos: TopCandidato[];
  fora_da_curva?: CandidatoForaDaCurva[];
}

export async function carregarResumo(): Promise<Resumo | null> {
  try {
    const r = await fetch('/dados/resumo.json');
    if (r.ok) return (await r.json()) as Resumo;
  } catch {
    /* segue para o retorno nulo */
  }
  return null;
}
