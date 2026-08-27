"""Testes dos agregados materializados (o que o site consome) sobre cenários
sintéticos: série diária reconstruída, benchmark, indicadores e rede."""

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import agregados  # noqa: E402
from tests.conftest import extrair_dia  # noqa: E402


def test_serie_diaria_reconstroi_o_declarado_em_cada_dia(banco):
    # dia 20: bandeira (100) + carro de som (5000); dia 21: o carro de som some
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "BANDEIRA", "VR_DESPESA_CONTRATADA": "100,00"},
        {"SQ_DESPESA": "2", "DS_DESPESA": "CARRO DE SOM", "VR_DESPESA_CONTRATADA": "5000,00"},
    ])
    extrair_dia(banco, "21/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "BANDEIRA", "VR_DESPESA_CONTRATADA": "100,00"},
    ])
    agregados.materializar(banco)
    totais = dict(banco.execute(
        "SELECT dt_extracao, SUM(total_contratado) FROM serie_diaria GROUP BY 1"
    ).fetchall())
    assert totais[date(2026, 8, 20)] == pytest.approx(5100.0)
    assert totais[date(2026, 8, 21)] == pytest.approx(100.0)


def test_serie_diaria_multiplica_linhas_identicas_por_qt_linhas(banco):
    # 3 itens idênticos de R$ 10 no arquivo = R$ 30 declarados
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "ADESIVO", "VR_DESPESA_CONTRATADA": "10,00"},
        {"SQ_DESPESA": "1", "DS_DESPESA": "ADESIVO", "VR_DESPESA_CONTRATADA": "10,00"},
        {"SQ_DESPESA": "1", "DS_DESPESA": "ADESIVO", "VR_DESPESA_CONTRATADA": "10,00"},
    ])
    agregados.materializar(banco)
    total, itens = banco.execute(
        "SELECT total_contratado, itens_despesa FROM serie_diaria"
    ).fetchone()
    assert total == pytest.approx(30.0)
    assert itens == 3


def test_serie_diaria_ultimo_dia_bate_com_o_retrato_atual(banco):
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "250,50"},
        {"SQ_DESPESA": "2", "DS_DESPESA": "SANTINHO", "VR_DESPESA_CONTRATADA": "99,50"},
    ])
    agregados.materializar(banco)
    serie, fonte = banco.execute("""
        SELECT (SELECT SUM(total_contratado) FROM serie_diaria
                WHERE dt_extracao = (SELECT MAX(dt_extracao) FROM serie_diaria)),
               (SELECT SUM(VR) FROM v_despesas)
    """).fetchone()
    assert serie == pytest.approx(fonte)


def test_benchmark_exige_minimo_de_notas_e_ordena_quantis(banco):
    despesas = [
        {"SQ_DESPESA": str(i), "VR_DESPESA_CONTRATADA": f"{v},00"}
        for i, v in enumerate([10, 20, 30, 40, 500])
    ]
    # categoria com só 2 notas não pode entrar
    despesas += [
        {"SQ_DESPESA": "90", "DS_ORIGEM_DESPESA": "Despesas com pessoal", "VR_DESPESA_CONTRATADA": "70,00"},
        {"SQ_DESPESA": "91", "DS_ORIGEM_DESPESA": "Despesas com pessoal", "VR_DESPESA_CONTRATADA": "80,00"},
    ]
    extrair_dia(banco, "20/08/2026", despesas=despesas)
    agregados.materializar(banco)
    linhas = banco.execute(
        "SELECT DS_ORIGEM_DESPESA, SG_UF, p25, mediana, p75, p95, maximo FROM benchmark_precos"
    ).df()
    assert set(linhas["DS_ORIGEM_DESPESA"]) == {"Publicidade por materiais impressos"}
    assert set(linhas["SG_UF"]) == {"XX", "BR-TODAS"}  # âmbito UF + nacional
    for _, l in linhas.iterrows():
        assert l["p25"] <= l["mediana"] <= l["p75"] <= l["p95"] <= l["maximo"]


