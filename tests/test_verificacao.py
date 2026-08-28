"""Testes da guarda de queda de volume (arquivo truncado do TSE).

Uma queda brusca no retrato inteiro geraria uma enxurrada de falsas
'remoções' — a rotina precisa recusar publicar nesse cenário.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import verificacao  # noqa: E402
from tests.conftest import extrair_dia  # noqa: E402


def _dia_com_n_despesas(banco, data, n):
    extrair_dia(banco, data, despesas=[
        {"SQ_DESPESA": str(i), "DS_DESPESA": f"ITEM {i}", "VR_DESPESA_CONTRATADA": "10,00"}
        for i in range(n)
    ])


def test_primeira_extracao_nao_tem_base_de_comparacao(banco):
    _dia_com_n_despesas(banco, "20/08/2026", 10)
    ok, detalhe = verificacao.queda_de_volume(banco, "despesas_contratadas")
    assert ok
    assert "primeira extração" in detalhe


def test_crescimento_e_queda_pequena_passam(banco):
    _dia_com_n_despesas(banco, "20/08/2026", 10)
    _dia_com_n_despesas(banco, "21/08/2026", 12)
    ok, _ = verificacao.queda_de_volume(banco, "despesas_contratadas")
    assert ok
    _dia_com_n_despesas(banco, "22/08/2026", 11)  # -8%: dentro da tolerância
    ok, _ = verificacao.queda_de_volume(banco, "despesas_contratadas")
    assert ok


def test_queda_brusca_e_recusada(banco):
    _dia_com_n_despesas(banco, "20/08/2026", 10)
    _dia_com_n_despesas(banco, "21/08/2026", 3)  # -70%: arquivo suspeito
    ok, detalhe = verificacao.queda_de_volume(banco, "despesas_contratadas")
    assert not ok
    assert "10 -> 3" in detalhe


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
