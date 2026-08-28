"""Tabelas materializadas que alimentam o site: série diária, benchmark de
preços, scorecard de indícios, benchmark de indicadores por grupo de
comparação (cargo×UF) e rede de relações. Rodam após cada carga.

Tudo é derivado; recriar é sempre seguro.
"""

from src.analises import SQL_CATEGORIAS_SEM_NOTA_ESPERADA

VALOR_DESPESA = "TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA, ',', '.') AS DOUBLE)"
VALOR_RECEITA = "TRY_CAST(REPLACE(VR_RECEITA, ',', '.') AS DOUBLE)"

# tamanho mínimo do grupo de comparação: percentis de grupos menores não são
# fatos estáveis o bastante para sustentar um "fora da curva"
MIN_GRUPO_COMPARACAO = 20


def materializar(con) -> None:
    _serie_diaria(con)
    _benchmark_precos(con)
    _indicadores(con)
    _benchmark_indicadores(con)
    _rede(con)


def _tem(con, nome: str) -> bool:
    return bool(con.execute("""
        SELECT (SELECT count(*) FROM information_schema.tables WHERE table_name = ?)
             + (SELECT count(*) FROM duckdb_views() WHERE view_name = ?)
    """, [nome, nome]).fetchone()[0])


def _ano_eleicao(con):
    """Ano da eleição derivado das datas declaradas (nada de constante fixa)."""
    return con.execute("""
        SELECT MAX(ano) FROM (
            SELECT MAX(EXTRACT(year FROM DT)) AS ano FROM v_despesas
            UNION ALL
            SELECT MAX(EXTRACT(year FROM DT)) FROM v_receitas)
    """).fetchone()[0]


