"""SQL das ferramentas curadas do MCP.

Espelho em Python das consultas do site (site/src/lib/consultas.ts e as
fichas em site/src/pages/*.tsx), sobre as MESMAS tabelas publicadas. As
réguas de negócio não são copiadas: vêm importadas de src/analises.py
(documento fiscal, plataforma, impulsionamento), src/resumo.py (sinais do
fora da curva, cota do FEFC) e src/agregados.py (cor/raça, unidade da nota
no benchmark de preço). O que é texto de SQL espelhado do front é coberto por
tests/test_sincronia_site.py.
"""

from __future__ import annotations

import re

from src import agregados, analises, resumo

# --------------------------------------------------------------------------- #
# Helpers de filtro (port de condUF/condTexto/montarWhere do site)
# --------------------------------------------------------------------------- #

CONECTIVOS = {
    "a", "as", "o", "os", "e", "de", "da", "do", "das", "dos",
    "em", "na", "no", "nas", "nos", "para", "por", "com",
}


def esc(s: str) -> str:
    return str(s).replace("'", "''")


def cond_uf(uf: str | None, prefixo: str = "") -> str | None:
    lista = [u.strip().upper() for u in (uf or "").split(",") if u.strip()]
    if not lista:
        return None
    if len(lista) == 1:
        return f"{prefixo}SG_UF = '{esc(lista[0])}'"
    # sempre aspas simples de SQL: repr() trocaria para aspas duplas (identificador)
    # quando o valor traz apóstrofo, e escaparia barras e controles à moda do Python
    return f"{prefixo}SG_UF IN ({', '.join(f"'{esc(u)}'" for u in lista)})"


def cond_texto(termo: str | None, colunas: list[str], plural: bool = False) -> str | None:
    """Cada palavra é exigida (AND) dentro de UMA das colunas; conectivos não
    contam; com `plural`, palavra de 4+ letras terminada em s perde o s."""
    palavras = (termo or "").split()
    sem_conectivos = [p for p in palavras if p.lower() not in CONECTIVOS]
    tokens = sem_conectivos or palavras
    if not tokens or not colunas:
        return None

    def padrao(t: str) -> str:
        if plural and len(t) >= 4 and t.lower().endswith("s"):
            t = t[:-1]
        return f"%{esc(t)}%"

    por_coluna = [
        "(" + " AND ".join(f"{c} ILIKE '{padrao(t)}'" for t in tokens) + ")" for c in colunas
    ]
    return por_coluna[0] if len(por_coluna) == 1 else "(" + " OR ".join(por_coluna) + ")"


def where_recorte(uf: str | None = None, cargo: str | None = None,
                  partido: str | None = None, prefixo: str = "") -> str:
    """Recorte por UF/cargo/partido — as colunas existem em todas as tabelas
    por candidato (indicadores, despesas_atual, receitas_atual, *_removidas)."""
    partes = ["1=1"]
    c = cond_uf(uf, prefixo)
    if c:
        partes.append(c)
    if cargo:
        partes.append(f"{prefixo}DS_CARGO ILIKE '%{esc(cargo)}%'")
    if partido:
        partes.append(f"{prefixo}SG_PARTIDO = '{esc(partido.upper())}'")
    return " AND ".join(partes)


# --------------------------------------------------------------------------- #
# Réguas espelhadas (texto igual ao do site — tests/test_sincronia_site.py)
# --------------------------------------------------------------------------- #

NOME_FORNECEDOR = "COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NM_FORNECEDOR)"
NOME_FORNECEDOR_OU_ANONIMO = (
    "COALESCE(NULLIF(NM_FORNECEDOR_RFB, '#NULO'), NULLIF(NM_FORNECEDOR, '#NULO'), "
    "'Não identificado (declarado sem contraparte)')"
)
NOME_DOADOR_OU_ANONIMO = (
    "COALESCE(NULLIF(NM_DOADOR_RFB, '#NULO'), NULLIF(NM_DOADOR, '#NULO'), "
    "'Doador não identificado')"
)

# red flag 12 — nota fiscal afirmada sem número localizável
CONDICAO_NOTA_SEM_NUMERO = (
    f"NOT {analises.cond_documento_nao_fiscal()}"
    " AND NOT regexp_matches(COALESCE(NR_DOCUMENTO, ''), '[0-9]')"
)
# red flag 13 — documento fiscal com número de verdade, fornecedor identificado,
# fora de impulsionamento (número digitado à mão, sem nota sequencial)
CONDICAO_DOCUMENTO_NUMERADO = (
    f"NOT {analises.cond_documento_nao_fiscal()}"
    " AND regexp_full_match(COALESCE(NR_DOCUMENTO, ''), '[0-9]{3,}')"
    " AND NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')"
    f" AND COALESCE(DS_ORIGEM_DESPESA, '') <> '{analises.CATEGORIA_IMPULSIONAMENTO}'"
)
CONDICAO_DOACAO_DIRETA = analises.cond_doacao_direta()
# red flag 7 — mesmo valor, mesmo fornecedor, em notas DISTINTAS (rep em agregados.py)
MINIMO_NOTAS_VALOR_REPETIDO = 3
MARGEM_GASTO_ACIMA = resumo.MARGEM_GASTO_ACIMA

# A nota comparada contra benchmark_precos tem de ser montada com a MESMA chave
# que gerou os percentis (src/agregados.py) — daí o import em vez de uma cópia.
CHAVE_NOTA = ", ".join(agregados.CHAVE_NOTA)
SEM_ID_DESPESA = agregados.SEM_ID_DESPESA
MIN_NOTAS_BENCHMARK_PRECO = agregados.MIN_NOTAS_BENCHMARK_PRECO

# Contrapartes que atendem tanta gente que ligá-las a alguém não diz nada sobre
# relação: plataformas de anúncio, de pagamento e de vaquinha. Não é juízo sobre
# elas — é o corte que separa infraestrutura de vínculo, e vai declarado na
# resposta (`contrapartes_ignoradas`) para o corte ficar conferível.
# Medido em 07/09/2026: com 20, 17 contrapartes das 36.754 saem e 95% das
# arestas ficam; sem corte, o 1º nível de um candidato qualquer já alcança 42%
# do país por causa de uma única plataforma de anúncio.
MAX_CANDIDATOS_CONTRAPARTE_COMUM = 20
MAX_NIVEIS_CONEXAO = 3


def sql_documento_da_nota(tipo: str = "DS_TIPO_DOCUMENTO", numero: str = "NR_DOCUMENTO") -> str:
    """'Nota Fiscal nº 1426', 'Outro SN' — os nulos do TSE diferem por coluna
    ('#NULO' no tipo, '#NULO#' no número)."""
    num = f"COALESCE({numero}, '')"
    return (
        f"TRIM(COALESCE(NULLIF({tipo}, '#NULO'), '')"
        f" || CASE WHEN regexp_matches({num}, '[0-9]') THEN ' nº ' || {numero}"
        f"         WHEN {num} NOT IN ('', '#NULO', '#NULO#', '-1') THEN ' ' || {numero}"
        f"         ELSE '' END)"
    )


