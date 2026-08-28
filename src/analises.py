"""Catálogo de análises (red flags) sobre o banco DuckDB.

Cada análise devolve (título, comentário, DataFrame). Os resultados são
indícios para investigação, nunca prova de irregularidade.
"""

import pandas as pd

# Categorias em que documento fiscal não é esperado: transferências entre
# campanhas, tributos e tarifas; locação de imóvel (não é serviço — não há NF,
# o documento próprio é o recibo de aluguel); pessoal (RPA/folha, sem NF).
CATEGORIAS_SEM_NOTA_ESPERADA = (
    "Doações financeiras a outros candidatos/partidos",
    "Encargos financeiros, taxas bancárias e/ou op. cartão de crédito",
    "Encargos sociais",
    "Impostos, contribuições e taxas",
    "Locação/cessão de bens imóveis",
    "Despesas com pessoal",
)
SQL_CATEGORIAS_SEM_NOTA_ESPERADA = ", ".join(f"'{c}'" for c in CATEGORIAS_SEM_NOTA_ESPERADA)


def montar_filtro(numeros=None, uf=None, alias="") -> str:
    """WHERE parcial para limitar aos candidatos-alvo. Vazio = todos."""
    p = f"{alias}." if alias else ""
    partes = []
    if numeros:
        lista = ", ".join(f"'{n}'" for n in numeros)
        partes.append(f"{p}NR_CANDIDATO IN ({lista})")
    if uf:
        partes.append(f"{p}SG_UF = '{uf}'")
    return " AND ".join(partes) or "1=1"


