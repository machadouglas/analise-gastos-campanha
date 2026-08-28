"""Testes dos agregados materializados (o que o site consome) sobre cenários
sintéticos: série diária reconstruída, benchmark, indicadores e rede."""

import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import agregados  # noqa: E402
from tests.conftest import extrair_dia, inserir_bem, inserir_pagamento  # noqa: E402


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


def test_indicadores_valor_repetido_ignora_itens_da_mesma_nota(banco):
    # 3 itens idênticos da MESMA nota (SQ_DESPESA igual): legítimo, não conta
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "10,00"},
        {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "10,00"},
        {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "10,00"},
    ])
    agregados.materializar(banco)
    assert banco.execute("SELECT grupos_valor_repetido FROM indicadores").fetchone()[0] == 0


def test_indicadores_valor_repetido_conta_notas_distintas(banco):
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": str(i), "DS_DESPESA": f"SERVICO {i}", "VR_DESPESA_CONTRATADA": "999,00"}
        for i in (1, 2, 3)
    ])
    agregados.materializar(banco)
    assert banco.execute("SELECT grupos_valor_repetido FROM indicadores").fetchone()[0] == 1


def test_indicadores_valor_repetido_exige_mesmo_fornecedor(banco):
    """Mesmo valor em fornecedores DIFERENTES (diárias, cachês tabelados) é
    padrão legítimo — fracionamento pressupõe o mesmo fornecedor."""
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": str(i), "NR_CPF_CNPJ_FORNECEDOR": f"1122233300014{i}",
         "NM_FORNECEDOR": f"FORNECEDOR {i}", "VR_DESPESA_CONTRATADA": "999,00"}
        for i in (1, 2, 3)
    ])
    agregados.materializar(banco)
    assert banco.execute("SELECT grupos_valor_repetido FROM indicadores").fetchone()[0] == 0


def test_indicadores_pago_fundos_proprios_e_bens(banco):
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "1000,00"},
    ], receitas=[
        {"SQ_RECEITA": "1", "DS_FONTE_RECEITA": "FUNDO ESPECIAL", "VR_RECEITA": "3000,00"},
        {"SQ_RECEITA": "2", "DS_FONTE_RECEITA": "OUTROS RECURSOS",
         "DS_ORIGEM_RECEITA": "Recursos próprios", "VR_RECEITA": "1000,00"},
    ])
    inserir_pagamento(banco, valor="400,00")
    inserir_bem(banco, valor="50000,00")
    agregados.materializar(banco)
    ind = banco.execute("SELECT * FROM indicadores").df().iloc[0]
    assert ind["total_pago"] == pytest.approx(400.0)
    assert ind["pct_pago"] == pytest.approx(40.0)
    assert ind["fundos_publicos"] == pytest.approx(3000.0)
    assert ind["pct_fundos_publicos"] == pytest.approx(75.0)
    assert ind["recursos_proprios"] == pytest.approx(1000.0)
    assert ind["total_bens"] == pytest.approx(50000.0)


def test_indicadores_cobertura_do_enriquecimento_de_cnpj(banco):
    """'0 recém-abertos' só é afirmável sabendo quantos CNPJs já foram consultados."""
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1"},  # fornecedor padrão 11222333000144
        {"SQ_DESPESA": "2", "NR_CPF_CNPJ_FORNECEDOR": "55666777000188",
         "NM_FORNECEDOR": "NAO CONSULTADA LTDA"},
        {"SQ_DESPESA": "3", "NR_CPF_CNPJ_FORNECEDOR": "12345678901",
         "NM_FORNECEDOR": "PESSOA FISICA", "DS_TIPO_FORNECEDOR": "PESSOA FÍSICA"},
    ])
    banco.execute("""
        CREATE TABLE fornecedores (cnpj VARCHAR, razao_social VARCHAR,
            data_abertura VARCHAR, situacao VARCHAR, porte VARCHAR, opcao_mei BOOLEAN,
            cnae_principal VARCHAR, municipio VARCHAR, uf VARCHAR,
            capital_social DOUBLE, socios VARCHAR)
    """)
    banco.execute(
        "INSERT INTO fornecedores VALUES ('11222333000144', 'FORNECEDOR LTDA', "
        "'2010-01-15', 'ATIVA', 'ME', false, 'Publicidade', 'CIDADE', 'XX', 0, '')"
    )
    agregados.materializar(banco)
    cnpjs, consultados = banco.execute(
        "SELECT fornecedores_cnpj, fornecedores_consultados FROM indicadores"
    ).fetchone()
    assert cnpjs == 2  # o CPF (11 dígitos) não entra no denominador
    assert consultados == 1