def sinais_cte() -> str:
    """CTE dos sinais do fora da curva, gerada de METRICAS_SINAL (src/resumo.py):
    métrica estritamente acima do p95 do grupo cargo×UF, BR-TODAS quando o
    grupo local não existe. Mesma régua da home e do Explorar."""
    unioes = "\n    UNION ALL ".join(
        f"SELECT SQ_CANDIDATO, DS_CARGO, SG_UF, '{nome}' AS metrica, {expr} AS valor "
        f"FROM indicadores WHERE {filtro}"
        for nome, expr, filtro in resumo.METRICAS_SINAL
    )
    return f"""
  metricas AS (
    {unioes}),
  sinais AS (
    SELECT m.SQ_CANDIDATO, m.metrica, m.valor,
           COALESCE(buf.p95, bbr.p95) AS p95,
           COALESCE(buf.mediana, bbr.mediana) AS mediana,
           COALESCE(buf.candidatos, bbr.candidatos) AS grupo_n,
           CASE WHEN buf.metrica IS NOT NULL THEN m.SG_UF ELSE 'BR-TODAS' END AS grupo_ambito
    FROM metricas m
    LEFT JOIN benchmark_indicadores buf
      ON buf.DS_CARGO = m.DS_CARGO AND buf.SG_UF = m.SG_UF AND buf.metrica = m.metrica
    LEFT JOIN benchmark_indicadores bbr
      ON bbr.DS_CARGO = m.DS_CARGO AND bbr.SG_UF = 'BR-TODAS' AND bbr.metrica = m.metrica
    WHERE COALESCE(buf.p95, bbr.p95) IS NOT NULL
      AND m.valor > COALESCE(buf.p95, bbr.p95))"""


SINAIS = [nome for nome, _, _ in resumo.METRICAS_SINAL]


# --------------------------------------------------------------------------- #
# buscar_candidato
# --------------------------------------------------------------------------- #

def sql_buscar_candidato(termo: str, uf: str | None, cargo: str | None,
                         partido: str | None, limite: int) -> str:
    termo = (termo or "").strip()
    recorte = where_recorte(uf, cargo, partido)
    if termo.isdigit():
        busca = f"NR_CANDIDATO = '{esc(termo)}'"
        busca_ind = busca
    else:
        busca = cond_texto(termo, ["NM_CANDIDATO", "NM_URNA_CANDIDATO"]) or "1=1"
        busca_ind = cond_texto(termo, ["NM_CANDIDATO"]) or "1=1"
    # registro (inclui quem ainda não movimentou nada) + quem só existe na
    # prestação; os totais vêm dos indicadores
    return f"""
WITH reg AS (
  SELECT SQ_CANDIDATO,
         ANY_VALUE(NM_CANDIDATO) AS nome, ANY_VALUE(NM_URNA_CANDIDATO) AS nome_urna,
         ANY_VALUE(NR_CANDIDATO) AS numero, ANY_VALUE(DS_CARGO) AS cargo,
         ANY_VALUE(SG_PARTIDO) AS partido, ANY_VALUE(SG_UF) AS uf,
         ANY_VALUE(NULLIF(NULLIF(DS_SITUACAO_CANDIDATURA, '#NE'), '#NULO')) AS situacao
  FROM candidatos WHERE {recorte} AND {busca}
  GROUP BY 1
  UNION ALL
  SELECT SQ_CANDIDATO, NM_CANDIDATO, NULL, NR_CANDIDATO, DS_CARGO, SG_PARTIDO, SG_UF, NULL
  FROM indicadores WHERE {recorte} AND {busca_ind}
    AND SQ_CANDIDATO NOT IN (SELECT SQ_CANDIDATO FROM candidatos))
SELECT r.SQ_CANDIDATO AS sq_candidato, r.nome, r.nome_urna, r.numero, r.cargo, r.partido, r.uf,
       r.situacao,
       ROUND(i.total_contratado, 2) AS total_contratado,
       ROUND(i.total_receitas, 2) AS total_receitas,
       i.n_fornecedores,
       i.SQ_CANDIDATO IS NOT NULL AS tem_movimento
FROM reg r LEFT JOIN indicadores i USING (SQ_CANDIDATO)
ORDER BY COALESCE(i.total_contratado, 0) + COALESCE(i.total_receitas, 0) DESC, r.nome
LIMIT {int(limite)}"""


# --------------------------------------------------------------------------- #
# ficha_candidato — as consultas da página /candidato/:sq
# --------------------------------------------------------------------------- #

def sql_notas_marcadas(where: str, limite: int = 30) -> str:
    """As notas de um candidato com as red flags por nota (7, 12, 13) — port
    de sqlNotasDoCandidato; aqui só as marcadas, que é o que interessa."""
    chave = "NR_CPF_CNPJ_FORNECEDOR, SQ_DESPESA"
    doc = sql_documento_da_nota()
    return f"""
WITH itens AS (SELECT * FROM despesas_atual WHERE {where}),
repetidos AS (
  SELECT NR_CPF_CNPJ_FORNECEDOR AS cnpj, valor FROM itens
  GROUP BY 1, 2 HAVING COUNT(DISTINCT SQ_DESPESA) >= {MINIMO_NOTAS_VALOR_REPETIDO}),
notas AS (
  SELECT {chave}, ANY_VALUE(DT_DESPESA) AS dt, ANY_VALUE(DS_ORIGEM_DESPESA) AS categoria,
         STRING_AGG(DISTINCT DS_DESPESA, ' · ') AS descricao,
         ANY_VALUE({doc}) AS documento, ANY_VALUE(NR_DOCUMENTO) AS n_doc,
         ROUND(SUM(valor), 2) AS valor, COUNT(*) AS itens,
         MAX(CASE WHEN {CONDICAO_NOTA_SEM_NUMERO} THEN 1 ELSE 0 END) AS sem_numero,
         MAX(CASE WHEN {CONDICAO_DOCUMENTO_NUMERADO} THEN 1 ELSE 0 END) AS numerado,
         MAX(CASE WHEN EXISTS (SELECT 1 FROM repetidos r
               WHERE r.cnpj = itens.NR_CPF_CNPJ_FORNECEDOR AND r.valor = itens.valor)
             THEN 1 ELSE 0 END) AS valor_repetido
  FROM itens WHERE SQ_DESPESA <> '-1' GROUP BY 1, 2
  UNION ALL
  SELECT NR_CPF_CNPJ_FORNECEDOR, SQ_DESPESA, DT_DESPESA, DS_ORIGEM_DESPESA, DS_DESPESA,
         {doc}, NR_DOCUMENTO, ROUND(valor, 2), 1,
         CASE WHEN {CONDICAO_NOTA_SEM_NUMERO} THEN 1 ELSE 0 END,
         CASE WHEN {CONDICAO_DOCUMENTO_NUMERADO} THEN 1 ELSE 0 END, 0
  FROM itens WHERE SQ_DESPESA = '-1'),
marcadas AS (
  SELECT n.NR_CPF_CNPJ_FORNECEDOR AS fornecedor_id, n.dt AS data, n.categoria, n.descricao,
         n.documento, n.valor, n.itens,
         n.sem_numero = 1 AS nota_sem_numero,
         n.valor_repetido = 1 AS valor_repetido,
         (n.numerado = 1 AND EXISTS (
            SELECT 1 FROM despesas_atual o
            WHERE o.NR_CPF_CNPJ_FORNECEDOR = n.NR_CPF_CNPJ_FORNECEDOR
              AND o.NR_DOCUMENTO = n.n_doc
              AND {CONDICAO_DOCUMENTO_NUMERADO}
              AND o.SQ_CANDIDATO <> (SELECT ANY_VALUE(SQ_CANDIDATO) FROM itens))) AS mesmo_numero_em_outro_candidato
  FROM notas n)
SELECT * FROM marcadas
WHERE nota_sem_numero OR valor_repetido OR mesmo_numero_em_outro_candidato
ORDER BY valor DESC LIMIT {int(limite)}"""


