/* Home: três coisas que só tinham verificação no olho — a seção de custo por
 * voto, que some por completo enquanto o TSE não totaliza; a linha de cartões,
 * onde o cartão sem sparkline precisa manter altura e padding dos vizinhos; e o
 * chip do fora da curva, que precisa afirmar o fato em vez de largar um par
 * "métrica: número" para o leitor interpretar. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { CandidatoForaDaCurva, CustoCandidato, DespesaResumo, Resumo } from '@/lib/resumo';
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

const ELEITA: CustoCandidato = {
  SQ_CANDIDATO: '900000000003', NM_CANDIDATO: 'DANIEL FICTÍCIO', NM_URNA_CANDIDATO: 'DANI',
  SG_PARTIDO: 'PXX', DS_CARGO: 'Deputado Federal', SG_UF: 'PR', resultado: 'ELEITO POR QP',
  votos: 40_000, contratado: 3_000_000, custo_por_voto: 75, custo_publico_por_voto: 60,
};
const NAO_ELEITO: CustoCandidato = {
  ...ELEITA, SQ_CANDIDATO: '900000000004', NM_CANDIDATO: 'ELIAS FICTÍCIO', NM_URNA_CANDIDATO: 'ELIAS',
  DS_CARGO: 'Governador', resultado: 'NÃO ELEITO', votos: 500_000, contratado: 9_000_000, custo_por_voto: 18,
};

const COM_VOTOS: Resumo = {
  ...BASE,
  custo_por_voto: {
    nacional: {
      candidatos: 16_600, eleitos: 1_646, votos: 500_000_000, contratado: 4_000_000_000,
      custo_por_voto: 8, custo_publico_por_voto: 6, custo_proprio_por_voto: 0.5, custo_terceiros_por_voto: 1.5,
    },
    partidos: [{
      SG_PARTIDO: 'PXX', candidatos: 120, eleitos: 9, votos: 2_000_000, contratado: 50_000_000,
      custo_por_voto: 25, custo_publico_por_voto: 20.5, custo_proprio_por_voto: 1,
      custo_terceiros_por_voto: 3.5,
    }],
    eleitos_mais_caros: [ELEITA],
    gastaram_sem_eleger: [NAO_ELEITO],
    maiores_gastos: [NAO_ELEITO, ELEITA],
  },
};

describe('home · custo por voto', () => {
  it('com votos, a abertura e os cartões giram em torno do custo', async () => {
    montar(COM_VOTOS);

    expect(await screen.findByText('Quanto custou cada voto?')).toBeInTheDocument();
    expect(screen.getByText('Custo por voto no país').parentElement).toHaveTextContent(/R\$\s8,00/);
    expect(screen.getByText('Dinheiro público por voto').parentElement).toHaveTextContent(/R\$\s6,00/);
    expect(screen.getByText('Dinheiro público por voto').parentElement).toHaveTextContent('75% do custo');
    // o que saiu da Home: candidaturas registradas, maiores despesas, removidas,
    // compartilhados e o ranking de gasto bruto (virou lista do custo)
    expect(screen.queryByText('Candidaturas registradas')).not.toBeInTheDocument();
    expect(screen.queryByText('Declarações removidas')).not.toBeInTheDocument();
    expect(screen.queryByText(/Maiores despesas/)).not.toBeInTheDocument();
    expect(screen.queryByText('Fornecedores de múltiplos candidatos')).not.toBeInTheDocument();
    expect(screen.queryByText('Quem mais contratou até agora')).not.toBeInTheDocument();
  });

  it('as quatro listas e o ranking de partidos aparecem, e a aba por cargo filtra', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    montar(COM_VOTOS);

    expect(await screen.findByText('Quanto custou cada voto')).toBeInTheDocument();
    expect(screen.getByText('Mais gastaram sem se eleger')).toBeInTheDocument();
    expect(screen.getByText('Quem mais contratou')).toBeInTheDocument();
    expect(screen.getAllByText('ELIAS').length).toBeGreaterThan(0);
    // o gráfico por partido: barra empilhada com as três fatias nomeadas
    expect(screen.getByText(/R\$\s25,00/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /PXX: R\$\s25,00 por voto/ })).toHaveAccessibleName(
      /Dinheiro público R\$\s20,50, Bolso dos candidatos R\$\s1,00, Doações de terceiros R\$\s3,50/);
    expect(screen.getAllByRole('link', { name: 'PXX' })[0]).toHaveAttribute('href', '/partido/PXX');

    await userEvent.click(screen.getByRole('tab', { name: 'Senador' }));
    expect(screen.queryByText('DANI')).not.toBeInTheDocument();
    expect(screen.getAllByText('Nenhum candidato neste cargo ainda.').length).toBe(3);
    expect(screen.getByRole('link', { name: /Explorar o custo por voto/ })).toHaveAttribute(
      'href', '/explorar?visao=custo-por-voto&cargo=Senador');
  });

  it('sem totalização, a Home antiga segue: ranking de gasto e sem a seção de custo', async () => {
    montar(BASE);

    // o resto da Home carregou — não é ausência por página vazia
    expect(await screen.findByText('Quem mais contratou até agora')).toBeInTheDocument();
    expect(screen.queryByText('Quanto custou cada voto')).not.toBeInTheDocument();
    expect(screen.getByText('Candidaturas registradas')).toBeInTheDocument();
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
