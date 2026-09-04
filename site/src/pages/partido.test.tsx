/* Ficha do partido: a seção do Fundo Eleitoral por gênero e cor/raça lê o
 * parquet cota_fefc e compara a fatia do fundo com a fatia das candidaturas e
 * com o piso legal de 30%. Sem o parquet, a seção não aparece — nem inventa. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { limparDuckDBFalso, responder, tabelasDisponiveis, type RotaFalsa } from '@/test/duckdb-falso';
import { renderizarRota } from '@/test/render';

vi.mock('@/lib/duckdb', () => import('@/test/duckdb-falso'));

const { Partido } = await import('@/pages/partido');

/** KPIs: candidatos com movimento, contratado, fornecedores. */
const KPIS: RotaFalsa = [
  'SELECT DISTINCT SQ_CANDIDATO FROM despesas_atual',
  { linhas: [[12, 900000, 40]] },
];

/** fefc, % fundo mulheres, % candidaturas mulheres, % fundo negros,
 *  % candidaturas negras, candidaturas, base = registro. */
const COTA_ABAIXO_DO_PISO: RotaFalsa = [
  'FROM cota_fefc',
  { linhas: [[21910000, 25.3, 36.2, 21.8, 37.8, 503, true]] },
];

function montar(rotas: RotaFalsa[]) {
  responder([KPIS, ...rotas]);
  renderizarRota(<Partido />, { caminho: '/partido/:sigla', url: '/partido/PXX' });
}

beforeEach(() => {
  limparDuckDBFalso();
});

describe('ficha do partido · Fundo Eleitoral por gênero e cor/raça', () => {
  it('mostra as duas réguas e a distância ao piso quando o parquet existe', async () => {
    tabelasDisponiveis.add('cota_fefc');
    montar([COTA_ABAIXO_DO_PISO]);

    expect(await screen.findByText('Fundo Eleitoral: gênero e cor/raça')).toBeInTheDocument();
    expect(screen.getByText('Candidaturas femininas')).toBeInTheDocument();
    expect(screen.getByText('25,3% do fundo')).toBeInTheDocument();
    expect(screen.getByText('36,2% das candidaturas')).toBeInTheDocument();
    // 30 − 25,3 = 4,7 pontos abaixo do piso — e a ressalva vai junto
    expect(screen.getByText(/4,7% abaixo do piso de 30%/)).toBeInTheDocument();
    expect(screen.getByText(/prestação está aberta/)).toBeInTheDocument();
    // régua racial: fatia das candidaturas vem do registro (base = true)
    expect(
      screen.getByText(/Candidaturas negras são 37,8% das candidaturas registradas e receberam 21,8% do fundo — 16% a menos/),
    ).toBeInTheDocument();
  });

  it('acima do piso, diz isso — sem alarme', async () => {
    tabelasDisponiveis.add('cota_fefc');
    montar([['FROM cota_fefc', { linhas: [[97730000, 54.5, 41.8, 44.7, 54.7, 434, false]] }]]);

    expect(await screen.findByText(/Acima do piso de 30%/)).toBeInTheDocument();
    // sem o registro completo, a base declarada é quem já recebeu fundo
    expect(screen.getByText(/54,7% de quem já recebeu fundo/)).toBeInTheDocument();
  });

  it('sem o parquet cota_fefc, a seção não aparece', async () => {
    montar([]);

    expect(await screen.findByText('Ficha do partido')).toBeInTheDocument();
    expect(screen.queryByText('Fundo Eleitoral: gênero e cor/raça')).not.toBeInTheDocument();
  });

  it('partido sem um centavo de FEFC também fica sem a seção', async () => {
    tabelasDisponiveis.add('cota_fefc');
    montar([['FROM cota_fefc', { linhas: [[0, null, null, null, null, 0, false]] }]]);

    expect(await screen.findByText('Ficha do partido')).toBeInTheDocument();
    expect(screen.queryByText('Fundo Eleitoral: gênero e cor/raça')).not.toBeInTheDocument();
  });
});
