"""Testes do catálogo de red flags (analises.py) sobre cenários sintéticos."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import analises  # noqa: E402
from tests.conftest import extrair_dia, inserir_despesa, inserir_receita  # noqa: E402


def _resultado(resultados, titulo):
    for t, _, df in resultados:
        if t.startswith(titulo):
            return df
    raise AssertionError(f"análise '{titulo}' não encontrada")


def test_todas_as_analises_rodam_no_schema_do_tse(banco):
    """Rede de proteção contra drift de schema: cada consulta do catálogo
    precisa executar sem erro sobre as colunas reais dos arquivos."""
    banco.execute(
        "INSERT INTO candidatos VALUES ('160001', '12345', 'FULANO', 'FULANO DA URNA', "
        "'Deputado Estadual', 'XYZ', 'XX', 'DEFERIDO')"
    )
    inserir_despesa(banco)
    inserir_receita(banco)
    resultados = analises.executar_todas(banco)
    assert len(resultados) == 9
    for titulo, comentario, df in resultados:
        assert comentario, titulo


def test_doador_fornecedor_soma_doacoes_de_mesmo_valor(banco):
    """Duas doações idênticas de R$ 1.000 são R$ 2.000 doados — regressão do
    SUM(DISTINCT), que colapsava valores repetidos."""
    inserir_receita(banco, SQ_RECEITA="1", VR_RECEITA="1000,00")
    inserir_receita(banco, SQ_RECEITA="2", VR_RECEITA="1000,00")
    inserir_despesa(banco, NR_CPF_CNPJ_FORNECEDOR="99888777000166",
                    NM_FORNECEDOR="DOADOR DA SILVA", VR_DESPESA_CONTRATADA="500,00")
    df = _resultado(analises.executar_todas(banco), "Doador que também é fornecedor")
    assert len(df) == 1
    assert df.iloc[0]["doou"] == pytest.approx(2000.0)
    assert df.iloc[0]["doacoes"] == 2
    assert df.iloc[0]["recebeu_como_fornecedor"] == pytest.approx(500.0)


def test_doador_que_nao_e_fornecedor_fica_de_fora(banco):
    inserir_receita(banco, NR_CPF_CNPJ_DOADOR="11111111000111")
    inserir_despesa(banco, NR_CPF_CNPJ_FORNECEDOR="22222222000122")
    df = _resultado(analises.executar_todas(banco), "Doador que também é fornecedor")
    assert df.empty


def test_concentracao_calcula_percentual_por_candidato(banco):
    inserir_despesa(banco, SQ_DESPESA="1", VR_DESPESA_CONTRATADA="300,00")
    inserir_despesa(banco, SQ_DESPESA="2", NR_CPF_CNPJ_FORNECEDOR="55666777000188",
                    NM_FORNECEDOR="OUTRA LTDA", VR_DESPESA_CONTRATADA="700,00")
    df = _resultado(analises.executar_todas(banco), "Fornecedores por candidato")
    assert df.iloc[0]["pct_do_candidato"] == pytest.approx(70.0)
    assert df.iloc[1]["pct_do_candidato"] == pytest.approx(30.0)


def test_fornecedor_compartilhado_exige_mais_de_um_candidato(banco):
    inserir_despesa(banco, SQ_CANDIDATO="160001", NM_CANDIDATO="FULANO")
    inserir_despesa(banco, SQ_CANDIDATO="160002", NM_CANDIDATO="BELTRANO",
                    NR_CANDIDATO="54321", SQ_PRESTADOR_CONTAS="900002")
    inserir_despesa(banco, SQ_CANDIDATO="160001",
                    SQ_DESPESA="9", NR_CPF_CNPJ_FORNECEDOR="55666777000188",
                    NM_FORNECEDOR="EXCLUSIVA LTDA")
    df = _resultado(analises.executar_todas(banco), "Fornecedores compartilhados")
    assert list(df["cnpj_cpf"]) == ["11222333000144"]
    assert df.iloc[0]["candidatos_atendidos"] == 2


def test_filtro_por_numero_e_uf_limita_o_recorte(banco):
    banco.execute(
        "INSERT INTO candidatos VALUES ('160001', '12345', 'FULANO', 'FULANO', "
        "'Deputado Estadual', 'XYZ', 'XX', 'DEFERIDO')"
    )
    banco.execute(
        "INSERT INTO candidatos VALUES ('160002', '54321', 'BELTRANO', 'BELTRANO', "
        "'Deputado Estadual', 'XYZ', 'YY', 'DEFERIDO')"
    )
    inserir_despesa(banco, SQ_CANDIDATO="160001")
    inserir_despesa(banco, SQ_CANDIDATO="160002", NM_CANDIDATO="BELTRANO",
                    NR_CANDIDATO="54321", SG_UF="YY", SQ_DESPESA="2")
    df = _resultado(analises.executar_todas(banco, numeros=["12345"], uf="XX"),
                    "Resumo financeiro")
    assert list(df["NM_CANDIDATO"]) == ["FULANO"]
