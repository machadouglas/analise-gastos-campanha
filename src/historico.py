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

# tabelas versionadas -> id da nota no arquivo do TSE. NÃO serve para parear
# versões: o SPCE regenera os SQ_* a cada retransmissão (nos dados publicados,
# 10.112 notas já trocaram de SQ e 3.489 SQ apontam para mais de uma nota).
TABELAS = {
    "despesas_contratadas": "SQ_DESPESA",
    "receitas": "SQ_RECEITA",
}

# "Essência" do fato declarado, em duas partes:
# IDENTIDADE — a quem o dinheiro liga (candidato ↔ contraparte). Uma mudança
#   aqui é outro fato, nunca uma correção do mesmo.
# VARIAVEIS — o que uma retificação costuma mexer: quanto, do quê, quando.
# Quando o candidato retransmite a prestação, o SPCE regenera os SQ_* e
# metadados — o conteúdo "some" e renasce com id novo. Uma remoção REAL é a que
# não reaparece nem com a mesma essência nem como edição (ver _condicao_edicao).
IDENTIDADE = {
    "despesas_contratadas": ["SQ_CANDIDATO", "NR_CPF_CNPJ_FORNECEDOR"],
    "receitas": ["SQ_CANDIDATO", "NR_CPF_CNPJ_DOADOR"],
}
VARIAVEIS = {
    "despesas_contratadas": ["DS_DESPESA", "VR_DESPESA_CONTRATADA", "DT_DESPESA"],
    "receitas": ["DS_ORIGEM_RECEITA", "VR_RECEITA", "DT_RECEITA"],
}
ESSENCIA = {t: IDENTIDADE[t] + VARIAVEIS[t] for t in IDENTIDADE}

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


def _condicao_edicao(tabela: str) -> str:
    """Reconhece a MESMA declaração entre uma versão morta (m) e uma viva (v).

    Parear por SQ_* não funciona — o SPCE os regenera a cada retransmissão, e
    era por isso que `v_alteradas` ficava cega e toda edição caía como remoção.
    A régua aqui é: mesma IDENTIDADE e exatamente UM campo variável diferente
    (corrigiram o valor, OU a descrição, OU a data).

    Descartada a régua alternativa "mesmo NR_DOCUMENTO": o arquivo do TSE é por
    ITEM de nota, e os itens irmãos de uma nota compartilham o número — parear
    por ele casaria linhas diferentes da mesma nota (medido: 84 dos 530 casos
    reais eram exatamente isso) e engoliria remoções de verdade.

    O erro residual é assimétrico de propósito: dois itens irmãos que difiram em
    um só campo podem ser lidos como edição. Errar para "editada" enfraquece um
    indício; errar para "removida" afirma que alguém apagou declaração — e essa
    é a acusação que o projeto não pode fazer por engano.
    """
    ident = " AND ".join(f"v.{c} = m.{c}" for c in IDENTIDADE[tabela])
    variaveis = VARIAVEIS[tabela]
    iguais = " + ".join(
        f"CASE WHEN v.{c} IS NOT DISTINCT FROM m.{c} THEN 1 ELSE 0 END" for c in variaveis
    )
    return f"{ident} AND ({iguais}) = {len(variaveis) - 1}"


def _criar_views_mudancas(con) -> None:
    for tabela in TABELAS:
        hist = f"hist_{tabela}"
        if not con.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [hist]
        ).fetchone()[0]:
            continue
        essencia = " AND ".join(f"v.{c} = m.{c}" for c in ESSENCIA[tabela])
        contraparte, valor = CONTRAPARTE[tabela]
        # conteúdo que estava declarado e não está mais, SEM correspondente de
        # mesma essência na extração atual (filtra o re-registro em massa do SPCE)
        sumidas = f"""
            WITH ultima AS (SELECT MAX(dt_ultima_extracao) AS dt FROM {hist}),
            mortas AS (
                SELECT h.* FROM {hist} h, ultima
                QUALIFY MAX(h.dt_ultima_extracao) OVER (PARTITION BY h.hash_linha) < ultima.dt),
            vivas AS (
                SELECT h.* FROM {hist} h, ultima WHERE h.dt_ultima_extracao = ultima.dt),
            sumidas AS (
                SELECT m.* FROM mortas m
                WHERE NOT EXISTS (SELECT 1 FROM vivas v WHERE {essencia}))"""
        # edição: a essência sumiu, mas a declaração continua viva com um campo
        # corrigido. Traz as DUAS versões (a morta e a viva) para dar o antes/depois.
        con.execute(f"""
            CREATE OR REPLACE VIEW v_alteradas_{tabela} AS
            {sumidas},
            pares AS (
                SELECT DISTINCT m.hash_linha AS morta, v.hash_linha AS viva
                FROM sumidas m JOIN vivas v ON {_condicao_edicao(tabela)})
            SELECT h.* FROM {hist} h
            WHERE h.hash_linha IN (SELECT morta FROM pares)
               OR h.hash_linha IN (SELECT viva FROM pares)
            ORDER BY {", ".join(f"h.{c}" for c in IDENTIDADE[tabela])}, h.dt_primeira_extracao
        """)
        # remoção de fato: sumiu, não voltou com a mesma essência e não é edição.
        # As duas views são mutuamente exclusivas por construção — uma declaração
        # corrigida não pode aparecer no site como declaração apagada.
        con.execute(f"""
            CREATE OR REPLACE VIEW v_removidas_{tabela} AS
            {sumidas}
            SELECT m.* FROM sumidas m
            WHERE {filtro_placeholder(f'm.{contraparte}', f'm.{valor}')}
              AND m.hash_linha NOT IN (SELECT hash_linha FROM v_alteradas_{tabela})
        """)


def resumo_mudancas(con):
    """DataFrames com removidas e alteradas de cada tabela versionada."""
    saida = []
    for tabela in TABELAS:
        for tipo in ("removidas", "alteradas"):
            df = con.execute(f"SELECT * FROM v_{tipo}_{tabela}").df()
            saida.append((f"{tipo} em {tabela}", df))
    return saida
