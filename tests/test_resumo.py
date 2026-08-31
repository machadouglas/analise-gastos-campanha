"""Contrato do resumo.json (o que a Home do site consome).

O site lê chaves e campos por nome; se o gerador mudar de forma silenciosa,
a Home quebra só em produção. Estes testes fixam o contrato.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import agregados, resumo  # noqa: E402
from tests.conftest import extrair_dia  # noqa: E402

CHAVES = {
    "gerado_em", "publicado_em", "primeira_extracao", "totais", "mudancas",
    "novas_despesas", "despesas_removidas", "receitas_removidas",
    "fornecedores_compartilhados", "top_candidatos", "fora_da_curva",
    "serie_nacional",
}


def test_resumo_tem_o_contrato_da_home(banco):
    extrair_dia(banco, "20/08/2026",
                despesas=[{"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"}],
                receitas=[{"SQ_RECEITA": "1", "VR_RECEITA": "1000,00"}])
    r = resumo.gerar(banco)
    assert set(r) == CHAVES
    assert r["fora_da_curva"] == []  # sem agregados materializados, não inventa ranking
    assert r["primeira_extracao"] is True
    assert r["totais"]["total_contratado"] == pytest.approx(100.0)
    assert r["totais"]["total_receitas"] == pytest.approx(1000.0)
    assert r["totais"]["candidatos_com_gastos"] == 1


def test_novas_despesas_multiplicam_qt_linhas(banco):
    # 3 itens idênticos de R$ 10 são UMA linha de conteúdo com valor total R$ 30
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "ADESIVO", "VR_DESPESA_CONTRATADA": "10,00"}
        for _ in range(3)
    ])
    r = resumo.gerar(banco)
    assert len(r["novas_despesas"]) == 1
    assert r["novas_despesas"][0]["valor"] == pytest.approx(30.0)


def test_retransmissao_nao_vira_despesa_nova(banco):
    """Regressão: 'nova' era hash novo, e o SPCE regenera SQ_DESPESA a cada
    retransmissão — a prestação inteira de quem retransmite renascia todo dia e
    tomava o topo da Home. Nova é a ESSÊNCIA que estreou hoje."""
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "100", "DS_DESPESA": "CARRO DE SOM",
         "VR_DESPESA_CONTRATADA": "5000,00"}])
    extrair_dia(banco, "21/08/2026", despesas=[
        {"SQ_DESPESA": "999", "DS_DESPESA": "CARRO DE SOM",   # mesmo fato, SQ novo
         "VR_DESPESA_CONTRATADA": "5000,00"},
        {"SQ_DESPESA": "1000", "DS_DESPESA": "PANFLETO",      # essa sim é nova
         "VR_DESPESA_CONTRATADA": "800,00"}])
    novas = resumo.gerar(banco)["novas_despesas"]
    assert [n["DS_DESPESA"] for n in novas] == ["PANFLETO"]


def test_despesa_editada_conta_como_nova(banco):
    """A régua é a essência, e valor faz parte dela: corrigir o valor declara um
    fato que ninguém tinha visto antes — aparece como novo (e a versão antiga
    aparece em v_alteradas, não em removidas)."""
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "CARRO DE SOM",
         "VR_DESPESA_CONTRATADA": "5000,00"}])
    extrair_dia(banco, "21/08/2026", despesas=[
        {"SQ_DESPESA": "1", "DS_DESPESA": "CARRO DE SOM",
         "VR_DESPESA_CONTRATADA": "9000,00"}])
    r = resumo.gerar(banco)
    assert [n["valor"] for n in r["novas_despesas"]] == [pytest.approx(9000.0)]
    assert r["despesas_removidas"] == []


def test_remocoes_aparecem_no_resumo_apos_sumirem(banco):
    extrair_dia(banco, "20/08/2026",
                despesas=[
                    {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"},
                    {"SQ_DESPESA": "2", "DS_DESPESA": "CARRO DE SOM",
                     "VR_DESPESA_CONTRATADA": "5000,00"},
                ],
                receitas=[
                    {"SQ_RECEITA": "1", "VR_RECEITA": "1000,00"},
                    {"SQ_RECEITA": "2", "NM_DOADOR": "SUMIDO ME",
                     "NR_CPF_CNPJ_DOADOR": "11111111000111", "VR_RECEITA": "7000,00"},
                ])
    extrair_dia(banco, "21/08/2026",
                despesas=[{"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"}],
                receitas=[{"SQ_RECEITA": "1", "VR_RECEITA": "1000,00"}])
    r = resumo.gerar(banco)
    assert r["primeira_extracao"] is False
    assert r["mudancas"]["despesas_removidas_qtd"] == 1
    assert r["mudancas"]["despesas_removidas_valor"] == pytest.approx(5000.0)
    assert r["mudancas"]["receitas_removidas_valor"] == pytest.approx(7000.0)
    assert [d["valor"] for d in r["despesas_removidas"]] == [pytest.approx(5000.0)]
    assert [d["NM_DOADOR"] for d in r["receitas_removidas"]] == ["SUMIDO ME"]
    # ids das fichas: a Home linka candidato e fornecedor a partir do resumo
    assert r["despesas_removidas"][0]["SQ_CANDIDATO"]
    assert "NR_CPF_CNPJ_FORNECEDOR" in r["despesas_removidas"][0]
    assert r["receitas_removidas"][0]["SQ_CANDIDATO"]
    # datas serializadas como texto (JSON não aceita date do pandas)
    assert isinstance(r["despesas_removidas"][0]["dt_primeira_extracao"], str)


def test_fornecedor_compartilhado_exige_dois_candidatos(banco):
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"},
        {"SQ_DESPESA": "2", "SQ_CANDIDATO": "160002", "NM_CANDIDATO": "BELTRANO",
         "NR_CANDIDATO": "54321", "SQ_PRESTADOR_CONTAS": "900002",
         "VR_DESPESA_CONTRATADA": "200,00"},
    ])
    r = resumo.gerar(banco)
    assert len(r["fornecedores_compartilhados"]) == 1
    assert r["fornecedores_compartilhados"][0]["candidatos"] == 2
    assert r["fornecedores_compartilhados"][0]["total"] == pytest.approx(300.0)


def test_fora_da_curva_aponta_quem_estoura_o_p95_do_grupo(banco):
    """19 candidatos gastando até R$ 2.000 e um gastando R$ 100.000: só o
    destoante entra, com valor, mediana e p95 do grupo (fatos conferíveis)."""
    despesas = [
        {"SQ_DESPESA": "1", "SQ_CANDIDATO": f"16{i:04d}", "SQ_PRESTADOR_CONTAS": f"90{i:04d}",
         "NM_CANDIDATO": f"CAND {i}", "NR_CANDIDATO": str(10000 + i),
         "VR_DESPESA_CONTRATADA": f"{(i + 1) * 100},00"}
        for i in range(19)
    ]
    despesas.append(
        {"SQ_DESPESA": "1", "SQ_CANDIDATO": "169999", "SQ_PRESTADOR_CONTAS": "909999",
         "NM_CANDIDATO": "GASTADOR", "NR_CANDIDATO": "99999",
         "VR_DESPESA_CONTRATADA": "100000,00"})
    extrair_dia(banco, "20/08/2026", despesas=despesas)
    agregados.materializar(banco)
    r = resumo.gerar(banco)
    json.dumps(r)  # o site consome JSON — tipos numpy não podem vazar
    fora = r["fora_da_curva"]
    assert [c["NM_CANDIDATO"] for c in fora] == ["GASTADOR"]
    # contrato da foto: as chaves existem sempre; sem CD_ELEICAO/SG_UE na tabela
    # candidatos (caso deste banco de teste) vêm nulas e o site cai nas iniciais
    assert fora[0]["cd_eleicao"] is None
    assert fora[0]["sg_ue"] is None
    sinal = fora[0]["sinais"][0]
    assert sinal["metrica"] == "total_contratado"
    assert sinal["valor"] == pytest.approx(100000.0)
    assert sinal["p95"] < 100000.0
    assert sinal["grupo_n"] == 20


def test_serie_nacional_reconcilia_com_totais(banco):
    """Os sparklines da Home leem serie_nacional do resumo.json; o último dia
    da série precisa bater com os totais do próprio resumo."""
    extrair_dia(banco, "20/08/2026",
                despesas=[{"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"}],
                receitas=[{"SQ_RECEITA": "1", "VR_RECEITA": "1000,00"}])
    agregados.materializar(banco)
    r = resumo.gerar(banco)
    serie = r["serie_nacional"]
    assert len(serie) == 1
    ultimo = serie[-1]
    assert ultimo["dt"] == "2026-08-20"
    assert ultimo["contratado"] == pytest.approx(r["totais"]["total_contratado"])
    assert ultimo["receitas"] == pytest.approx(r["totais"]["total_receitas"])
    assert ultimo["candidatos"] == r["totais"]["candidatos_com_gastos"]


def test_serie_nacional_vazia_sem_agregados(banco):
    extrair_dia(banco, "20/08/2026",
                despesas=[{"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"}])
    assert resumo.gerar(banco)["serie_nacional"] == []


def test_razao_gasto_receita_so_e_sinal_acima_de_1x(banco):
    """Gastar MENOS do que arrecadou nunca é sinal, mesmo acima do p95 do grupo
    (no início da campanha o p95 da razão é ~0 e tudo 'estouraria')."""
    linhas = [
        {"SQ_RECEITA": "1", "SQ_CANDIDATO": f"16{i:04d}", "SQ_PRESTADOR_CONTAS": f"90{i:04d}",
         "NM_CANDIDATO": f"CAND {i}", "NR_CANDIDATO": str(10000 + i), "VR_RECEITA": "1000,00"}
        for i in range(20)
    ]
    # o candidato 0 gastou metade do que arrecadou: razão 0,5 — acima do p95 do
    # grupo (todo mundo em 0), mas abaixo de 1× — não pode virar sinal
    despesas = [{"SQ_DESPESA": "1", "SQ_CANDIDATO": "160000", "SQ_PRESTADOR_CONTAS": "900000",
                 "NM_CANDIDATO": "CAND 0", "NR_CANDIDATO": "10000",
                 "VR_DESPESA_CONTRATADA": "500,00"}]
    extrair_dia(banco, "20/08/2026", despesas=despesas, receitas=linhas)
    agregados.materializar(banco)
    razao = banco.execute(
        "SELECT razao_gasto_receita FROM indicadores WHERE SQ_CANDIDATO = '160000'"
    ).fetchone()[0]
    assert razao == pytest.approx(0.5)  # premissa do cenário
    sinais = [s["metrica"] for c in resumo.gerar(banco)["fora_da_curva"] for s in c["sinais"]]
    assert "razao_gasto_receita" not in sinais


def test_fora_da_curva_nao_dispara_por_arrecadar_muito(banco):
    """Arrecadar acima do grupo não é indício — receita não entra nos sinais."""
    linhas = [
        {"SQ_RECEITA": "1", "SQ_CANDIDATO": f"16{i:04d}", "SQ_PRESTADOR_CONTAS": f"90{i:04d}",
         "NM_CANDIDATO": f"CAND {i}", "NR_CANDIDATO": str(10000 + i), "VR_RECEITA": "100,00"}
        for i in range(19)
    ]
    linhas.append(
        {"SQ_RECEITA": "1", "SQ_CANDIDATO": "169999", "SQ_PRESTADOR_CONTAS": "909999",
         "NM_CANDIDATO": "ARRECADADOR", "NR_CANDIDATO": "99999", "VR_RECEITA": "900000,00"})
    extrair_dia(banco, "20/08/2026", receitas=linhas)
    agregados.materializar(banco)
    assert resumo.gerar(banco)["fora_da_curva"] == []


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
