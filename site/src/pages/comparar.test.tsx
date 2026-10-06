/* Comparação lado a lado: candidaturas (pelo SQ) ou partidos (pela sigla, com
 * cargo/UF opcionais), tudo lido da URL. Os números vêm prontos de
 * `indicadores`; a página só arruma, escolhe as categorias da matriz e escreve
 * as frases de leitura rápida. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { limparDuckDBFalso, responder, type RotaFalsa } from '@/test/duckdb-falso';
import { renderizarRota } from '@/test/render';
import { montarMatriz } from '@/components/app/comparacao';

vi.mock('@/lib/dados', () => import('@/test/duckdb-falso'));

const { Comparar } = await import('@/pages/comparar');

/** Linha de sqlCompararCandidatos: sq, nome, civil, partido, uf, cargo,
 *  arrecadado, contratado, pago, público, próprios, votos, votos 2º t,
 *  resultado, custo, público/voto, próprio/voto, terceiros/voto, cd, ue. */
function candidato(sq: string, nome: string, extra: Partial<Record<'cargo' | 'votos' | 'resultado' | 'custo', unknown>> = {}) {
  return [
    sq, nome, nome, 'PXX', 'SP', extra.cargo ?? 'Governador',
    1_000_000, 800_000, 700_000, 900_000, 0,
    'votos' in extra ? extra.votos : 400_000, null, extra.resultado ?? 'NÃO ELEITO',
    'custo' in extra ? extra.custo : 2, 1.8, 0, 0.2, '1', 'SP',
  ];
}

const DOIS_CANDIDATOS: RotaFalsa = [
  'WITH foto AS',
  {
    linhas: [
      candidato('111', 'FULANA', { resultado: 'ELEITO', custo: 1.5 }),
      [...candidato('222', 'BELTRANO').slice(0, 6), 100_000, 90_000, 50_000, 30_000, 10_000, 30_000, null, 'NÃO ELEITO', 3, 0.9, 0.3, 1.8, '1', 'SP'],
    ],
  },
];

const CATEGORIAS: RotaFalsa = [
  'AS categoria',
  {
    linhas: [
      ['111', 'Publicidade por materiais impressos', 600_000],
      ['111', 'Despesas com pessoal', 200_000],
      ['222', 'Publicidade por materiais impressos', 9_000],
      ['222', 'Atividades de militância e mobilização de rua', 81_000],
    ],
  },
];

function montar(url: string, rotas: RotaFalsa[]) {
  responder(rotas);
  renderizarRota(<Comparar />, { caminho: '/comparar', url });
}

beforeEach(() => {
  limparDuckDBFalso();
});

describe('comparar candidatos', () => {
  it('mostra os dois lado a lado, as frases de leitura e a matriz de gastos', async () => {
    montar('/comparar?c=111,222', [DOIS_CANDIDATOS, CATEGORIAS]);

    expect(await screen.findByText('Em poucas palavras')).toBeInTheDocument();
    // a ordem da URL é a ordem da tela
    const cartoes = screen.getAllByRole('button', { name: /Remover .* da comparação/ });
    expect(cartoes.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remover FULANA da comparação',
      'Remover BELTRANO da comparação',
    ]);
    expect(screen.getByText(/FULANA arrecadou R\$\s1\.000\.000 — 10 vezes o que BELTRANO arrecadou/)).toBeInTheDocument();
    expect(screen.getByText(/O voto mais caro foi o de BELTRANO \(R\$\s3,00\); o mais barato, o de FULANA \(R\$\s1,50\)/)).toBeInTheDocument();
    // matriz: fatia de cada um no próprio gasto (75% de 800 mil; 90% de 90 mil)
    expect(screen.getByText('Atividades de militância e mobilização de rua')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    // mesmo cargo: sem o aviso de escalas diferentes
    expect(screen.queryByText(/disputam cargos diferentes/)).not.toBeInTheDocument();
  });

  it('cargos diferentes ganham o aviso; quem não teve voto diz por quê', async () => {
    montar('/comparar?c=111,222', [
      ['WITH foto AS', {
        linhas: [
          candidato('111', 'FULANA'),
          candidato('222', 'BELTRANO', { cargo: 'Deputado Federal', votos: null, custo: null, resultado: null }),
        ],
      }],
      CATEGORIAS,
    ]);

    expect(await screen.findByText(/disputam cargos diferentes \(Governador, Deputado Federal\)/)).toBeInTheDocument();
    expect(screen.getByText(/Sem votação totalizada para esta candidatura/)).toBeInTheDocument();
  });

  it('sem nenhuma candidatura totalizada, a seção de custo diz isso em vez de barras vazias', async () => {
    montar('/comparar?c=111', [
      ['WITH foto AS', { linhas: [candidato('111', 'FULANA', { votos: null, custo: null, resultado: null })] }],
      CATEGORIAS,
    ]);

    expect(await screen.findByText(/ainda não foi totalizada pelo TSE/)).toBeInTheDocument();
    // um item só: nada a comparar nas frases
    expect(screen.queryByText('Em poucas palavras')).not.toBeInTheDocument();
  });

  it('sem nada na URL, convida a buscar', async () => {
    montar('/comparar', []);
    expect(await screen.findByText(/Busque um candidato acima para começar/)).toBeInTheDocument();
  });
});