def sql_corrigidas(tabela: str, where: str, limite: int = 30) -> str:
    """Retificações já pareadas pelo backend (v_alteradas_pares_*)."""
    contraparte = "NR_CPF_CNPJ_FORNECEDOR" if tabela == "despesas_alteradas" else "NR_CPF_CNPJ_DOADOR"
    return f"""
SELECT campo_alterado, nome_contraparte, {contraparte} AS contraparte_id,
       SQ_CANDIDATO AS sq_candidato, NM_CANDIDATO AS candidato, SG_PARTIDO AS partido, SG_UF AS uf,
       descricao_antes, descricao_depois, valor_antes, valor_depois, data_antes, data_depois,
       STRFTIME(dt_primeira_extracao, '%d/%m/%Y') AS visivel_de,
       STRFTIME(dt_ultima_extracao, '%d/%m/%Y') AS visivel_ate,
       sucessores
FROM {tabela} WHERE {where}
ORDER BY ABS(COALESCE(valor_depois, 0) - COALESCE(valor_antes, 0)) DESC,
         COALESCE(valor_antes, 0) DESC
LIMIT {int(limite)}"""


def sql_removidas(tabela: str, where: str, limite: int) -> str:
    if tabela == "receitas_removidas":
        return f"""
SELECT SQ_CANDIDATO AS sq_candidato, NM_CANDIDATO AS candidato, SG_PARTIDO AS partido, SG_UF AS uf,
       DS_CARGO AS cargo, DT_RECEITA AS data, {NOME_DOADOR_OU_ANONIMO} AS doador,
       NR_CPF_CNPJ_DOADOR AS doador_id, DS_ORIGEM_RECEITA AS origem, DS_ESPECIE_RECEITA AS especie,
       ROUND(valor, 2) AS valor,
       STRFTIME(dt_primeira_extracao, '%d/%m/%Y') AS visivel_de,
       STRFTIME(dt_ultima_extracao, '%d/%m/%Y') AS visivel_ate
FROM receitas_removidas WHERE {where}
ORDER BY valor DESC LIMIT {int(limite)}"""
    return f"""
SELECT SQ_CANDIDATO AS sq_candidato, NM_CANDIDATO AS candidato, SG_PARTIDO AS partido, SG_UF AS uf,
       DS_CARGO AS cargo, DT_DESPESA AS data, {NOME_FORNECEDOR_OU_ANONIMO} AS fornecedor,
       NR_CPF_CNPJ_FORNECEDOR AS fornecedor_id, DS_ORIGEM_DESPESA AS categoria,
       DS_DESPESA AS descricao, ROUND(valor, 2) AS valor,
       STRFTIME(dt_primeira_extracao, '%d/%m/%Y') AS visivel_de,
       STRFTIME(dt_ultima_extracao, '%d/%m/%Y') AS visivel_ate
FROM despesas_removidas WHERE {where}
ORDER BY valor DESC LIMIT {int(limite)}"""


def sql_ficha_candidato(sq: str, tem_fornecedores: bool) -> dict[str, str]:
    w = f"SQ_CANDIDATO = '{esc(sq)}'"
    join_forn = "LEFT JOIN fornecedores f ON d.NR_CPF_CNPJ_FORNECEDOR = f.cnpj" if tem_fornecedores else ""
    cols_forn = (
        ", ANY_VALUE(f.data_abertura) AS empresa_aberta_em, "
        "ANY_VALUE(NULLIF(f.municipio || '/' || f.uf, '/')) AS sede, ANY_VALUE(f.situacao) AS situacao_rfb"
        if tem_fornecedores else ""
    )
    return {
        "indicadores": f"SELECT * FROM indicadores WHERE {w}",
        "registro": f"""
SELECT ANY_VALUE(NM_URNA_CANDIDATO) AS nome_urna, ANY_VALUE(NM_CANDIDATO) AS nome,
       ANY_VALUE(NR_CANDIDATO) AS numero, ANY_VALUE(SG_PARTIDO) AS partido,
       ANY_VALUE(DS_CARGO) AS cargo, ANY_VALUE(SG_UF) AS uf,
       ANY_VALUE(NULLIF(NULLIF(DS_SITUACAO_CANDIDATURA, '#NE'), '#NULO')) AS situacao
FROM candidatos WHERE {w}""",
        "bens": f"""
SELECT DS_TIPO_BEM_CANDIDATO AS tipo, DS_BEM_CANDIDATO AS descricao, ROUND(VR, 2) AS valor
FROM bens WHERE {w} ORDER BY VR DESC LIMIT 30""",
        "serie": f"""
SELECT STRFTIME(dt_extracao, '%Y-%m-%d') AS dt_extracao, ROUND(total_contratado, 2) AS contratado,
       ROUND(total_receitas, 2) AS receitas, itens_despesa
FROM serie_diaria WHERE {w} ORDER BY dt_extracao""",
        "categorias": f"""
SELECT DS_ORIGEM_DESPESA AS categoria, ROUND(SUM(valor), 2) AS total, COUNT(*) AS itens
FROM despesas_atual WHERE {w} GROUP BY 1 ORDER BY total DESC""",
        "origens_receita": f"""
SELECT DS_ORIGEM_RECEITA AS origem, DS_FONTE_RECEITA AS fonte, ROUND(SUM(valor), 2) AS total
FROM receitas_atual WHERE {w} GROUP BY 1, 2 ORDER BY total DESC""",
        "fornecedores": f"""
SELECT {NOME_FORNECEDOR_OU_ANONIMO.replace('NM_FORNECEDOR_RFB', 'd.NM_FORNECEDOR_RFB').replace("NULLIF(NM_FORNECEDOR,", "NULLIF(d.NM_FORNECEDOR,")} AS fornecedor,
       d.NR_CPF_CNPJ_FORNECEDOR AS fornecedor_id,
       ANY_VALUE(d.DS_TIPO_FORNECEDOR) AS tipo,
       ROUND(SUM(d.valor), 2) AS total, COUNT(*) AS itens,
       STRING_AGG(DISTINCT d.DS_ORIGEM_DESPESA, ' · ') AS categorias{cols_forn}
FROM despesas_atual d {join_forn}
WHERE d.{w} GROUP BY 1, 2 ORDER BY total DESC LIMIT 30""",
        "doadores": f"""
SELECT NR_CPF_CNPJ_DOADOR AS doador_id, {NOME_DOADOR_OU_ANONIMO} AS doador,
       ROUND(SUM(valor), 2) AS total,
       ROUND(SUM(valor) FILTER (WHERE {CONDICAO_DOACAO_DIRETA}), 2) AS doacao_direta
FROM receitas_atual WHERE {w} GROUP BY 1, 2 ORDER BY total DESC LIMIT 12""",
        # o anel só fecha com doação DIRETA a ESTE candidato (mesma regra da
        # ficha do site: o repasse de plataforma não conta) — a versão anterior
        # excluía quem doasse via plataforma a QUALQUER candidato
        "dinheiro_que_volta": f"""
SELECT d.contraparte_id AS id, d.contraparte AS nome,
       ROUND(d.valor, 2) AS recebeu_como_fornecedor, ROUND(o.total, 2) AS doou_ao_candidato,
       ROUND(o.direta, 2) AS doacao_direta
FROM rede d JOIN (
    SELECT SQ_CANDIDATO, NR_CPF_CNPJ_DOADOR AS contraparte_id, SUM(valor) AS total,
           SUM(valor) FILTER (WHERE {CONDICAO_DOACAO_DIRETA}) AS direta
    FROM receitas_atual GROUP BY 1, 2) o
  ON o.SQ_CANDIDATO = d.SQ_CANDIDATO AND o.contraparte_id = d.contraparte_id
WHERE d.tipo = 'despesa' AND d.{w} AND d.contraparte_id NOT IN ('-1', '#NULO')
  AND o.direta > 0
ORDER BY recebeu_como_fornecedor DESC LIMIT 10""",
        "sinais": f"""
WITH {sinais_cte()}
SELECT metrica, ROUND(valor, 4) AS valor, ROUND(mediana, 4) AS mediana_do_grupo,
       ROUND(p95, 4) AS p95_do_grupo, grupo_n, grupo_ambito
FROM sinais WHERE {w} ORDER BY metrica""",
        "comparacao": f"""
SELECT b.metrica, b.SG_UF AS ambito, b.candidatos, b.p25, b.mediana, b.p75, b.p95
FROM benchmark_indicadores b
JOIN indicadores i ON b.DS_CARGO = i.DS_CARGO AND b.SG_UF IN (i.SG_UF, 'BR-TODAS')
WHERE i.{w} ORDER BY b.metrica, (b.SG_UF = 'BR-TODAS')""",
        "removidas": sql_removidas("despesas_removidas", w, 30),
        "receitas_removidas": sql_removidas("receitas_removidas", w, 30),
        "corrigidas_despesas": sql_corrigidas("despesas_alteradas", w),
        "corrigidas_receitas": sql_corrigidas("receitas_alteradas", w),
        "notas_marcadas": sql_notas_marcadas(w),
    }


