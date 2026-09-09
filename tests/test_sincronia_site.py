"""Sincronia backend ↔ front: as regras que o site espelha do Python.

O site reimplementa em SQL (DuckDB-WASM) três regras definidas aqui no backend.
Cada uma vivia como comentário "manter em sincronia" — estes testes leem os
arquivos do front e falham quando as cópias divergem.
"""

import ast
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import analises, resumo  # noqa: E402

RAIZ = Path(__file__).parent.parent
CONSULTAS_TS = (RAIZ / "site" / "src" / "lib" / "consultas.ts").read_text(encoding="utf-8")
DUCKDB_TS = (RAIZ / "site" / "src" / "lib" / "duckdb.ts").read_text(encoding="utf-8")


def test_condicao_sem_nota_igual_no_front():
    """A régua do 'sem documento fiscal' é a mesma nos dois lados: documento não
    fiscal (nota OU cupom), fornecedor PJ e categoria em que a nota é a norma."""
    for doc in analises.DOCUMENTOS_FISCAIS:
        assert f"NOT ILIKE '%{doc}%'" in CONSULTAS_TS, f"documento fiscal '{doc}' ausente do site"
    # fornecedor PJ e o corte pela norma medida
    assert "LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 14" in CONSULTAS_TS
    assert "FROM norma_documento WHERE exige_documento" in CONSULTAS_TS


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


def test_exclusoes_de_plataforma_iguais_no_front():
    """Duas exclusões de ruído estrutural, cada uma com constante espelhada:
    - red flag 4 ("dinheiro que volta") ignora o repasse de plataforma de
      arrecadação — ela doa o que arrecadou e cobra a taxa do mesmo candidato;
    - red flag 13 (mesmo nº de nota) ignora impulsionamento — a plataforma não
      emite nota sequencial e o número é digitado à mão.
    Se o Python mudar o texto da origem/categoria e o site não, o anel vermelho
    do grafo e o chip do fornecedor voltam a marcar plataforma."""
    fonte_analises = (RAIZ / "src" / "analises.py").read_text(encoding="utf-8")
    exemplos_ts = (RAIZ / "site" / "src" / "lib" / "exemplos.ts").read_text(encoding="utf-8")

    assert f"ORIGEM_FINANCIAMENTO_COLETIVO = '{analises.ORIGEM_FINANCIAMENTO_COLETIVO}'" in CONSULTAS_TS
    assert "export const CONDICAO_DOACAO_DIRETA =" in CONSULTAS_TS
    corpo = CONSULTAS_TS.split("export const CONDICAO_DOACAO_DIRETA =", 1)[1].split(";", 1)[0]
    assert "<> '${ORIGEM_FINANCIAMENTO_COLETIVO}'" in corpo
    # as duas fichas que desenham o anel do "dinheiro que volta" usam a condição
    for pagina in ("candidato.tsx", "fornecedor.tsx"):
        fonte = (RAIZ / "site" / "src" / "pages" / pagina).read_text(encoding="utf-8")
        assert "CONDICAO_DOACAO_DIRETA" in fonte, f"{pagina} marca 'dinheiro que volta' sem excluir plataforma"
    # e a consulta pronta do console (texto puro, sem interpolação) leva o literal
    assert analises.ORIGEM_FINANCIAMENTO_COLETIVO in exemplos_ts

    assert f"CATEGORIA_IMPULSIONAMENTO = '{analises.CATEGORIA_IMPULSIONAMENTO}'" in CONSULTAS_TS
    numerado = CONSULTAS_TS.split("export const CONDICAO_DOCUMENTO_NUMERADO =", 1)[1].split(";", 1)[0]
    assert "COALESCE(DS_ORIGEM_DESPESA, '') <> '${CATEGORIA_IMPULSIONAMENTO}'" in numerado
    assert "COALESCE(DS_ORIGEM_DESPESA, '') <> '{CATEGORIA_IMPULSIONAMENTO}'" in fonte_analises


