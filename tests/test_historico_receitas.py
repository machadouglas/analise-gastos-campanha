"""Versionamento do caminho de RECEITAS (a suíte principal cobre só despesas).

A essência de receitas usa colunas próprias (DS_ORIGEM_RECEITA, VR_RECEITA...);
uma regressão aqui passaria despercebida pelos testes de despesas.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from tests.conftest import extrair_dia  # noqa: E402


def contar(con, sql):
    return con.execute(sql).fetchone()[0]


def test_receita_removida_e_detectada(banco):
    extrair_dia(banco, "20/08/2026", receitas=[
        {"SQ_RECEITA": "1", "VR_RECEITA": "1000,00"},
        {"SQ_RECEITA": "2", "NR_CPF_CNPJ_DOADOR": "11111111000111",
         "NM_DOADOR": "SUMIDO ME", "VR_RECEITA": "5000,00"},
    ])
    extrair_dia(banco, "21/08/2026", receitas=[
        {"SQ_RECEITA": "1", "VR_RECEITA": "1000,00"},
    ])
    removidas = banco.execute(
        "SELECT NM_DOADOR, VR_RECEITA FROM v_removidas_receitas").fetchall()
    assert removidas == [("SUMIDO ME", "5000,00")]


def test_receita_retransmitida_com_sq_novo_nao_e_removida(banco):
    """Retransmissão da prestação regenera SQ_RECEITA: mesma essência = não é remoção."""
    extrair_dia(banco, "20/08/2026", receitas=[{"SQ_RECEITA": "100", "VR_RECEITA": "1000,00"}])
    extrair_dia(banco, "21/08/2026", receitas=[{"SQ_RECEITA": "999", "VR_RECEITA": "1000,00"}])
    assert contar(banco, "SELECT COUNT(*) FROM v_removidas_receitas") == 0


def test_receita_alterada_gera_versoes_e_flag(banco):
    extrair_dia(banco, "20/08/2026", receitas=[{"SQ_RECEITA": "1", "VR_RECEITA": "9000,00"}])
    extrair_dia(banco, "21/08/2026", receitas=[{"SQ_RECEITA": "1", "VR_RECEITA": "900,00"}])
    assert contar(banco, "SELECT COUNT(*) FROM hist_receitas") == 2
    alteradas = banco.execute(
        "SELECT VR_RECEITA FROM v_alteradas_receitas ORDER BY dt_primeira_extracao"
    ).fetchall()
    assert [a[0] for a in alteradas] == ["9000,00", "900,00"]


def test_receita_editada_com_sq_regenerado_nao_e_removida(banco):
    """Mesma correção do lado das despesas: o SPCE regenera SQ_RECEITA e o
    doador retifica o valor — é alteração, não doação apagada."""
    extrair_dia(banco, "20/08/2026", receitas=[{"SQ_RECEITA": "100", "VR_RECEITA": "9000,00"}])
    extrair_dia(banco, "21/08/2026", receitas=[{"SQ_RECEITA": "999", "VR_RECEITA": "900,00"}])
    assert contar(banco, "SELECT COUNT(*) FROM v_removidas_receitas") == 0
    alteradas = banco.execute(
        "SELECT VR_RECEITA FROM v_alteradas_receitas ORDER BY dt_primeira_extracao"
    ).fetchall()
    assert [a[0] for a in alteradas] == ["9000,00", "900,00"]


def test_doador_diferente_nunca_e_edicao(banco):
    """Trocar a contraparte é outro fato: a receita antiga foi removida mesmo."""
    extrair_dia(banco, "20/08/2026", receitas=[
        {"SQ_RECEITA": "1", "NR_CPF_CNPJ_DOADOR": "11111111000111",
         "NM_DOADOR": "SUMIDO ME", "VR_RECEITA": "5000,00"}])
    extrair_dia(banco, "21/08/2026", receitas=[
        {"SQ_RECEITA": "2", "NR_CPF_CNPJ_DOADOR": "22222222000122",
         "NM_DOADOR": "OUTRO ME", "VR_RECEITA": "5000,00"}])
    removidas = banco.execute("SELECT NM_DOADOR FROM v_removidas_receitas").fetchall()
    assert [r[0] for r in removidas] == ["SUMIDO ME"]


def test_despesas_e_receitas_versionam_de_forma_independente(banco):
    """Remover uma despesa não pode contaminar o histórico de receitas (e vice-versa)."""
    extrair_dia(banco, "20/08/2026",
                despesas=[
                    {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"},
                    {"SQ_DESPESA": "2", "DS_DESPESA": "CARRO DE SOM",
                     "VR_DESPESA_CONTRATADA": "5000,00"},
                ],
                receitas=[{"SQ_RECEITA": "1", "VR_RECEITA": "1000,00"}])
    extrair_dia(banco, "21/08/2026",
                despesas=[{"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"}],
                receitas=[{"SQ_RECEITA": "1", "VR_RECEITA": "1000,00"}])
    assert contar(banco, "SELECT COUNT(*) FROM v_removidas_despesas_contratadas") == 1
    assert contar(banco, "SELECT COUNT(*) FROM v_removidas_receitas") == 0


def test_fonte_vazia_nao_marca_remocao_em_massa(banco):
    """Arquivo vazio do TSE (download quebrado) é ignorado pelo versionamento —
    proteção deliberada: nada pode aparecer como 'removido' por falha de coleta."""
    extrair_dia(banco, "20/08/2026",
                despesas=[{"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"}])
    extrair_dia(banco, "21/08/2026", despesas=[])  # fonte vazia
    assert contar(banco, "SELECT COUNT(*) FROM v_removidas_despesas_contratadas") == 0
    assert contar(banco, "SELECT COUNT(*) FROM hist_despesas_contratadas") == 1


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