# --------------------------------------------------------------------------- #
# ficha_fornecedor — /fornecedor/:id
# --------------------------------------------------------------------------- #

def sql_ficha_fornecedor(id_: str, tem_norma: bool) -> dict[str, str]:
    w = f"NR_CPF_CNPJ_FORNECEDOR = '{esc(id_)}'"
    sem_nota = analises.cond_sem_documento_fiscal(com_norma=tem_norma)
    doc = sql_documento_da_nota()
    return {
        "perfil": f"""
SELECT ANY_VALUE({NOME_FORNECEDOR}) AS nome,
       ANY_VALUE(NULLIF(DS_TIPO_FORNECEDOR, '#NULO')) AS tipo,
       ANY_VALUE(NULLIF(DS_CNAE_FORNECEDOR, '#NULO')) AS cnae_declarado,
       ANY_VALUE(CASE WHEN SQ_CANDIDATO_FORNECEDOR NOT IN ('-1', '#NULO')
                      THEN SQ_CANDIDATO_FORNECEDOR END) AS e_candidato_sq,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos, COUNT(DISTINCT SG_PARTIDO) AS partidos,
       COUNT(DISTINCT SG_UF) AS ufs, ROUND(SUM(valor), 2) AS total, COUNT(*) AS itens,
       ROUND(SUM(valor) FILTER (WHERE {sem_nota}), 2) AS valor_sem_nota,
       COUNT(*) FILTER (WHERE {CONDICAO_NOTA_SEM_NUMERO}) AS notas_sem_numero
FROM despesas_atual WHERE {w}""",
        "numeros_repetidos": f"""
SELECT NR_DOCUMENTO AS numero, COUNT(DISTINCT SQ_CANDIDATO) AS candidatos,
       STRING_AGG(DISTINCT NM_CANDIDATO, ' | ') AS quem, ROUND(SUM(valor), 2) AS total
FROM despesas_atual WHERE {w} AND {CONDICAO_DOCUMENTO_NUMERADO}
GROUP BY 1 HAVING COUNT(DISTINCT SQ_CANDIDATO) > 1
ORDER BY candidatos DESC, total DESC LIMIT 20""",
        "cadastro_rfb": f"""
SELECT razao_social, data_abertura, situacao, porte, opcao_mei, cnae_principal,
       NULLIF(municipio || '/' || uf, '/') AS sede, capital_social, socios,
       STRFTIME(dt_consulta, '%d/%m/%Y') AS consultado_em,
       situacao_anterior, STRFTIME(dt_situacao_anterior, '%d/%m/%Y') AS situacao_anterior_em
FROM fornecedores WHERE cnpj = '{esc(id_)}'""",
        "como_doador": f"""
SELECT ROUND(SUM(valor), 2) AS total_doado, COUNT(DISTINCT SQ_CANDIDATO) AS candidatos,
       ROUND(SUM(valor) FILTER (WHERE {CONDICAO_DOACAO_DIRETA}), 2) AS doacao_direta
FROM receitas_atual WHERE NR_CPF_CNPJ_DOADOR = '{esc(id_)}'""",
        "candidatos": f"""
SELECT SQ_CANDIDATO AS sq_candidato, ANY_VALUE(NM_CANDIDATO) AS candidato,
       ANY_VALUE(DS_CARGO) AS cargo, ANY_VALUE(SG_PARTIDO) AS partido, ANY_VALUE(SG_UF) AS uf,
       COUNT(*) AS itens, ROUND(SUM(valor), 2) AS total
FROM despesas_atual WHERE {w} GROUP BY 1 ORDER BY total DESC LIMIT 50""",
        "categorias": f"""
SELECT DS_ORIGEM_DESPESA AS categoria, ROUND(SUM(valor), 2) AS total
FROM despesas_atual WHERE {w} GROUP BY 1 ORDER BY total DESC LIMIT 10""",
        "notas": f"""
SELECT DT_DESPESA AS data, SQ_CANDIDATO AS sq_candidato, NM_CANDIDATO AS candidato,
       DS_ORIGEM_DESPESA AS categoria, DS_DESPESA AS descricao, {doc} AS documento,
       ROUND(valor, 2) AS valor,
       ({CONDICAO_NOTA_SEM_NUMERO}) AS nota_sem_numero,
       ({CONDICAO_DOCUMENTO_NUMERADO} AND EXISTS (
          SELECT 1 FROM despesas_atual o
          WHERE o.NR_CPF_CNPJ_FORNECEDOR = despesas_atual.NR_CPF_CNPJ_FORNECEDOR
            AND o.NR_DOCUMENTO = despesas_atual.NR_DOCUMENTO
            AND {CONDICAO_DOCUMENTO_NUMERADO}
            AND o.SQ_CANDIDATO <> despesas_atual.SQ_CANDIDATO)) AS mesmo_numero_em_outro_candidato
FROM despesas_atual WHERE {w} ORDER BY valor DESC LIMIT 50""",
        "doacoes": f"""
SELECT SQ_CANDIDATO AS sq_candidato, NM_CANDIDATO AS candidato, SG_PARTIDO AS partido, SG_UF AS uf,
       DT_RECEITA AS data, DS_ORIGEM_RECEITA AS origem, DS_ESPECIE_RECEITA AS especie,
       ROUND(valor, 2) AS valor, ({CONDICAO_DOACAO_DIRETA}) AS direta
FROM receitas_atual WHERE NR_CPF_CNPJ_DOADOR = '{esc(id_)}' ORDER BY valor DESC LIMIT 30""",
        "removidas": sql_removidas("despesas_removidas", w, 30),
        "corrigidas_despesas": sql_corrigidas("despesas_alteradas", w),
    }