def test_indicadores_recem_aberto_deriva_o_corte_do_ano_da_eleicao(banco):
    """Despesas de 2026 => corte em 2025-10-01: aberto antes não é 'recém'."""
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1"},
        {"SQ_DESPESA": "2", "NR_CPF_CNPJ_FORNECEDOR": "55666777000188",
         "NM_FORNECEDOR": "VETERANA LTDA"},
    ])
    banco.execute("""
        CREATE TABLE fornecedores (cnpj VARCHAR, razao_social VARCHAR,
            data_abertura VARCHAR, situacao VARCHAR, porte VARCHAR, opcao_mei BOOLEAN,
            cnae_principal VARCHAR, municipio VARCHAR, uf VARCHAR,
            capital_social DOUBLE, socios VARCHAR)
    """)
    banco.execute("INSERT INTO fornecedores VALUES "
                  "('11222333000144', 'RECENTE', '2025-10-02', 'ATIVA', 'ME', false, '', '', 'XX', 0, ''), "
                  "('55666777000188', 'VETERANA', '2025-09-30', 'ATIVA', 'ME', false, '', '', 'XX', 0, '')")
    agregados.materializar(banco)
    assert banco.execute(
        "SELECT fornecedores_recem_abertos FROM indicadores"
    ).fetchone()[0] == 1


def test_indicadores_sem_nota_ignora_categorias_sem_documento_esperado(banco):
    extrair_dia(banco, "20/08/2026", despesas=[
        # transferência a outro candidato: sem nota por natureza — não conta
        {"SQ_DESPESA": "1", "DS_TIPO_DOCUMENTO": "#NULO", "VR_DESPESA_CONTRATADA": "500,00",
         "DS_ORIGEM_DESPESA": "Doações financeiras a outros candidatos/partidos"},
        {"SQ_DESPESA": "2", "DS_TIPO_DOCUMENTO": "#NULO", "VR_DESPESA_CONTRATADA": "80,00",
         "DS_ORIGEM_DESPESA": "Impostos, contribuições e taxas"},
        # aluguel de imóvel: o documento próprio é recibo, não nota fiscal — não conta
        {"SQ_DESPESA": "4", "DS_TIPO_DOCUMENTO": "Recibo", "VR_DESPESA_CONTRATADA": "900,00",
         "DS_ORIGEM_DESPESA": "Locação/cessão de bens imóveis"},
        # pessoal (RPA/folha): sem nota por natureza — não conta
        {"SQ_DESPESA": "5", "DS_TIPO_DOCUMENTO": "#NULO", "VR_DESPESA_CONTRATADA": "700,00",
         "DS_ORIGEM_DESPESA": "Despesas com pessoal"},
        # publicidade com recibo: conta
        {"SQ_DESPESA": "3", "DS_TIPO_DOCUMENTO": "Recibo", "VR_DESPESA_CONTRATADA": "100,00"},
    ])
    agregados.materializar(banco)
    assert banco.execute(
        "SELECT valor_sem_nota FROM indicadores"
    ).fetchone()[0] == pytest.approx(100.0)


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


def test_serie_diaria_inclui_candidato_que_so_tem_receitas(banco):
    """Receita declarada antes de qualquer despesa não pode sumir da série —
    e os metadados vêm da receita (a ficha do partido filtra por SG_PARTIDO)."""
    extrair_dia(banco, "20/08/2026", receitas=[
        {"SQ_RECEITA": "1", "VR_RECEITA": "1500,00"},
    ])
    agregados.materializar(banco)
    linha = banco.execute(
        "SELECT SQ_CANDIDATO, SG_PARTIDO, SG_UF, NM_CANDIDATO, total_contratado, total_receitas "
        "FROM serie_diaria"
    ).fetchone()
    assert linha == ("160001", "XYZ", "XX", "FULANO", pytest.approx(0.0), pytest.approx(1500.0))


def test_indicadores_incluem_candidato_que_so_tem_receitas(banco):
    """Quem arrecadou e nada gastou também é fato — precisa ter linha (e ficha)."""
    extrair_dia(banco, "20/08/2026", receitas=[
        {"SQ_RECEITA": "1", "VR_RECEITA": "1500,00"},
    ])
    agregados.materializar(banco)
    linha = banco.execute(
        "SELECT NM_CANDIDATO, SG_PARTIDO, total_contratado, total_receitas FROM indicadores"
    ).fetchone()
    assert linha == ("FULANO", "XYZ", pytest.approx(0.0), pytest.approx(1500.0))