def _serie_diaria(con) -> None:
    """Reconstrói, para cada dia de extração, o total declarado por candidato
    (conteúdo vivo no dia = dt_primeira <= dia <= dt_ultima). Os metadados vêm
    de despesas OU receitas: candidato que só arrecadou não pode ficar sem
    partido/UF na série (a ficha do partido filtra por SG_PARTIDO)."""
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
                   ANY_VALUE(h.NM_CANDIDATO) AS NM_CANDIDATO,
                   ANY_VALUE(h.NR_CANDIDATO) AS NR_CANDIDATO,
                   ANY_VALUE(h.SG_PARTIDO) AS SG_PARTIDO,
                   ANY_VALUE(h.DS_CARGO) AS DS_CARGO,
                   ANY_VALUE(h.SG_UF) AS SG_UF,
                   ROUND(SUM({VALOR_RECEITA} * h.qt_linhas), 2) AS total_receitas
            FROM dias d
            JOIN hist_receitas h
              ON h.dt_primeira_extracao <= d.dt_extracao
             AND h.dt_ultima_extracao >= d.dt_extracao
            GROUP BY 1, 2)
        SELECT COALESCE(desp.dt_extracao, rec.dt_extracao) AS dt_extracao,
               COALESCE(desp.SQ_CANDIDATO, rec.SQ_CANDIDATO) AS SQ_CANDIDATO,
               COALESCE(desp.NM_CANDIDATO, rec.NM_CANDIDATO) AS NM_CANDIDATO,
               COALESCE(desp.NR_CANDIDATO, rec.NR_CANDIDATO) AS NR_CANDIDATO,
               COALESCE(desp.SG_PARTIDO, rec.SG_PARTIDO) AS SG_PARTIDO,
               COALESCE(desp.DS_CARGO, rec.DS_CARGO) AS DS_CARGO,
               COALESCE(desp.SG_UF, rec.SG_UF) AS SG_UF,
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
    """Distribuição de preços por categoria de gasto, por UF e nacional ('BR-TODAS').

    A unidade é a NOTA (soma dos itens de mesma SQ_DESPESA do candidato na
    categoria), não o item: os arquivos do TSE fatiam notas em itens, e uma
    nota fatiada em 50 linhas baratas puxaria os percentis para baixo —
    exatamente o efeito de quem fraciona. SQ_DESPESA = '-1' (sem id) não
    permite reagrupar: cada linha conta como uma nota."""
    con.execute("""
        CREATE OR REPLACE TABLE benchmark_precos AS
        WITH base AS (
            SELECT DS_ORIGEM_DESPESA, SG_UF, SUM(VR) AS VR
            FROM v_despesas
            WHERE VR IS NOT NULL AND VR > 0 AND DS_ORIGEM_DESPESA <> '#NULO'
              AND SQ_DESPESA <> '-1'
            GROUP BY DS_ORIGEM_DESPESA, SG_UF, SQ_CANDIDATO, SQ_DESPESA
            UNION ALL
            SELECT DS_ORIGEM_DESPESA, SG_UF, VR
            FROM v_despesas
            WHERE VR IS NOT NULL AND VR > 0 AND DS_ORIGEM_DESPESA <> '#NULO'
              AND SQ_DESPESA = '-1'),
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
    """Scorecard de indícios por candidato — fatos contáveis, nunca acusações.
    A base é quem movimentou qualquer coisa (despesa OU receita)."""
    ano = _ano_eleicao(con)
    # empresa aberta a partir de outubro do ano anterior à eleição = "às vésperas"
    corte_abertura = f"{int(ano) - 1}-10-01" if ano else None

    tem_fornecedores = _tem(con, "fornecedores")
    recem = (
        f"""LEFT JOIN (
              SELECT d.SQ_CANDIDATO, COUNT(DISTINCT f.cnpj) AS n
              FROM v_despesas d JOIN fornecedores f ON d.NR_CPF_CNPJ_FORNECEDOR = f.cnpj
              WHERE f.data_abertura >= '{corte_abertura}'
              GROUP BY 1) recem USING (SQ_CANDIDATO)"""
        if tem_fornecedores and corte_abertura
        else "LEFT JOIN (SELECT NULL AS SQ_CANDIDATO, NULL AS n) recem USING (SQ_CANDIDATO)"
    )
    # cobertura do enriquecimento: sem ela, "0 recém-abertos" seria ambíguo
    # (nunca consultado × consultado e sem indício)
    consultados = (
        """LEFT JOIN (
              SELECT d.SQ_CANDIDATO,
                     COUNT(DISTINCT d.NR_CPF_CNPJ_FORNECEDOR) AS cnpjs,
                     COUNT(DISTINCT CASE WHEN f.cnpj IS NOT NULL
                                         THEN d.NR_CPF_CNPJ_FORNECEDOR END) AS ok
              FROM v_despesas d LEFT JOIN fornecedores f ON d.NR_CPF_CNPJ_FORNECEDOR = f.cnpj
              WHERE LENGTH(d.NR_CPF_CNPJ_FORNECEDOR) = 14
              GROUP BY 1) cons USING (SQ_CANDIDATO)"""
        if tem_fornecedores else
        """LEFT JOIN (
              SELECT SQ_CANDIDATO, COUNT(DISTINCT NR_CPF_CNPJ_FORNECEDOR) AS cnpjs, 0 AS ok
              FROM v_despesas WHERE LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 14
              GROUP BY 1) cons USING (SQ_CANDIDATO)"""
    )
    bens = (
        "LEFT JOIN (SELECT SQ_CANDIDATO, ROUND(SUM(VR), 2) AS total_bens FROM v_bens GROUP BY 1) bens USING (SQ_CANDIDATO)"
        if _tem(con, "v_bens")
        else "LEFT JOIN (SELECT NULL AS SQ_CANDIDATO, CAST(NULL AS DOUBLE) AS total_bens) bens USING (SQ_CANDIDATO)"
    )
    pagas = (
        "LEFT JOIN (SELECT SQ_CANDIDATO, ROUND(SUM(VR), 2) AS total_pago FROM v_despesas_pagas WHERE SQ_CANDIDATO IS NOT NULL GROUP BY 1) pagas USING (SQ_CANDIDATO)"
        if _tem(con, "v_despesas_pagas")
        else "LEFT JOIN (SELECT NULL AS SQ_CANDIDATO, CAST(NULL AS DOUBLE) AS total_pago) pagas USING (SQ_CANDIDATO)"
    )

    con.execute(f"""
        CREATE OR REPLACE TABLE indicadores AS
        WITH cand AS (
            -- quem movimentou: despesa OU receita (só-receita também é fato)
            SELECT SQ_CANDIDATO,
                   ANY_VALUE(NM_CANDIDATO) AS NM_CANDIDATO, ANY_VALUE(NR_CANDIDATO) AS NR_CANDIDATO,
                   ANY_VALUE(SG_PARTIDO) AS SG_PARTIDO, ANY_VALUE(DS_CARGO) AS DS_CARGO,
                   ANY_VALUE(SG_UF) AS SG_UF
            FROM (SELECT SQ_CANDIDATO, NM_CANDIDATO, NR_CANDIDATO, SG_PARTIDO, DS_CARGO, SG_UF FROM v_despesas
                  UNION ALL
                  SELECT SQ_CANDIDATO, NM_CANDIDATO, NR_CANDIDATO, SG_PARTIDO, DS_CARGO, SG_UF FROM v_receitas)
            GROUP BY 1),
        tot AS (
            SELECT SQ_CANDIDATO, ROUND(SUM(VR), 2) AS total_contratado, COUNT(*) AS itens
            FROM v_despesas GROUP BY 1),
        rec AS (
            SELECT SQ_CANDIDATO, ROUND(SUM(VR), 2) AS total_receitas,
                   ROUND(SUM(CASE WHEN DS_FONTE_RECEITA ILIKE 'FUNDO%' THEN VR ELSE 0 END), 2) AS fundos_publicos,
                   ROUND(SUM(CASE WHEN DS_ORIGEM_RECEITA ILIKE '%pr_prio%' THEN VR ELSE 0 END), 2) AS recursos_proprios
            FROM v_receitas GROUP BY 1),
        forn AS (
            SELECT SQ_CANDIDATO,
                   ROUND(100.0 * MAX(total_forn) / NULLIF(SUM(total_forn), 0), 1) AS pct_maior_fornecedor,
                   COUNT(*) AS n_fornecedores
            FROM (SELECT SQ_CANDIDATO, NR_CPF_CNPJ_FORNECEDOR, SUM(VR) AS total_forn
                  FROM v_despesas GROUP BY 1, 2)
            GROUP BY 1),
        sem_nota AS (
            -- categorias sem documento fiscal esperado ficam de fora (ver analises.py)
            SELECT SQ_CANDIDATO, ROUND(SUM(VR), 2) AS valor_sem_nota FROM v_despesas
            WHERE (DS_TIPO_DOCUMENTO IS NULL OR DS_TIPO_DOCUMENTO = '#NULO'
                   OR DS_TIPO_DOCUMENTO NOT ILIKE '%nota fiscal%')
              AND DS_ORIGEM_DESPESA NOT IN ({SQL_CATEGORIAS_SEM_NOTA_ESPERADA})
            GROUP BY 1),
        pf AS (
            SELECT SQ_CANDIDATO, ROUND(SUM(VR), 2) AS valor_pessoa_fisica FROM v_despesas
            WHERE DS_TIPO_FORNECEDOR ILIKE '%f_sica%' GROUP BY 1),
        rep AS (
            -- fracionamento clássico: mesmo valor, mesmo fornecedor, notas distintas.
            -- Itens repetidos da MESMA nota são legítimos; valores iguais em
            -- fornecedores diferentes (diárias, cachês tabelados) também.
            SELECT SQ_CANDIDATO, COUNT(*) AS grupos_valor_repetido
            FROM (SELECT SQ_CANDIDATO, NR_CPF_CNPJ_FORNECEDOR, VR
                  FROM v_despesas GROUP BY 1, 2, 3
                  HAVING COUNT(DISTINCT SQ_DESPESA) >= 3)
            GROUP BY 1),
        removidas AS (
            SELECT SQ_CANDIDATO, ROUND(SUM({VALOR_DESPESA} * qt_linhas), 2) AS valor_removido
            FROM v_removidas_despesas_contratadas GROUP BY SQ_CANDIDATO)
        SELECT cand.*,
               COALESCE(tot.total_contratado, 0) AS total_contratado,
               COALESCE(tot.itens, 0) AS itens,
               rec.total_receitas,
               pagas.total_pago,
               ROUND(100.0 * pagas.total_pago / NULLIF(tot.total_contratado, 0), 1) AS pct_pago,
               ROUND(COALESCE(tot.total_contratado, 0) / NULLIF(rec.total_receitas, 0), 2) AS razao_gasto_receita,
               COALESCE(rec.fundos_publicos, 0) AS fundos_publicos,
               ROUND(100.0 * rec.fundos_publicos / NULLIF(rec.total_receitas, 0), 1) AS pct_fundos_publicos,
               COALESCE(rec.recursos_proprios, 0) AS recursos_proprios,
               bens.total_bens,
               forn.pct_maior_fornecedor, forn.n_fornecedores,
               COALESCE(cons.cnpjs, 0) AS fornecedores_cnpj,
               COALESCE(cons.ok, 0) AS fornecedores_consultados,
               COALESCE(sem_nota.valor_sem_nota, 0) AS valor_sem_nota,
               ROUND(100.0 * COALESCE(sem_nota.valor_sem_nota, 0) / NULLIF(tot.total_contratado, 0), 1) AS pct_sem_nota,
               COALESCE(pf.valor_pessoa_fisica, 0) AS valor_pessoa_fisica,
               ROUND(100.0 * COALESCE(pf.valor_pessoa_fisica, 0) / NULLIF(tot.total_contratado, 0), 1) AS pct_pessoa_fisica,
               COALESCE(rep.grupos_valor_repetido, 0) AS grupos_valor_repetido,
               COALESCE(removidas.valor_removido, 0) AS valor_removido,
               COALESCE(recem.n, 0) AS fornecedores_recem_abertos
        FROM cand
        LEFT JOIN tot USING (SQ_CANDIDATO)
        LEFT JOIN rec USING (SQ_CANDIDATO)
        LEFT JOIN forn USING (SQ_CANDIDATO)
        LEFT JOIN sem_nota USING (SQ_CANDIDATO)
        LEFT JOIN pf USING (SQ_CANDIDATO)
        LEFT JOIN rep USING (SQ_CANDIDATO)
        LEFT JOIN removidas USING (SQ_CANDIDATO)
        {pagas}
        {bens}
        {consultados}
        {recem}
    """)
    n = con.execute("SELECT COUNT(*) FROM indicadores").fetchone()[0]
    print(f"[agregado] indicadores: {n} candidatos")


# métricas comparáveis entre candidatos do mesmo grupo (cargo×UF).
# (metrica, expressão-fonte em indicadores, filtro de quem entra na distribuição)
METRICAS_COMPARACAO = [
    ("total_contratado", "total_contratado", "total_contratado > 0"),
    ("total_receitas", "total_receitas", "total_receitas > 0"),
    ("razao_gasto_receita", "razao_gasto_receita", "razao_gasto_receita IS NOT NULL"),
    ("pct_maior_fornecedor", "pct_maior_fornecedor", "n_fornecedores > 1"),
    ("pct_sem_nota", "pct_sem_nota", "total_contratado > 0"),
    ("pct_pessoa_fisica", "pct_pessoa_fisica", "total_contratado > 0"),
    ("pct_fundos_publicos", "pct_fundos_publicos", "total_receitas > 0"),
]


def _benchmark_indicadores(con) -> None:
    """Distribuição de cada indicador dentro do grupo de comparação (cargo×UF,
    mais o âmbito nacional 'BR-TODAS'). É o que permite dizer, com fatos, se um
    candidato está fora da curva DO SEU GRUPO — nunca em termos absolutos."""
    unioes = " UNION ALL ".join(
        f"SELECT DS_CARGO, SG_UF, '{nome}' AS metrica, {expr} AS valor FROM indicadores WHERE {filtro}"
        for nome, expr, filtro in METRICAS_COMPARACAO
    )
    con.execute(f"""
        CREATE OR REPLACE TABLE benchmark_indicadores AS
        WITH metricas AS ({unioes}),
        ambito AS (
            SELECT * FROM metricas
            UNION ALL
            SELECT DS_CARGO, 'BR-TODAS', metrica, valor FROM metricas)
        SELECT DS_CARGO, SG_UF, metrica,
               COUNT(*) AS candidatos,
               ROUND(QUANTILE_CONT(valor, 0.25), 2) AS p25,
               ROUND(MEDIAN(valor), 2) AS mediana,
               ROUND(QUANTILE_CONT(valor, 0.75), 2) AS p75,
               ROUND(QUANTILE_CONT(valor, 0.95), 2) AS p95,
               ROUND(MAX(valor), 2) AS maximo
        FROM ambito
        GROUP BY 1, 2, 3
        HAVING candidatos >= {MIN_GRUPO_COMPARACAO}
    """)
    n = con.execute("SELECT COUNT(*) FROM benchmark_indicadores").fetchone()[0]
    print(f"[agregado] benchmark_indicadores: {n} combinações grupo×métrica")


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
