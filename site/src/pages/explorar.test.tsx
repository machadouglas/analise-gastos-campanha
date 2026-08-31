/* Explorar, visão "Quem mais gastou" (ranking): a tabela troca de colunas
 * conforme a visão, e é a única em que cada linha é um candidato — com o nome
 * linkando para a ficha e as colunas técnicas (_sq, _cnpj) fora da tela. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { brl } from '@/lib/format';
import { limparDuckDBFalso, responder, tabelasDisponiveis, type RotaFalsa } from '@/test/duckdb-falso';
import { renderizarRota } from '@/test/render';

vi.mock('@/lib/duckdb', () => import('@/test/duckdb-falso'));

const { Explorar } = await import('@/pages/explorar');

const PARTIDOS: RotaFalsa = ['SELECT DISTINCT SG_PARTIDO', { linhas: [['PXX'], ['PYY']] }];

const KPIS: RotaFalsa = [
  'SELECT ROUND(SUM(valor),2), COUNT(DISTINCT SQ_CANDIDATO)',
  { linhas: [[54000, 2, 5, 12]] },
];

/** A CTE do ranking é a única consulta que projeta "Arrecadado". */
const RANKING: RotaFalsa = [
  'rec.arrecadado AS "Arrecadado"',
  {
    colunas: ['_sq', '_cnpj', 'Candidato', 'Partido/UF', 'Cargo', 'Total', 'Itens', 'Fornecedores', 'Arrecadado'],
    linhas: [
      ['900000000001', '', 'ANA FICTÍCIA DE SOUZA', 'PXX/PR', 'Deputada Federal', 42000, 7, 3, 60000],
      ['900000000002', '', 'BRUNO EXEMPLO', 'PYY/PR', 'Deputado Estadual', 12000, 5, 2, null],
    ],
  },
];

async function montarRanking() {
  responder([PARTIDOS, KPIS, RANKING]);
  renderizarRota(<Explorar />, { caminho: '/explorar', url: '/explorar?visao=ranking' });
  await screen.findByText('ANA FICTÍCIA DE SOUZA');
  return screen.getByRole('table');
}

beforeEach(() => {
  limparDuckDBFalso();
  tabelasDisponiveis.add('indicadores');
});

describe('explorar · visão "Quem mais gastou"', () => {
  it('mostra as colunas do ranking, sem as técnicas', async () => {
    const tabela = await montarRanking();

    expect(within(tabela).getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Candidato', 'Partido/UF', 'Cargo', 'Total', 'Itens', 'Fornecedores', 'Arrecadado',
    ]);
    expect(screen.queryByText('_sq')).not.toBeInTheDocument();
    expect(screen.queryByText('_cnpj')).not.toBeInTheDocument();
  });

  it('cada linha é um candidato, com o nome linkando para a ficha', async () => {
    const tabela = await montarRanking();
    const linhas = within(tabela).getAllByRole('row').slice(1);

    expect(linhas.map((l) => within(l).getAllByRole('cell').map((c) => c.textContent))).toEqual([
      // brl.format (e não o literal): o separador do Intl é espaço não-quebrável
      ['ANA FICTÍCIA DE SOUZA', 'PXX/PR', 'Deputada Federal', brl.format(42000), '7', '3', brl.format(60000)],
      // sem receita declarada, o Arrecadado sai como travessão
      ['BRUNO EXEMPLO', 'PYY/PR', 'Deputado Estadual', brl.format(12000), '5', '2', '—'],
    ]);
    expect(within(linhas[0]).getByRole('link', { name: 'ANA FICTÍCIA DE SOUZA' })).toHaveAttribute(
      'href',
      '/candidato/900000000001',
    );
  });
});
