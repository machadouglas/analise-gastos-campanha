"""Versionamento das extrações: histórico do que estava declarado em cada dia.

Os arquivos do TSE são detalhados por ITEM de nota: SQ_DESPESA identifica a
despesa (nota), que se repete em vários itens — inclusive linhas 100% idênticas
(2 unidades do mesmo produto = 2 linhas iguais). Por isso o histórico é por
CONTEÚDO: cada combinação única de colunas vira uma linha com:

- qt_linhas: quantas vezes aparecia no arquivo;
- dt_primeira_extracao / dt_ultima_extracao: janela em que esteve declarada;
- hash_linha: identidade do conteúdo.

Se um conteúdo some (ou muda de quantidade), a linha antiga para de ser
atualizada — é o rastro de uma declaração removida ou alterada, algo
invisível no site do TSE. A data usada é a DT_GERACAO do próprio arquivo.
"""

from src.carga import filtro_placeholder

# tabelas versionadas -> coluna de pareamento p/ detectar alterações (id da nota)
TABELAS = {
    "despesas_contratadas": "SQ_DESPESA",
    "receitas": "SQ_RECEITA",
}

# "Essência" do fato declarado. Quando o candidato retransmite a prestação, o
# SPCE regenera os SQ_* e metadados — o conteúdo "some" e renasce com id novo.
# Uma remoção REAL é a que não reaparece com a mesma essência na extração atual.
ESSENCIA = {
    "despesas_contratadas": [
        "SQ_CANDIDATO", "NR_CPF_CNPJ_FORNECEDOR", "DS_DESPESA",
        "VR_DESPESA_CONTRATADA", "DT_DESPESA",
    ],
    "receitas": [
        "SQ_CANDIDATO", "NR_CPF_CNPJ_DOADOR", "DS_ORIGEM_RECEITA",
        "VR_RECEITA", "DT_RECEITA",
    ],
}

# metadados do arquivo, não do fato declarado — ficam fora do histórico e do hash
COLUNAS_VOLATEIS = {"DT_GERACAO", "HH_GERACAO"}

# (contraparte, valor) por tabela — para excluir linhas-placeholder das views de
# mudanças (o SPCE troca o placeholder pela primeira declaração real; isso não é
# uma remoção de fato declarado)
CONTRAPARTE = {
    "despesas_contratadas": ("NR_CPF_CNPJ_FORNECEDOR", "VR_DESPESA_CONTRATADA"),
    "receitas": ("NR_CPF_CNPJ_DOADOR", "VR_RECEITA"),
}


def _colunas(con, tabela):
    return [
        r[0] for r in con.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = ? ORDER BY ordinal_position", [tabela]
        ).fetchall() if r[0] not in COLUNAS_VOLATEIS
    ]


def versionar(con) -> None:
    """Aplica a extração corrente (tabelas brutas) sobre as tabelas hist_*."""
    con.execute("CREATE TABLE IF NOT EXISTS extracoes (dt_extracao DATE)")
    for tabela in TABELAS:
        hist = f"hist_{tabela}"
        cols = _colunas(con, tabela)
        lista = ", ".join(cols)

        # o hist_* existe mesmo com a fonte vazia: os agregados dependem dele
        con.execute(f"""
            CREATE TABLE IF NOT EXISTS {hist} AS
            SELECT {lista}, CAST(NULL AS VARCHAR) AS hash_linha,
                   CAST(NULL AS BIGINT) AS qt_linhas,
                   CAST(NULL AS DATE) AS dt_primeira_extracao,
                   CAST(NULL AS DATE) AS dt_ultima_extracao
            FROM {tabela} WHERE 1=0
        """)
        dt = con.execute(
            f"SELECT MAX(TRY_CAST(STRPTIME(DT_GERACAO, '%d/%m/%Y') AS DATE)) FROM {tabela}"
        ).fetchone()[0]
        if dt is None:
            print(f"[aviso] {tabela} vazia — nada a versionar")
            continue
        con.execute(f"""
            CREATE OR REPLACE TEMP TABLE stg AS
            SELECT {lista}, md5(concat_ws('|', {lista})) AS hash_linha,
                   COUNT(*) AS qt_linhas
            FROM {tabela} GROUP BY ALL
        """)
        # conteúdo idêntico (mesmo hash e mesma quantidade) continua vivo
        con.execute(f"""
            UPDATE {hist} h SET dt_ultima_extracao = ?
            FROM stg s
            WHERE h.hash_linha = s.hash_linha AND h.qt_linhas = s.qt_linhas
        """, [dt])
        # A última extração de um mesmo dia vence (o TSE regenera o arquivo ao
        # longo do dia): conteúdo marcado como vivo em `dt` mas ausente do
        # arquivo atual nasceu-e-sumiu dentro do dia (sai do histórico: não
        # houve dia em que tenha ficado declarado) ou volta a morrer na
        # extração anterior.
        sem_par = ("h.dt_ultima_extracao = ? AND NOT EXISTS "
                   "(SELECT 1 FROM stg s WHERE s.hash_linha = h.hash_linha "
                   "AND s.qt_linhas = h.qt_linhas)")
        con.execute(
            f"DELETE FROM {hist} h WHERE h.dt_primeira_extracao = ? AND {sem_par}",
            [dt, dt],
        )
        anterior = con.execute(
            "SELECT MAX(dt_extracao) FROM extracoes WHERE dt_extracao < ?", [dt]
        ).fetchone()[0]
        if anterior is not None:
            con.execute(
                f"UPDATE {hist} h SET dt_ultima_extracao = ? WHERE {sem_par}",
                [anterior, dt],
            )
        # conteúdo novo (ou com quantidade alterada) vira linha nova no histórico
        novas = con.execute(f"""
            INSERT INTO {hist}
            SELECT s.*, ?, ? FROM stg s
            WHERE NOT EXISTS (SELECT 1 FROM {hist} h
                              WHERE h.hash_linha = s.hash_linha
                                AND h.qt_linhas = s.qt_linhas
                                AND h.dt_ultima_extracao = ?)
        """, [dt, dt, dt]).fetchone()[0]

        removidas = con.execute(f"""
            SELECT COUNT(*) FROM (
                SELECT hash_linha FROM {hist}
                QUALIFY MAX(dt_ultima_extracao) OVER (PARTITION BY hash_linha) < ?)
        """, [dt]).fetchone()[0]
        print(f"[historico] {hist} @ {dt}: {novas} conteúdos novos, {removidas} sem correspondência atual")

    _registrar_extracao(con)
    _criar_views_mudancas(con)