describe('comparar partidos', () => {
  it('soma as candidaturas do recorte e usa o custo agregado da sigla', async () => {
    montar('/comparar?modo=partidos&p=PAA,PBB&cargo=Deputado%20Federal', [
      ['SG_PARTIDO AS grupo', {
        linhas: [
          ['PAA', 300, 70, 13_000_000, 190_000_000, 14.15, 12.5, 0.1, 1.55],
          ['PBB', 500, 120, 25_000_000, 350_000_000, 14.05, 12.8, 0.2, 1.05],
        ],
      }],
      ['FROM indicadores WHERE SG_PARTIDO IN', {
        linhas: [
          ['PAA', 331, 70, 295_000_000, 194_000_000, 135_000_000, 262_000_000, 3_500_000],
          ['PBB', 520, 120, 534_000_000, 357_000_000, 248_000_000, 491_000_000, 7_900_000],
        ],
      }],
      ['FROM indicadores WHERE SG_PARTIDO IS NOT NULL', { linhas: [['PBB', 1], ['PAA', 1]] }],
      CATEGORIAS,
    ]);

    expect(await screen.findByText('331 candidaturas · Deputado Federal')).toBeInTheDocument();
    // a tabela-resumo é a última da página (a primeira é a matriz de gastos)
    const tabela = screen.getAllByRole('table').at(-1)!;
    expect(within(tabela).getByText('Candidaturas')).toBeInTheDocument();
    expect(within(tabela).getByText('R$ 14,15')).toBeInTheDocument();
    expect(screen.getByText(/O voto mais caro foi o de PAA \(R\$\s14,15\); o mais barato, o de PBB \(R\$\s14,05\)/)).toBeInTheDocument();
    // o chip da sigla escolhida aparece marcado
    expect(screen.getByRole('button', { name: 'PAA', pressed: true })).toBeInTheDocument();
  });
});

describe('montarMatriz', () => {
  it('escolhe as linhas pela soma das FATIAS, não pelo valor bruto — o menor não fica sem as dele', () => {
    const gastos = [
      { id: 'grande', categoria: 'A', total: 1_000_000 },
      { id: 'grande', categoria: 'B', total: 900_000 },
      { id: 'pequeno', categoria: 'C', total: 1_000 },
    ];
    const { linhas, totais } = montarMatriz(['grande', 'pequeno'], gastos, 1);
    // C é 100% do pequeno: pesa mais que A (52,6% do grande)
    expect(linhas[0].categoria).toBe('C');
    expect(totais).toEqual([1_900_000, 1_000]);
    // o resto (A e B) vira "Outras", com os valores de cada um
    expect(linhas[1]).toEqual({ categoria: 'Outras (2 tipos)', valores: [1_900_000, 0] });
  });

  it('uma categoria sobrando sozinha vira linha própria, não "Outras (1 tipos)"', () => {
    const gastos = ['A', 'B', 'C'].map((categoria, i) => ({ id: 'x', categoria, total: 30 - i }));
    const { linhas } = montarMatriz(['x'], gastos, 2);
    expect(linhas.map((l) => l.categoria)).toEqual(['A', 'B', 'C']);
  });
});