# --------------------------------------------------------------------------- #
# ficha_partido — /partido/:sigla
# --------------------------------------------------------------------------- #

def sql_ficha_partido(sigla: str, uf: str | None) -> dict[str, str]:
    w = f"SG_PARTIDO = '{esc(sigla.upper())}'"
    c = cond_uf(uf)
    if c:
        w = f"{w} AND {c}"
    return {
        "kpis": f"""
SELECT (SELECT COUNT(*) FROM (
          SELECT DISTINCT SQ_CANDIDATO FROM despesas_atual WHERE {w}
          UNION SELECT DISTINCT SQ_CANDIDATO FROM receitas_atual WHERE {w})) AS candidatos_com_movimento,
       (SELECT ROUND(SUM(valor), 2) FROM despesas_atual WHERE {w}) AS total_contratado,
       (SELECT COUNT(DISTINCT NR_CPF_CNPJ_FORNECEDOR) FROM despesas_atual
        WHERE {w} AND NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')) AS fornecedores,
       (SELECT ROUND(SUM(valor), 2) FROM receitas_atual WHERE {w}) AS total_receitas,
       (SELECT ROUND(SUM(CASE WHEN DS_FONTE_RECEITA ILIKE 'FUNDO%' THEN valor ELSE 0 END), 2)
        FROM receitas_atual WHERE {w}) AS fundos_publicos,
       (SELECT ROUND(SUM(CASE WHEN DS_ORIGEM_RECEITA ILIKE '%pr_prio%' THEN valor ELSE 0 END), 2)
        FROM receitas_atual WHERE {w}) AS recursos_proprios""",
        "origens_receita": f"""
SELECT DS_ORIGEM_RECEITA AS origem, ROUND(SUM(valor), 2) AS total
FROM receitas_atual WHERE {w} GROUP BY 1 ORDER BY total DESC LIMIT 8""",
        "doadores_originarios": f"""
SELECT contraparte AS doador_originario, contraparte_id AS id, ROUND(SUM(valor), 2) AS total
FROM rede WHERE tipo = 'doacao_originaria' AND {w}
GROUP BY 1, 2 ORDER BY total DESC LIMIT 10""",
        "fornecedores_compartilhados": f"""
SELECT {NOME_FORNECEDOR} AS fornecedor, NR_CPF_CNPJ_FORNECEDOR AS fornecedor_id,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos, ROUND(SUM(valor), 2) AS total
FROM despesas_atual WHERE {w} AND NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')
GROUP BY 1, 2 HAVING candidatos > 1 ORDER BY total DESC LIMIT 15""",
        "candidatos": f"""
WITH r AS (SELECT SQ_CANDIDATO, ROUND(SUM(valor), 2) AS receitas FROM receitas_atual GROUP BY 1)
SELECT d.SQ_CANDIDATO AS sq_candidato, ANY_VALUE(d.NM_CANDIDATO) AS candidato,
       ANY_VALUE(d.DS_CARGO) AS cargo, ANY_VALUE(d.SG_UF) AS uf,
       ROUND(SUM(d.valor), 2) AS contratado, ANY_VALUE(r.receitas) AS arrecadado
FROM despesas_atual d LEFT JOIN r USING (SQ_CANDIDATO)
WHERE d.{w} GROUP BY 1 ORDER BY contratado DESC LIMIT 50""",
        "cota_fefc": resumo.sql_cota_por_partido(w),
        "custo_por_voto": resumo.sql_custo_por_voto_partido(w),
        "custo_por_voto_por_cargo": resumo.sql_custo_por_voto_partido(w, por_cargo=True),
    }


# --------------------------------------------------------------------------- #
# visões do Explorar
# --------------------------------------------------------------------------- #

def sql_fora_da_curva(sinal: str | None, uf: str | None, cargo: str | None,
                      partido: str | None, limite: int) -> str:
    w = where_recorte(uf, cargo, partido, prefixo="i.")
    filtro_sinal = f" AND s.metrica = '{esc(sinal)}'" if sinal else ""
    ordem = ("ORDER BY sinal_selecionado DESC" if sinal
             else "ORDER BY n_sinais DESC, contratado DESC")
    return f"""
WITH {sinais_cte()}
SELECT i.SQ_CANDIDATO AS sq_candidato, i.NM_CANDIDATO AS candidato, i.SG_PARTIDO AS partido,
       i.SG_UF AS uf, i.DS_CARGO AS cargo,
       ROUND(i.total_contratado, 2) AS contratado, ROUND(i.total_receitas, 2) AS arrecadado,
       {f"ROUND(MAX(CASE WHEN s.metrica = '{esc(sinal)}' THEN s.valor END), 4)" if sinal else "NULL"} AS sinal_selecionado,
       COUNT(*) AS n_sinais,
       STRING_AGG(s.metrica || '~' || ROUND(s.valor, 4) || '~' || ROUND(s.mediana, 4) || '~'
                  || ROUND(s.p95, 4) || '~' || s.grupo_n || '~' || s.grupo_ambito,
                  ';' ORDER BY s.metrica) AS sinais
FROM sinais s JOIN indicadores i USING (SQ_CANDIDATO)
WHERE {w}{filtro_sinal}
GROUP BY ALL
{ordem}
LIMIT {int(limite)}"""


def desmontar_sinais(texto: str | None) -> list[dict]:
    """'metrica~valor~mediana~p95~n~ambito;...' -> lista de dicts."""
    saida = []
    for parte in (texto or "").split(";"):
        if not parte:
            continue
        m, v, med, p95, n, amb = parte.split("~")
        saida.append({"metrica": m, "valor": float(v), "mediana_do_grupo": float(med),
                      "p95_do_grupo": float(p95), "grupo_n": int(n), "grupo_ambito": amb})
    return saida


def sql_declaracoes_removidas(tipo: str, uf: str | None, cargo: str | None,
                              partido: str | None, sq: str | None, limite: int) -> str:
    w = where_recorte(uf, cargo, partido)
    if sq:
        w = f"{w} AND SQ_CANDIDATO = '{esc(sq)}'"
    tabela = "receitas_removidas" if tipo == "receita" else "despesas_removidas"
    return sql_removidas(tabela, w, limite)


def sql_fornecedores_compartilhados(uf: str | None, cargo: str | None, partido: str | None,
                                    minimo: int, limite: int) -> str:
    w = where_recorte(uf, cargo, partido)
    return f"""
SELECT {NOME_FORNECEDOR} AS fornecedor, NR_CPF_CNPJ_FORNECEDOR AS fornecedor_id,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos, COUNT(DISTINCT SG_PARTIDO) AS partidos,
       STRING_AGG(DISTINCT SG_UF, ', ') AS ufs,
       STRING_AGG(DISTINCT NM_CANDIDATO, ' | ') AS quem,
       ROUND(SUM(valor), 2) AS total
FROM despesas_atual WHERE {w} AND NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')
GROUP BY 1, 2 HAVING COUNT(DISTINCT SQ_CANDIDATO) >= {int(minimo)}
ORDER BY total DESC LIMIT {int(limite)}"""


