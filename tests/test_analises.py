"""Testes do catálogo de red flags (analises.py) sobre cenários sintéticos."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import analises  # noqa: E402
from tests.conftest import inserir_despesa, inserir_receita  # noqa: E402


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
    assert len(resultados) == 11
    for titulo, comentario, _df in resultados:
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


def test_valores_repetidos_exige_notas_distintas(banco):
    for _ in range(3):  # 3 itens da mesma nota: não é fracionamento
        inserir_despesa(banco, SQ_DESPESA="1", VR_DESPESA_CONTRATADA="10,00")
    df = _resultado(analises.executar_todas(banco), "Valores repetidos")
    assert df.empty
    for i in (2, 3, 4):  # mesmo valor em 3 notas distintas: entra
        inserir_despesa(banco, SQ_DESPESA=str(i), DS_DESPESA=f"SERVICO {i}",
                        VR_DESPESA_CONTRATADA="999,00")
    df = _resultado(analises.executar_todas(banco), "Valores repetidos")
    assert len(df) == 1
    assert df.iloc[0]["notas_distintas"] == 3


def test_sem_nota_ignora_categorias_sem_documento_esperado(banco):
    inserir_despesa(banco, SQ_DESPESA="1", DS_TIPO_DOCUMENTO="#NULO",
                    DS_ORIGEM_DESPESA="Doações financeiras a outros candidatos/partidos")
    # aluguel de imóvel e pessoal não têm nota fiscal por natureza
    inserir_despesa(banco, SQ_DESPESA="4", DS_TIPO_DOCUMENTO="Recibo",
                    DS_ORIGEM_DESPESA="Locação/cessão de bens imóveis",
                    VR_DESPESA_CONTRATADA="900,00")
    inserir_despesa(banco, SQ_DESPESA="5", DS_TIPO_DOCUMENTO="#NULO",
                    DS_ORIGEM_DESPESA="Despesas com pessoal",
                    VR_DESPESA_CONTRATADA="700,00")
    inserir_despesa(banco, SQ_DESPESA="2", DS_TIPO_DOCUMENTO="Recibo",
                    VR_DESPESA_CONTRATADA="100,00")
    df = _resultado(analises.executar_todas(banco), "Despesas sem documento fiscal")
    assert len(df) == 1
    assert df.iloc[0]["total"] == pytest.approx(100.0)


def test_resumo_financeiro_conta_dinheiro_publico_pela_fonte(banco):
    """O fundo chega ao candidato como 'Recursos de partido político' na origem;
    a fonte (DS_FONTE_RECEITA) é quem diz se é dinheiro público."""
    banco.execute(
        "INSERT INTO candidatos VALUES ('160001', '12345', 'FULANO', 'FULANO', "
        "'Deputado Estadual', 'XYZ', 'XX', 'DEFERIDO')"
    )
    inserir_receita(banco, SQ_RECEITA="1", DS_FONTE_RECEITA="FUNDO ESPECIAL",
                    DS_ORIGEM_RECEITA="Recursos de partido político", VR_RECEITA="8000,00")
    inserir_receita(banco, SQ_RECEITA="2", DS_FONTE_RECEITA="FUNDO PARTIDARIO",
                    DS_ORIGEM_RECEITA="Recursos de partido político", VR_RECEITA="1000,00")
    inserir_receita(banco, SQ_RECEITA="3", DS_FONTE_RECEITA="OUTROS RECURSOS",
                    VR_RECEITA="500,00")
    df = _resultado(analises.executar_todas(banco), "Resumo financeiro")
    assert df.iloc[0]["receita_total"] == pytest.approx(9500.0)
    assert df.iloc[0]["fundos_publicos"] == pytest.approx(9000.0)


def test_fornecedor_que_e_candidato_aparece_apenas_quando_ha_vinculo(banco):
    inserir_despesa(banco, SQ_DESPESA="1")  # fornecedor comum: fica de fora
    inserir_despesa(banco, SQ_DESPESA="2", NR_CPF_CNPJ_FORNECEDOR="98765432100",
                    NM_FORNECEDOR="CANDIDATO FORNECEDOR",
                    SQ_CANDIDATO_FORNECEDOR="160099", SG_PARTIDO_FORNECEDOR="ABC",
                    DS_CARGO_FORNECEDOR="Vereador", VR_DESPESA_CONTRATADA="800,00")
    df = _resultado(analises.executar_todas(banco), "Fornecedor que também é candidato")
    assert list(df["NM_FORNECEDOR"]) == ["CANDIDATO FORNECEDOR"]
    assert df.iloc[0]["total"] == pytest.approx(800.0)


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
