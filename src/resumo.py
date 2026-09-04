"""Gera o resumo.json publicado junto dos Parquet — alimenta o site estático.

Tudo aqui é derivado dos dados públicos do TSE já carregados no banco.
"""

import json
from datetime import UTC, datetime

import pandas as pd

from src import agregados, db, historico, privacidade
from src.carga import filtro_placeholder


def _registros(con, sql) -> list[dict]:
    df = con.execute(sql).df()
    for c in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[c]):
            df[c] = df[c].dt.strftime("%Y-%m-%d")
    return json.loads(df.to_json(orient="records"))


# métricas que contam como "sinal" no fora da curva: fatos em que estar muito
# acima do grupo merece pergunta (arrecadar muito, por si, não é indício).
# A razão gasto÷arrecadado só é sinal com MARGEM_GASTO_ACIMA: quem gastou menos
# do que arrecadou não vira sinal só porque o p95 do grupo é ~0 no início da
# campanha, e quem estourou por poucos por cento está em descompasso de
# calendário (nota contratada antes do repasse entrar), não em indício — com o
# corte em 1 o sinal disparava a 1,01×, e em quase metade dos grupos o p95 fica
# abaixo de 1, ou seja, esse corte era o único portão que existia.
# Métricas percentuais têm teto: quando 5% ou mais do grupo está em 100%, o p95
# satura no teto e "estritamente acima" vira impossível — o sinal simplesmente
# NÃO dispara nesse grupo. Já houve uma exceção que tratava "estar no teto"
# como sinal (na época pct_sem_nota saturava em todos os grupos e o sinal era
# mudo), mas ela marcava candidatos demais: num grupo com 15% em 100%, todos os
# 15% ganhavam o rótulo "fora da curva" — que promete outlier e entregava um
# sexto do grupo. Com a norma_documento a saturação de pct_sem_nota sumiu, e a
# exceção saiu: fora da curva é estritamente acima do p95, sem letra miúda.
MARGEM_GASTO_ACIMA = 1.1
CONDICAO_SINAL = "r.valor > r.p95"

METRICAS_SINAL = [
    ("total_contratado", "total_contratado", "total_contratado > 0"),
    ("razao_gasto_receita", "razao_gasto_receita",
     f"razao_gasto_receita > {MARGEM_GASTO_ACIMA}"),
    ("pct_maior_fornecedor", "pct_maior_fornecedor", "n_fornecedores > 1"),
    ("pct_sem_nota", "pct_sem_nota", "total_contratado > 0"),
    ("pct_pessoa_fisica", "pct_pessoa_fisica", "total_contratado > 0"),
]


_existe = db.existe


def _tem_metadados_foto(con) -> bool:
    """A foto oficial do TSE precisa de CD_ELEICAO e SG_UE (registro de
    candidaturas); bancos de teste/antigos podem não ter as colunas."""
    if not _existe(con, "candidatos"):
        return False
    cols = {r[0] for r in con.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'candidatos'"
    ).fetchall()}
    return {"CD_ELEICAO", "SG_UE"} <= cols


