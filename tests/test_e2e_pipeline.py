"""E2E do pipeline: do CSV bruto no formato do TSE até as consultas do site.

As outras suítes cobrem pedaços (versionamento sintético, export a partir de
tabelas prontas, consultas do console contra o banco real), mas duas emendas
ficavam sem teste algum:

1. a CARGA real (`carga.carregar`): zip → CSV Windows-1252, separador ';', aspas,
   '#NULO', linhas-placeholder — nada exercitava o parse de verdade;
2. o site consome os PARQUETS PSEUDONIMIZADOS, e as consultas do console eram
   testadas contra o banco cru — nenhum teste as rodava sobre o dado mascarado
   (onde NR_DOCUMENTO pode conter pf-… e hash_linha vira h-…).

Este teste percorre o fio inteiro, duas extrações (com uma remoção e uma
edição no meio): zip → carregar → versionar → agregados → verificar →
exportar → abre os parquets gerados num DuckDB limpo, como o visitante, e
roda cada consulta pronta do console sobre eles.
"""

import csv
import io
import sys
import zipfile
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import agregados, carga, cnpj, exportar, historico, verificacao  # noqa: E402
from tests.conftest import (  # noqa: E402
    COLS_DESPESAS,
    COLS_RECEITAS,
    DESPESA_PADRAO,
    RECEITA_PADRAO,
)
from tests.test_consultas_do_site import _consultas  # noqa: E402

ANO = 2026

COLS_CANDIDATOS = [
    "SQ_CANDIDATO", "NR_CANDIDATO", "NM_CANDIDATO", "NM_URNA_CANDIDATO",
    "DS_CARGO", "SG_PARTIDO", "SG_UF", "DS_SITUACAO_CANDIDATURA",
    "CD_ELEICAO", "SG_UE", "DS_GENERO", "DS_COR_RACA",
]
COLS_PAGAS = ["DT_GERACAO", "SQ_PRESTADOR_CONTAS", "SG_UF",
              "VR_PAGTO_DESPESA", "DT_PAGTO_DESPESA"]
COLS_ORIGINARIO = ["SQ_PRESTADOR_CONTAS", "NR_CPF_CNPJ_DOADOR_ORIGINARIO",
                   "NM_DOADOR_ORIGINARIO", "NM_DOADOR_ORIGINARIO_RFB", "VR_RECEITA"]
COLS_BENS = ["SQ_CANDIDATO", "SG_UF", "DS_TIPO_BEM_CANDIDATO",
             "DS_BEM_CANDIDATO", "VR_BEM_CANDIDATO", "DT_ULT_ATUAL_BEM_CANDIDATO"]

# subconjunto do cabeçalho real de votacao_candidato_munzona (a carga lê por nome)
COLS_VOTACAO = ["DT_GERACAO", "NR_TURNO", "SG_UF", "CD_MUNICIPIO", "NR_ZONA",
                "DS_CARGO", "SQ_CANDIDATO", "QT_VOTOS_NOMINAIS",
                "QT_VOTOS_NOMINAIS_VALIDOS", "DS_SIT_TOT_TURNO"]


def _votacao_do_dia(dia: str) -> list[dict]:
    """Votos como o TSE entrega: uma linha por candidato × município × zona × turno."""
    def linha(i, turno, municipio, zona, votos, validos, situacao):
        return {"DT_GERACAO": dia, "NR_TURNO": str(turno), "SG_UF": "XX",
                "CD_MUNICIPIO": municipio, "NR_ZONA": zona, "DS_CARGO": "Deputado Estadual",
                "SQ_CANDIDATO": _cand(i)["SQ_CANDIDATO"], "QT_VOTOS_NOMINAIS": str(votos),
                "QT_VOTOS_NOMINAIS_VALIDOS": str(validos), "DS_SIT_TOT_TURNO": situacao}
    return [
        # candidato 1: três zonas em dois municípios somam 1.000 votos
        linha(1, 1, "100", "1", 600, 600, "ELEITO POR MÉDIA"),
        linha(1, 1, "100", "2", 300, 300, "ELEITO POR MÉDIA"),
        linha(1, 1, "200", "1", 100, 100, "ELEITO POR MÉDIA"),
        # candidato 2: foi ao 2º turno — o resultado é o do último turno
        linha(2, 1, "100", "1", 400, 400, "2º TURNO"),
        linha(2, 2, "100", "1", 900, 900, "NÃO ELEITO"),
        # candidato 3: candidatura indeferida — voto digitado, nenhum válido
        linha(3, 1, "100", "1", 50, 0, "#NULO#"),
    ]