def test_indicadores_sem_receita_declarada_nao_inventa_razao(banco):
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "100,00"},
    ])
    agregados.materializar(banco)
    receitas, razao = banco.execute(
        "SELECT total_receitas, razao_gasto_receita FROM indicadores"
    ).fetchone()
    assert receitas is None
    assert razao is None


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


def test_benchmark_conta_por_nota_e_nao_por_item(banco):
    """Nota fatiada em itens não pode entrar N vezes na distribuição de preços:
    3 itens de R$ 10 da mesma nota = UMA observação de R$ 30."""
    despesas = [
        {"SQ_DESPESA": str(i), "VR_DESPESA_CONTRATADA": f"{v},00"}
        for i, v in enumerate([100, 200, 300, 400], start=1)
    ]
    despesas += [
        {"SQ_DESPESA": "9", "DS_DESPESA": "ADESIVO", "VR_DESPESA_CONTRATADA": "10,00"}
        for _ in range(3)
    ]
    extrair_dia(banco, "20/08/2026", despesas=despesas)
    agregados.materializar(banco)
    notas, mediana, maximo = banco.execute(
        "SELECT notas, mediana, maximo FROM benchmark_precos WHERE SG_UF = 'XX'"
    ).fetchone()
    assert notas == 5  # 4 notas simples + 1 nota agregada de 30 (não 7 itens)
    assert mediana == pytest.approx(200.0)  # mediana de [30, 100, 200, 300, 400]
    assert maximo == pytest.approx(400.0)


def test_benchmark_indicadores_exige_grupo_minimo(banco):
    """Percentis só para grupos (cargo×UF) com pelo menos 20 candidatos."""
    despesas = [
        {"SQ_DESPESA": "1", "SQ_CANDIDATO": f"16{i:04d}", "SQ_PRESTADOR_CONTAS": f"90{i:04d}",
         "NM_CANDIDATO": f"CAND {i}", "NR_CANDIDATO": str(10000 + i),
         "VR_DESPESA_CONTRATADA": f"{(i + 1) * 100},00"}
        for i in range(20)
    ]
    despesas += [
        {"SQ_DESPESA": "1", "SQ_CANDIDATO": f"17{i:04d}", "SQ_PRESTADOR_CONTAS": f"91{i:04d}",
         "NM_CANDIDATO": f"SEN {i}", "NR_CANDIDATO": str(20000 + i),
         "DS_CARGO": "Senador", "VR_DESPESA_CONTRATADA": "500,00"}
        for i in range(5)
    ]
    extrair_dia(banco, "20/08/2026", despesas=despesas)
    agregados.materializar(banco)
    grupos = banco.execute("""
        SELECT DS_CARGO, SG_UF, candidatos, p25, mediana, p75, p95, maximo
        FROM benchmark_indicadores WHERE metrica = 'total_contratado' ORDER BY SG_UF
    """).fetchall()
    # deputado estadual entra (20 candidatos, âmbitos UF e nacional); senador (5) não
    assert [(g[0], g[1], g[2]) for g in grupos] == [
        ("Deputado Estadual", "BR-TODAS", 20), ("Deputado Estadual", "XX", 20)]
    for g in grupos:
        assert g[3] <= g[4] <= g[5] <= g[6] <= g[7]


def test_rede_doacao_originaria_liga_ao_candidato_sem_fanout(banco):
    """O rastreio do doador originário liga pelo prestador de contas; o join
    com v_prestadores não pode multiplicar nem perder valor."""
    extrair_dia(banco, "20/08/2026", despesas=[{"SQ_DESPESA": "1"}])
    banco.execute(
        "INSERT INTO receitas_doador_originario VALUES "
        "('900001', '33444555000166', 'EMPRESARIO ORIGINARIO', '#NULO', '2500,00')"
    )
    agregados.materializar(banco)
    linhas = banco.execute("""
        SELECT contraparte, NM_CANDIDATO, valor FROM rede
        WHERE tipo = 'doacao_originaria'
    """).fetchall()
    assert linhas == [("EMPRESARIO ORIGINARIO", "FULANO", 2500.0)]
