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
