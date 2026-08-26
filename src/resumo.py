"""Gera o resumo.json publicado junto dos Parquet — alimenta o site estático.

Tudo aqui é derivado dos dados públicos do TSE já carregados no banco.
"""

import json

import pandas as pd


def _registros(con, sql) -> list[dict]:
    df = con.execute(sql).df()
    for c in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[c]):
            df[c] = df[c].dt.strftime("%Y-%m-%d")
    return json.loads(df.to_json(orient="records"))


def gerar(con) -> dict:
    dt_extracao, dt_inicio = con.execute(
        "SELECT MAX(dt_ultima_extracao), MIN(dt_primeira_extracao) FROM hist_despesas_contratadas"
    ).fetchone()
    primeira_extracao = dt_extracao == dt_inicio

    totais = _registros(con, """
        SELECT (SELECT COUNT(DISTINCT SQ_CANDIDATO) FROM v_despesas) AS candidatos_com_gastos,
               (SELECT ROUND(SUM(VR),2) FROM v_despesas) AS total_contratado,
               (SELECT ROUND(SUM(VR),2) FROM v_receitas) AS total_receitas,
               (SELECT COUNT(*) FROM v_despesas) AS itens_declarados,
               (SELECT COUNT(DISTINCT SQ_CANDIDATO) FROM candidatos) AS candidaturas_registradas
    """)[0]

    novas = _registros(con, f"""
        SELECT NM_CANDIDATO, SG_PARTIDO, DS_CARGO, SG_UF,
               COALESCE(NULLIF(NM_FORNECEDOR_RFB,'#NULO'), NM_FORNECEDOR) AS fornecedor,
               DS_ORIGEM_DESPESA, DS_DESPESA,
               ROUND(TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA,',','.') AS DOUBLE) * qt_linhas, 2) AS valor,
               DT_DESPESA
        FROM hist_despesas_contratadas
        WHERE dt_primeira_extracao = DATE '{dt_extracao}'
        ORDER BY valor DESC LIMIT 15
    """)

    removidas = _registros(con, """
        SELECT NM_CANDIDATO, SG_PARTIDO, SG_UF,
               COALESCE(NULLIF(NM_FORNECEDOR_RFB,'#NULO'), NM_FORNECEDOR) AS fornecedor,
               DS_DESPESA,
               ROUND(TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA,',','.') AS DOUBLE) * qt_linhas, 2) AS valor,
               dt_primeira_extracao, dt_ultima_extracao
        FROM v_removidas_despesas_contratadas
        ORDER BY valor DESC LIMIT 20
    """)

    removidas_receitas = _registros(con, """
        SELECT NM_CANDIDATO, SG_PARTIDO, SG_UF, NM_DOADOR, DS_ORIGEM_RECEITA,
               ROUND(TRY_CAST(REPLACE(VR_RECEITA,',','.') AS DOUBLE) * qt_linhas, 2) AS valor,
               dt_primeira_extracao, dt_ultima_extracao
        FROM v_removidas_receitas
        ORDER BY valor DESC LIMIT 20
    """)

    compartilhados = _registros(con, """
        SELECT COALESCE(NULLIF(NM_FORNECEDOR_RFB,'#NULO'), NM_FORNECEDOR) AS fornecedor,
               NR_CPF_CNPJ_FORNECEDOR AS cnpj,
               COUNT(DISTINCT SQ_CANDIDATO) AS candidatos,
               COUNT(DISTINCT SG_PARTIDO) AS partidos,
               STRING_AGG(DISTINCT SG_UF, ', ') AS ufs,
               ROUND(SUM(VR),2) AS total
        FROM v_despesas
        WHERE NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1','#NULO')
        GROUP BY 1, 2 HAVING candidatos > 1
        ORDER BY total DESC LIMIT 12
    """)

    top_candidatos = _registros(con, """
        WITH r AS (SELECT SQ_CANDIDATO, SUM(VR) AS receita FROM v_receitas GROUP BY 1)
        SELECT d.SQ_CANDIDATO,
               ANY_VALUE(d.NM_CANDIDATO) AS NM_CANDIDATO, ANY_VALUE(d.SG_PARTIDO) AS SG_PARTIDO,
               ANY_VALUE(d.DS_CARGO) AS DS_CARGO, ANY_VALUE(d.SG_UF) AS SG_UF,
               ROUND(SUM(d.VR),2) AS contratado, ROUND(ANY_VALUE(r.receita),2) AS receita
        FROM v_despesas d LEFT JOIN r USING (SQ_CANDIDATO)
        GROUP BY d.SQ_CANDIDATO ORDER BY contratado DESC LIMIT 12
    """)

    return {
        "gerado_em": str(dt_extracao),
        "primeira_extracao": primeira_extracao,
        "totais": totais,
        "novas_despesas": novas,
        "despesas_removidas": removidas,
        "receitas_removidas": removidas_receitas,
        "fornecedores_compartilhados": compartilhados,
        "top_candidatos": top_candidatos,
    }
