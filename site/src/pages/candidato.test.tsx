/* Ficha do candidato: a tabela de fornecedores mistura dados do TSE com o
 * cadastro da Receita. Quando a consulta ao CNPJ voltou 404, a coluna "Empresa
 * aberta em" viria vazia — igual a "ainda não consultado" — e por isso a página
 * carrega uma coluna oculta `_situacao` que NUNCA pode ser renderizada. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { limparDuckDBFalso, responder, tabelasDisponiveis, type RotaFalsa } from '@/test/duckdb-falso';
import { renderizarRota } from '@/test/render';

vi.mock('@/lib/duckdb', () => import('@/test/duckdb-falso'));
// grafo de conexões: <canvas> do force-graph, fora do escopo destes testes
vi.mock('@/components/app/grafo', () => ({
  GrafoConexoes: () => <div data-testid="grafo" />,
}));

const { Candidato } = await import('@/pages/candidato');

const SQ = '900000000001';

const INDICADORES: RotaFalsa = [
  'FROM indicadores WHERE',
  {
    colunas: [
      'SQ_CANDIDATO', 'NM_CANDIDATO', 'NR_CANDIDATO', 'SG_PARTIDO', 'DS_CARGO', 'SG_UF',
      'total_contratado', 'total_receitas', 'total_pago', 'pct_fundos_publicos',
      'fundos_publicos', 'recursos_proprios', 'n_fornecedores',
      'fornecedores_cnpj', 'fornecedores_consultados',
    ],
    linhas: [[
      SQ, 'ANA FICTÍCIA DE SOUZA', '99999', 'PXX', 'Deputada Federal', 'PR',
      42000, 60000, 30000, 40, 24000, 6000, 2, 2, 2,
    ]],
  },
];

const COLUNAS_FORNECEDORES = [
  'Fornecedor', 'CNPJ/CPF', 'Total', 'Itens', 'Empresa aberta em', 'Sede', '_situacao',
];

const FORNECEDORES: RotaFalsa = [
  'LEFT JOIN fornecedores f',
  {
    colunas: COLUNAS_FORNECEDORES,
    linhas: [
      ['GRÁFICA HORIZONTE LTDA', '12345678000190', 30000, 4, '2019-03-15', 'Curitiba/PR', 'ATIVA'],
      ['AGÊNCIA MIRAGEM ME', '98765432000155', 12000, 2, null, null, 'NAO ENCONTRADO NA BASE PUBLICA'],
    ],
  },
];

/** A seção de fornecedores é recolhível e só monta o conteúdo na 1ª abertura. */
async function abrirFornecedores() {
  // "Fornecedores" também é rótulo de um cartão de indicador — o que interessa
  // aqui é o <summary> da seção recolhível
  const titulos = await screen.findAllByText('Fornecedores');
  const resumo = titulos.map((t) => t.closest('summary')).find(Boolean)!;
  await userEvent.click(resumo);
  return screen.getByRole('table');
}

/* As notas que cada linha de fornecedor esconde. A ficha só mostrava "4 itens";
 * as red flags por nota (12, 13 e 7 do catálogo) viviam fora do site, como
 * consulta de exemplo no console SQL. */
const NOTAS: RotaFalsa = [
  'repetidos AS (',
  {
    colunas: ['cnpj', 'dt', 'categoria', 'descricao', 'documento',
              'valor', 'itens', 'sem_numero', 'valor_repetido', 'doc_de_outro'],
    linhas: [
      // nota limpa: nenhuma marca deve aparecer
      ['12345678000190', '10/08/2026', 'Publicidade por materiais impressos',
       'Santinhos', 'Nota Fiscal nº 1426', 20000, 2, 0, 0, 0],
      // as três marcas juntas, na mesma nota
      ['12345678000190', '12/08/2026', 'Publicidade por adesivos',
       'Adesivos', 'Nota Fiscal SN', 10000, 1, 1, 1, 1],
    ],
  },
];