def sql_sem_nota(uf: str | None, cargo: str | None, partido: str | None, limite: int) -> str:
    """Quem mais declarou gasto sem documento fiscal onde a nota é a norma —
    o indicador valor_sem_nota já traz a régua de src/analises.py aplicada."""
    w = where_recorte(uf, cargo, partido, prefixo="i.")
    return f"""
SELECT i.SQ_CANDIDATO AS sq_candidato, i.NM_CANDIDATO AS candidato, i.SG_PARTIDO AS partido,
       i.SG_UF AS uf, i.DS_CARGO AS cargo,
       ROUND(i.valor_sem_nota, 2) AS valor_sem_nota, ROUND(i.pct_sem_nota, 1) AS pct_sem_nota,
       ROUND(i.total_contratado, 2) AS contratado,
       COALESCE(buf.p95, bbr.p95) AS p95_do_grupo,
       CASE WHEN buf.p95 IS NOT NULL THEN i.SG_UF ELSE 'BR-TODAS' END AS grupo_ambito
FROM indicadores i
LEFT JOIN benchmark_indicadores buf
  ON buf.DS_CARGO = i.DS_CARGO AND buf.SG_UF = i.SG_UF AND buf.metrica = 'pct_sem_nota'
LEFT JOIN benchmark_indicadores bbr
  ON bbr.DS_CARGO = i.DS_CARGO AND bbr.SG_UF = 'BR-TODAS' AND bbr.metrica = 'pct_sem_nota'
WHERE {w} AND i.valor_sem_nota > 0
ORDER BY i.valor_sem_nota DESC LIMIT {int(limite)}"""


ORDENS_CUSTO_POR_VOTO = {
    "maior_custo": "i.custo_por_voto DESC",
    "menor_custo": "i.custo_por_voto ASC",
    "mais_votos": "i.votos DESC",
    "maior_gasto": "i.total_contratado DESC",
}


def sql_custo_por_voto(uf: str | None, cargo: str | None, partido: str | None,
                       ordem: str, so_eleitos: bool, limite: int) -> str:
    """Custo por voto de cada candidato no recorte, com a distribuição do grupo
    (cargo×UF; nacional quando o grupo local é pequeno) ao lado. Lê as colunas
    que src/agregados.py já calculou — o denominador é o 1º turno — e nunca
    refaz a divisão aqui."""
    w = where_recorte(uf, cargo, partido, prefixo="i.")
    eleitos = " AND i.resultado LIKE 'ELEITO%'" if so_eleitos else ""
    return f"""
SELECT i.SQ_CANDIDATO AS sq_candidato, i.NM_CANDIDATO AS candidato,
       i.NM_URNA_CANDIDATO AS nome_urna, i.SG_PARTIDO AS partido, i.SG_UF AS uf,
       i.DS_CARGO AS cargo, i.resultado, i.votos AS votos_1t, i.votos_2t,
       ROUND(i.total_contratado, 2) AS contratado, ROUND(i.total_receitas, 2) AS arrecadado,
       ROUND(i.fundos_publicos, 2) AS fundos_publicos, ROUND(i.recursos_proprios, 2) AS recursos_proprios,
       i.custo_por_voto, i.custo_publico_por_voto, i.custo_proprio_por_voto,
       i.custo_terceiros_por_voto,
       COALESCE(buf.mediana, bbr.mediana) AS mediana_do_grupo,
       COALESCE(buf.p95, bbr.p95) AS p95_do_grupo,
       COALESCE(buf.candidatos, bbr.candidatos) AS grupo_n,
       CASE WHEN buf.p95 IS NOT NULL THEN i.SG_UF ELSE 'BR-TODAS' END AS grupo_ambito
FROM indicadores i
LEFT JOIN benchmark_indicadores buf
  ON buf.DS_CARGO = i.DS_CARGO AND buf.SG_UF = i.SG_UF AND buf.metrica = 'custo_por_voto'
LEFT JOIN benchmark_indicadores bbr
  ON bbr.DS_CARGO = i.DS_CARGO AND bbr.SG_UF = 'BR-TODAS' AND bbr.metrica = 'custo_por_voto'
WHERE {w} AND i.custo_por_voto IS NOT NULL{eleitos}
ORDER BY {ORDENS_CUSTO_POR_VOTO[ordem]} LIMIT {int(limite)}"""


def sql_gastos_por_categoria(uf: str | None, cargo: str | None, partido: str | None,
                             categoria: str | None, limite: int) -> str:
    """Total por categoria no recorte, com a régua nacional de preço por nota."""
    w = where_recorte(uf, cargo, partido)
    c = cond_texto(categoria, ["DS_ORIGEM_DESPESA"], plural=True) if categoria else None
    if c:
        w = f"{w} AND {c}"
    return f"""
SELECT DS_ORIGEM_DESPESA AS categoria, ROUND(SUM(valor), 2) AS total,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos, COUNT(*) AS itens,
       (SELECT ROUND(mediana, 2) FROM benchmark_precos b
        WHERE b.DS_ORIGEM_DESPESA = d.DS_ORIGEM_DESPESA AND b.SG_UF = 'BR-TODAS') AS mediana_nacional_por_nota
FROM despesas_atual d WHERE {w}
GROUP BY 1 ORDER BY total DESC LIMIT {int(limite)}"""


# --------------------------------------------------------------------------- #
# notas_fora_do_preco
# --------------------------------------------------------------------------- #

def sql_notas_fora_do_preco(uf: str | None, cargo: str | None, partido: str | None,
                            sq: str | None, categoria: str | None, limite: int) -> str:
    """Notas acima do p95 de preço da própria categoria (benchmark_precos).

    A nota é montada com CHAVE_NOTA — a mesma chave que gerou os percentis em
    src/agregados.py. Montada de outro jeito (por item, ou por fornecedor), o
    número comparado teria uma forma e a régua outra, e a comparação seria
    silenciosamente errada. O p95 é o da UF quando o grupo existe, senão o
    nacional; `vezes_o_p95` deixa a conta à vista."""
    w = where_recorte(uf, cargo, partido)
    if sq:
        w = f"{w} AND SQ_CANDIDATO = '{esc(sq)}'"
    c = cond_texto(categoria, ["DS_ORIGEM_DESPESA"], plural=True) if categoria else None
    if c:
        w = f"{w} AND {c}"
    doc = sql_documento_da_nota()
    return f"""
WITH itens AS (SELECT * FROM despesas_atual
               WHERE {w} AND valor > 0 AND DS_ORIGEM_DESPESA <> '#NULO'),
notas AS (
  SELECT SQ_CANDIDATO AS sq_candidato, DS_ORIGEM_DESPESA AS categoria, SG_UF AS uf,
         ANY_VALUE(NM_CANDIDATO) AS candidato, ANY_VALUE(SG_PARTIDO) AS partido,
         ANY_VALUE(DS_CARGO) AS cargo,
         ANY_VALUE({NOME_FORNECEDOR_OU_ANONIMO}) AS fornecedor,
         ANY_VALUE(NR_CPF_CNPJ_FORNECEDOR) AS fornecedor_id,
         ANY_VALUE(DT_DESPESA) AS data,
         STRING_AGG(DISTINCT DS_DESPESA, ' - ') AS descricao,
         ANY_VALUE({doc}) AS documento,
         COUNT(*) AS itens, ROUND(SUM(valor), 2) AS valor
  FROM itens WHERE SQ_DESPESA <> '{SEM_ID_DESPESA}'
  GROUP BY DS_ORIGEM_DESPESA, SG_UF, {CHAVE_NOTA}
  UNION ALL
  SELECT SQ_CANDIDATO, DS_ORIGEM_DESPESA, SG_UF, NM_CANDIDATO, SG_PARTIDO, DS_CARGO,
         {NOME_FORNECEDOR_OU_ANONIMO}, NR_CPF_CNPJ_FORNECEDOR, DT_DESPESA, DS_DESPESA,
         {doc}, 1, ROUND(valor, 2)
  FROM itens WHERE SQ_DESPESA = '{SEM_ID_DESPESA}'),
com_regua AS (
  SELECT n.*, COALESCE(buf.p95, bbr.p95) AS p95,
         COALESCE(buf.mediana, bbr.mediana) AS mediana,
         COALESCE(buf.notas, bbr.notas) AS notas_no_grupo,
         CASE WHEN buf.p95 IS NOT NULL THEN n.uf ELSE 'BR-TODAS' END AS grupo_ambito
  FROM notas n
  LEFT JOIN benchmark_precos buf
    ON buf.DS_ORIGEM_DESPESA = n.categoria AND buf.SG_UF = n.uf
  LEFT JOIN benchmark_precos bbr
    ON bbr.DS_ORIGEM_DESPESA = n.categoria AND bbr.SG_UF = 'BR-TODAS')
SELECT sq_candidato, candidato, partido, cargo, uf, categoria, fornecedor, fornecedor_id,
       data, descricao, documento, itens, valor,
       mediana AS mediana_do_grupo, p95 AS p95_do_grupo, notas_no_grupo, grupo_ambito,
       ROUND(valor / NULLIF(p95, 0), 1) AS vezes_o_p95
FROM com_regua WHERE p95 IS NOT NULL AND valor > p95
ORDER BY valor / NULLIF(p95, 0) DESC LIMIT {int(limite)}"""


