"""Publicação condicional: a rotina só publica quando o estado publicável
mudou — o fingerprint precisa reagir a dado novo e ignorar ruído (reconsulta
de CNPJ que não mudou nada)."""

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import cnpj, exportar  # noqa: E402
from tests.conftest import extrair_dia  # noqa: E402


def test_fingerprint_estavel_sem_mudanca_e_sensivel_a_dado_novo(banco):
    extrair_dia(banco, "20/08/2026", despesas=[{"SQ_DESPESA": "1"}])
    f1 = exportar.fingerprint(banco)
    assert exportar.fingerprint(banco) == f1
    extrair_dia(banco, "21/08/2026", despesas=[
        {"SQ_DESPESA": "1"},
        {"SQ_DESPESA": "2", "DS_DESPESA": "CARRO DE SOM", "VR_DESPESA_CONTRATADA": "500,00"},
    ])
    assert exportar.fingerprint(banco) != f1


def test_fingerprint_avanca_com_extracao_nova_mesmo_identica(banco):
    """Arquivo regenerado pelo TSE com o MESMO conteúdo em dia novo ainda é
    publicação: o site carimba a data da extração e ela precisa avançar."""
    extrair_dia(banco, "20/08/2026", despesas=[{"SQ_DESPESA": "1"}])
    f1 = exportar.fingerprint(banco)
    extrair_dia(banco, "21/08/2026", despesas=[{"SQ_DESPESA": "1"}])
    assert exportar.fingerprint(banco) != f1


def test_fingerprint_ignora_reconsulta_de_cnpj_sem_mudanca(banco):
    extrair_dia(banco, "20/08/2026", despesas=[{"SQ_DESPESA": "1"}])
    cnpj._garantir_tabela(banco)
    banco.execute(
        "INSERT INTO fornecedores (cnpj, situacao, dt_consulta) "
        "VALUES ('11222333000144', 'ATIVA', DATE '2026-06-01')")
    f1 = exportar.fingerprint(banco)
    # reconsulta que só re-carimba a data: nada visível mudou, não republicar
    banco.execute("UPDATE fornecedores SET dt_consulta = DATE '2026-08-28'")
    assert exportar.fingerprint(banco) == f1
    # mudança de situação é conteúdo: republicar
    banco.execute(
        "UPDATE fornecedores SET situacao = 'BAIXADA', situacao_anterior = 'ATIVA', "
        "dt_situacao_anterior = DATE '2026-08-28'")
    assert exportar.fingerprint(banco) != f1


def test_fingerprint_reage_a_fornecedor_novo(banco):
    extrair_dia(banco, "20/08/2026", despesas=[{"SQ_DESPESA": "1"}])
    cnpj._garantir_tabela(banco)
    f1 = exportar.fingerprint(banco)
    banco.execute(
        "INSERT INTO fornecedores (cnpj, situacao, dt_consulta) "
        "VALUES ('11222333000144', 'ATIVA', DATE '2026-08-28')")
    assert exportar.fingerprint(banco) != f1


def test_registro_da_ultima_publicacao(banco):
    assert exportar.ultima_publicacao(banco) is None
    exportar.registrar_publicacao(banco, "aaa")
    assert exportar.ultima_publicacao(banco) == "aaa"
    exportar.registrar_publicacao(banco, "bbb")
    assert exportar.ultima_publicacao(banco) == "bbb"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
