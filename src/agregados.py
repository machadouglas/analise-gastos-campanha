"""Tabelas materializadas que alimentam o site: série diária, benchmark de
preços, scorecard de indícios e rede de relações. Rodam após cada carga.

Tudo é derivado; recriar é sempre seguro.
"""

VALOR_DESPESA = "TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE)"
VALOR_RECEITA = "TRY_CAST(REPLACE(VR_RECEITA, ',', '.') AS DOUBLE)"


def materializar(con) -> None:
    _serie_diaria(con)
    _benchmark_precos(con)
    _indicadores(con)
    _rede(con)


def _serie_diaria(con) -> None:
    """Reconstrói, para cada dia de extração, o total declarado por candidato
    (conteúdo vivo no dia = dt_primeira <= dia <= dt_ultima)."""
    con.execute(f"""
        CREATE OR REPLACE TABLE serie_diaria AS
        WITH dias AS (SELECT DISTINCT dt_extracao FROM extracoes),
        desp AS (
            SELECT d.dt_extracao, h.SQ_CANDIDATO,
                   ANY_VALUE(h.NM_CANDIDATO) AS NM_CANDIDATO,
                   ANY_VALUE(h.NR_CANDIDATO) AS NR_CANDIDATO,
                   ANY_VALUE(h.SG_PARTIDO) AS SG_PARTIDO,
                   ANY_VALUE(h.DS_CARGO) AS DS_CARGO,
                   ANY_VALUE(h.SG_UF) AS SG_UF,
                   ROUND(SUM({VALOR_DESPESA} * h.qt_linhas), 2) AS total_contratado,
                   SUM(h.qt_linhas) AS itens_despesa
            FROM dias d
            JOIN hist_despesas_contratadas h
              ON h.dt_primeira_extracao <= d.dt_extracao
             AND h.dt_ultima_extracao >= d.dt_extracao
            GROUP BY 1, 2),
        rec AS (
            SELECT d.dt_extracao, h.SQ_CANDIDATO,
                   ROUND(SUM({VALOR_RECEITA} * h.qt_linhas), 2) AS total_receitas
            FROM dias d
            JOIN hist_receitas h
              ON h.dt_primeira_extracao <= d.dt_extracao
             AND h.dt_ultima_extracao >= d.dt_extracao
            GROUP BY 1, 2)
        SELECT COALESCE(desp.dt_extracao, rec.dt_extracao) AS dt_extracao,
               COALESCE(desp.SQ_CANDIDATO, rec.SQ_CANDIDATO) AS SQ_CANDIDATO,
               desp.NM_CANDIDATO, desp.NR_CANDIDATO, desp.SG_PARTIDO,
               desp.DS_CARGO, desp.SG_UF,
               COALESCE(desp.total_contratado, 0) AS total_contratado,
               COALESCE(desp.itens_despesa, 0) AS itens_despesa,
               COALESCE(rec.total_receitas, 0) AS total_receitas
        FROM desp
        FULL JOIN rec ON desp.dt_extracao = rec.dt_extracao
                     AND desp.SQ_CANDIDATO = rec.SQ_CANDIDATO
    """)
    n = con.execute("SELECT COUNT(*) FROM serie_diaria").fetchone()[0]
    print(f"[agregado] serie_diaria: {n} linhas")


def _benchmark_precos(con) -> None:
    """Distribuição de preços por categoria de gasto, por UF e nacional ('BR-TODAS')."""
    con.execute("""
        CREATE OR REPLACE TABLE benchmark_precos AS
        WITH base AS (
            SELECT DS_ORIGEM_DESPESA, SG_UF, VR FROM v_despesas
            WHERE VR IS NOT NULL AND VR > 0 AND DS_ORIGEM_DESPESA <> '#NULO'),
        ambito AS (
            SELECT DS_ORIGEM_DESPESA, SG_UF, VR FROM base
            UNION ALL
            SELECT DS_ORIGEM_DESPESA, 'BR-TODAS', VR FROM base)
        SELECT DS_ORIGEM_DESPESA, SG_UF,
               COUNT(*) AS notas,
               ROUND(QUANTILE_CONT(VR, 0.25), 2) AS p25,
               ROUND(MEDIAN(VR), 2) AS mediana,
               ROUND(QUANTILE_CONT(VR, 0.75), 2) AS p75,
               ROUND(QUANTILE_CONT(VR, 0.95), 2) AS p95,
               ROUND(MAX(VR), 2) AS maximo
        FROM ambito
        GROUP BY 1, 2
        HAVING notas >= 5
    """)
    n = con.execute("SELECT COUNT(*) FROM benchmark_precos").fetchone()[0]
    print(f"[agregado] benchmark_precos: {n} combinações categoria×UF")