def test_cota_fefc_e_a_tabela_que_o_site_espera():
    """A ficha do partido lê `cota_fefc` (FEFC por gênero e cor) direto do
    parquet; o backend precisa publicar esse nome de tabela e essas colunas."""
    agregados_py = (RAIZ / "src" / "agregados.py").read_text(encoding="utf-8")
    exportar_py = (RAIZ / "src" / "exportar.py").read_text(encoding="utf-8")
    partido_tsx = (RAIZ / "site" / "src" / "pages" / "partido.tsx").read_text(encoding="utf-8")
    assert "CREATE OR REPLACE TABLE cota_fefc" in agregados_py
    assert "cota_fefc.parquet" in exportar_py
    assert "'cota_fefc'" in DUCKDB_TS
    for coluna in ("genero", "cor_raca", "candidatos_fefc", "fefc", "candidaturas"):
        assert coluna in partido_tsx, f"ficha do partido não lê a coluna {coluna} de cota_fefc"
    # o mesmo grupo de cor/raça nos dois lados da régua racial
    from src import agregados as ag
    for cor in ag.COR_RACA_NEGRA:
        assert f"'{cor}'" in partido_tsx


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


def test_essencia_do_backend_nao_regride_para_igualdade():
    """A essência do versionamento compara com IS NOT DISTINCT FROM: `NULL = NULL`
    não casa, e uma retransmissão com campo NULL viraria falsa remoção."""
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


