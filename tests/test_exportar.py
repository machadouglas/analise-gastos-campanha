"""Parquet do estado atual (despesas_atual/receitas_atual): o site consulta a
extração mais recente sem baixar o histórico inteiro. Estes testes garantem que
o arquivo leva só o conteúdo vivo, sem placeholders e com a coluna `valor`."""

import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import exportar  # noqa: E402
from tests.conftest import extrair_dia  # noqa: E402


def _exportados(banco, tmp_path, monkeypatch):
    monkeypatch.setattr(exportar, "DIR_EXPORT", tmp_path)
    exportar.exportar(banco)
    return tmp_path


def test_parquet_estado_atual_leva_so_o_vivo_e_sem_placeholder(banco, tmp_path, monkeypatch):
    extrair_dia(banco, "20/08/2026",
                despesas=[
                    {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"},
                    {"SQ_DESPESA": "2", "DS_DESPESA": "REMOVIDA DEPOIS",
                     "VR_DESPESA_CONTRATADA": "50,00"},
                ],
                receitas=[{"SQ_RECEITA": "1", "VR_RECEITA": "1000,00"}])
    extrair_dia(banco, "21/08/2026",
                despesas=[
                    {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"},
                    # linha-placeholder do SPCE: sem contraparte E sem valor — não é fato
                    {"SQ_DESPESA": "-1", "NR_CPF_CNPJ_FORNECEDOR": "-1",
                     "NM_FORNECEDOR": "#NULO", "VR_DESPESA_CONTRATADA": "0,00"},
                ],
                receitas=[{"SQ_RECEITA": "1", "VR_RECEITA": "1000,00"}])
    saida = _exportados(banco, tmp_path, monkeypatch)

    despesas = duckdb.query(
        f"SELECT DS_DESPESA, valor FROM '{(saida / 'despesas_atual.parquet').as_posix()}' ORDER BY 1"
    ).fetchall()
    # só o conteúdo vivo na última extração: sem a removida, sem o placeholder
    assert despesas == [("BANDEIRA", pytest.approx(100.0))]

    receitas = duckdb.query(
        f"SELECT valor FROM '{(saida / 'receitas_atual.parquet').as_posix()}'"
    ).fetchall()
    assert receitas == [(pytest.approx(1000.0),)]


def test_valor_do_estado_atual_multiplica_qt_linhas(banco, tmp_path, monkeypatch):
    # 3 itens idênticos de R$ 10 = uma linha de conteúdo com valor total R$ 30,
    # mesma régua da view do site
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "ADESIVO", "VR_DESPESA_CONTRATADA": "10,00"}
        for _ in range(3)
    ])
    saida = _exportados(banco, tmp_path, monkeypatch)
    linhas = duckdb.query(
        f"SELECT qt_linhas, valor FROM '{(saida / 'despesas_atual.parquet').as_posix()}'"
    ).fetchall()
    assert linhas == [(3, pytest.approx(30.0))]


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