# --------------------------------------------------------------------------- #
# candidatos_conectados
# --------------------------------------------------------------------------- #

TIPOS_REDE = ("despesa", "doacao", "doacao_originaria")


def sql_contrapartes_ignoradas(tipos: tuple[str, ...], maximo: int) -> str:
    """As contrapartes tratadas como infraestrutura — a resposta as lista para
    o corte ficar conferível em vez de silencioso."""
    lista = ", ".join(f"'{esc(t)}'" for t in tipos)
    return f"""
SELECT contraparte_id, ANY_VALUE(contraparte) AS contraparte,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos
FROM rede WHERE tipo IN ({lista}) AND contraparte_id NOT IN ('-1', '#NULO')
GROUP BY 1 HAVING COUNT(DISTINCT SQ_CANDIDATO) > {int(maximo)}
ORDER BY candidatos DESC"""


def sql_candidatos_conectados(sq: str, niveis: int, tipos: tuple[str, ...],
                              maximo: int, limite: int) -> str:
    """Quem alcanca quem pela rede de contrapartes compartilhadas.

    Cada nivel e uma CTE explicita (e nao uma CTE recursiva) porque o que
    interessa nao e so QUEM foi alcancado, mas POR ONDE: sem a contraparte que
    fez a ponte, uma lista de nivel 3 nao e conferivel. Um candidato aparece
    uma vez so, no nivel mais curto em que foi alcancado; contraparte ja usada
    nao reabre o nivel seguinte."""
    lista = ", ".join(f"'{esc(t)}'" for t in tipos)
    niveis = max(1, min(int(niveis), MAX_NIVEIS_CONEXAO))
    partes = [f"""
WITH r AS (
  SELECT SQ_CANDIDATO, contraparte_id, contraparte, tipo, valor
  FROM rede WHERE tipo IN ({lista}) AND contraparte_id NOT IN ('-1', '#NULO')),
hubs AS (
  SELECT contraparte_id FROM r GROUP BY 1
  HAVING COUNT(DISTINCT SQ_CANDIDATO) > {int(maximo)}),
g AS (SELECT * FROM r WHERE contraparte_id NOT IN (SELECT contraparte_id FROM hubs)),
n0 AS (SELECT '{esc(sq)}' AS SQ_CANDIDATO)"""]
    for k in range(1, niveis + 1):
        vistos = " UNION ALL ".join(f"SELECT SQ_CANDIDATO FROM n{i}" for i in range(k))
        usadas = ""
        if k > 1:
            ja = " UNION ALL ".join(f"SELECT contraparte_id FROM f{i}" for i in range(1, k))
            usadas = f" AND contraparte_id NOT IN ({ja})"
        partes.append(f""",
f{k} AS (
  SELECT DISTINCT contraparte_id FROM g
  WHERE SQ_CANDIDATO IN (SELECT SQ_CANDIDATO FROM n{k - 1}){usadas}),
a{k} AS (
  SELECT g.SQ_CANDIDATO, {k} AS nivel, g.contraparte_id, g.contraparte, g.tipo, g.valor
  FROM g JOIN f{k} USING (contraparte_id)
  WHERE g.SQ_CANDIDATO NOT IN ({vistos})),
n{k} AS (SELECT DISTINCT SQ_CANDIDATO FROM a{k})""")
    alcance = " UNION ALL ".join(f"SELECT * FROM a{k}" for k in range(1, niveis + 1))
    partes.append(f""",
alcance AS ({alcance}),
rotulos AS (
  SELECT SQ_CANDIDATO, ANY_VALUE(NM_CANDIDATO) AS candidato,
         ANY_VALUE(SG_PARTIDO) AS partido, ANY_VALUE(DS_CARGO) AS cargo,
         ANY_VALUE(SG_UF) AS uf
  FROM rede WHERE SQ_CANDIDATO IN (SELECT SQ_CANDIDATO FROM alcance) GROUP BY 1)
SELECT a.SQ_CANDIDATO AS sq_candidato, rot.candidato, rot.partido, rot.cargo, rot.uf,
       MIN(a.nivel) AS nivel,
       COUNT(DISTINCT a.contraparte_id) AS contrapartes_em_comum,
       STRING_AGG(DISTINCT a.contraparte, ' | ') AS por_meio_de,
       STRING_AGG(DISTINCT a.tipo, ', ') AS tipos,
       ROUND(SUM(a.valor), 2) AS valor_nas_arestas
FROM alcance a JOIN rotulos rot USING (SQ_CANDIDATO)
GROUP BY 1, 2, 3, 4, 5
ORDER BY nivel, contrapartes_em_comum DESC, valor_nas_arestas DESC
LIMIT {int(limite)}""")
    return "".join(partes)


# --------------------------------------------------------------------------- #
# buscar_fornecedor
# --------------------------------------------------------------------------- #

