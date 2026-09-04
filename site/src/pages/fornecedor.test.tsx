/* Ficha do fornecedor: o bloco da Receita Federal tem duas caras — a lápide do
 * CNPJ que a base pública respondeu 404 e o cadastro normal. Sem o aviso, o
 * bloco exibia só "Situação: NAO ENCONTRADO NA BASE PUBLICA" em caixa alta sob
 * um título prometendo dados da Receita. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { limparDuckDBFalso, responder, tabelasDisponiveis, type RotaFalsa } from '@/test/duckdb-falso';
import { renderizarRota } from '@/test/render';

vi.mock('@/lib/duckdb', () => import('@/test/duckdb-falso'));
// o grafo de conexões desenha em <canvas> (force-graph), que o jsdom não tem —
// fora do escopo destes testes de estado condicional
vi.mock('@/components/app/grafo', () => ({
  GrafoConexoes: () => <div data-testid="grafo" />,
}));

const { Fornecedor } = await import('@/pages/fornecedor');

const CNPJ = '12345678000190';

/** Perfil agregado das despesas: nome, tipo, cnae, sq de candidato, nº de
 *  candidatos/partidos/ufs, total, itens, valor sem nota. */
const PERFIL: RotaFalsa = [
  'COUNT(DISTINCT SQ_CANDIDATO), COUNT(DISTINCT SG_PARTIDO)',
  { linhas: [['GRÁFICA HORIZONTE LTDA', 'Pessoa Jurídica', 'Impressão de material publicitário', null, 2, 1, 1, 48000, 7, 0]] },
];

const CANDIDATOS: RotaFalsa = [
  'ORDER BY total DESC LIMIT 50',
  {
    linhas: [
      ['900000000001', 'ANA FICTÍCIA DE SOUZA', 'Deputada Federal', 'PXX', 'PR', 4, 30000],
      ['900000000002', 'BRUNO EXEMPLO', 'Deputado Estadual', 'PYY', 'PR', 3, 18000],
    ],
  },
];

function montar(rfb: RotaFalsa[]) {
  responder([PERFIL, ...rfb, CANDIDATOS]);
  renderizarRota(<Fornecedor />, { caminho: '/fornecedor/:id', url: `/fornecedor/${CNPJ}` });
}

beforeEach(() => {
  limparDuckDBFalso();
  tabelasDisponiveis.add('fornecedores');
});

describe('ficha do fornecedor · chips do cabeçalho', () => {
  it('CNAE vazio no TSE não vira chip (é atraso de cadastro, não idade da empresa)', async () => {
    responder([
      [
        'COUNT(DISTINCT SQ_CANDIDATO), COUNT(DISTINCT SG_PARTIDO)',
        { linhas: [['EMPRESA SEM RAMO NO TSE LTDA', 'Pessoa Jurídica', null, null, 1, 1, 1, 300000, 4, 0]] },
      ],
      CANDIDATOS,
    ]);
    renderizarRota(<Fornecedor />, { caminho: '/fornecedor/:id', url: `/fornecedor/${CNPJ}` });

    await screen.findByText('EMPRESA SEM RAMO NO TSE LTDA');
    expect(screen.queryByText(/sem cadastro na Receita/)).not.toBeInTheDocument();
  });

  it('plataforma de vaquinha: repasse não vira "também aparece como doador"', async () => {
    responder([
      PERFIL,
      // total doado, candidatos, doado DIRETO (zero: tudo é repasse de financiamento coletivo)
      ['ROUND(SUM(valor) FILTER (WHERE COALESCE(DS_ORIGEM_RECEITA', { linhas: [[9075564, 833, 0]] }],
      [
        'AS "Espécie"',
        { linhas: [['900000000001', 'ANA FICTÍCIA DE SOUZA', 'PXX/PR', '20/08/2026', 'Recursos de Financiamento Coletivo', 'PIX', 1200, 0]] },
      ],
      CANDIDATOS,
    ]);
    renderizarRota(<Fornecedor />, { caminho: '/fornecedor/:id', url: `/fornecedor/${CNPJ}` });

    expect(await screen.findByText('Repassa doações arrecadadas')).toBeInTheDocument();
    expect(screen.queryByText(/também aparece como doador/)).not.toBeInTheDocument();
  });

  it('doação direta continua marcando "também aparece como doador"', async () => {
    responder([
      PERFIL,
      ['ROUND(SUM(valor) FILTER (WHERE COALESCE(DS_ORIGEM_RECEITA', { linhas: [[5000, 1, 5000]] }],
      [
        'AS "Espécie"',
        { linhas: [['900000000001', 'ANA FICTÍCIA DE SOUZA', 'PXX/PR', '20/08/2026', 'Recursos de pessoas jurídicas', 'PIX', 5000, 1]] },
      ],
      CANDIDATOS,
    ]);
    renderizarRota(<Fornecedor />, { caminho: '/fornecedor/:id', url: `/fornecedor/${CNPJ}` });

    expect(await screen.findByText('Também aparece como doador')).toBeInTheDocument();
    expect(screen.getByText(/também aparece como doador: R\$\s?5\.000/)).toBeInTheDocument();
  });
});