def executar_todas(con, numeros=None, uf=None):
    f = montar_filtro(numeros, uf)
    resultados = []

    def q(titulo, comentario, sql):
        df = con.execute(sql).df()
        resultados.append((titulo, comentario, df))

    q("Resumo financeiro por candidato",
      "Total arrecadado, contratado e pago. Diferenças grandes entre contratado e pago perto do fim da campanha merecem atenção. "
      "Dinheiro público = Fundo Especial + Fundo Partidário (coluna DS_FONTE_RECEITA; a origem declarada costuma ser 'Recursos de partido político').",
      f"""
      WITH rec AS (
        SELECT SQ_CANDIDATO, SUM(VR) AS receita,
               SUM(CASE WHEN DS_FONTE_RECEITA ILIKE 'FUNDO%' THEN VR ELSE 0 END) AS fundos_publicos,
               SUM(CASE WHEN DS_ORIGEM_RECEITA ILIKE '%f_sica%' OR DS_ORIGEM_RECEITA ILIKE '%fisica%' THEN VR ELSE 0 END) AS pessoas_fisicas,
               SUM(CASE WHEN DS_ORIGEM_RECEITA ILIKE '%pr_prio%' THEN VR ELSE 0 END) AS recursos_proprios
        FROM v_receitas WHERE {f} GROUP BY 1),
      desp AS (SELECT SQ_CANDIDATO, SUM(VR) AS contratado FROM v_despesas WHERE {f} GROUP BY 1),
      pag AS (SELECT SQ_CANDIDATO, SUM(VR) AS pago FROM v_despesas_pagas WHERE {f} GROUP BY 1),
      cand AS (SELECT DISTINCT SQ_CANDIDATO, NM_CANDIDATO, NR_CANDIDATO, SG_PARTIDO, DS_CARGO, SG_UF
               FROM candidatos WHERE {f})
      SELECT c.NM_CANDIDATO, c.NR_CANDIDATO, c.SG_PARTIDO, c.DS_CARGO, c.SG_UF,
             ROUND(COALESCE(r.receita,0),2) AS receita_total,
             ROUND(COALESCE(r.fundos_publicos,0),2) AS fundos_publicos,
             ROUND(COALESCE(r.pessoas_fisicas,0),2) AS pessoas_fisicas,
             ROUND(COALESCE(r.recursos_proprios,0),2) AS recursos_proprios,
             ROUND(COALESCE(d.contratado,0),2) AS despesa_contratada,
             ROUND(COALESCE(p.pago,0),2) AS despesa_paga
      FROM cand c LEFT JOIN rec r USING (SQ_CANDIDATO)
      LEFT JOIN desp d USING (SQ_CANDIDATO) LEFT JOIN pag p USING (SQ_CANDIDATO)
      WHERE {'1=1' if numeros else 'COALESCE(r.receita,0) > 0 OR COALESCE(d.contratado,0) > 0'}
      ORDER BY receita_total DESC
      """)

    q("Fornecedores por candidato (concentração)",
      "Percentual alto em um único fornecedor pode indicar direcionamento.",
      f"""
      WITH d AS (
        SELECT NM_CANDIDATO, NR_CANDIDATO, NR_CPF_CNPJ_FORNECEDOR AS cnpj_cpf,
               COALESCE(NULLIF(NM_FORNECEDOR_RFB,'#NULO'), NM_FORNECEDOR) AS fornecedor,
               DS_CNAE_FORNECEDOR, COUNT(*) AS notas, SUM(VR) AS total
        FROM v_despesas WHERE {f} GROUP BY ALL)
      SELECT NM_CANDIDATO, fornecedor, cnpj_cpf, DS_CNAE_FORNECEDOR, notas,
             ROUND(total,2) AS total,
             ROUND(100.0 * total / SUM(total) OVER (PARTITION BY NR_CANDIDATO), 1) AS pct_do_candidato
      FROM d ORDER BY NM_CANDIDATO, total DESC
      """)

    q("Fornecedores compartilhados com outros candidatos",
      "Fornecedores dos candidatos-alvo que também atendem outros candidatos (qualquer UF): pode ser empresa consolidada ou rateio/esquema.",
      f"""
      WITH alvo AS (SELECT DISTINCT NR_CPF_CNPJ_FORNECEDOR FROM v_despesas
                    WHERE {f} AND NR_CPF_CNPJ_FORNECEDOR NOT IN ('-1','#NULO'))
      SELECT COALESCE(NULLIF(d.NM_FORNECEDOR_RFB,'#NULO'), d.NM_FORNECEDOR) AS fornecedor,
             d.NR_CPF_CNPJ_FORNECEDOR AS cnpj_cpf,
             COUNT(DISTINCT d.SQ_CANDIDATO) AS candidatos_atendidos,
             COUNT(DISTINCT d.SG_PARTIDO) AS partidos,
             ROUND(SUM(d.VR),2) AS total_recebido_geral,
             STRING_AGG(DISTINCT d.SG_UF, ',') AS ufs
      FROM v_despesas d JOIN alvo USING (NR_CPF_CNPJ_FORNECEDOR)
      GROUP BY ALL HAVING candidatos_atendidos > 1
      ORDER BY total_recebido_geral DESC
      """)

    q("Doador que também é fornecedor",
      "Mesmo CPF/CNPJ doando e recebendo do mesmo candidato: dinheiro que 'volta'.",
      f"""
      SELECT r.NM_CANDIDATO, r.NM_DOADOR, r.NR_CPF_CNPJ_DOADOR AS cpf_cnpj,
             ROUND(SUM(r.VR),2) AS doou, COUNT(*) AS doacoes,
             (SELECT ROUND(SUM(d.VR),2) FROM v_despesas d
              WHERE d.SQ_CANDIDATO = r.SQ_CANDIDATO
                AND d.NR_CPF_CNPJ_FORNECEDOR = r.NR_CPF_CNPJ_DOADOR) AS recebeu_como_fornecedor
      FROM v_receitas r
      WHERE {montar_filtro(numeros, uf, 'r')} AND r.NR_CPF_CNPJ_DOADOR NOT IN ('-1','#NULO','-4')
        AND EXISTS (SELECT 1 FROM v_despesas d WHERE d.SQ_CANDIDATO = r.SQ_CANDIDATO
                    AND d.NR_CPF_CNPJ_FORNECEDOR = r.NR_CPF_CNPJ_DOADOR)
      GROUP BY ALL ORDER BY doou DESC
      """)

    q("O que cada fornecedor vendeu × ramo de atividade (CNAE)",
      "Inspecionar: serviço prestado incompatível com o ramo da empresa é um clássico (ex.: confecção de roupas emitindo nota de carro de som).",
      f"""
      SELECT NM_CANDIDATO,
             COALESCE(NULLIF(NM_FORNECEDOR_RFB,'#NULO'), NM_FORNECEDOR) AS fornecedor,
             DS_CNAE_FORNECEDOR AS ramo_cnae, DS_ORIGEM_DESPESA AS tipo_gasto,
             DS_DESPESA AS descricao, ROUND(VR,2) AS valor, DT_DESPESA
      FROM v_despesas WHERE {f} ORDER BY NM_CANDIDATO, VR DESC
      """)

    q("Fornecedores pessoa física",
      "Serviços relevantes prestados por PF (sem empresa) merecem checagem de vínculo.",
      f"""
      SELECT NM_CANDIDATO, NM_FORNECEDOR, DS_ORIGEM_DESPESA, DS_DESPESA,
             ROUND(SUM(VR),2) AS total, COUNT(*) AS notas
      FROM v_despesas WHERE {f} AND DS_TIPO_FORNECEDOR ILIKE '%f_sica%'
      GROUP BY ALL ORDER BY total DESC
      """)

    q("Valores repetidos",
      "Mesmo valor em 3+ notas distintas pode indicar fracionamento. Itens repetidos "
      "de uma mesma nota (padrão dos arquivos do TSE) não contam.",
      f"""
      SELECT NM_CANDIDATO, VR AS valor, COUNT(*) AS ocorrencias,
             COUNT(DISTINCT SQ_DESPESA) AS notas_distintas,
             COUNT(DISTINCT NR_CPF_CNPJ_FORNECEDOR) AS fornecedores_distintos
      FROM v_despesas WHERE {f}
      GROUP BY ALL HAVING notas_distintas >= 3 ORDER BY ocorrencias DESC, valor DESC
      """)

    q("Fornecedor que também é candidato",
      "Negócio entre candidatos: atenção a triangulação de recursos.",
      f"""
      SELECT NM_CANDIDATO, NM_FORNECEDOR, SG_PARTIDO_FORNECEDOR, DS_CARGO_FORNECEDOR,
             DS_ORIGEM_DESPESA, ROUND(SUM(VR),2) AS total
      FROM v_despesas WHERE {f} AND SQ_CANDIDATO_FORNECEDOR NOT IN ('-1','#NULO')
      GROUP BY ALL ORDER BY total DESC
      """)

    q("Despesas sem nota fiscal",
      "Documentos diferentes de nota fiscal (ou ausentes) têm menor rastreabilidade. "
      "Categorias sem documento fiscal esperado (transferências, tributos, tarifas) ficam de fora.",
      f"""
      SELECT NM_CANDIDATO, DS_TIPO_DOCUMENTO, COUNT(*) AS notas, ROUND(SUM(VR),2) AS total
      FROM v_despesas WHERE {f}
        AND (DS_TIPO_DOCUMENTO IS NULL OR DS_TIPO_DOCUMENTO IN ('#NULO')
             OR DS_TIPO_DOCUMENTO NOT ILIKE '%nota fiscal%')
        AND DS_ORIGEM_DESPESA NOT IN ({SQL_CATEGORIAS_SEM_NOTA_ESPERADA})
      GROUP BY ALL ORDER BY total DESC
      """)

    return resultados


def gerar_markdown(resultados, titulo="Análise de gastos de campanha") -> str:
    linhas = [f"# {titulo}", "",
              "> Dados declarados ao TSE. Todo achado é **indício** a investigar, não prova de irregularidade.", ""]
    for t, comentario, df in resultados:
        linhas += [f"## {t}", "", f"_{comentario}_", ""]
        if df.empty:
            linhas += ["Nada encontrado.", ""]
        else:
            linhas += [df.to_markdown(index=False), ""]
    return "\n".join(linhas)