def test_estado_atual_publicado_e_a_ultima_extracao_viva():
    """despesas_atual/receitas_atual (src/exportar.py) são a última extração
    viva com `valor` = VR × qt_linhas — o site lê o parquet, não deriva."""
    exportar_py = _normalizar((RAIZ / "src" / "exportar.py").read_text(encoding="utf-8"))
    for trecho in (
        "AS DOUBLE) * qt_linhas AS valor",
        "dt_ultima_extracao = (SELECT MAX(dt_ultima_extracao) FROM",
    ):
        assert trecho in exportar_py, f"recorte do estado atual ausente de exportar.py: '{trecho}'"


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
            VR_DESPESA_CONTRATADA VARCHAR, DT_DESPESA VARCHAR, NM_FORNECEDOR_RFB VARCHAR);
        CREATE TABLE receitas (DT_GERACAO VARCHAR, HH_GERACAO VARCHAR,
            SQ_CANDIDATO VARCHAR, NM_CANDIDATO VARCHAR, NR_CANDIDATO VARCHAR,
            SG_PARTIDO VARCHAR, DS_CARGO VARCHAR, SG_UF VARCHAR, SQ_RECEITA VARCHAR,
            NM_DOADOR VARCHAR, NR_CPF_CNPJ_DOADOR VARCHAR, DS_ORIGEM_RECEITA VARCHAR,
            VR_RECEITA VARCHAR, DT_RECEITA VARCHAR, NM_DOADOR_RFB VARCHAR);
    """)
    con.execute(
        "INSERT INTO despesas_contratadas VALUES ('20/08/2026','04:00:00','160001','F','1',"
        "'X','Dep','XX','1','FORN','11222333000144','BANDEIRA','100,00','15/08/2026','#NULO')")
    h.versionar(con)
    con.execute("DELETE FROM despesas_contratadas")
    con.execute(
        "INSERT INTO despesas_contratadas VALUES ('21/08/2026','04:00:00','160001','F','1',"
        "'X','Dep','XX','2','FORN','11222333000144','BANDEIRA','150,00','15/08/2026','#NULO')")
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


# --------------------------------------------------------------------------- #
# Servidor MCP (src/mcp/): o que ele espelha do site tem de bater
# --------------------------------------------------------------------------- #

def test_mcp_gate_cobre_os_verbos_do_console_menos_a_excecao_documentada():
    """VERBOS_LEITURA de sql-gate.ts x gate do MCP (parser do DuckDB). PIVOT e
    UNPIVOT são a exceção documentada: o parser os reescreve como CREATE +
    SELECT e o MCP os recusa — registrado aqui em vez de fingir paridade."""
    from src.mcp import gate

    gate_ts = (RAIZ / "site" / "src" / "lib" / "sql-gate.ts").read_text(encoding="utf-8")
    achado = re.search(r"VERBOS_LEITURA = /\^\(([a-z|]+)\)", gate_ts)
    assert achado, "VERBOS_LEITURA não encontrada em sql-gate.ts"
    verbos = set(achado.group(1).split("|"))
    excecao = {"pivot", "unpivot"}
    assert verbos == {"select", "with", "describe", "summarize", "show", "from"} | excecao
    exemplos = {
        "select": "SELECT 1", "with": "WITH a AS (SELECT 1) SELECT * FROM a",
        "describe": "DESCRIBE SELECT 1", "summarize": "SUMMARIZE SELECT 1 AS x",
        "show": "SHOW TABLES", "from": "FROM range(2)",
        "pivot": "PIVOT t ON a USING sum(b)", "unpivot": "UNPIVOT t ON a INTO NAME n VALUE v",
    }
    for verbo in verbos - excecao:
        assert gate.validar_leitura(exemplos[verbo])
    for verbo in excecao:
        import pytest

        with pytest.raises(gate.ConsultaRecusada, match="PIVOT"):
            gate.validar_leitura(exemplos[verbo])


def test_mcp_instructions_sao_o_prompt_do_console():
    """O modelo conectado ao MCP lê o MESMO contexto/tabelas/regras que o
    visitante cola na IA dele (prompt.ts) — mudou lá, mudou aqui."""
    from src.mcp import esquema

    prompt_ts = (RAIZ / "site" / "src" / "lib" / "prompt.ts").read_text(encoding="utf-8")
    texto = re.search(r"export const PROMPT_IA = `(.*?)`;", prompt_ts, re.DOTALL).group(1)
    compartilhado = esquema.trecho_compartilhado(texto)
    assert compartilhado.startswith("CONTEXTO:")
    assert "REGRAS OBRIGATÓRIAS" in compartilhado and "EXEMPLOS:" not in compartilhado
    assert compartilhado in esquema.instrucoes()
    # as tabelas que as ferramentas usam estão descritas para o modelo
    for tabela in ("despesas_atual", "receitas_atual", "despesas_removidas", "indicadores",
                   "benchmark_indicadores", "rede", "fornecedores", "cota_fefc"):
        assert tabela in compartilhado, f"prompt do console não descreve {tabela}"


def _resolver_template(ts: str, corpo: str) -> str:
    """Resolve ${CONST} de um template literal do consultas.ts pelas constantes
    do próprio arquivo (um nível basta para as condições das flags)."""
    consts = dict(re.findall(r"export const (\w+) = '([^']*)'", ts))
    consts["CONDICAO_DOCUMENTO_NAO_FISCAL"] = _resolver_bloco(ts, "CONDICAO_DOCUMENTO_NAO_FISCAL")
    for nome, valor in consts.items():
        corpo = corpo.replace("${" + nome + "}", valor)
    return corpo


def _resolver_bloco(ts: str, nome: str) -> str:
    """Concatena as partes `...` + `...` de uma constante de texto do TS."""
    corpo = ts.split(f"export const {nome} =", 1)[1].split(";", 1)[0]
    return "".join(re.findall(r"`([^`]*)`", corpo))


def test_mcp_reguas_por_nota_iguais_ao_site():
    """As condições das red flags 12/13 e o rótulo do documento em
    src/mcp/consultas.py são o mesmo SQL de consultas.ts, caractere a caractere
    após normalizar espaços — uma divergência marcaria nota de gente real."""
    from src.mcp import consultas as c

    for nome, do_mcp in (("CONDICAO_NOTA_SEM_NUMERO", c.CONDICAO_NOTA_SEM_NUMERO),
                         ("CONDICAO_DOCUMENTO_NUMERADO", c.CONDICAO_DOCUMENTO_NUMERADO),
                         ("CONDICAO_DOACAO_DIRETA", c.CONDICAO_DOACAO_DIRETA)):
        do_site = _resolver_template(CONSULTAS_TS, _resolver_bloco(CONSULTAS_TS, nome))
        assert _normalizar(do_site) == _normalizar(do_mcp), f"{nome} divergente entre site e MCP"

    assert f"MINIMO_NOTAS_VALOR_REPETIDO = {c.MINIMO_NOTAS_VALOR_REPETIDO};" in CONSULTAS_TS
    assert c.MARGEM_GASTO_ACIMA == resumo.MARGEM_GASTO_ACIMA

    corpo = CONSULTAS_TS.split("export function sqlDocumentoDaNota", 1)[1].split("\n}", 1)[0]
    do_site = re.search(r"return `(.*?)`;", corpo, re.DOTALL).group(1)
    do_site = do_site.replace("${num}", "COALESCE(NR_DOCUMENTO, '')").replace("${numero}", "NR_DOCUMENTO")
    do_site = do_site.replace("${tipo}", "DS_TIPO_DOCUMENTO")
    assert _normalizar(do_site) == _normalizar(c.sql_documento_da_nota())


def test_mcp_sinais_e_cte_iguais_ao_site():
    """SINAIS do MCP == SINAIS_FILTRO do site == METRICAS_SINAL do backend, e a
    CTE gerada carrega cada filtro de elegibilidade e o p95 com fallback BR-TODAS."""
    from src.mcp import consultas as c

    bloco = re.search(r"SINAIS_FILTRO = \[(.*?)\]", CONSULTAS_TS, re.DOTALL)
    assert re.findall(r"'([^']+)'", bloco.group(1)) == c.SINAIS
    cte = c.sinais_cte()
    for nome, _, filtro in resumo.METRICAS_SINAL:
        assert f"'{nome}'" in cte and filtro in cte
    assert "m.valor > COALESCE(buf.p95, bbr.p95)" in cte
    assert "LIKE 'pct_%'" not in cte


def test_mcp_compara_a_nota_com_a_regua_que_gerou_o_p95():
    """A unidade da nota tem UM dono: src/agregados.py. O benchmark de preço e
    a ferramenta que compara contra ele agrupam pela MESMA chave — senão o
    número comparado teria uma forma e a régua outra, sem ninguém perceber."""
    from src import agregados
    from src.mcp import consultas

    assert consultas.CHAVE_NOTA == ", ".join(agregados.CHAVE_NOTA)
    assert consultas.SEM_ID_DESPESA == agregados.SEM_ID_DESPESA
    sql = consultas.sql_notas_fora_do_preco("XX", None, None, None, None, 10)
    assert f"GROUP BY DS_ORIGEM_DESPESA, SG_UF, {', '.join(agregados.CHAVE_NOTA)}" in sql
    # a linha sem id não pode ser reagrupada: conta uma nota por linha
    assert f"WHERE SQ_DESPESA = '{agregados.SEM_ID_DESPESA}'" in sql

    fonte = (RAIZ / "src" / "agregados.py").read_text(encoding="utf-8")
    corpo = fonte[fonte.index("def _benchmark_precos"):fonte.index("def _indicadores")]
    sql_do_benchmark = corpo[corpo.index("CREATE OR REPLACE TABLE benchmark_precos"):]
    assert "{CHAVE_NOTA}" in sql_do_benchmark and "'-1'" not in sql_do_benchmark, (
        "benchmark_precos voltou a escrever a chave da nota à mão — a régua tem um dono só"
    )


def test_corte_de_infraestrutura_igual_no_front():
    """Contraparte que atende muita gente é infraestrutura, não vínculo: o corte
    do 2º nível do grafo (site) e o de candidatos_conectados (MCP) usam o MESMO
    teto. Medido em 07/09/2026: sem ele, uma única plataforma de anúncio põe os
    três maiores anunciantes do país no anel externo de qualquer ficha."""
    from src.mcp import consultas

    achado = re.search(r"MAX_CANDIDATOS_CONTRAPARTE_COMUM = (\d+);", CONSULTAS_TS)
    assert achado, "MAX_CANDIDATOS_CONTRAPARTE_COMUM não encontrada em consultas.ts"
    assert int(achado.group(1)) == consultas.MAX_CANDIDATOS_CONTRAPARTE_COMUM

    # as duas páginas do grafo aplicam o corte no 2º nível
    for pagina in ("candidato.tsx", "fornecedor.tsx"):
        fonte = (RAIZ / "site" / "src" / "pages" / pagina).read_text(encoding="utf-8")
        assert "sqlContrapartesInfraestrutura()" in fonte, (
            f"{pagina} não corta as contrapartes-infraestrutura no 2º nível")


def test_top_n_do_grafo_e_cap_de_desenho_que_o_mcp_nao_aplica():
    """A divergência que SOBRA entre site e MCP, registrada em vez de fingida:

    - site: além do corte de hub, mantém só os N maiores por contraparte
      (QUALIFY ROW_NUMBER()). É cap de DESENHO — o canvas não comporta mais.
    - MCP: não aplica o top-N. Para investigar ele seria nocivo, porque esconde
      quem divide fornecedor gastando POUCO, que é o padrão de rateio; quem
      consome a ferramenta lê uma lista, não um canvas.

    Mudou um dos dois lados, isto falha e força a decisão consciente.
    """
    from src.mcp import consultas

    for pagina in ("candidato.tsx", "fornecedor.tsx"):
        fonte = (RAIZ / "site" / "src" / "pages" / pagina).read_text(encoding="utf-8")
        assert re.search(
            r"QUALIFY ROW_NUMBER\(\) OVER \(PARTITION BY \w+ ORDER BY total DESC\) <= \d",
            fonte), f"{pagina} não usa mais o top-N por contraparte no 2º nível"

    sql = consultas.sql_candidatos_conectados("1", 2, consultas.TIPOS_REDE,
                                              consultas.MAX_CANDIDATOS_CONTRAPARTE_COMUM, 10)
    assert "QUALIFY" not in sql, "o MCP passou a aplicar o cap de desenho do site"
    assert f"HAVING COUNT(DISTINCT SQ_CANDIDATO) > {consultas.MAX_CANDIDATOS_CONTRAPARTE_COMUM}" in sql


def _docstrings_das_ferramentas() -> dict[str, str]:
    """Docstrings das tools lidas do FONTE de servidor.py, sem importá-lo.

    Importar puxaria o SDK `mcp`, que a imagem da rotina (Dockerfile) não
    instala nem precisa — e a suíte dela roda este arquivo (o --ignore-glob de
    lá só cobre tests/test_mcp_*.py). Este teste é sobre o TEXTO das docstrings,
    então o fonte basta e a garantia vale nas duas imagens.
    """
    arvore = ast.parse((RAIZ / "src" / "mcp" / "servidor.py").read_text(encoding="utf-8"))
    return {no.name: ast.get_docstring(no) or ""
            for no in ast.walk(arvore)
            if isinstance(no, (ast.FunctionDef, ast.AsyncFunctionDef))}


def test_ferramentas_de_recorte_nao_entregam_veredito():
    """As tools que devolvem "fora da curva" descrevem a medida e a régua; o
    julgamento fica com quem lê. Duas garantias mecânicas: nenhuma docstring
    promete irregularidade, e as instructions dizem ao modelo o que elas NÃO
    afirmam (o modelo pode concluir por conta própria — via sql, mostrando o
    cálculo — mas não emprestando rótulo da ferramenta)."""
    from src.mcp import esquema

    docs = _docstrings_das_ferramentas()

    veredito = re.compile(r"\b(fraude|fraudulent\w*|superfatur\w*|desvi(o|os|ado\w*)|"
                          r"irregularidade|suspeit\w+)\b", re.IGNORECASE)
    # a palavra vale como promessa quando é AFIRMADA; negar que a ferramenta a
    # detecta ("não classifica irregularidade") é exatamente o que se quer
    nega = re.compile(r"\b(não|nem|nenhum\w*|sem)\b", re.IGNORECASE)
    for nome in ("fora_da_curva", "notas_fora_do_preco", "sem_nota",
                 "fornecedores_compartilhados", "declaracoes_removidas",
                 "candidatos_conectados", "ficha_candidato", "ficha_fornecedor"):
        assert nome in docs, f"ferramenta {nome} não existe mais em servidor.py"
        doc = " ".join(docs[nome].split())
        for frase in re.split(r"(?<=[.;:])\s+", doc):
            achado = veredito.search(frase)
            assert not achado or nega.search(frase), (
                f"{nome} promete veredito na docstring: {frase!r}")

    instrucoes = esquema.instrucoes()
    assert "O QUE ESTAS FERRAMENTAS MEDEM" in instrucoes
    for exigido in ("5% do grupo", "Nenhuma delas classifica irregularidade",
                    "hipóteses próprias", "deixe o caminho à vista"):
        assert exigido in instrucoes, f"as instructions perderam: {exigido}"


def test_mcp_ferramentas_listadas_no_site_sao_as_do_servidor():
    """A página Consultar lista as ferramentas do MCP (FERRAMENTAS_MCP em
    site/src/lib/mcp.ts); ferramenta nova ou renomeada em src/mcp/servidor.py
    tem de aparecer lá — senão o site promete uma lista velha."""
    servidor = (RAIZ / "src" / "mcp" / "servidor.py").read_text(encoding="utf-8")
    no_servidor = set(re.findall(r"@mcp\.tool\([^)]*\)\s*async def (\w+)\(", servidor))
    mcp_ts = (RAIZ / "site" / "src" / "lib" / "mcp.ts").read_text(encoding="utf-8")
    bloco = mcp_ts[mcp_ts.index("FERRAMENTAS_MCP: FerramentaMCP[]"):]
    no_site = set(re.findall(r"nome: '(\w+)'", bloco))
    assert no_servidor, "nenhuma ferramenta encontrada em servidor.py (mudou o decorator?)"
    assert no_site == no_servidor, (
        f"faltam no site: {no_servidor - no_site}; sobram no site: {no_site - no_servidor}")


def test_busca_de_candidato_cobre_o_nome_de_urna_nos_dois_lados():
    """sqlBuscaCandidatos (site) e sql_buscar_candidato (MCP) partem do REGISTRO
    e casam pelos dois nomes.

    A divergência entre os dois é o bug que este teste tranca: o site buscava em
    `indicadores`/`despesas_atual` — que vêm da prestação e só têm NM_CANDIDATO —
    e o MCP em `candidatos`, que tem também NM_URNA_CANDIDATO. Metade das
    candidaturas com movimento usa na urna um nome que não está no nome civil
    ('JANE MARREE' para 'JANE APARECIDA DA SILVA'), e é por ele que o eleitor
    procura: quem tivesse nome de urna próprio simplesmente não existia no site.
    Partir de `indicadores` também escondia quem só declarou receita.
    """
    consultas_mcp = (RAIZ / "src" / "mcp" / "consultas.py").read_text(encoding="utf-8")

    corpo_site = re.search(
        r"export function sqlBuscaCandidatos\(.*?\n}", CONSULTAS_TS, re.DOTALL
    )
    assert corpo_site, "sqlBuscaCandidatos não encontrada em consultas.ts"
    corpo_mcp = re.search(
        r"def sql_buscar_candidato\(.*?\n(?=\n\n|# ---)", consultas_mcp, re.DOTALL
    )
    assert corpo_mcp, "sql_buscar_candidato não encontrada em src/mcp/consultas.py"

    for lado, corpo in (("site", corpo_site.group()), ("mcp", corpo_mcp.group())):
        assert "NM_URNA_CANDIDATO" in corpo, f"busca do {lado} deixou de casar o nome de urna"
        assert "candidatos" in corpo, f"busca do {lado} não parte do registro"
        # os totais vêm de indicadores (despesa OU receita), nunca de despesas
        assert "indicadores" in corpo, f"busca do {lado} não lê os totais de indicadores"

    # o site não pode voltar a excluir quem já movimentou: a lista tem de trazer
    # as duas situações e separá-las por tem_movimento
    assert "NOT IN (SELECT SQ_CANDIDATO FROM indicadores)" not in corpo_site.group()
    assert "tem_movimento" in corpo_site.group()

    # e o resto do Explorar (painel, tabela, fora-da-curva) filtra pela mesma
    # régua: todo filtro de nome sobre a prestação passa por condCandidato, que
    # chega ao nome de urna pelo registro
    cond = re.search(r"export function condCandidato\(.*?\n}", CONSULTAS_TS, re.DOTALL)
    assert cond and "NM_URNA_CANDIDATO" in cond.group()
    for fn in ("montarWhere", "whereIndicadores"):
        corpo = re.search(rf"export function {fn}\(.*?\n}}", CONSULTAS_TS, re.DOTALL)
        assert corpo, f"{fn} não encontrada em consultas.ts"
        assert "condCandidato(" in corpo.group(), f"{fn} filtra nome sem passar por condCandidato"


def test_view_nomes_urna_e_a_mesma_no_wasm_e_no_mcp():
    """As páginas mandam para a rota do site (src/mcp/api.py) o mesmo SQL que
    rodariam no navegador, e esse SQL faz LEFT JOIN nomes_urna: a view precisa
    existir com a MESMA definição nos dois executores (duckdb.ts e dados.py)."""
    from src.mcp import dados

    def normalizar(sql: str) -> str:
        return re.sub(r"\s+", " ", sql).strip()

    cheia = normalizar(dados.VIEW_NOMES_URNA)
    wasm = normalizar(DUCKDB_TS)
    assert cheia in wasm, f"duckdb.ts não define nomes_urna como o MCP: {cheia}"
