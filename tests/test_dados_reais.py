"""Integridade do banco real (data/db/gastos.duckdb). Pulados se não existir."""

import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import verificacao  # noqa: E402

BANCO = Path(__file__).parent.parent / "data" / "db" / "gastos.duckdb"

pytestmark = pytest.mark.skipif(not BANCO.exists(), reason="banco local ainda não carregado")


@pytest.fixture(scope="module")
def con():
    c = duckdb.connect(str(BANCO), read_only=True)
    yield c
    c.close()


def test_verificacao_completa_passa(con):
    assert verificacao.verificar(con) == []


def test_alvo_conhecido_consistente(con):
    """Amostra de veracidade: o total de um candidato bate entre visões distintas."""
    linhas = con.execute("""
        WITH direto AS (
            SELECT SQ_CANDIDATO, ROUND(SUM(VR), 2) AS t FROM v_despesas GROUP BY 1),
        via_indicadores AS (
            SELECT SQ_CANDIDATO, total_contratado AS t FROM indicadores)
        SELECT COUNT(*) FROM direto d
        JOIN via_indicadores i USING (SQ_CANDIDATO)
        WHERE ABS(d.t - i.t) > 0.01
    """).fetchone()[0]
    assert linhas == 0


def test_receitas_reconciliam_entre_visoes(con):
    """serie_diaria (último dia) e rede (doações) precisam bater com v_receitas —
    o lado de receitas tinha só reconciliação de despesas."""
    serie, rede, fonte = con.execute("""
        SELECT (SELECT ROUND(SUM(total_receitas), 2) FROM serie_diaria
                WHERE dt_extracao = (SELECT MAX(dt_extracao) FROM serie_diaria)),
               (SELECT ROUND(SUM(valor), 2) FROM rede WHERE tipo = 'doacao'),
               (SELECT ROUND(SUM(VR), 2) FROM v_receitas)
    """).fetchone()
    assert abs((serie or 0) - (fonte or 0)) < 0.01
    assert abs((rede or 0) - (fonte or 0)) < 0.01


def test_serie_diaria_monotonicidade_por_dia_unico(con):
    """Nenhum candidato aparece duplicado num mesmo dia da série."""
    dup = con.execute("""
        SELECT COUNT(*) FROM (
            SELECT dt_extracao, SQ_CANDIDATO FROM serie_diaria
            GROUP BY 1, 2 HAVING COUNT(*) > 1)
    """).fetchone()[0]
    assert dup == 0


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