def _registrar_extracao(con) -> None:
    """Registro de todos os dias de extração já vistos (a série diária precisa
    deles: dias sem mudança não deixam rastro próprio nas tabelas hist_*)."""
    con.execute("CREATE TABLE IF NOT EXISTS extracoes (dt_extracao DATE)")
    existentes = [
        f"hist_{t}" for t in TABELAS
        if con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ?",
                       [f"hist_{t}"]).fetchone()[0]
    ]
    if not existentes:
        return
    uniao = " UNION ".join(
        f"SELECT dt_primeira_extracao AS dt FROM {h} UNION SELECT dt_ultima_extracao FROM {h}"
        for h in existentes
    )
    con.execute(f"""
        INSERT INTO extracoes
        SELECT dt FROM ({uniao})
        WHERE dt IS NOT NULL AND dt NOT IN (SELECT dt_extracao FROM extracoes)
    """)


def _criar_views_mudancas(con) -> None:
    for tabela, sq in TABELAS.items():
        hist = f"hist_{tabela}"
        if not con.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [hist]
        ).fetchone()[0]:
            continue
        essencia = " AND ".join(f"v.{c} = m.{c}" for c in ESSENCIA[tabela])
        contraparte, valor = CONTRAPARTE[tabela]
        # conteúdo que estava declarado e não está mais, SEM correspondente de
        # mesma essência na extração atual (filtra o re-registro em massa do
        # SPCE) e SEM linhas-placeholder (prestação sem movimento)
        con.execute(f"""
            CREATE OR REPLACE VIEW v_removidas_{tabela} AS
            WITH ultima AS (SELECT MAX(dt_ultima_extracao) AS dt FROM {hist}),
            mortas AS (
                SELECT h.* FROM {hist} h, ultima
                QUALIFY MAX(h.dt_ultima_extracao) OVER (PARTITION BY h.hash_linha) < ultima.dt),
            vivas AS (
                SELECT h.* FROM {hist} h, ultima WHERE h.dt_ultima_extracao = ultima.dt)
            SELECT m.* FROM mortas m
            WHERE {filtro_placeholder(f'm.{contraparte}', f'm.{valor}')}
              AND NOT EXISTS (SELECT 1 FROM vivas v WHERE {essencia})
        """)
        # notas (SQ) com versão antiga sem essência atual + versão nova: provável edição
        con.execute(f"""
            CREATE OR REPLACE VIEW v_alteradas_{tabela} AS
            WITH ultima AS (SELECT MAX(dt_ultima_extracao) AS dt FROM {hist})
            SELECT h.* FROM {hist} h, ultima
            WHERE h.{sq} <> '-1'
              AND h.{sq} IN (SELECT {sq} FROM v_removidas_{tabela})
              AND h.{sq} IN (SELECT {sq} FROM {hist}, ultima WHERE dt_primeira_extracao = ultima.dt)
            ORDER BY h.{sq}, h.dt_primeira_extracao
        """)


def resumo_mudancas(con):
    """DataFrames com removidas e alteradas de cada tabela versionada."""
    saida = []
    for tabela in TABELAS:
        for tipo in ("removidas", "alteradas"):
            df = con.execute(f"SELECT * FROM v_{tipo}_{tabela}").df()
            saida.append((f"{tipo} em {tabela}", df))
    return saida
