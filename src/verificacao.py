"""Checagens de integridade dos dados carregados.

Rodam na rotina diária ANTES de publicar: se algo falhar, nada sobe.
Cada checagem devolve (nome, ok, detalhe).
"""

from src import analises, db, historico
from src.carga import filtro_placeholder

TOLERANCIA = 0.01  # centavos de diferença por arredondamento
QUEDA_MAXIMA_PCT = 20.0  # retrato encolher mais que isso = suspeita de arquivo truncado


def queda_de_volume(con, tabela: str, limite_pct: float = QUEDA_MAXIMA_PCT) -> tuple[bool, str]:
    """Compara o retrato atual com o da extração anterior. Prestação de contas
    cresce ao longo da campanha; uma queda brusca no arquivo inteiro indica
    download truncado — e viraria uma enxurrada de falsas 'remoções'."""
    hist = f"hist_{tabela}"
    anterior = con.execute("""
        SELECT MAX(dt_extracao) FROM extracoes
        WHERE dt_extracao < (SELECT MAX(dt_extracao) FROM extracoes)
    """).fetchone()[0]
    if anterior is None:
        return True, "primeira extração — sem base de comparação"
    antes = con.execute(f"""
        SELECT COALESCE(SUM(qt_linhas), 0) FROM {hist}
        WHERE dt_primeira_extracao <= ? AND dt_ultima_extracao >= ?
    """, [anterior, anterior]).fetchone()[0]
    atual = con.execute(f"SELECT COUNT(*) FROM {tabela}").fetchone()[0]
    if antes == 0:
        return True, f"sem retrato anterior ({atual} linhas hoje)"
    variacao = 100.0 * (atual - antes) / antes
    return -variacao <= limite_pct, f"{antes} -> {atual} linhas (variação de {variacao:+.1f}%)"