# valores que provam o parse: acento, cedilha e ';' DENTRO de campo com aspas
# ’ (0x92) só existe no Windows-1252 — o `encoding='latin-1'` do DuckDB recusava o
# arquivo inteiro por um byte desses (rotina de 12/09/2026)
DESCRICAO_ACENTUADA = 'PLACA "VOTE JÁ"; CONFECÇÃO ESPECIAL Nº 1 – D’ÁGUA'
CPF_FORNECEDOR_PF = "12345678901"
CPF_DOADOR_PF = "98765432100"


def _cand(i: int) -> dict:
    """Metadados de um candidato sintético, iguais entre despesa e receita.
    (Divergência descritiva é caso do test_verificacao: v_prestadores colapsa.)"""
    return {
        "SQ_CANDIDATO": f"16{i:04d}", "SQ_PRESTADOR_CONTAS": f"90{i:04d}",
        "NM_CANDIDATO": f"CANDIDATO {i:04d}", "NR_CANDIDATO": f"1{i:04d}",
        "SG_PARTIDO": "XYZ" if i % 2 else "ABC",
        "DS_CARGO": "Deputado Estadual", "SG_UF": "XX",
    }


def _despesas_do_dia(dia: str, com_removida: bool, valor_editada: str, sq_editada: str):
    linhas = []

    def add(**ajustes):
        linhas.append({**DESPESA_PADRAO, "DT_GERACAO": dia, **ajustes})

    for i in range(1, 31):
        c = _cand(i)
        for k, vr in enumerate(["100,00", "250,00", "400,00", "1000,00"]):
            add(**c, SQ_DESPESA=f"d{i}x{k}", NR_DOCUMENTO=f"{i}00{k}",
                VR_DESPESA_CONTRATADA=vr)

    extra = _cand(1)
    # fornecedor pessoa física com o CPF repetido no número do documento —
    # exatamente o padrão real do TSE que vazava CPF cru no parquet
    add(**extra, SQ_DESPESA="501", NM_FORNECEDOR="PRESTADOR PESSOA FISICA",
        NR_CPF_CNPJ_FORNECEDOR=CPF_FORNECEDOR_PF, DS_TIPO_FORNECEDOR="PESSOA FÍSICA",
        DS_TIPO_DOCUMENTO="Recibo", NR_DOCUMENTO=CPF_FORNECEDOR_PF,
        DS_ORIGEM_DESPESA="Despesas com pessoal", VR_DESPESA_CONTRATADA="800,00")
    # acento, ’ e ';' dentro de campo com aspas: o parse cp1252/;/aspas de verdade
    add(**extra, SQ_DESPESA="502", DS_DESPESA=DESCRICAO_ACENTUADA,
        NR_DOCUMENTO="5020", VR_DESPESA_CONTRATADA="300,00")
    # três linhas 100% idênticas (itens repetidos legítimos) -> qt_linhas = 3
    for _ in range(3):
        add(**extra, SQ_DESPESA="77", DS_DESPESA="ADESIVO TRIPLO",
            NR_DOCUMENTO="7700", VR_DESPESA_CONTRATADA="10,00")
    # data ausente ('#NULO'): a régua de essência precisa tratá-la
    add(**extra, SQ_DESPESA="503", DS_DESPESA="SEM DATA", NR_DOCUMENTO="5030",
        VR_DESPESA_CONTRATADA="120,00", DT_DESPESA="#NULO")
    # linha-placeholder do SPCE (prestação sem movimento) — não é fato
    add(**extra, SQ_DESPESA="-1", NR_CPF_CNPJ_FORNECEDOR="-1",
        NM_FORNECEDOR="#NULO", NM_FORNECEDOR_RFB="#NULO", DS_DESPESA="#NULO",
        DS_ORIGEM_DESPESA="#NULO", DS_TIPO_DOCUMENTO="#NULO",
        NR_DOCUMENTO="#NULO#", VR_DESPESA_CONTRATADA="0,00", DT_DESPESA="#NULO")
    if com_removida:
        add(**extra, SQ_DESPESA="504", DS_DESPESA="CARRO DE SOM QUE SOME",
            NR_DOCUMENTO="5040", VR_DESPESA_CONTRATADA="5000,00")
    # data própria: com a data padrão, a régua 2-de-3 casaria a versão morta
    # também com as notas comuns do candidato (mesmo valor + mesma data)
    add(**extra, SQ_DESPESA=sq_editada, DS_DESPESA="PANFLETO EDITAVEL",
        NR_DOCUMENTO="5050", VR_DESPESA_CONTRATADA=valor_editada,
        DT_DESPESA="14/08/2026")
    return linhas