def _fora_da_curva(con, limite: int = 10) -> list[dict]:
    """Candidatos com mais métricas acima do p95 do próprio grupo
    de comparação (cargo×UF; nacional quando o grupo local é pequeno).
    Cada sinal carrega o valor, a mediana e o p95 do grupo — fatos conferíveis."""
    if not (_existe(con, "indicadores") and _existe(con, "benchmark_indicadores")):
        return []
    unioes = " UNION ALL ".join(
        f"SELECT SQ_CANDIDATO, DS_CARGO, SG_UF, '{nome}' AS metrica, {expr} AS valor "
        f"FROM indicadores WHERE {filtro}"
        for nome, expr, filtro in METRICAS_SINAL
    )
    # metadados da foto oficial (divulgacandcontas): o site usa como hotlink,
    # com fallback para iniciais quando ausentes
    foto = (
        "LEFT JOIN (SELECT SQ_CANDIDATO, ANY_VALUE(CD_ELEICAO) AS cd_eleicao, "
        "ANY_VALUE(SG_UE) AS sg_ue FROM candidatos GROUP BY 1) c USING (SQ_CANDIDATO)"
        if _tem_metadados_foto(con)
        else "LEFT JOIN (SELECT NULL AS SQ_CANDIDATO, NULL AS cd_eleicao, NULL AS sg_ue) c USING (SQ_CANDIDATO)"
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
               i.total_contratado, i.total_receitas, c.cd_eleicao, c.sg_ue,
               r.metrica, ROUND(r.valor, 2) AS valor, r.mediana, r.p95, r.grupo_n, r.grupo_ambito
        FROM ref r JOIN indicadores i USING (SQ_CANDIDATO)
        {foto}
        WHERE r.p95 IS NOT NULL AND {CONDICAO_SINAL}
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
            "cd_eleicao": None if pd.isna(primeiro["cd_eleicao"]) else str(primeiro["cd_eleicao"]),
            "sg_ue": None if pd.isna(primeiro["sg_ue"]) else str(primeiro["sg_ue"]),
            "sinais": [
                {"metrica": s["metrica"], "valor": float(s["valor"]),
                 "mediana": float(s["mediana"]), "p95": float(s["p95"]),
                 "grupo_n": int(s["grupo_n"]), "grupo_ambito": s["grupo_ambito"]}
                for _, s in grupo.iterrows()
            ],
        })
    saida.sort(key=lambda c: (-len(c["sinais"]), -c["total_contratado"]))
    return saida[:limite]


def _cota_fefc(con) -> list[dict]:
    """Por partido: fatia do Fundo Especial que chegou a candidatas e a
    candidaturas negras, ao lado da fatia que elas representam entre as
    candidaturas — a distância entre as duas é o dado. Denominador das
    candidaturas: o registro (consulta_cand) quando o banco o traz com gênero e
    cor; senão, quem recebeu FEFC. Só partidos com FEFC declarado."""
    if not _existe(con, "cota_fefc"):
        return []
    return _registros(con, sql_cota_por_partido("1=1"))


def sql_cota_por_partido(where: str) -> str:
    """Uma linha por partido com FEFC declarado. A fatia das candidaturas vem
    do registro (SUM(candidaturas), só das linhas que o registro tem) quando o
    partido tem QUALQUER registro com gênero/cor; senão, de quem recebeu — os
    dois denominadores nunca se misturam. A ficha do partido roda o MESMO SQL
    (site/src/pages/partido.tsx espelha as colunas na mesma ordem)."""
    negros = ", ".join(f"'{c}'" for c in agregados.COR_RACA_NEGRA)
    return f"""
        WITH p AS (
            SELECT SG_PARTIDO,
                   SUM(fefc) AS fefc,
                   SUM(candidatos_fefc) AS cf,
                   COALESCE(SUM(fefc) FILTER (WHERE genero = 'FEMININO'), 0) AS fefc_f,
                   COALESCE(SUM(fefc) FILTER (WHERE cor_raca IN ({negros})), 0) AS fefc_n,
                   SUM(candidaturas) AS reg,
                   COALESCE(SUM(candidaturas) FILTER (WHERE genero = 'FEMININO'), 0) AS reg_f,
                   COALESCE(SUM(candidaturas) FILTER (WHERE cor_raca IN ({negros})), 0) AS reg_n,
                   COALESCE(SUM(candidatos_fefc) FILTER (WHERE genero = 'FEMININO'), 0) AS cf_f,
                   COALESCE(SUM(candidatos_fefc) FILTER (WHERE cor_raca IN ({negros})), 0) AS cf_n
            FROM cota_fefc WHERE {where}
            GROUP BY 1 HAVING SUM(fefc) > 0)
        SELECT SG_PARTIDO,
               ROUND(fefc, 2) AS fefc,
               cf AS candidatos_fefc,
               COALESCE(reg, cf) AS candidaturas,
               reg IS NOT NULL AS base_registro,
               ROUND(100.0 * fefc_f / fefc, 1) AS pct_fefc_feminino,
               ROUND(100.0 * (CASE WHEN reg IS NOT NULL THEN reg_f ELSE cf_f END)
                     / NULLIF(COALESCE(reg, cf), 0), 1) AS pct_candidaturas_femininas,
               ROUND(100.0 * fefc_n / fefc, 1) AS pct_fefc_negros,
               ROUND(100.0 * (CASE WHEN reg IS NOT NULL THEN reg_n ELSE cf_n END)
                     / NULLIF(COALESCE(reg, cf), 0), 1) AS pct_candidaturas_negras
        FROM p ORDER BY fefc DESC
    """