def test_indicadores_concentracao_sem_nota_e_pessoa_fisica(banco):
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "NR_CPF_CNPJ_FORNECEDOR": "11222333000144",
         "VR_DESPESA_CONTRATADA": "300,00", "DS_TIPO_DOCUMENTO": "Nota Fiscal"},
        {"SQ_DESPESA": "2", "NR_CPF_CNPJ_FORNECEDOR": "12345678901",
         "NM_FORNECEDOR": "CICRANO PF", "DS_TIPO_FORNECEDOR": "PESSOA FÍSICA",
         "VR_DESPESA_CONTRATADA": "700,00", "DS_TIPO_DOCUMENTO": "Recibo"},
    ], receitas=[
        {"SQ_RECEITA": "1", "VR_RECEITA": "2000,00"},
    ])
    agregados.materializar(banco)
    ind = banco.execute("SELECT * FROM indicadores").df().iloc[0]
    assert ind["total_contratado"] == pytest.approx(1000.0)
    assert ind["total_receitas"] == pytest.approx(2000.0)
    assert ind["razao_gasto_receita"] == pytest.approx(0.5)
    assert ind["n_fornecedores"] == 2
    assert ind["pct_maior_fornecedor"] == pytest.approx(70.0)
    assert ind["valor_sem_nota"] == pytest.approx(700.0)   # recibo não é nota fiscal
    assert ind["valor_pessoa_fisica"] == pytest.approx(700.0)


def test_indicadores_valor_removido_aparece_apos_remocao(banco):
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "BANDEIRA", "VR_DESPESA_CONTRATADA": "100,00"},
        {"SQ_DESPESA": "2", "DS_DESPESA": "CARRO DE SOM", "VR_DESPESA_CONTRATADA": "5000,00"},
    ])
    extrair_dia(banco, "21/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "BANDEIRA", "VR_DESPESA_CONTRATADA": "100,00"},
    ])
    agregados.materializar(banco)
    assert banco.execute(
        "SELECT valor_removido FROM indicadores"
    ).fetchone()[0] == pytest.approx(5000.0)


def test_indicadores_fornecedor_recem_aberto(banco):
    extrair_dia(banco, "20/08/2026", despesas=[{"SQ_DESPESA": "1"}])
    banco.execute("""
        CREATE TABLE fornecedores (cnpj VARCHAR, razao_social VARCHAR,
            data_abertura VARCHAR, situacao VARCHAR, porte VARCHAR, opcao_mei BOOLEAN,
            cnae_principal VARCHAR, municipio VARCHAR, uf VARCHAR,
            capital_social DOUBLE, socios VARCHAR)
    """)
    banco.execute(
        "INSERT INTO fornecedores VALUES ('11222333000144', 'FORNECEDOR LTDA', "
        "'2026-01-15', 'ATIVA', 'ME', false, 'Publicidade', 'CIDADE', 'XX', 0, '')"
    )
    agregados.materializar(banco)
    assert banco.execute(
        "SELECT fornecedores_recem_abertos FROM indicadores"
    ).fetchone()[0] == 1


def test_rede_reconcilia_com_despesas_e_receitas(banco):
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "300,00"},
        {"SQ_DESPESA": "2", "NR_CPF_CNPJ_FORNECEDOR": "55666777000188",
         "NM_FORNECEDOR": "OUTRA LTDA", "VR_DESPESA_CONTRATADA": "700,00"},
    ], receitas=[
        {"SQ_RECEITA": "1", "VR_RECEITA": "1234,56"},
    ])
    agregados.materializar(banco)
    despesa, doacao = banco.execute("""
        SELECT (SELECT SUM(valor) FROM rede WHERE tipo = 'despesa'),
               (SELECT SUM(valor) FROM rede WHERE tipo = 'doacao')
    """).fetchone()
    assert despesa == pytest.approx(1000.0)
    assert doacao == pytest.approx(1234.56)
