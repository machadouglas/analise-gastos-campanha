"""Checagens de integridade dos dados carregados.

Rodam na rotina diária ANTES de publicar: se algo falhar, nada sobe.
Cada checagem devolve (nome, ok, detalhe).
"""

TOLERANCIA = 0.01  # centavos de diferença por arredondamento


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

    janela_invertida = con.execute("""
        SELECT COUNT(*) FROM hist_despesas_contratadas
        WHERE dt_primeira_extracao > dt_ultima_extracao
    """).fetchone()[0]
    checar("janelas de extração coerentes", janela_invertida == 0, f"{janela_invertida} invertidas")

    # --- despesas_pagas: o join com prestadores não pode multiplicar linhas
    pagas_raw = con.execute("SELECT COUNT(*) FROM despesas_pagas").fetchone()[0]
    pagas_view = con.execute("SELECT COUNT(*) FROM v_despesas_pagas").fetchone()[0]
    checar("v_despesas_pagas sem fan-out no join", pagas_view == pagas_raw, f"view={pagas_view} raw={pagas_raw}")

    # --- reconciliação: agregados batem com a fonte
    if _existe(con, "serie_diaria"):
        serie, fonte = con.execute("""
            SELECT (SELECT ROUND(SUM(total_contratado), 2) FROM serie_diaria
                    WHERE dt_extracao = (SELECT MAX(dt_extracao) FROM serie_diaria)),
                   (SELECT ROUND(SUM(VR), 2) FROM v_despesas)
        """).fetchone()
        checar("serie_diaria (último dia) == total atual", abs((serie or 0) - (fonte or 0)) < TOLERANCIA,
               f"serie={serie} fonte={fonte}")

    if _existe(con, "indicadores"):
        ind, fonte = con.execute("""
            SELECT (SELECT ROUND(SUM(total_contratado), 2) FROM indicadores),
                   (SELECT ROUND(SUM(VR), 2) FROM v_despesas)
        """).fetchone()
        checar("indicadores == total atual", abs((ind or 0) - (fonte or 0)) < TOLERANCIA,
               f"indicadores={ind} fonte={fonte}")

    if _existe(con, "rede"):
        rede, fonte = con.execute("""
            SELECT (SELECT ROUND(SUM(valor), 2) FROM rede WHERE tipo = 'despesa'),
                   (SELECT ROUND(SUM(VR), 2) FROM v_despesas)
        """).fetchone()
        checar("rede (despesas) == total atual", abs((rede or 0) - (fonte or 0)) < TOLERANCIA,
               f"rede={rede} fonte={fonte}")

    if _existe(con, "benchmark_precos"):
        quebrados = con.execute("""
            SELECT COUNT(*) FROM benchmark_precos
            WHERE NOT (p25 <= mediana AND mediana <= p75 AND p75 <= p95 AND p95 <= maximo)
        """).fetchone()[0]
        checar("benchmark: quantis ordenados", quebrados == 0, f"{quebrados} inconsistentes")

    print(f"[verificacao] {'TUDO OK' if not falhas else f'{len(falhas)} FALHAS: ' + ', '.join(falhas)}")
    return falhas


def _existe(con, tabela: str) -> bool:
    return bool(con.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [tabela]
    ).fetchone()[0])