def _receitas_do_dia(dia: str):
    linhas = []
    for i in range(1, 31):
        c = _cand(i)
        base = {**RECEITA_PADRAO, "DT_GERACAO": dia, **c}
        linhas.append({**base, "SQ_RECEITA": f"r{i}a", "VR_RECEITA": "2000,00",
                       "DS_FONTE_RECEITA": "FUNDO ESPECIAL",
                       "DS_ORIGEM_RECEITA": "Recursos de partido político"})
        linhas.append({**base, "SQ_RECEITA": f"r{i}b", "VR_RECEITA": "500,00",
                       "NM_DOADOR": "DOADORA APARECIDA",
                       "NR_CPF_CNPJ_DOADOR": CPF_DOADOR_PF,
                       "DS_ORIGEM_RECEITA": "Recursos de pessoas físicas",
                       "DS_ESPECIE_RECEITA": "PIX"})
        linhas.append({**base, "SQ_RECEITA": f"r{i}c", "VR_RECEITA": "300,00",
                       "NM_DOADOR": c["NM_CANDIDATO"],
                       "DS_ORIGEM_RECEITA": "Recursos próprios"})
        linhas.append({**base, "SQ_RECEITA": f"r{i}d", "VR_RECEITA": "700,00"})
    return linhas


def _csv_cp1252(colunas: list[str], linhas: list[dict]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", quoting=csv.QUOTE_ALL, lineterminator="\n")
    w.writerow(colunas)
    for linha in linhas:
        w.writerow([linha[c] for c in colunas])
    return buf.getvalue().encode("cp1252")


def _publicar_zip_do_dia(dir_raw: Path, dia: str, com_removida: bool,
                         valor_editada: str, sq_editada: str) -> None:
    """Escreve o zip do dia como o TSE serviria (sobrescrevendo o anterior)."""
    candidatos = [
        {"SQ_CANDIDATO": f"16{i:04d}", "NR_CANDIDATO": f"1{i:04d}",
         "NM_CANDIDATO": f"CANDIDATO {i:04d}", "NM_URNA_CANDIDATO": f"CAND {i:04d}",
         "DS_CARGO": "Deputado Estadual", "SG_PARTIDO": "XYZ" if i % 2 else "ABC",
         "SG_UF": "XX", "DS_SITUACAO_CANDIDATURA": "APTO",
         "CD_ELEICAO": "2045202026", "SG_UE": "XX",
         "DS_GENERO": "FEMININO" if i % 2 else "MASCULINO",
         "DS_COR_RACA": "PARDA" if i % 3 == 0 else "BRANCA"}
        for i in range(1, 1051)
    ]
    # o candidato presidencial do membro _BR (sem movimento financeiro)
    candidatos.append({**candidatos[0], "SQ_CANDIDATO": "169999", "NR_CANDIDATO": "99",
                       "NM_CANDIDATO": "CANDIDATO PRESIDENCIAL", "NM_URNA_CANDIDATO": "PRESIDENCIAL",
                       "DS_CARGO": "Presidente", "SG_UF": "BR", "SG_UE": "BR"})
    pagas = [
        {"DT_GERACAO": dia, "SQ_PRESTADOR_CONTAS": _cand(i)["SQ_PRESTADOR_CONTAS"],
         "SG_UF": "XX", "VR_PAGTO_DESPESA": "150,00", "DT_PAGTO_DESPESA": "16/08/2026"}
        for i in range(1, 31)
    ]
    originario = [
        {"SQ_PRESTADOR_CONTAS": _cand(1)["SQ_PRESTADOR_CONTAS"],
         "NR_CPF_CNPJ_DOADOR_ORIGINARIO": "55666777000188",
         "NM_DOADOR_ORIGINARIO": "EMPRESA ORIGINÁRIA SA",
         "NM_DOADOR_ORIGINARIO_RFB": "#NULO", "VR_RECEITA": "2000,00"},
        {"SQ_PRESTADOR_CONTAS": _cand(2)["SQ_PRESTADOR_CONTAS"],
         "NR_CPF_CNPJ_DOADOR_ORIGINARIO": CPF_DOADOR_PF,
         "NM_DOADOR_ORIGINARIO": "DOADORA APARECIDA",
         "NM_DOADOR_ORIGINARIO_RFB": "#NULO", "VR_RECEITA": "500,00"},
    ]
    bens = [
        {"SQ_CANDIDATO": _cand(1)["SQ_CANDIDATO"], "SG_UF": "XX",
         "DS_TIPO_BEM_CANDIDATO": "Casa", "DS_BEM_CANDIDATO": "IMÓVEL RESIDENCIAL",
         "VR_BEM_CANDIDATO": "350000,00", "DT_ULT_ATUAL_BEM_CANDIDATO": "15/07/2026"},
    ]
    arquivos = {
        f"despesas_contratadas_candidatos_{ANO}_BRASIL.csv": _csv_cp1252(
            COLS_DESPESAS, _despesas_do_dia(dia, com_removida, valor_editada, sq_editada)),
        f"receitas_candidatos_{ANO}_BRASIL.csv": _csv_cp1252(
            COLS_RECEITAS, _receitas_do_dia(dia)),
        f"despesas_pagas_candidatos_{ANO}_BRASIL.csv": _csv_cp1252(COLS_PAGAS, pagas),
        f"receitas_candidatos_doador_originario_{ANO}_BRASIL.csv": _csv_cp1252(
            COLS_ORIGINARIO, originario),
        f"consulta_cand_{ANO}_BRASIL.csv": _csv_cp1252(COLS_CANDIDATOS, candidatos),
        f"bem_candidato_{ANO}_BRASIL.csv": _csv_cp1252(COLS_BENS, bens),
    }
    destino = dir_raw / str(ANO)
    destino.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destino / "prestacao_de_contas.zip", "w") as z:
        for nome, conteudo in arquivos.items():
            z.writestr(nome, conteudo)
    # a votação vem em zip próprio, com um CSV por UF além do consolidado — a
    # carga tem de ler só o _BRASIL (somar os dois dobraria todo voto)
    votacao = _csv_cp1252(COLS_VOTACAO, _votacao_do_dia(dia))
    with zipfile.ZipFile(destino / carga.ZIP_VOTACAO.format(ano=ANO), "w") as z:
        z.writestr(carga.CSV_VOTACAO.format(ano=ANO), votacao)
        z.writestr(f"votacao_candidato_munzona_{ANO}_XX.csv", votacao)
        # a presidencial vem no membro _BR, que o TSE publica vazio até totalizar
        # o país; aqui traz um candidato que o consolidado não tem e um repetido,
        # que não pode dobrar
        z.writestr(carga.CSV_VOTACAO_BR.format(ano=ANO), _csv_cp1252(COLS_VOTACAO, [
            {**_votacao_do_dia(dia)[0], "SQ_CANDIDATO": "169999", "DS_CARGO": "Presidente",
             "QT_VOTOS_NOMINAIS": "5000", "QT_VOTOS_NOMINAIS_VALIDOS": "5000",
             "DS_SIT_TOT_TURNO": "2º TURNO"},
            _votacao_do_dia(dia)[0],
        ]))