beforeEach(() => {
  limparDuckDBFalso();
  tabelasDisponiveis.add('fornecedores');
  responder([INDICADORES, NOTAS, FORNECEDORES]);
  renderizarRota(<Candidato />, { caminho: '/candidato/:sq', url: `/candidato/${SQ}` });
});

describe('ficha do candidato · tabela de fornecedores', () => {
  it('CNPJ com lápide de 404 explica a coluna vazia da abertura', async () => {
    const tabela = await abrirFornecedores();
    const linha = within(tabela).getByText('AGÊNCIA MIRAGEM ME').closest('tr')!;

    expect(within(linha).getByText('CNPJ não encontrado na Receita')).toBeInTheDocument();
  });

  it('CNPJ com cadastro normal mostra a data de abertura', async () => {
    const tabela = await abrirFornecedores();
    const linha = within(tabela).getByText('GRÁFICA HORIZONTE LTDA').closest('tr')!;

    expect(within(linha).getByText('15/03/2019')).toBeInTheDocument();
    expect(within(linha).queryByText('CNPJ não encontrado na Receita')).not.toBeInTheDocument();
  });

  it('a coluna oculta _situacao não vira cabeçalho nem célula', async () => {
    const tabela = await abrirFornecedores();

    expect(
      within(tabela).getAllByRole('columnheader').map((c) => c.textContent),
    ).toEqual(['Fornecedor', 'CNPJ/CPF', 'Total', 'Itens', 'Empresa aberta em', 'Sede']);
    // uma célula por coluna visível — a oculta não vira <td> vazio no fim
    for (const nome of ['GRÁFICA HORIZONTE LTDA', 'AGÊNCIA MIRAGEM ME']) {
      const linha = within(tabela).getByText(nome).closest('tr')!;
      expect(within(linha).getAllByRole('cell')).toHaveLength(6);
    }
    // e o valor da coluna oculta não escapa por nenhum outro canto da página
    expect(screen.queryByText(/NAO ENCONTRADO NA BASE PUBLICA/)).not.toBeInTheDocument();
  });
});

describe('ficha do candidato · notas escondidas na linha do fornecedor', () => {
  it('as notas só aparecem depois do clique na linha', async () => {
    const tabela = await abrirFornecedores();
    expect(within(tabela).queryByText('Santinhos')).not.toBeInTheDocument();

    await userEvent.click(within(tabela).getByText('GRÁFICA HORIZONTE LTDA').closest('tr')!);

    expect(within(tabela).getByText('Santinhos')).toBeInTheDocument();
    expect(within(tabela).getByText(/Adesivos/)).toBeInTheDocument();
  });

  it('cada red flag por nota vira marca, e só na nota que a tem', async () => {
    const tabela = await abrirFornecedores();
    await userEvent.click(within(tabela).getByText('GRÁFICA HORIZONTE LTDA').closest('tr')!);

    const marcada = within(tabela).getByText(/Adesivos/).closest('tr')!;
    expect(within(marcada).getByText('nota sem número')).toBeInTheDocument();
    expect(within(marcada).getByText('nº repetido em outro candidato')).toBeInTheDocument();
    expect(within(marcada).getByText('valor repetido')).toBeInTheDocument();

    // a nota limpa não pode herdar marca da vizinha
    const limpa = within(tabela).getByText('Santinhos').closest('tr')!;
    expect(within(limpa).queryByText(/nota sem número|repetido/)).not.toBeInTheDocument();
    expect(within(limpa).getByText(/2 itens/)).toBeInTheDocument();
  });

  it('fornecedor sem nota carregada não vira linha clicável', async () => {
    const tabela = await abrirFornecedores();
    const semNotas = within(tabela).getByText('AGÊNCIA MIRAGEM ME').closest('tr')!;

    expect(semNotas).not.toHaveClass('cursor-pointer');
    await userEvent.click(semNotas);
    // nada de linha de detalhe vazia abaixo dela
    expect(semNotas.nextElementSibling).toBeNull();
  });
});