def _indicadores(con) -> None:
    """Scorecard de indícios por candidato — fatos contáveis, nunca acusações."""
    tem_fornecedores = con.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'fornecedores'"
    ).fetchone()[0]
    recem = (
        """LEFT JOIN (
              SELECT d.SQ_CANDIDATO, COUNT(DISTINCT f.cnpj) AS n
              FROM v_despesas d JOIN fornecedores f ON d.NR_CPF_CNPJ_FORNECEDOR = f.cnpj
              WHERE f.data_abertura >= '2025-10-01'
              GROUP BY 1) recem USING (SQ_CANDIDATO)"""
        if tem_fornecedores else "LEFT JOIN (SELECT NULL AS SQ_CANDIDATO, NULL AS n) recem USING (SQ_CANDIDATO)"
    )
    con.execute(f"""
        CREATE OR REPLACE TABLE indicadores AS
        WITH tot AS (
            SELECT SQ_CANDIDATO,
                   ANY_VALUE(NM_CANDIDATO) AS NM_CANDIDATO, ANY_VALUE(NR_CANDIDATO) AS NR_CANDIDATO,
                   ANY_VALUE(SG_PARTIDO) AS SG_PARTIDO, ANY_VALUE(DS_CARGO) AS DS_CARGO,
                   ANY_VALUE(SG_UF) AS SG_UF,
                   ROUND(SUM(VR), 2) AS total_contratado, COUNT(*) AS itens
            FROM v_despesas GROUP BY 1),
        rec AS (SELECT SQ_CANDIDATO, ROUND(SUM(VR), 2) AS total_receitas FROM v_receitas GROUP BY 1),
        forn AS (
            SELECT SQ_CANDIDATO,
                   ROUND(100.0 * MAX(total_forn) / NULLIF(SUM(total_forn), 0), 1) AS pct_maior_fornecedor,
                   COUNT(*) AS n_fornecedores
            FROM (SELECT SQ_CANDIDATO, NR_CPF_CNPJ_FORNECEDOR, SUM(VR) AS total_forn
                  FROM v_despesas GROUP BY 1, 2)
            GROUP BY 1),
        sem_nota AS (
            SELECT SQ_CANDIDATO, ROUND(SUM(VR), 2) AS valor_sem_nota FROM v_despesas
            WHERE DS_TIPO_DOCUMENTO IS NULL OR DS_TIPO_DOCUMENTO = '#NULO'
               OR DS_TIPO_DOCUMENTO NOT ILIKE '%nota fiscal%'
            GROUP BY 1),
        pf AS (
            SELECT SQ_CANDIDATO, ROUND(SUM(VR), 2) AS valor_pessoa_fisica FROM v_despesas
            WHERE DS_TIPO_FORNECEDOR ILIKE '%f_sica%' GROUP BY 1),
        rep AS (
            SELECT SQ_CANDIDATO, COUNT(*) AS grupos_valor_repetido
            FROM (SELECT SQ_CANDIDATO, VR FROM v_despesas GROUP BY 1, 2 HAVING COUNT(*) >= 3)
            GROUP BY 1),
        removidas AS (
            SELECT SQ_CANDIDATO, ROUND(SUM({VALOR_DESPESA} * qt_linhas), 2) AS valor_removido
            FROM v_removidas_despesas_contratadas GROUP BY SQ_CANDIDATO)
        SELECT tot.*, rec.total_receitas,
               ROUND(tot.total_contratado / NULLIF(rec.total_receitas, 0), 2) AS razao_gasto_receita,
               forn.pct_maior_fornecedor, forn.n_fornecedores,
               COALESCE(sem_nota.valor_sem_nota, 0) AS valor_sem_nota,
               COALESCE(pf.valor_pessoa_fisica, 0) AS valor_pessoa_fisica,
               COALESCE(rep.grupos_valor_repetido, 0) AS grupos_valor_repetido,
               COALESCE(removidas.valor_removido, 0) AS valor_removido,
               COALESCE(recem.n, 0) AS fornecedores_recem_abertos
        FROM tot
        LEFT JOIN rec USING (SQ_CANDIDATO)
        LEFT JOIN forn USING (SQ_CANDIDATO)
        LEFT JOIN sem_nota USING (SQ_CANDIDATO)
        LEFT JOIN pf USING (SQ_CANDIDATO)
        LEFT JOIN rep USING (SQ_CANDIDATO)
        LEFT JOIN removidas USING (SQ_CANDIDATO)
        {recem}
    """)
    n = con.execute("SELECT COUNT(*) FROM indicadores").fetchone()[0]
    print(f"[agregado] indicadores: {n} candidatos")


def _rede(con) -> None:
    """Arestas agregadas: quem paga e quem doa para cada candidato."""
    con.execute(f"""
        CREATE OR REPLACE TABLE rede AS
        SELECT 'despesa' AS tipo,
               NR_CPF_CNPJ_FORNECEDOR AS contraparte_id,
               COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR) AS contraparte,
               SQ_CANDIDATO, NR_CANDIDATO, NM_CANDIDATO, SG_PARTIDO, DS_CARGO, SG_UF,
               ROUND(SUM(VR), 2) AS valor, COUNT(*) AS itens
        FROM v_despesas GROUP BY ALL
        UNION ALL
        SELECT 'doacao', NR_CPF_CNPJ_DOADOR,
               COALESCE(NULLIF(NM_DOADOR_RFB, '#NULO'), NM_DOADOR),
               SQ_CANDIDATO, NR_CANDIDATO, NM_CANDIDATO, SG_PARTIDO, DS_CARGO, SG_UF,
               ROUND(SUM(VR), 2), COUNT(*)
        FROM v_receitas GROUP BY ALL
        UNION ALL
        SELECT 'doacao_originaria', o.NR_CPF_CNPJ_DOADOR_ORIGINARIO,
               COALESCE(NULLIF(o.NM_DOADOR_ORIGINARIO_RFB, '#NULO'), o.NM_DOADOR_ORIGINARIO),
               p.SQ_CANDIDATO, p.NR_CANDIDATO, p.NM_CANDIDATO, p.SG_PARTIDO, p.DS_CARGO, p.SG_UF,
               ROUND(SUM(TRY_CAST(REPLACE(o.VR_RECEITA, ',', '.') AS DOUBLE)), 2), COUNT(*)
        FROM receitas_doador_originario o
        JOIN v_prestadores p USING (SQ_PRESTADOR_CONTAS)
        GROUP BY ALL
    """)
    n = con.execute("SELECT COUNT(*) FROM rede").fetchone()[0]
    print(f"[agregado] rede: {n} arestas")