def _serie_nacional(con) -> list[dict]:
    """Totais do país por dia de extração — alimenta os sparklines da Home
    (que não carrega DuckDB-WASM; tudo que ela mostra vem do resumo.json)."""
    if not _existe(con, "serie_diaria"):
        return []
    return _registros(con, """
        SELECT STRFTIME(dt_extracao, '%Y-%m-%d') AS dt,
               ROUND(SUM(total_contratado), 2) AS contratado,
               ROUND(SUM(total_receitas), 2) AS receitas,
               COUNT(DISTINCT CASE WHEN total_contratado > 0 THEN SQ_CANDIDATO END) AS candidatos
        FROM serie_diaria
        GROUP BY dt_extracao ORDER BY dt_extracao
    """)


def gerar(con) -> dict:
    # o resumo.json é público como os parquet: CPFs saem pseudonimizados (pf-…)
    pseudo_fornecedor = privacidade.sql_pseudonimo("NR_CPF_CNPJ_FORNECEDOR", privacidade.sal())
    dt_extracao, dt_inicio = con.execute(
        "SELECT MAX(dt_ultima_extracao), MIN(dt_primeira_extracao) FROM hist_despesas_contratadas"
    ).fetchone()
    primeira_extracao = dt_extracao == dt_inicio

    # totais das mudanças (as listas abaixo são só as maiores; a Home mostra o
    # número cheio e manda o visitante explorar o resto com filtros)
    mudancas = _registros(con, """
        SELECT (SELECT COUNT(*) FROM v_removidas_despesas_contratadas) AS despesas_removidas_qtd,
               (SELECT COALESCE(ROUND(SUM(TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA,',','.') AS DOUBLE) * qt_linhas), 2), 0)
                FROM v_removidas_despesas_contratadas) AS despesas_removidas_valor,
               (SELECT COUNT(*) FROM v_removidas_receitas) AS receitas_removidas_qtd,
               (SELECT COALESCE(ROUND(SUM(TRY_CAST(REPLACE(VR_RECEITA,',','.') AS DOUBLE) * qt_linhas), 2), 0)
                FROM v_removidas_receitas) AS receitas_removidas_valor
    """)[0]

    totais = _registros(con, """
        SELECT (SELECT COUNT(DISTINCT SQ_CANDIDATO) FROM v_despesas) AS candidatos_com_gastos,
               (SELECT ROUND(SUM(VR),2) FROM v_despesas) AS total_contratado,
               (SELECT ROUND(SUM(VR),2) FROM v_receitas) AS total_receitas,
               (SELECT COUNT(*) FROM v_despesas) AS itens_declarados,
               (SELECT COUNT(DISTINCT SQ_CANDIDATO) FROM candidatos) AS candidaturas_registradas
    """)[0]

    # SQ_CANDIDATO e o CNPJ/CPF do fornecedor viajam junto: a Home linka cada
    # nome à sua ficha (site todo conectado).
    # "Nova" é a ESSÊNCIA que estreou hoje, não o hash. O hash inclui o
    # SQ_DESPESA, que o SPCE regenera a cada retransmissão: pela régua do hash,
    # a prestação inteira de quem retransmite renascia "nova" todo dia e ocupava
    # o topo da Home (medido em 31/08/2026: 62% das linhas e 13 dos 15 maiores
    # já estavam declaradas dias antes).
    chave_essencia = ", ".join(historico.ESSENCIA["despesas_contratadas"])
    # o join NÃO pode ser USING: campo de essência NULL (DT_DESPESA falta aos
    # milhares nos arquivos do TSE) não casa em `=`, e a despesa debutante com
    # data vazia sumiria da lista em silêncio
    join_essencia = " AND ".join(
        f"h.{c} IS NOT DISTINCT FROM e.{c}"
        for c in historico.ESSENCIA["despesas_contratadas"]
    )
    pseudo_fornecedor_h = privacidade.sql_pseudonimo(
        "h.NR_CPF_CNPJ_FORNECEDOR", privacidade.sal())
    novas = _registros(con, f"""
        WITH estreia AS (
            SELECT {chave_essencia}, MIN(dt_primeira_extracao) AS dt
            FROM hist_despesas_contratadas GROUP BY ALL)
        SELECT h.SQ_CANDIDATO, h.NM_CANDIDATO, h.SG_PARTIDO, h.DS_CARGO, h.SG_UF,
               COALESCE(NULLIF(h.NM_FORNECEDOR_RFB,'#NULO'), h.NM_FORNECEDOR) AS fornecedor,
               {pseudo_fornecedor_h} AS NR_CPF_CNPJ_FORNECEDOR,
               h.DS_ORIGEM_DESPESA, h.DS_DESPESA,
               ROUND(TRY_CAST(REPLACE(h.VR_DESPESA_CONTRATADA,',','.') AS DOUBLE) * h.qt_linhas, 2) AS valor,
               h.DT_DESPESA
        FROM hist_despesas_contratadas h
        JOIN estreia e ON {join_essencia}
        WHERE h.dt_primeira_extracao = DATE '{dt_extracao}'
          AND e.dt = DATE '{dt_extracao}'
          AND {filtro_placeholder('h.NR_CPF_CNPJ_FORNECEDOR', 'h.VR_DESPESA_CONTRATADA')}
        ORDER BY valor DESC LIMIT 15
    """)

    removidas = _registros(con, f"""
        SELECT SQ_CANDIDATO, NM_CANDIDATO, SG_PARTIDO, SG_UF,
               COALESCE(NULLIF(NM_FORNECEDOR_RFB,'#NULO'), NM_FORNECEDOR) AS fornecedor,
               {pseudo_fornecedor} AS NR_CPF_CNPJ_FORNECEDOR,
               DS_DESPESA,
               ROUND(TRY_CAST(REPLACE(VR_DESPESA_CONTRATADA,',','.') AS DOUBLE) * qt_linhas, 2) AS valor,
               dt_primeira_extracao, dt_ultima_extracao
        FROM v_removidas_despesas_contratadas
        ORDER BY valor DESC LIMIT 20
    """)

    removidas_receitas = _registros(con, """
        SELECT SQ_CANDIDATO, NM_CANDIDATO, SG_PARTIDO, SG_UF, NM_DOADOR, DS_ORIGEM_RECEITA,
               ROUND(TRY_CAST(REPLACE(VR_RECEITA,',','.') AS DOUBLE) * qt_linhas, 2) AS valor,
               dt_primeira_extracao, dt_ultima_extracao
        FROM v_removidas_receitas
        ORDER BY valor DESC LIMIT 20
    """)

    compartilhados = _registros(con, f"""
        SELECT COALESCE(NULLIF(NM_FORNECEDOR_RFB,'#NULO'), NM_FORNECEDOR) AS fornecedor,
               {pseudo_fornecedor} AS cnpj,
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
        # carimbo desta publicação: o site usa como cache-buster (?v=) nos
        # parquet, para ninguém misturar arquivos de publicações diferentes
        "publicado_em": datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"),
        "primeira_extracao": primeira_extracao,
        "totais": totais,
        "mudancas": mudancas,
        "novas_despesas": novas,
        "despesas_removidas": removidas,
        "receitas_removidas": removidas_receitas,
        "fornecedores_compartilhados": compartilhados,
        "top_candidatos": top_candidatos,
        "fora_da_curva": _fora_da_curva(con),
        "serie_nacional": _serie_nacional(con),
        "cota_fefc": _cota_fefc(con),
    }
