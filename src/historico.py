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

# tabelas versionadas -> coluna de pareamento p/ detectar alterações (id da nota)
TABELAS = {
    "despesas_contratadas": "SQ_DESPESA",
    "receitas": "SQ_RECEITA",
}

# metadados do arquivo, não do fato declarado — ficam fora do histórico e do hash
COLUNAS_VOLATEIS = {"DT_GERACAO", "HH_GERACAO"}


def _colunas(con, tabela):
    return [
        r[0] for r in con.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = ? ORDER BY ordinal_position", [tabela]
        ).fetchall() if r[0] not in COLUNAS_VOLATEIS
    ]


def versionar(con) -> None:
    """Aplica a extração corrente (tabelas brutas) sobre as tabelas hist_*."""
    for tabela, sq in TABELAS.items():
        hist = f"hist_{tabela}"
        dt = con.execute(
            f"SELECT MAX(TRY_CAST(STRPTIME(DT_GERACAO, '%d/%m/%Y') AS DATE)) FROM {tabela}"
        ).fetchone()[0]
        if dt is None:
            print(f"[aviso] {tabela} vazia — nada a versionar")
            continue
        cols = _colunas(con, tabela)
        lista = ", ".join(cols)

        con.execute(f"""
            CREATE TABLE IF NOT EXISTS {hist} AS
            SELECT {lista}, CAST(NULL AS VARCHAR) AS hash_linha,
                   CAST(NULL AS BIGINT) AS qt_linhas,
                   CAST(NULL AS DATE) AS dt_primeira_extracao,
                   CAST(NULL AS DATE) AS dt_ultima_extracao
            FROM {tabela} WHERE 1=0
        """)
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

    _criar_views_mudancas(con)


def _criar_views_mudancas(con) -> None:
    for tabela, sq in TABELAS.items():
        hist = f"hist_{tabela}"
        # conteúdo que estava declarado e não está mais (removido ou alterado)
        con.execute(f"""
            CREATE OR REPLACE VIEW v_removidas_{tabela} AS
            WITH ultima AS (SELECT MAX(dt_ultima_extracao) AS dt FROM {hist})
            SELECT h.* FROM {hist} h, ultima
            QUALIFY MAX(h.dt_ultima_extracao) OVER (PARTITION BY h.hash_linha) < ultima.dt
        """)
        # notas (SQ) com versões antes e depois: provável edição da declaração
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
