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
    for _, linha in linhas.iterrows():
        assert linha["p25"] <= linha["mediana"] <= linha["p75"] <= linha["p95"] <= linha["maximo"]


def _candidata(sq, nome):
    return {"SQ_CANDIDATO": sq, "NM_CANDIDATO": nome, "SQ_PRESTADOR_CONTAS": f"9{sq}",
            "DS_GENERO": "Feminino", "DS_COR_RACA": "Parda"}


def test_cota_fefc_separa_o_fundo_especial_por_genero_e_cor(banco):
    """A régua legal é do FEFC: Fundo Partidário e outros recursos não entram.
    Prestação de contas vem Capitalizada ('Feminino') — a tabela normaliza."""
    extrair_dia(banco, "20/08/2026", receitas=[
        {"SQ_RECEITA": "1", "VR_RECEITA": "7000,00", "DS_FONTE_RECEITA": "FUNDO ESPECIAL"},
        {"SQ_RECEITA": "2", "VR_RECEITA": "3000,00", "DS_FONTE_RECEITA": "FUNDO ESPECIAL",
         **_candidata("160002", "BELTRANA")},
        {"SQ_RECEITA": "3", "VR_RECEITA": "9000,00", "DS_FONTE_RECEITA": "FUNDO PARTIDARIO",
         **_candidata("160002", "BELTRANA")},
        {"SQ_RECEITA": "4", "VR_RECEITA": "500,00", **_candidata("160002", "BELTRANA")},
    ])
    agregados.materializar(banco)
    linhas = banco.execute("""
        SELECT genero, cor_raca, candidatos_fefc, fefc, candidaturas
        FROM cota_fefc ORDER BY genero
    """).fetchall()
    # o registro sintético não traz gênero/cor: candidaturas fica NULL (nunca 0)
    assert linhas == [("FEMININO", "PARDA", 1, pytest.approx(3000.0), None),
                      ("MASCULINO", "BRANCA", 1, pytest.approx(7000.0), None)]


def test_cota_fefc_usa_o_registro_de_candidaturas_como_denominador(banco):
    """Quando o registro traz gênero e cor (em CAIXA ALTA, como no consulta_cand —
    inclusive o cargo, 'DEPUTADO ESTADUAL'), o grupo com candidatura e sem um
    centavo de fundo TEM de aparecer — é o que a régua de proporcionalidade
    precisa ver — e a grafia publicada do cargo é a da prestação."""
    banco.execute("ALTER TABLE candidatos ADD COLUMN DS_GENERO VARCHAR")
    banco.execute("ALTER TABLE candidatos ADD COLUMN DS_COR_RACA VARCHAR")
    for sq, nome, genero, cor in (("160001", "FULANO", "MASCULINO", "BRANCA"),
                                  ("160002", "BELTRANA", "FEMININO", "PARDA"),
                                  ("160003", "CICRANA", "FEMININO", "PRETA")):
        banco.execute(
            "INSERT INTO candidatos VALUES (?, '1', ?, ?, 'DEPUTADO ESTADUAL', 'XYZ', 'XX', "
            "'#NE', ?, ?)", [sq, nome, nome, genero, cor])
    extrair_dia(banco, "20/08/2026", receitas=[
        {"SQ_RECEITA": "1", "VR_RECEITA": "7000,00", "DS_FONTE_RECEITA": "FUNDO ESPECIAL"},
    ])
    agregados.materializar(banco)
    linhas = banco.execute("""
        SELECT DS_CARGO, genero, cor_raca, candidatos_fefc, fefc, candidaturas
        FROM cota_fefc ORDER BY genero, cor_raca
    """).fetchall()
    assert linhas == [("Deputado Estadual", "FEMININO", "PARDA", 0, 0.0, 1),
                      ("Deputado Estadual", "FEMININO", "PRETA", 0, 0.0, 1),
                      ("Deputado Estadual", "MASCULINO", "BRANCA", 1, pytest.approx(7000.0), 1)]


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
    # o recibo aqui é de pessoa física, que não emite nota: fora do indicador
    assert ind["valor_sem_nota"] == pytest.approx(0.0)
    assert ind["valor_pessoa_fisica"] == pytest.approx(700.0)


def test_indicadores_sem_nota_so_conta_pessoa_juridica(banco):
    """PF não emite nota (recibo/RPA é o documento correto dela): marcar PF
    seria ruído garantido. O mesmo recibo, vindo de PJ, é indício."""
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "NR_CPF_CNPJ_FORNECEDOR": "12345678901",
         "NM_FORNECEDOR": "CICRANO PF", "DS_TIPO_FORNECEDOR": "PESSOA FÍSICA",
         "VR_DESPESA_CONTRATADA": "700,00", "DS_TIPO_DOCUMENTO": "Recibo"},
        {"SQ_DESPESA": "2", "NR_CPF_CNPJ_FORNECEDOR": "11222333000144",
         "VR_DESPESA_CONTRATADA": "250,00", "DS_TIPO_DOCUMENTO": "Recibo"},
    ])
    agregados.materializar(banco)
    assert banco.execute(
        "SELECT valor_sem_nota FROM indicadores"
    ).fetchone()[0] == pytest.approx(250.0)


def test_indicadores_sem_nota_aceita_cupom_fiscal(banco):
    """Cupom fiscal (NFC-e/ECF) comprova a despesa tanto quanto a nota."""
    extrair_dia(banco, "20/08/2026", despesas=[
        {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "400,00",
         "DS_TIPO_DOCUMENTO": "Cupom Fiscal"},
    ])
    agregados.materializar(banco)
    assert banco.execute(
        "SELECT COALESCE(valor_sem_nota, 0) FROM indicadores"
    ).fetchone()[0] == pytest.approx(0.0)


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