def sql_buscar_fornecedor(termo: str, uf: str | None, limite: int) -> str:
    """Localiza contraparte por nome (parcial) ou CNPJ e devolve o id que
    ficha_fornecedor consome. Procura nos DOIS papeis — quem recebeu despesa e
    quem doou — porque a ficha cobre os dois e um doador puro nao aparece em
    despesas_atual."""
    id_ = limpar_id(termo)
    if id_:
        onde_d = f"NR_CPF_CNPJ_FORNECEDOR = '{esc(id_)}'"
        onde_r = f"NR_CPF_CNPJ_DOADOR = '{esc(id_)}'"
    else:
        onde_d = cond_texto(termo, ["NM_FORNECEDOR_RFB", "NM_FORNECEDOR"]) or "1=0"
        onde_r = cond_texto(termo, ["NM_DOADOR_RFB", "NM_DOADOR"]) or "1=0"
    filtro_uf = cond_uf(uf)
    if filtro_uf:
        onde_d = f"{onde_d} AND {filtro_uf}"
        onde_r = f"{onde_r} AND {filtro_uf}"
    return f"""
WITH papeis AS (
  SELECT NR_CPF_CNPJ_FORNECEDOR AS id, {NOME_FORNECEDOR_OU_ANONIMO} AS nome,
         SQ_CANDIDATO, SG_UF, valor, 'fornecedor' AS papel
  FROM despesas_atual
  WHERE {onde_d} AND NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1', '#NULO')
  UNION ALL
  SELECT NR_CPF_CNPJ_DOADOR, {NOME_DOADOR_OU_ANONIMO}, SQ_CANDIDATO, SG_UF, valor, 'doador'
  FROM receitas_atual
  WHERE {onde_r} AND NR_CPF_CNPJ_DOADOR NOT IN ('-1', '#NULO'))
SELECT id, ANY_VALUE(nome) AS nome,
       CASE WHEN id LIKE 'pf-%' THEN 'pessoa_fisica_pseudonimizada' ELSE 'cnpj' END AS tipo_id,
       STRING_AGG(DISTINCT papel, ', ') AS papeis,
       COUNT(DISTINCT SQ_CANDIDATO) AS candidatos,
       STRING_AGG(DISTINCT SG_UF, ', ') AS ufs,
       ROUND(SUM(valor), 2) AS total
FROM papeis GROUP BY 1
ORDER BY total DESC LIMIT {int(limite)}"""


# --------------------------------------------------------------------------- #
# fornecedores_por_cadastro
# --------------------------------------------------------------------------- #

def sql_fornecedores_por_cadastro(uf: str | None, cargo: str | None, partido: str | None,
                                  situacao: str | None, aberto_apos: str | None,
                                  limite: int) -> str:
    """Fornecedores com CNPJ cruzados com o cadastro da Receita.

    A tabela `fornecedores` é preenchida aos poucos (limite diário de consultas
    na rotina), então a resposta precisa dizer a COBERTURA: sem isso, "só 5
    empresas baixadas" se confunde com "só 5 empresas verificadas"."""
    w = where_recorte(uf, cargo, partido, prefixo="d.")
    filtros = [w, "f.cnpj IS NOT NULL"]
    if situacao:
        filtros.append(f"f.situacao ILIKE '%{esc(situacao)}%'")
    if aberto_apos:
        filtros.append(f"f.data_abertura >= '{esc(aberto_apos)}'")
    return f"""
SELECT f.cnpj AS fornecedor_id, f.razao_social AS fornecedor, f.situacao,
       f.situacao_anterior, f.dt_situacao_anterior, f.data_abertura, f.porte,
       f.opcao_mei, f.capital_social, f.cnae_principal,
       f.municipio, f.uf AS uf_da_empresa, f.dt_consulta,
       COUNT(DISTINCT d.SQ_CANDIDATO) AS candidatos,
       STRING_AGG(DISTINCT d.SG_UF, ', ') AS ufs_dos_candidatos,
       ROUND(SUM(d.valor), 2) AS total_recebido
FROM despesas_atual d JOIN fornecedores f ON f.cnpj = d.NR_CPF_CNPJ_FORNECEDOR
WHERE {' AND '.join(filtros)}
GROUP BY ALL
ORDER BY total_recebido DESC LIMIT {int(limite)}"""


def sql_cobertura_do_cadastro(uf: str | None, cargo: str | None, partido: str | None) -> str:
    """Quantos CNPJs do recorte já foram consultados na Receita — o denominador
    sem o qual qualquer contagem de situação cadastral engana."""
    w = where_recorte(uf, cargo, partido, prefixo="d.")
    return f"""
SELECT COUNT(DISTINCT d.NR_CPF_CNPJ_FORNECEDOR) AS cnpjs_no_recorte,
       COUNT(DISTINCT f.cnpj) AS cnpjs_consultados
FROM despesas_atual d
LEFT JOIN fornecedores f ON f.cnpj = d.NR_CPF_CNPJ_FORNECEDOR
WHERE {w} AND regexp_full_match(d.NR_CPF_CNPJ_FORNECEDOR, '[0-9]{{14}}')"""


# --------------------------------------------------------------------------- #
# novidades
# --------------------------------------------------------------------------- #

def sql_novidades(tipo: str, desde: str | None, uf: str | None, cargo: str | None,
                  partido: str | None, sq: str | None, limite: int) -> str:
    """O que ENTROU na prestação a partir de uma extração (dt_primeira_extracao).

    O contrário de declaracoes_removidas, e o único jeito de ver despesa
    declarada tarde. Entrar tarde não é indício por si: a prestação é
    incremental e o candidato declara quando quer, dentro do prazo."""
    tabela = "receitas_atual" if tipo == "receita" else "despesas_atual"
    w = where_recorte(uf, cargo, partido)
    if sq:
        w = f"{w} AND SQ_CANDIDATO = '{esc(sq)}'"
    if desde:
        w = f"{w} AND dt_primeira_extracao >= '{esc(desde)}'"
    else:
        w = f"{w} AND dt_primeira_extracao = (SELECT MAX(dt_primeira_extracao) FROM {tabela})"
    if tipo == "receita":
        quem = f"{NOME_DOADOR_OU_ANONIMO} AS contraparte, NR_CPF_CNPJ_DOADOR AS contraparte_id"
        oque = "DS_ORIGEM_RECEITA AS categoria, DS_FONTE_RECEITA AS fonte, DT_RECEITA AS data"
    else:
        quem = f"{NOME_FORNECEDOR_OU_ANONIMO} AS contraparte, NR_CPF_CNPJ_FORNECEDOR AS contraparte_id"
        oque = "DS_ORIGEM_DESPESA AS categoria, DS_DESPESA AS descricao, DT_DESPESA AS data"
    return f"""
SELECT dt_primeira_extracao AS entrou_em, SQ_CANDIDATO AS sq_candidato,
       NM_CANDIDATO AS candidato, SG_PARTIDO AS partido, DS_CARGO AS cargo, SG_UF AS uf,
       {quem}, {oque}, ROUND(valor, 2) AS valor
FROM {tabela} WHERE {w}
ORDER BY valor DESC LIMIT {int(limite)}"""


def sql_resumo_das_novidades(tipo: str, desde: str | None, uf: str | None, cargo: str | None,
                             partido: str | None, sq: str | None) -> str:
    """Os totais do recorte — a lista tem `limite`, e somar só o listado daria
    um número menor que o real sem avisar."""
    tabela = "receitas_atual" if tipo == "receita" else "despesas_atual"
    w = where_recorte(uf, cargo, partido)
    if sq:
        w = f"{w} AND SQ_CANDIDATO = '{esc(sq)}'"
    if desde:
        w = f"{w} AND dt_primeira_extracao >= '{esc(desde)}'"
    else:
        w = f"{w} AND dt_primeira_extracao = (SELECT MAX(dt_primeira_extracao) FROM {tabela})"
    return f"""
SELECT MIN(dt_primeira_extracao) AS da_extracao, MAX(dt_primeira_extracao) AS ate_a_extracao,
       COUNT(*) AS linhas, COUNT(DISTINCT SQ_CANDIDATO) AS candidatos,
       ROUND(SUM(valor), 2) AS valor_total
FROM {tabela} WHERE {w}"""


def limpar_id(id_: str) -> str | None:
    """CNPJ (14 dígitos, com ou sem pontuação) ou código pf-… de pessoa física."""
    id_ = (id_ or "").strip()
    if re.fullmatch(r"pf-[0-9a-f]{16}", id_):
        return id_
    digitos = re.sub(r"\D", "", id_)
    if len(digitos) == 14:
        return digitos
    return None
