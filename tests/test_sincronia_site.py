"""Sincronia backend ↔ front: as regras que o site espelha do Python.

O site reimplementa em SQL (DuckDB-WASM) três regras definidas aqui no backend.
Cada uma vivia como comentário "manter em sincronia" — estes testes leem os
arquivos do front e falham quando as cópias divergem.
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import analises, historico, resumo  # noqa: E402

RAIZ = Path(__file__).parent.parent
CONSULTAS_TS = (RAIZ / "site" / "src" / "lib" / "consultas.ts").read_text(encoding="utf-8")
DUCKDB_TS = (RAIZ / "site" / "src" / "lib" / "duckdb.ts").read_text(encoding="utf-8")


def test_categorias_sem_nota_iguais_no_front():
    """CATEGORIAS_SEM_NOTA_ESPERADA em consultas.ts == src/analises.py."""
    bloco = re.search(
        r"CATEGORIAS_SEM_NOTA_ESPERADA = \[(.*?)\]", CONSULTAS_TS, re.DOTALL
    )
    assert bloco, "lista CATEGORIAS_SEM_NOTA_ESPERADA não encontrada em consultas.ts"
    do_front = re.findall(r"'([^']+)'", bloco.group(1))
    assert do_front == list(analises.CATEGORIAS_SEM_NOTA_ESPERADA)


def test_condicao_sem_nota_igual_no_front():
    """A régua do 'sem documento fiscal' é a mesma nos dois lados: documento não
    fiscal (nota OU cupom), fornecedor PJ e categoria em que a nota é a norma."""
    for doc in analises.DOCUMENTOS_FISCAIS:
        assert f"NOT ILIKE '%{doc}%'" in CONSULTAS_TS, f"documento fiscal '{doc}' ausente do site"
    # fornecedor PJ e o corte pela norma medida
    assert "LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 14" in CONSULTAS_TS
    assert "FROM norma_documento WHERE exige_documento" in CONSULTAS_TS
    # e o fallback sem o parquet novo continua sendo a lista fixa
    assert "SQL_CATEGORIAS_SEM_NOTA" in CONSULTAS_TS


def test_reguas_por_nota_iguais_no_front():
    """As red flags 12 (nota sem número), 13 (mesmo número em candidatos
    diferentes) e 7 (valor repetido) passaram a ser marcas nas fichas. Antes
    existiam só como consulta de exemplo no console; agora o site as aplica e
    precisa usar a MESMA régua de src/analises.py e src/agregados.py — uma
    divergência aqui marca (ou deixa de marcar) nota de gente real.
    """
    fonte_analises = (RAIZ / "src" / "analises.py").read_text(encoding="utf-8")
    fonte_agregados = (RAIZ / "src" / "agregados.py").read_text(encoding="utf-8")

    # 12 — documento fiscal cujo número não tem um só dígito
    sem_numero = "NOT regexp_matches(COALESCE(NR_DOCUMENTO, ''), '[0-9]')"
    assert sem_numero in fonte_analises, "régua da nota sem número mudou no backend"
    assert sem_numero in CONSULTAS_TS, f"esperava \"{sem_numero}\" em consultas.ts"

    # 13 — número de verdade (3+ dígitos) e fornecedor identificado. O backend
    # escapa as chaves por estar dentro de f-string; o site não.
    numerado = "regexp_full_match(COALESCE(NR_DOCUMENTO, ''), '[0-9]{3,}')"
    assert numerado.replace("{3,}", "{{3,}}") in fonte_analises
    assert numerado in CONSULTAS_TS
    assert "NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')" in CONSULTAS_TS

    # ambas só valem para documento FISCAL: não se cobra número de um recibo.
    # As duas condições do site precisam carregar essa negação.
    for regra in ("CONDICAO_NOTA_SEM_NUMERO", "CONDICAO_DOCUMENTO_NUMERADO"):
        assert f"export const {regra} =" in CONSULTAS_TS, (
            f"{regra} não encontrada em consultas.ts"
        )
        corpo = CONSULTAS_TS.split(f"export const {regra} =", 1)[1].split(";", 1)[0]
        assert "NOT ${CONDICAO_DOCUMENTO_NAO_FISCAL}" in corpo, (
            f"{regra} precisa exigir documento fiscal, como faz src/analises.py"
        )

    # 7 — mínimo de notas distintas de mesmo valor no mesmo fornecedor
    minimo = re.search(r"COUNT\(DISTINCT SQ_DESPESA\) >= (\d+)", fonte_agregados)
    assert minimo, "mínimo do valor repetido não encontrado em agregados.py"
    assert f"MINIMO_NOTAS_VALOR_REPETIDO = {minimo.group(1)}" in CONSULTAS_TS, (
        f"mínimo do valor repetido divergente: o backend usa {minimo.group(1)}"
    )
    assert "COUNT(DISTINCT SQ_DESPESA) >= ${MINIMO_NOTAS_VALOR_REPETIDO}" in CONSULTAS_TS


def test_norma_documento_e_a_tabela_que_o_site_espera():
    """O site registra `norma_documento` no boot e lê a coluna exige_documento;
    o backend precisa publicar exatamente esse nome de tabela e de coluna."""
    agregados_py = (RAIZ / "src" / "agregados.py").read_text(encoding="utf-8")
    exportar_py = (RAIZ / "src" / "exportar.py").read_text(encoding="utf-8")
    assert "CREATE OR REPLACE TABLE norma_documento" in agregados_py
    assert "AS exige_documento" in agregados_py
    assert "norma_documento.parquet" in exportar_py
    assert "'norma_documento'" in DUCKDB_TS


def test_sinais_do_fora_da_curva_iguais_no_front():
    """SINAIS_CTE/SINAIS_FILTRO em consultas.ts espelham METRICAS_SINAL:
    mesmas métricas E mesmos filtros de elegibilidade (ex.: razão só > 1)."""
    bloco = re.search(r"SINAIS_FILTRO = \[(.*?)\]", CONSULTAS_TS, re.DOTALL)
    assert bloco, "lista SINAIS_FILTRO não encontrada em consultas.ts"
    filtro_front = re.findall(r"'([^']+)'", bloco.group(1))
    nomes_backend = [nome for nome, _, _ in resumo.METRICAS_SINAL]
    assert filtro_front == nomes_backend

    # a exceção de saturação (estar no teto de 100% contava como sinal) foi
    # REMOVIDA da metodologia: "fora da curva" é estritamente acima do p95, sem
    # letra miúda. A ausência tem de valer nos dois lados — se ela voltar num
    # deles, a home marca um candidato que o outro lado não marca.
    assert "LIKE 'pct_%'" not in resumo.CONDICAO_SINAL
    assert "LIKE 'pct_%'" not in CONSULTAS_TS

    # a margem da razão gasto÷arrecadado vive num literal do SQL (o SINAIS_CTE
    # é texto puro) E numa constante que a ficha do candidato usa para o mesmo
    # chip — as duas têm de bater com o Python, senão a home marca um candidato
    # que a ficha dele não marca
    assert f"MARGEM_GASTO_ACIMA = {resumo.MARGEM_GASTO_ACIMA};" in CONSULTAS_TS, (
        f"MARGEM_GASTO_ACIMA do site fora de {resumo.MARGEM_GASTO_ACIMA} (src/resumo.py)"
    )

    cte = re.search(r"SINAIS_CTE = `(.*?)`", CONSULTAS_TS, re.DOTALL)
    assert cte, "SINAIS_CTE não encontrada em consultas.ts"
    for nome, _, filtro in resumo.METRICAS_SINAL:
        assert f"'{nome}'" in cte.group(1) or f", {nome}" in cte.group(1), (
            f"métrica {nome} ausente do SINAIS_CTE do site"
        )
        assert filtro in cte.group(1), (
            f"filtro de elegibilidade '{filtro}' da métrica {nome} ausente do SINAIS_CTE do site"
        )


def test_essencia_das_removidas_igual_no_front():
    """As views despesas_removidas/receitas_removidas do site usam a MESMA régua
    do versionamento (src/historico.py): a IDENTIDADE casa por igualdade e os
    campos VARIAVEIS são contados, para que nem a retransmissão renumerada (3 de
    3 iguais) nem a edição de um campo (2 de 3) apareçam como declaração
    apagada. Se a régua do Python mudar e a do site não, a mesma pergunta passa
    a ter duas respostas conforme o parquet publicado exista ou não."""
    for tabela, alias in (("despesas_contratadas", "d"), ("receitas", "r")):
        # TODA a essência compara com IS NOT DISTINCT FROM (identidade inclusa):
        # `NULL = NULL` não casa, e uma retransmissão com campo NULL viraria
        # falsa remoção — o erro que o projeto não pode cometer
        for coluna in historico.IDENTIDADE[tabela]:
            esperado = f"v.{coluna} IS NOT DISTINCT FROM {alias}.{coluna}"
            assert esperado in DUCKDB_TS, (
                f"coluna de identidade {coluna} ({tabela}) fora da view de removidas do "
                f"site: esperava '{esperado}' em site/src/lib/duckdb.ts"
            )
        variaveis = historico.VARIAVEIS[tabela]
        for coluna in variaveis:
            esperado = f"v.{coluna} IS NOT DISTINCT FROM {alias}.{coluna}"
            assert esperado in DUCKDB_TS, (
                f"campo variável {coluna} ({tabela}) fora da contagem de removidas do "
                f"site: esperava '{esperado}' em site/src/lib/duckdb.ts"
            )
        # o corte tem de ser o mesmo: "pelo menos todos-menos-um campos iguais"
        assert f">= {len(variaveis) - 1})" in DUCKDB_TS, (
            f"corte de campos iguais ({tabela}) divergente do backend: "
            f"esperava '>= {len(variaveis) - 1}' em site/src/lib/duckdb.ts"
        )
        # a comparação cobre exatamente essência = identidade + variáveis
        assert DUCKDB_TS.count(f"IS NOT DISTINCT FROM {alias}.") == (
            len(historico.IDENTIDADE[tabela]) + len(variaveis)
        )
    # e o próprio backend não pode regredir para `=` na essência
    historico_py = (RAIZ / "src" / "historico.py").read_text(encoding="utf-8")
    assert 'f"v.{c} = m.{c}"' not in historico_py, (
        "essência em historico.py voltou a comparar com '=' — NULL não casa e "
        "retransmissão vira falsa remoção; use IS NOT DISTINCT FROM"
    )


def test_paginas_nao_burlam_a_view_de_removidas():
    """Nenhuma página consulta remoção 'na unha' (dt_ultima_extracao < MAX sem a
    view) — foi exatamente o desvio metodológico da ficha do fornecedor."""
    paginas = (RAIZ / "site" / "src" / "pages").glob("*.tsx")
    for pagina in paginas:
        fonte = pagina.read_text(encoding="utf-8")
        assert "dt_ultima_extracao < (SELECT MAX" not in fonte, (
            f"{pagina.name} calcula remoções direto do histórico; use as views "
            "despesas_removidas/receitas_removidas (mesma régua do backend)"
        )


if __name__ == "__main__":
    import pytest

    sys.exit(pytest.main([__file__, "-v"]))


def _normalizar(texto: str) -> str:
    return " ".join(texto.split())


def test_filtro_placeholder_igual_no_front():
    """O filtro de linha-placeholder (contraparte '-1'/'#NULO' E valor zero) é
    espelhado 4× em duckdb.ts (views *_atual e *_removidas derivadas). Se a
    definição mudar em src/carga.py e a do site não, o fallback do site passa a
    contar (ou descartar) linhas que o backend não conta."""
    from src.carga import filtro_placeholder

    site = _normalizar(DUCKDB_TS)
    casos = [
        ("NR_CPF_CNPJ_FORNECEDOR", "VR_DESPESA_CONTRATADA"),   # despesas_atual
        ("NR_CPF_CNPJ_DOADOR", "VR_RECEITA"),                  # receitas_atual
        ("d.NR_CPF_CNPJ_FORNECEDOR", "d.VR_DESPESA_CONTRATADA"),  # despesas_removidas
        ("r.NR_CPF_CNPJ_DOADOR", "r.VR_RECEITA"),              # receitas_removidas
    ]
    for contraparte, valor in casos:
        esperado = _normalizar(filtro_placeholder(contraparte, valor))
        assert esperado in site, (
            f"filtro_placeholder({contraparte}) divergente em site/src/lib/duckdb.ts: "
            f"esperava '{esperado}'"
        )


def test_derivacao_do_estado_atual_igual_no_front():
    """As views despesas_atual/receitas_atual derivadas no site precisam do
    mesmo recorte do parquet dedicado (src/exportar.py): última extração viva e
    `valor` = VR × qt_linhas."""
    exportar_py = (RAIZ / "src" / "exportar.py").read_text(encoding="utf-8")
    for fonte, nome in ((DUCKDB_TS, "duckdb.ts"), (exportar_py, "exportar.py")):
        texto = _normalizar(fonte)
        for trecho in (
            "AS DOUBLE) * qt_linhas AS valor",
            "dt_ultima_extracao = (SELECT MAX(dt_ultima_extracao) FROM",
        ):
            assert trecho in texto, f"recorte do estado atual ausente de {nome}: '{trecho}'"


def test_colunas_de_corrigidas_batem_com_a_view_do_backend():
    """sqlCorrigidas (consultas.ts) consome colunas de v_alteradas_pares_*
    (src/historico.py). Um rename no backend não derrubaria só a seção: a
    consulta roda dentro do Promise.all das fichas, e a ficha INTEIRA viraria
    'não encontrado'. Constrói a view num banco sintético e confere coluna a
    coluna o que o site referencia."""
    import duckdb

    from src import historico as h

    con = duckdb.connect()
    con.execute("""
        CREATE TABLE despesas_contratadas (DT_GERACAO VARCHAR, HH_GERACAO VARCHAR,
            SQ_CANDIDATO VARCHAR, NM_CANDIDATO VARCHAR, NR_CANDIDATO VARCHAR,
            SG_PARTIDO VARCHAR, DS_CARGO VARCHAR, SG_UF VARCHAR, SQ_DESPESA VARCHAR,
            NM_FORNECEDOR VARCHAR, NR_CPF_CNPJ_FORNECEDOR VARCHAR, DS_DESPESA VARCHAR,
            VR_DESPESA_CONTRATADA VARCHAR, DT_DESPESA VARCHAR);
        CREATE TABLE receitas (DT_GERACAO VARCHAR, HH_GERACAO VARCHAR,
            SQ_CANDIDATO VARCHAR, NM_CANDIDATO VARCHAR, NR_CANDIDATO VARCHAR,
            SG_PARTIDO VARCHAR, DS_CARGO VARCHAR, SG_UF VARCHAR, SQ_RECEITA VARCHAR,
            NM_DOADOR VARCHAR, NR_CPF_CNPJ_DOADOR VARCHAR, DS_ORIGEM_RECEITA VARCHAR,
            VR_RECEITA VARCHAR, DT_RECEITA VARCHAR);
    """)
    con.execute(
        "INSERT INTO despesas_contratadas VALUES ('20/08/2026','04:00:00','160001','F','1',"
        "'X','Dep','XX','1','FORN','11222333000144','BANDEIRA','100,00','15/08/2026')")
    h.versionar(con)
    con.execute("DELETE FROM despesas_contratadas")
    con.execute(
        "INSERT INTO despesas_contratadas VALUES ('21/08/2026','04:00:00','160001','F','1',"
        "'X','Dep','XX','2','FORN','11222333000144','BANDEIRA','150,00','15/08/2026')")
    h.versionar(con)

    corpo = CONSULTAS_TS.split("export function sqlCorrigidas", 1)[1].split("`;", 1)[0]
    for view, contraparte in (
        ("v_alteradas_pares_despesas_contratadas", "NR_CPF_CNPJ_FORNECEDOR"),
        ("v_alteradas_pares_receitas", "NR_CPF_CNPJ_DOADOR"),
    ):
        colunas_view = {
            r[0] for r in con.execute(f"DESCRIBE {view}").fetchall()
        }
        referenciadas = {
            "campo_alterado", "nome_contraparte", contraparte,
            "SQ_CANDIDATO", "NM_CANDIDATO", "SG_PARTIDO", "SG_UF",
            "descricao_antes", "descricao_depois", "valor_antes", "valor_depois",
            "data_antes", "data_depois", "dt_primeira_extracao",
            "dt_ultima_extracao", "sucessores",
        }
        faltando_na_view = referenciadas - colunas_view
        assert not faltando_na_view, (
            f"{view} não expõe colunas que sqlCorrigidas referencia: {faltando_na_view}"
        )
        for coluna in referenciadas - {contraparte}:
            assert coluna in corpo, f"sqlCorrigidas deixou de referenciar '{coluna}'"


def test_situacao_nao_encontrada_igual_no_front():
    """SITUACAO_NAO_ENCONTRADA em consultas.ts == SITUACAO_NAO_ENCONTRADO em
    src/cnpj.py. É a lápide gravada quando a base pública responde 404: o site
    troca o bloco de cadastro por um aviso quando a encontra, e um texto
    divergente faria o aviso nunca aparecer (voltando a exibir a string crua)."""
    from src import cnpj

    achado = re.search(
        r"SITUACAO_NAO_ENCONTRADA = '([^']+)'", CONSULTAS_TS
    )
    assert achado, "SITUACAO_NAO_ENCONTRADA não encontrada em consultas.ts"
    assert achado.group(1) == cnpj.SITUACAO_NAO_ENCONTRADO
