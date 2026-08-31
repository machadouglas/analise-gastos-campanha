/* Home: três coisas que só tinham verificação no olho — a seção de declarações
 * removidas, que some por completo quando não há remoção; a linha de cartões,
 * onde o cartão sem sparkline precisa manter altura e padding dos vizinhos; e o
 * chip do fora da curva, que precisa afirmar o fato em vez de largar um par
 * "métrica: número" para o leitor interpretar. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { CandidatoForaDaCurva, DespesaResumo, Resumo } from '@/lib/resumo';
import { renderizarRota } from '@/test/render';

const { carregarResumoFalso } = vi.hoisted(() => ({ carregarResumoFalso: vi.fn() }));
vi.mock('@/lib/resumo', () => ({ carregarResumo: carregarResumoFalso }));

const { Home } = await import('@/pages/home');

const REMOVIDA: DespesaResumo = {
  SQ_CANDIDATO: '900000000001',
  NM_CANDIDATO: 'ANA FICTÍCIA DE SOUZA',
  SG_PARTIDO: 'PXX',
  SG_UF: 'PR',
  fornecedor: 'GRÁFICA HORIZONTE LTDA',
  NR_CPF_CNPJ_FORNECEDOR: '12345678000190',
  DS_DESPESA: 'Impressão de santinhos',
  valor: 9000,
  dt_primeira_extracao: '2026-08-20',
  dt_ultima_extracao: '2026-08-28',
};

const RECEITA_REMOVIDA: DespesaResumo = {
  ...REMOVIDA,
  fornecedor: undefined,
  DS_DESPESA: undefined,
  NM_DOADOR: 'BRUNO EXEMPLO',
  DS_ORIGEM_RECEITA: 'Recursos de pessoas físicas',
  valor: 4000,
};

const FORA_DA_CURVA: CandidatoForaDaCurva = {
  SQ_CANDIDATO: '900000000002',
  NM_CANDIDATO: 'CARLA FICTÍCIA DE OLIVEIRA',
  SG_PARTIDO: 'PXX',
  DS_CARGO: 'Deputado Federal',
  SG_UF: 'PR',
  total_contratado: 1_262_278,
  total_receitas: 1_100_000,
  sinais: [
    { metrica: 'razao_gasto_receita', valor: 1.15, mediana: 0, p95: 0.9, grupo_n: 40, grupo_ambito: 'PR' },
    { metrica: 'pct_sem_nota', valor: 62.4, mediana: 0, p95: 0, grupo_n: 40, grupo_ambito: 'PR' },
  ],
};

const BASE: Resumo = {
  gerado_em: '2026-08-30',
  primeira_extracao: false,
  totais: {
    candidatos_com_gastos: 1200,
    total_contratado: 5_000_000,
    total_receitas: 7_000_000,
    itens_declarados: 40_000,
    candidaturas_registradas: 9000,
  },
  mudancas: {
    despesas_removidas_qtd: 12,
    despesas_removidas_valor: 90_000,
    receitas_removidas_qtd: 3,
    receitas_removidas_valor: 12_000,
  },
  novas_despesas: [],
  despesas_removidas: [REMOVIDA],
  receitas_removidas: [RECEITA_REMOVIDA],
  fornecedores_compartilhados: [],
  top_candidatos: [],
  fora_da_curva: [FORA_DA_CURVA],
  serie_nacional: [
    { dt: '2026-08-28', contratado: 4_000_000, receitas: 6_000_000, candidatos: 1100 },
    { dt: '2026-08-29', contratado: 4_500_000, receitas: 6_500_000, candidatos: 1150 },
    { dt: '2026-08-30', contratado: 5_000_000, receitas: 7_000_000, candidatos: 1200 },
  ],
};

function montar(resumo: Resumo) {
  carregarResumoFalso.mockResolvedValue(resumo);
  renderizarRota(<Home />);
}

/** O <div> do CardContent de um cartão de indicador (pai do rótulo). */
function conteudoDoCartao(rotulo: string) {
  return screen.getByText(rotulo).parentElement!;
}

beforeEach(() => {
  carregarResumoFalso.mockReset();
});

describe('home · declarações removidas', () => {
  it('a seção aparece quando há remoção', async () => {
    montar(BASE);

    expect(await screen.findByText('Declarações removidas')).toBeInTheDocument();
    expect(screen.getByText(/Despesas removidas: 12/)).toBeInTheDocument();
    expect(screen.getByText(/Receitas removidas: 3/)).toBeInTheDocument();
    expect(screen.getByText('Impressão de santinhos')).toBeInTheDocument();
    expect(screen.getByText('Recursos de pessoas físicas')).toBeInTheDocument();
  });

  it('some por completo quando não há nenhuma remoção', async () => {
    montar({
      ...BASE,
      despesas_removidas: [],
      receitas_removidas: [],
      mudancas: {
        despesas_removidas_qtd: 0,
        despesas_removidas_valor: 0,
        receitas_removidas_qtd: 0,
        receitas_removidas_valor: 0,
      },
    });

    // o resto da Home carregou — não é ausência por página vazia
    expect(await screen.findByText('Quem mais contratou até agora')).toBeInTheDocument();
    expect(screen.queryByText('Declarações removidas')).not.toBeInTheDocument();
    expect(screen.queryByText(/Despesas removidas/)).not.toBeInTheDocument();
  });
});

describe('home · cartões de indicador', () => {
  const COM_SPARKLINE = ['Receitas declaradas', 'Despesas contratadas', 'Candidatos com gastos'];
  const SEM_SPARKLINE = 'Candidaturas registradas';

  it('só os cartões com série ganham sparkline, e o sem sparkline mantém altura e padding', async () => {
    montar(BASE);
    await screen.findByText(SEM_SPARKLINE);

    for (const rotulo of COM_SPARKLINE) {
      expect(conteudoDoCartao(rotulo).querySelector('svg')).toBeInTheDocument();
    }
    const semSerie = conteudoDoCartao(SEM_SPARKLINE);
    expect(semSerie.querySelector('svg')).toBeNull();
    // mesmas classes de layout do vizinho com sparkline: altura cheia e o
    // miolo centrado no espaço que sobra
    expect(semSerie.className).toBe(conteudoDoCartao(COM_SPARKLINE[0]).className);
    expect(semSerie.parentElement).toHaveClass('h-full');
    // regressão real: `p-5` sozinho perdia para o `sm:pt-0` do CardContent e o
    // número colava no topo do quadro a partir do breakpoint sm
    expect(semSerie).toHaveClass('p-5', 'sm:p-5');
    expect(semSerie.className).not.toMatch(/(^|\s|:)pt-0(\s|$)/);
  });
});

describe('home · chips do fora da curva', () => {
  it('a razão vira frase com as 2 casas do banco, e não o par "métrica: número"', async () => {
    montar(BASE);
    const chip = await screen.findByText(/Gastou 1,15× o que arrecadou/);
    // o corte do grupo continua no chip: sem ele o número não tem régua
    expect(chip).toHaveTextContent('corte (p95): 0,90×');
    expect(chip).toHaveTextContent('mediana do grupo: 0,00×');
    // regressão: com 1 casa decimal a razão 1,03 virava "1×" e o chip parecia
    // implicância com quem está no normal
    expect(screen.queryByText(/Gasto ÷ arrecadado:/)).toBeNull();
  });

  it('métrica sem frase própria segue no par rótulo: valor', async () => {
    montar(BASE);
    expect(await screen.findByText(/% sem documento fiscal: 62,4%/)).toBeInTheDocument();
  });
});