def test_benchmark_categorias_compara_total_por_candidato_no_grupo(banco):
    """Régua do 'fora da curva por tipo de gasto': distribuição do total gasto
    por candidato na categoria, dentro do grupo — só entre quem gasta nela."""
    despesas = [
        # 20 candidatos gastando em materiais impressos (categoria padrão);
        # o candidato 19 gasta em DUAS notas (o total dele deve ser somado)
        {"SQ_DESPESA": "1", "SQ_CANDIDATO": f"16{i:04d}", "SQ_PRESTADOR_CONTAS": f"90{i:04d}",
         "NM_CANDIDATO": f"CAND {i}", "NR_CANDIDATO": str(10000 + i),
         "VR_DESPESA_CONTRATADA": f"{(i + 1) * 100},00"}
        for i in range(20)
    ]
    despesas.append(
        {"SQ_DESPESA": "2", "SQ_CANDIDATO": "160019", "SQ_PRESTADOR_CONTAS": "900019",
         "NM_CANDIDATO": "CAND 19", "NR_CANDIDATO": "10019",
         "VR_DESPESA_CONTRATADA": "50000,00"})
    # categoria com só 3 candidatos: não vira régua
    despesas += [
        {"SQ_DESPESA": "3", "SQ_CANDIDATO": f"16{i:04d}", "SQ_PRESTADOR_CONTAS": f"90{i:04d}",
         "NM_CANDIDATO": f"CAND {i}", "NR_CANDIDATO": str(10000 + i),
         "DS_ORIGEM_DESPESA": "Despesas com pessoal", "VR_DESPESA_CONTRATADA": "70,00"}
        for i in range(3)
    ]
    extrair_dia(banco, "20/08/2026", despesas=despesas)
    agregados.materializar(banco)
    linhas = banco.execute("""
        SELECT DS_ORIGEM_DESPESA, SG_UF, candidatos, maximo
        FROM benchmark_categorias ORDER BY SG_UF
    """).fetchall()
    assert [(li[0], li[1], li[2]) for li in linhas] == [
        ("Publicidade por materiais impressos", "BR-TODAS", 20),
        ("Publicidade por materiais impressos", "XX", 20),
    ]
    # o máximo é o TOTAL do candidato 19 (2000 + 50000), não a maior nota
    assert linhas[0][3] == pytest.approx(52000.0)


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


PLACEHOLDER_DESPESA = {
    "SQ_DESPESA": "-1", "NR_CPF_CNPJ_FORNECEDOR": "-1", "NM_FORNECEDOR": "#NULO",
    "DS_DESPESA": "#NULO", "DS_ORIGEM_DESPESA": "#NULO", "DS_TIPO_DOCUMENTO": "#NULO",
    "DS_CNAE_FORNECEDOR": "#NULO", "DS_TIPO_FORNECEDOR": "#NULO",
    "VR_DESPESA_CONTRATADA": "0", "DT_DESPESA": "#NULO",
}


def test_linha_placeholder_do_spce_nao_e_fato(banco):
    """Prestação sem movimento (contraparte '-1' E valor zero) não pode virar
    fornecedor, item nem categoria — não há fato declarado ali."""
    extrair_dia(banco, "20/08/2026", despesas=[
        dict(PLACEHOLDER_DESPESA),
        {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "300,00"},
    ], receitas=[
        {"SQ_RECEITA": "-1", "NR_CPF_CNPJ_DOADOR": "-1", "NM_DOADOR": "#NULO",
         "DS_ORIGEM_RECEITA": "#NULO", "VR_RECEITA": "0", "DT_RECEITA": "#NULO"},
    ])
    agregados.materializar(banco)
    assert banco.execute("SELECT COUNT(*) FROM v_despesas").fetchone()[0] == 1
    assert banco.execute("SELECT COUNT(*) FROM v_receitas").fetchone()[0] == 0
    ind = banco.execute(
        "SELECT itens, n_fornecedores, total_contratado FROM indicadores"
    ).fetchone()
    assert ind == (1, 1, pytest.approx(300.0))


def test_contraparte_anonima_com_valor_e_fato_e_indicio(banco):
    """Doação de origem não identificada COM valor não é placeholder — entra."""
    extrair_dia(banco, "20/08/2026", receitas=[
        {"SQ_RECEITA": "1", "NR_CPF_CNPJ_DOADOR": "-1", "NM_DOADOR": "#NULO",
         "DS_ORIGEM_RECEITA": "Recursos de origens não identificadas",
         "VR_RECEITA": "500,00"},
    ])
    agregados.materializar(banco)
    assert banco.execute("SELECT SUM(VR) FROM v_receitas").fetchone()[0] == pytest.approx(500.0)


def test_placeholder_substituido_por_declaracao_real_nao_e_remocao(banco):
    """A primeira declaração real substitui o placeholder no arquivo do TSE —
    isso não pode aparecer como 'declaração removida'."""
    extrair_dia(banco, "20/08/2026", despesas=[dict(PLACEHOLDER_DESPESA)])
    extrair_dia(banco, "21/08/2026", despesas=[
        {"SQ_DESPESA": "1", "VR_DESPESA_CONTRATADA": "300,00"},
    ])
    agregados.materializar(banco)
    assert banco.execute("SELECT COUNT(*) FROM v_removidas_despesas_contratadas").fetchone()[0] == 0
    assert banco.execute("SELECT valor_removido FROM indicadores").fetchone()[0] == pytest.approx(0.0)


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
