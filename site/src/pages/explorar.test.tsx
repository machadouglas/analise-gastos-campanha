/* Explorar: a visão "Quem mais gastou" (ranking), cuja tabela troca de colunas
 * conforme a visão e é a única em que cada linha é um candidato — com o nome
 * linkando para a ficha e as colunas técnicas (_sq, _cnpj) fora da tela — e a
 * busca por candidato, que tem de achar quem é conhecido pelo NOME DE URNA e
 * quem só declarou receita. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { brl, brlCentavos } from '@/lib/format';
import { limparDuckDBFalso, responder, tabelasDisponiveis, type RotaFalsa } from '@/test/duckdb-falso';
import { renderizarRota } from '@/test/render';

vi.mock('@/lib/dados', () => import('@/test/duckdb-falso'));

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

/** A busca de candidatura é a única consulta que projeta `tem_movimento`. */
const BUSCA: RotaFalsa = [
  'AS tem_movimento',
  {
    linhas: [
      // nome de urna diferente do civil E nenhuma despesa, só receita: as duas
      // formas pelas quais a busca antiga (indicadores/despesas_atual) perdia
      // a candidatura
      ['160000000001', 'FULANA FICTÍCIA DA SILVA', 'FULANA URNA', '22025', 'PXX',
       'Deputado Estadual', 'PR', 0, 50000, true],
      ['160000000002', 'BELTRANO FICTÍCIO', null, '22026', 'PYY',
       'Deputado Estadual', 'PR', 0, 0, false],
    ],
  },
];

describe('explorar · busca por candidato', () => {
  it('acha pelo nome de urna quem já movimentou, mostrando urna e arrecadado', async () => {
    responder([PARTIDOS, BUSCA, KPIS]);
    renderizarRota(<Explorar />, {
      caminho: '/explorar',
      url: '/explorar?candidato=FULANA+URNA',
    });

    const linha = (await screen.findByText('FULANA URNA')).closest('tr')!;
    // o nome de urna é o principal (é como a campanha divulga e como a busca
    // casou); o civil vem ao lado, menor, para dizer quem é
    expect(within(linha).getByRole('link', { name: /FULANA URNA/ })).toHaveTextContent(
      'FULANA URNA FULANA FICTÍCIA DA SILVA',
    );
    // sem despesa nenhuma, a linha existe pelo que foi arrecadado
    expect(within(linha).getByRole('link', { name: /FULANA URNA/ })).toHaveAttribute(
      'href',
      '/candidato/160000000001',
    );
    // arrecadado e contratado, nessa ordem: o dinheiro que ela declarou está
    // todo do lado da receita (comparação por célula — toHaveTextContent
    // normaliza o espaço não-quebrável do Intl)
    expect(within(linha).getAllByRole('cell').map((c) => c.textContent).slice(-2)).toEqual([
      brl.format(50000), brl.format(0),
    ]);
  });

  it('separa quem ainda não movimentou nada na lista de registrados', async () => {
    responder([PARTIDOS, BUSCA, KPIS]);
    renderizarRota(<Explorar />, {
      caminho: '/explorar',
      url: '/explorar?candidato=FULANA+URNA',
    });

    await screen.findByText('FULANA URNA');
    expect(screen.getByText(/Registrados sem movimento declarado \(1\)/)).toBeInTheDocument();
    // quem tem movimento fica na tabela, não entre os registrados
    expect(screen.getByRole('link', { name: /BELTRANO FICTÍCIO/ })).toBeInTheDocument();
    expect(within(screen.getByRole('table')).queryByText(/BELTRANO/)).not.toBeInTheDocument();
  });
});

/** A tabela do custo é a única que projeta "Custo por voto"; os KPIs do
 *  recorte, a única com `AS custo_por_voto` sobre indicadores sem nomes_urna. */
const CUSTO_TABELA: RotaFalsa = [
  'AS "Custo por voto"',
  {
    colunas: ['_sq', '_cnpj', 'Candidato', 'Partido/UF', 'Cargo', 'Resultado', 'Votos',
              'Contratado', 'Custo por voto', 'Público por voto', 'Próprio por voto'],
    linhas: [
      ['900000000001', '', 'ANA FICTÍCIA DE SOUZA', 'PXX/PR', 'Deputada Federal', 'eleito por qp',
       120000, 2400000, 20, 16.5, 0.5],
      ['900000000002', '', 'BRUNO EXEMPLO', 'PYY/PR', 'Deputado Estadual', 'não eleito',
       800, 12000, 15, null, null],
    ],
  },
];
const CUSTO_RECORTE: RotaFalsa = [
  'AS custo_por_voto', { linhas: [[2, 1, 120800, 2412000, 19.97, 16.4]] },
];

describe('explorar · visão "Custo por voto"', () => {
  async function montarCusto(url: string) {
    responder([PARTIDOS, CUSTO_TABELA, CUSTO_RECORTE, KPIS]);
    renderizarRota(<Explorar />, { caminho: '/explorar', url });
    await screen.findByText('ANA FICTÍCIA DE SOUZA');
    return screen.getByRole('table');
  }

  it('mostra o custo agregado do recorte nos cartões e um candidato por linha', async () => {
    const tabela = await montarCusto('/explorar?visao=custo-por-voto');

    expect(screen.getByText('Custo por voto do recorte').parentElement).toHaveTextContent(/R\$\s19,97/);
    expect(screen.getByText('Candidatos com voto').parentElement).toHaveTextContent('2 · 1 eleitos');
    expect(within(tabela).getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Candidato', 'Partido/UF', 'Cargo', 'Resultado', 'Votos', 'Contratado',
      'Custo por voto', 'Público por voto', 'Próprio por voto',
    ]);
    const linhas = within(tabela).getAllByRole('row').slice(1);
    expect(within(linhas[1]).getAllByRole('cell').map((c) => c.textContent)).toEqual([
      'BRUNO EXEMPLO', 'PYY/PR', 'Deputado Estadual', 'não eleito', '800', brl.format(12000),
      brlCentavos.format(15), '—', '—',
    ]);
    expect(within(linhas[0]).getByRole('link', { name: 'ANA FICTÍCIA DE SOUZA' })).toHaveAttribute(
      'href', '/candidato/900000000001');
  });

  it('a ordenação vem da URL e aparece selecionada', async () => {
    await montarCusto('/explorar?visao=custo-por-voto&ordem=gastou-sem-eleger');

    expect(screen.getByRole('tab', { name: 'Mais gastou sem se eleger' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Voto mais caro' })).toHaveAttribute('aria-selected', 'false');
  });
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