@pytest.fixture
def pipeline(tmp_path, monkeypatch):
    """Redireciona raw/banco/export para o tmp — o pipeline REAL roda inteiro."""
    monkeypatch.setattr(carga, "DIR_RAW", tmp_path / "raw")
    monkeypatch.setattr(carga, "CAMINHO_BANCO", tmp_path / "db" / "gastos.duckdb")
    monkeypatch.setattr(exportar, "DIR_EXPORT", tmp_path / "export")
    return tmp_path


def test_pipeline_completo_do_csv_do_tse_ate_as_consultas_do_site(pipeline):
    # --- dia 1: primeira extração
    _publicar_zip_do_dia(carga.DIR_RAW, "20/08/2026",
                         com_removida=True, valor_editada="100,00", sq_editada="505")
    carga.carregar(ANO)
    con = carga.conectar()
    historico.versionar(con)
    con.close()

    # --- dia 2: a nota 504 foi apagada e a 505 retificada (SQ regenerado)
    _publicar_zip_do_dia(carga.DIR_RAW, "21/08/2026",
                         com_removida=False, valor_editada="150,00", sq_editada="905")
    carga.carregar(ANO)
    con = carga.conectar()
    historico.versionar(con)

    # cadastro RFB como o enriquecimento deixaria (a rotina real consulta a rede)
    cnpj._garantir_tabela(con)
    con.execute("""
        INSERT INTO fornecedores VALUES
        ('11222333000144', 'FORNECEDOR LTDA OFICIAL', '2025-11-15', 'ATIVA', 'ME',
         false, 'Agências de publicidade', 'SÃO PAULO', 'XX', 10000.0,
         'SÓCIO UM', DATE '2026-08-21', NULL, NULL)
    """)

    # --- o parse preservou cp1252, aspas e ';' dentro de campo
    desc = con.execute(
        "SELECT DS_DESPESA FROM despesas_contratadas WHERE SQ_DESPESA = '502'"
    ).fetchone()[0]
    assert desc == DESCRICAO_ACENTUADA

    # --- votos: somados por candidato e turno, direto do zip — o CSV gigante
    # não fica no disco nem passa pelo extrair_zips
    assert con.execute("SELECT * FROM votos ORDER BY SQ_CANDIDATO").fetchall() == [
        ("160001", 1000, 1000, None, None, "ELEITO POR MÉDIA"),
        ("160002", 400, 400, 900, 900, "NÃO ELEITO"),
        ("160003", 50, 0, None, None, None),
        ("169999", 5000, 5000, None, None, "2º TURNO"),
    ]
    assert not list((carga.DIR_RAW / str(ANO)).rglob("votacao_candidato_munzona*.csv*"))

    # --- agregados + as MESMAS checagens que barram a publicação na rotina
    agregados.materializar(con)
    assert verificacao.verificar(con) == []

    # --- exportação pseudonimizada (o sal de teste vem do conftest)
    arquivos, hashes = exportar.exportar(con)
    con.close()
    nomes = {a.name for a in arquivos}
    esperados = (set(exportar.EXPORTS) | set(exportar.EXPORTS_ATUAL)
                 | set(exportar.EXPORTS_REMOVIDAS) | set(exportar.EXPORTS_ALTERADAS))
    assert esperados <= nomes, f"parquets ausentes: {esperados - nomes}"
    assert set(hashes) == nomes - {"resumo.json"}

    # --- o "site": um DuckDB limpo lendo SÓ os parquets publicados
    site = duckdb.connect()
    for a in arquivos:
        if a.suffix == ".parquet":
            site.execute(f"CREATE VIEW {a.stem} AS "
                         f"SELECT * FROM read_parquet('{a.as_posix()}')")

    # privacidade: nenhum CPF cru em nenhuma coluna sensível; o CPF gravado como
    # número de documento vira o MESMO código pf- da coluna de contraparte
    for coluna in ("NR_CPF_CNPJ_FORNECEDOR", "NR_DOCUMENTO", "hash_linha"):
        crus = site.execute(f"""
            SELECT COUNT(*) FROM despesas_atual
            WHERE regexp_matches({coluna}, '^[0-9]{{11}}$')
        """).fetchone()[0]
        assert crus == 0, f"{coluna} publicou valor de 11 dígitos cru"
    pf = site.execute("""
        SELECT NR_CPF_CNPJ_FORNECEDOR, NR_DOCUMENTO, hash_linha FROM despesas_atual
        WHERE NM_FORNECEDOR = 'PRESTADOR PESSOA FISICA'
    """).fetchone()
    assert pf[0].startswith("pf-") and pf[0] == pf[1]
    assert pf[2].startswith("h-")
    assert site.execute(
        "SELECT COUNT(*) FROM receitas_atual "
        "WHERE regexp_matches(NR_CPF_CNPJ_DOADOR, '^[0-9]{11}$')").fetchone()[0] == 0

    # placeholder fora; itens idênticos agregados com o valor multiplicado
    assert site.execute(
        "SELECT COUNT(*) FROM despesas_atual WHERE NR_CPF_CNPJ_FORNECEDOR = '-1'"
    ).fetchone()[0] == 0
    assert site.execute(
        "SELECT qt_linhas, valor FROM despesas_atual WHERE DS_DESPESA = 'ADESIVO TRIPLO'"
    ).fetchone() == (3, pytest.approx(30.0))

    # o diff entre as extrações chegou pronto ao visitante
    removidas = site.execute(
        "SELECT DS_DESPESA FROM despesas_removidas").fetchall()
    assert removidas == [("CARRO DE SOM QUE SOME",)]
    assert site.execute(
        "SELECT campo_alterado, valor_antes, valor_depois, sucessores FROM despesas_alteradas"
    ).fetchall() == [("valor", pytest.approx(100.0), pytest.approx(150.0), 1)]

    # o custo por voto chega pronto, sobre o 1º turno; sem voto não há custo
    custos = site.execute("""
        SELECT i.SQ_CANDIDATO, i.votos, i.votos_2t, i.resultado,
               i.custo_por_voto = ROUND(i.total_contratado / v.votos_1t, 4),
               i.custo_publico_por_voto, i.custo_proprio_por_voto, i.custo_terceiros_por_voto
        FROM indicadores i LEFT JOIN votos v USING (SQ_CANDIDATO)
        WHERE i.SQ_CANDIDATO IN ('160002', '160004') ORDER BY 1
    """).fetchall()
    # cand 2: R$ 1.750 contratados ÷ 400 votos; receita de 3.500 = 2.000 fundo +
    # 300 próprios + 1.200 terceiros → o custo repartido nessa proporção
    custo = 1750 / 400
    assert custos == [
        ("160002", 400, 900, "NÃO ELEITO", True,
         pytest.approx(custo * 2000 / 3500, abs=0.01), pytest.approx(custo * 300 / 3500, abs=0.01),
         pytest.approx(custo * 1200 / 3500, abs=0.01)),
        ("160004", None, None, None, None, None, None, None),
    ]

    # --- cada consulta pronta do console executa sobre os parquets publicados
    # (é o dado MASCARADO — a régua das flags precisa sobreviver ao pf-/h-)
    for rotulo, sql in _consultas():
        try:
            site.execute(sql).fetchall()
        except duckdb.Error as e:
            pytest.fail(f"consulta '{rotulo}' quebrou sobre os parquets publicados: {e}")

    # e as que o cenário garante respondem com o dado esperado
    partidos = dict(site.execute("""
        SELECT SG_PARTIDO, ROUND(SUM(valor), 2) FROM despesas_atual GROUP BY 1
    """).fetchall())
    assert set(partidos) == {"XYZ", "ABC"}
    recem = site.execute("""
        SELECT COUNT(*) FROM fornecedores WHERE data_abertura >= '2025-10-01'
    """).fetchone()[0]
    assert recem == 1
    site.close()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
