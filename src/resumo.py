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


# métricas que contam como "sinal" no fora da curva: fatos em que estar muito
# acima do grupo merece pergunta (arrecadar muito, por si, não é indício)
METRICAS_SINAL = [
    ("total_contratado", "total_contratado", "total_contratado > 0"),
    ("razao_gasto_receita", "razao_gasto_receita", "razao_gasto_receita IS NOT NULL"),
    ("pct_maior_fornecedor", "pct_maior_fornecedor", "n_fornecedores > 1"),
    ("pct_sem_nota", "pct_sem_nota", "total_contratado > 0"),
    ("pct_pessoa_fisica", "pct_pessoa_fisica", "total_contratado > 0"),
]


def _existe(con, tabela: str) -> bool:
    return bool(con.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [tabela]
    ).fetchone()[0])


def _fora_da_curva(con, limite: int = 10) -> list[dict]:
    """Candidatos com mais métricas estritamente acima do p95 do próprio grupo
    de comparação (cargo×UF; nacional quando o grupo local é pequeno).
    Cada sinal carrega o valor, a mediana e o p95 do grupo — fatos conferíveis."""
    if not (_existe(con, "indicadores") and _existe(con, "benchmark_indicadores")):
        return []
    unioes = " UNION ALL ".join(
        f"SELECT SQ_CANDIDATO, DS_CARGO, SG_UF, '{nome}' AS metrica, {expr} AS valor "
        f"FROM indicadores WHERE {filtro}"
        for nome, expr, filtro in METRICAS_SINAL
    )
    df = con.execute(f"""
        WITH m AS ({unioes}),
        ref AS (
            SELECT m.*,
                   COALESCE(buf.mediana, bbr.mediana) AS mediana,
                   COALESCE(buf.p95, bbr.p95) AS p95,
                   COALESCE(buf.candidatos, bbr.candidatos) AS grupo_n,
                   CASE WHEN buf.metrica IS NOT NULL THEN m.SG_UF ELSE 'BR-TODAS' END AS grupo_ambito
            FROM m
            LEFT JOIN benchmark_indicadores buf
              ON buf.DS_CARGO = m.DS_CARGO AND buf.SG_UF = m.SG_UF AND buf.metrica = m.metrica
            LEFT JOIN benchmark_indicadores bbr
              ON bbr.DS_CARGO = m.DS_CARGO AND bbr.SG_UF = 'BR-TODAS' AND bbr.metrica = m.metrica)
        SELECT r.SQ_CANDIDATO, i.NM_CANDIDATO, i.SG_PARTIDO, i.DS_CARGO, i.SG_UF,
               i.total_contratado, i.total_receitas,
               r.metrica, ROUND(r.valor, 2) AS valor, r.mediana, r.p95, r.grupo_n, r.grupo_ambito
        FROM ref r JOIN indicadores i USING (SQ_CANDIDATO)
        WHERE r.p95 IS NOT NULL AND r.valor > r.p95
        ORDER BY r.SQ_CANDIDATO
    """).df()
    if df.empty:
        return []
    saida = []
    for sq, grupo in df.groupby("SQ_CANDIDATO", sort=False):
        primeiro = grupo.iloc[0]
        saida.append({
            "SQ_CANDIDATO": str(sq),
            "NM_CANDIDATO": primeiro["NM_CANDIDATO"],
            "SG_PARTIDO": primeiro["SG_PARTIDO"],
            "DS_CARGO": primeiro["DS_CARGO"],
            "SG_UF": primeiro["SG_UF"],
            "total_contratado": float(primeiro["total_contratado"] or 0),
            "total_receitas": None if pd.isna(primeiro["total_receitas"]) else float(primeiro["total_receitas"]),
            "sinais": [
                {"metrica": s["metrica"], "valor": float(s["valor"]),
                 "mediana": float(s["mediana"]), "p95": float(s["p95"]),
                 "grupo_n": int(s["grupo_n"]), "grupo_ambito": s["grupo_ambito"]}
                for _, s in grupo.iterrows()
            ],
        })
    saida.sort(key=lambda c: (-len(c["sinais"]), -c["total_contratado"]))
    return saida[:limite]


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
        "fora_da_curva": _fora_da_curva(con),
    }