describe('ficha do fornecedor · cadastro na Receita', () => {
  it('CNPJ com lápide de 404 mostra o aviso datado no lugar dos campos', async () => {
    montar([
      [
        'FROM fornecedores WHERE cnpj',
        {
          linhas: [[null, null, 'NAO ENCONTRADO NA BASE PUBLICA', null, false, null, null, null, null, '03/08/2026']],
        },
      ],
    ]);

    expect(
      await screen.findByText(
        /CNPJ não encontrado na base pública da Receita Federal — consulta de 03\/08\/2026\./,
      ),
    ).toBeInTheDocument();
    // o título do bloco continua, mas o miolo é o aviso — não os campos
    expect(screen.getByText('Cadastro na Receita Federal')).toBeInTheDocument();
    expect(screen.queryByText('Razão social')).not.toBeInTheDocument();
    expect(screen.queryByText('Situação')).not.toBeInTheDocument();
    // a lápide é linguagem interna: nunca vaza em caixa alta para o leitor
    expect(screen.queryByText(/NAO ENCONTRADO NA BASE PUBLICA/)).not.toBeInTheDocument();
  });

  it('CNPJ com cadastro normal mostra os campos, e nenhum aviso de 404', async () => {
    montar([
      [
        'FROM fornecedores WHERE cnpj',
        {
          linhas: [[
            'GRAFICA HORIZONTE COMERCIO LTDA', '2019-03-15', 'ATIVA', 'Demais', false,
            'Impressão de material publicitário', 'Curitiba/PR', 50000, 'MARIA FICTÍCIA', '03/08/2026',
          ]],
        },
      ],
    ]);

    expect(await screen.findByText('Razão social')).toBeInTheDocument();
    expect(screen.getByText('GRAFICA HORIZONTE COMERCIO LTDA')).toBeInTheDocument();
    expect(screen.getByText('Situação')).toBeInTheDocument();
    expect(screen.getByText('ATIVA')).toBeInTheDocument();
    expect(screen.getByText('Abertura')).toBeInTheDocument();
    expect(screen.getByText('15/03/2019')).toBeInTheDocument();
    expect(screen.getByText('Curitiba/PR')).toBeInTheDocument();
    expect(screen.queryByText(/CNPJ não encontrado na base pública/)).not.toBeInTheDocument();
  });
});

/* Red flags 12 e 13 são fatos DO FORNECEDOR (numeração de nota é sequencial por
 * emitente), e a tabela de despesas mostra só as 50 maiores — se a marca
 * morasse só lá, o achado sumiria no fornecedor grande. Por isso viram chip do
 * cabeçalho, sempre visível. */
describe('ficha do fornecedor · red flags por nota no cabeçalho', () => {
  const DOCS_REPETIDOS: RotaFalsa = ['HAVING COUNT(DISTINCT SQ_CANDIDATO) > 1', { linhas: [[3, 7]] }];
  const SEM_REPETIDO: RotaFalsa = ['HAVING COUNT(DISTINCT SQ_CANDIDATO) > 1', { linhas: [[0, 0]] }];

  function perfil(notasSemNumero: number): RotaFalsa {
    return [
      'COUNT(DISTINCT SQ_CANDIDATO), COUNT(DISTINCT SG_PARTIDO)',
      {
        linhas: [[
          'GRÁFICA HORIZONTE LTDA', 'Pessoa Jurídica', 'Impressão', null,
          2, 1, 1, 48000, 7, 0, notasSemNumero,
        ]],
      },
    ];
  }

  it('conta as notas sem número e os documentos repetidos entre candidatos', async () => {
    responder([perfil(4), DOCS_REPETIDOS, CANDIDATOS]);
    renderizarRota(<Fornecedor />, { caminho: '/fornecedor/:id', url: `/fornecedor/${CNPJ}` });

    expect(await screen.findByText('4 notas fiscais declaradas sem número')).toBeInTheDocument();
    expect(
      screen.getByText('3 números de nota declarados para mais de um candidato'),
    ).toBeInTheDocument();
  });

  it('singular quando é uma só', async () => {
    responder([perfil(1), ['HAVING COUNT(DISTINCT SQ_CANDIDATO) > 1', { linhas: [[1, 2]] }], CANDIDATOS]);
    renderizarRota(<Fornecedor />, { caminho: '/fornecedor/:id', url: `/fornecedor/${CNPJ}` });

    expect(await screen.findByText('1 nota fiscal declarada sem número')).toBeInTheDocument();
    expect(
      screen.getByText('1 número de nota declarado para mais de um candidato'),
    ).toBeInTheDocument();
  });

  it('fornecedor limpo não ganha chip nenhum dos dois', async () => {
    responder([perfil(0), SEM_REPETIDO, CANDIDATOS]);
    renderizarRota(<Fornecedor />, { caminho: '/fornecedor/:id', url: `/fornecedor/${CNPJ}` });

    await screen.findByText('GRÁFICA HORIZONTE LTDA');
    expect(screen.queryByText(/sem número/)).not.toBeInTheDocument();
    expect(screen.queryByText(/mais de um candidato/)).not.toBeInTheDocument();
  });
});