def verificar(con) -> list[str]:
    falhas = []

    def checar(nome: str, ok: bool, detalhe: str = ""):
        status = "ok" if ok else "FALHA"
        print(f"[verificacao] {status:6} {nome}" + (f" — {detalhe}" if detalhe else ""))
        if not ok:
            falhas.append(nome)

    # --- tabelas essenciais não vazias
    for tabela, minimo in [("despesas_contratadas", 100), ("receitas", 100), ("candidatos", 1000)]:
        n = con.execute(f"SELECT COUNT(*) FROM {tabela}").fetchone()[0]
        checar(f"{tabela} tem volume plausível", n >= minimo, f"{n} linhas (mínimo {minimo})")

    # --- valores convertem para número (a vírgula decimal é a pegadinha clássica)
    for view, col in [("v_despesas", "VR_DESPESA_CONTRATADA"), ("v_receitas", "VR_RECEITA")]:
        total, invalidos, negativos = con.execute(f"""
            SELECT COUNT(*),
                   COUNT(*) FILTER (WHERE VR IS NULL AND {col} IS NOT NULL AND {col} <> '#NULO'),
                   COUNT(*) FILTER (WHERE VR < 0)
            FROM {view}
        """).fetchone()
        checar(f"{view}: valores numéricos válidos", invalidos == 0, f"{invalidos} não convertidos de {total}")
        checar(f"{view}: sem valores negativos", negativos == 0, f"{negativos} negativos")

    # --- datas dentro do ciclo eleitoral
    fora = con.execute("""
        SELECT COUNT(*) FROM v_despesas
        WHERE DT IS NOT NULL AND (DT < DATE '2025-01-01' OR DT > DATE '2027-03-01')
    """).fetchone()[0]
    checar("datas de despesa dentro do ciclo 2025–2027", fora == 0, f"{fora} fora do intervalo")

    # --- histórico consistente com o retrato atual
    dt_max = con.execute("SELECT MAX(dt_ultima_extracao) FROM hist_despesas_contratadas").fetchone()[0]
    vivos = con.execute(
        "SELECT COALESCE(SUM(qt_linhas), 0) FROM hist_despesas_contratadas WHERE dt_ultima_extracao = ?",
        [dt_max],
    ).fetchone()[0]
    brutos = con.execute("SELECT COUNT(*) FROM despesas_contratadas").fetchone()[0]
    checar("histórico vivo == retrato atual (despesas)", vivos == brutos, f"hist={vivos} raw={brutos}")

    dt_max_rec = con.execute("SELECT MAX(dt_ultima_extracao) FROM hist_receitas").fetchone()[0]
    vivos_rec = con.execute(
        "SELECT COALESCE(SUM(qt_linhas), 0) FROM hist_receitas WHERE dt_ultima_extracao = ?",
        [dt_max_rec],
    ).fetchone()[0]
    brutos_rec = con.execute("SELECT COUNT(*) FROM receitas").fetchone()[0]
    checar("histórico vivo == retrato atual (receitas)", vivos_rec == brutos_rec,
           f"hist={vivos_rec} raw={brutos_rec}")

    for hist in ("hist_despesas_contratadas", "hist_receitas"):
        janela_invertida = con.execute(f"""
            SELECT COUNT(*) FROM {hist}
            WHERE dt_primeira_extracao > dt_ultima_extracao
        """).fetchone()[0]
        checar(f"janelas de extração coerentes ({hist})", janela_invertida == 0,
               f"{janela_invertida} invertidas")

    # --- mudanças: toda linha morta tem UM destino, e "removida" é o último
    # A régua de remoção é a afirmação mais forte que o site faz ("apagaram a
    # declaração"). Estas checagens garantem que ela não volte a engolir
    # retransmissão nem retificação — foi o que aconteceu até 31/08/2026, quando
    # uma doação digitada como R$ 1 bi e corrigida para R$ 1 mi era publicada
    # como um bilhão em declarações removidas.
    for tabela in historico.TABELAS:
        hist = f"hist_{tabela}"
        if not (_existe(con, hist) and _existe(con, f"v_removidas_{tabela}")):
            continue
        contraparte, valor = historico.CONTRAPARTE[tabela]
        ult = con.execute(f"SELECT MAX(dt_ultima_extracao) FROM {hist}").fetchone()[0]
        if ult is None:
            continue
        # IS NOT DISTINCT FROM, como em historico.py: campo NULL precisa casar
        essencia = " AND ".join(
            f"v.{c} IS NOT DISTINCT FROM m.{c}" for c in historico.ESSENCIA[tabela])
        identidade = " AND ".join(
            f"v.{c} IS NOT DISTINCT FROM m.{c}" for c in historico.IDENTIDADE[tabela])
        variaveis = historico.VARIAVEIS[tabela]
        iguais = " + ".join(
            f"CASE WHEN v.{c} IS NOT DISTINCT FROM m.{c} THEN 1 ELSE 0 END" for c in variaveis
        )

        sobrepostas = con.execute(f"""
            SELECT COUNT(*) FROM v_removidas_{tabela}
            WHERE hash_linha IN (SELECT hash_linha FROM v_alteradas_{tabela})
        """).fetchone()[0]
        checar(f"removida e alterada nunca são a mesma linha ({tabela})",
               sobrepostas == 0, f"{sobrepostas} em ambas as views")

        # se uma "removida" tem sósia vivo com quase todos os campos iguais, ela
        # é retificação e a régua não pegou
        sosia = con.execute(f"""
            SELECT COUNT(*) FROM v_removidas_{tabela} m WHERE EXISTS (
                SELECT 1 FROM {hist} v WHERE v.dt_ultima_extracao = ?
                  AND {identidade} AND ({iguais}) >= {len(variaveis) - 1})
        """, [ult]).fetchone()[0]
        checar(f"nenhuma remoção tem versão viva equivalente ({tabela})",
               sosia == 0, f"{sosia} com sósia vivo de {len(variaveis) - 1}+ campos iguais")

        # decomposição fechada: cada linha morta é retransmissão, retificação,
        # placeholder ou remoção — sem sobra e sem dupla contagem
        mortas = con.execute(
            f"SELECT COUNT(*) FROM {hist} WHERE dt_ultima_extracao < ?", [ult]).fetchone()[0]
        partes = con.execute(f"""
            SELECT
              (SELECT COUNT(*) FROM {hist} m WHERE m.dt_ultima_extracao < ?
                 AND EXISTS (SELECT 1 FROM {hist} v
                             WHERE v.dt_ultima_extracao = ? AND {essencia}))
            + (SELECT COUNT(*) FROM v_alteradas_{tabela} WHERE dt_ultima_extracao < ?)
            + (SELECT COUNT(*) FROM {hist} m WHERE m.dt_ultima_extracao < ?
                 AND NOT EXISTS (SELECT 1 FROM {hist} v
                                 WHERE v.dt_ultima_extracao = ? AND {essencia})
                 AND m.hash_linha NOT IN (SELECT hash_linha FROM v_alteradas_{tabela})
                 AND NOT ({filtro_placeholder(f'm.{contraparte}', f'm.{valor}')}))
            + (SELECT COUNT(*) FROM v_removidas_{tabela})
        """, [ult, ult, ult, ult, ult]).fetchone()[0]
        checar(f"linhas mortas se decompõem sem sobra ({tabela})", partes == mortas,
               f"mortas={mortas} decomposição={partes}")

    # --- retrato não pode encolher bruscamente (arquivo truncado)
    for tabela in ("despesas_contratadas", "receitas"):
        ok, detalhe = queda_de_volume(con, tabela)
        checar(f"sem queda brusca de volume ({tabela})", ok, detalhe)

    # --- despesas_pagas: o join com prestadores não pode multiplicar linhas
    pagas_raw = con.execute("SELECT COUNT(*) FROM despesas_pagas").fetchone()[0]
    pagas_view = con.execute("SELECT COUNT(*) FROM v_despesas_pagas").fetchone()[0]
    checar("v_despesas_pagas sem fan-out no join", pagas_view == pagas_raw, f"view={pagas_view} raw={pagas_raw}")

    # --- v_prestadores é UNION DISTINCT de metadados: se despesa e receita
    # divergirem no nome/partido do mesmo prestador, ele duplica — e o join
    # acima dobraria total_pago e as arestas de doação originária
    if _existe(con, "v_prestadores"):
        prestadores_dup = con.execute("""
            SELECT COUNT(*) FROM (
                SELECT SQ_PRESTADOR_CONTAS FROM v_prestadores
                GROUP BY 1 HAVING COUNT(*) > 1)
        """).fetchone()[0]
        checar("v_prestadores sem prestador duplicado", prestadores_dup == 0,
               f"{prestadores_dup} prestadores com metadados divergentes")

    # --- reconciliação: agregados batem com a fonte
    if _existe(con, "serie_diaria"):
        serie, fonte = con.execute("""
            SELECT (SELECT ROUND(SUM(total_contratado), 2) FROM serie_diaria
                    WHERE dt_extracao = (SELECT MAX(dt_extracao) FROM serie_diaria)),
                   (SELECT ROUND(SUM(VR), 2) FROM v_despesas)
        """).fetchone()
        checar("serie_diaria (último dia) == total atual", abs((serie or 0) - (fonte or 0)) < TOLERANCIA,
               f"serie={serie} fonte={fonte}")

    if _existe(con, "serie_diaria"):
        serie_rec, fonte_rec = con.execute("""
            SELECT (SELECT ROUND(SUM(total_receitas), 2) FROM serie_diaria
                    WHERE dt_extracao = (SELECT MAX(dt_extracao) FROM serie_diaria)),
                   (SELECT ROUND(SUM(VR), 2) FROM v_receitas)
        """).fetchone()
        checar("serie_diaria receitas (último dia) == total atual",
               abs((serie_rec or 0) - (fonte_rec or 0)) < TOLERANCIA,
               f"serie={serie_rec} fonte={fonte_rec}")

    if _existe(con, "indicadores"):
        ind, fonte = con.execute("""
            SELECT (SELECT ROUND(SUM(total_contratado), 2) FROM indicadores),
                   (SELECT ROUND(SUM(VR), 2) FROM v_despesas)
        """).fetchone()
        checar("indicadores == total atual", abs((ind or 0) - (fonte or 0)) < TOLERANCIA,
               f"indicadores={ind} fonte={fonte}")
        ind_rec, fonte_rec = con.execute("""
            SELECT (SELECT ROUND(SUM(total_receitas), 2) FROM indicadores),
                   (SELECT ROUND(SUM(VR), 2) FROM v_receitas)
        """).fetchone()
        checar("indicadores receitas == total atual", abs((ind_rec or 0) - (fonte_rec or 0)) < TOLERANCIA,
               f"indicadores={ind_rec} fonte={fonte_rec}")
        pago_ind, pago_fonte = con.execute("""
            SELECT (SELECT ROUND(SUM(total_pago), 2) FROM indicadores),
                   (SELECT ROUND(SUM(VR), 2) FROM v_despesas_pagas WHERE SQ_CANDIDATO IS NOT NULL)
        """).fetchone()
        checar("indicadores pago == total atual", abs((pago_ind or 0) - (pago_fonte or 0)) < TOLERANCIA,
               f"indicadores={pago_ind} fonte={pago_fonte}")
        fundos_estourados = con.execute("""
            SELECT COUNT(*) FROM indicadores
            WHERE fundos_publicos > COALESCE(total_receitas, 0) + 0.01
        """).fetchone()[0]
        checar("fundos públicos <= receitas por candidato", fundos_estourados == 0,
               f"{fundos_estourados} candidatos com fundo maior que a receita")

    if _existe(con, "indicadores") and _existe(con, "norma_documento"):
        # a régua do sem-documento-fiscal vive em analises.py e é aplicada dentro
        # de uma CTE de indicadores: se as duas divergirem (alguém edita uma e
        # esquece a outra), o número publicado mente sem quebrar nada
        ind_sn, fonte_sn = con.execute(f"""
            SELECT (SELECT ROUND(SUM(valor_sem_nota), 2) FROM indicadores),
                   (SELECT ROUND(SUM(VR), 2) FROM v_despesas
                    WHERE {analises.cond_sem_documento_fiscal()})
        """).fetchone()
        checar("indicadores sem documento fiscal == régua de analises.py",
               abs((ind_sn or 0) - (fonte_sn or 0)) < TOLERANCIA,
               f"indicadores={ind_sn} régua={fonte_sn}")
        contradicao = con.execute(f"""
            SELECT COUNT(*) FROM norma_documento
            WHERE exige_documento
              AND DS_ORIGEM_DESPESA IN ({analises.SQL_CATEGORIAS_SEM_NOTA_ESPERADA})
        """).fetchone()[0]
        checar("norma_documento respeita o piso de categorias sem NF esperada",
               contradicao == 0, f"{contradicao} categorias do piso marcadas como exigindo nota")

    if _existe(con, "rede"):
        rede, fonte = con.execute("""
            SELECT (SELECT ROUND(SUM(valor), 2) FROM rede WHERE tipo = 'despesa'),
                   (SELECT ROUND(SUM(VR), 2) FROM v_despesas)
        """).fetchone()
        checar("rede (despesas) == total atual", abs((rede or 0) - (fonte or 0)) < TOLERANCIA,
               f"rede={rede} fonte={fonte}")
        rede_rec, fonte_rec = con.execute("""
            SELECT (SELECT ROUND(SUM(valor), 2) FROM rede WHERE tipo = 'doacao'),
                   (SELECT ROUND(SUM(VR), 2) FROM v_receitas)
        """).fetchone()
        checar("rede (doações) == total atual", abs((rede_rec or 0) - (fonte_rec or 0)) < TOLERANCIA,
               f"rede={rede_rec} fonte={fonte_rec}")

    for benchmark in ("benchmark_precos", "benchmark_indicadores", "benchmark_categorias"):
        if _existe(con, benchmark):
            quebrados = con.execute(f"""
                SELECT COUNT(*) FROM {benchmark}
                WHERE NOT (p25 <= mediana AND mediana <= p75 AND p75 <= p95 AND p95 <= maximo)
            """).fetchone()[0]
            checar(f"{benchmark}: quantis ordenados", quebrados == 0, f"{quebrados} inconsistentes")

    print(f"[verificacao] {'TUDO OK' if not falhas else f'{len(falhas)} FALHAS: ' + ', '.join(falhas)}")
    return falhas


_existe = db.existe
