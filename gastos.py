"""CLI do analisador de gastos de campanha. Veja README.md e CLAUDE.md."""

import argparse
import sys
from pathlib import Path

# line_buffering: logs saem em tempo real mesmo com stdout em pipe (Coolify)
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
sys.path.insert(0, str(Path(__file__).parent))

from src import agregados, analises, carga, cnpj, exportar, historico, tse, verificacao


def cmd_baixar(args):
    conjuntos = list(tse.CONJUNTOS) if args.conjunto == "tudo" else [args.conjunto]
    for c in conjuntos:
        try:
            tse.baixar_conjunto(c, args.ano, forcar=args.forcar)
        except RuntimeError as e:
            print(f"[erro] {c}: {e}")


def cmd_carregar(args):
    carga.carregar(args.ano)
    con = carga.conectar()
    historico.versionar(con)
    agregados.materializar(con)
    con.close()


def cmd_verificar(args):
    con = carga.conectar()
    falhas = verificacao.verificar(con)
    con.close()
    if falhas:
        sys.exit(1)


def cmd_mudancas(args):
    con = carga.conectar()
    for titulo, df in historico.resumo_mudancas(con):
        print(f"\n== {titulo}: {len(df)} linhas ==")
        if not df.empty:
            colunas = [c for c in ("NM_CANDIDATO", "SG_UF", "NM_FORNECEDOR", "NM_DOADOR",
                                   "DS_DESPESA", "DS_RECEITA", "VR_DESPESA_CONTRATADA", "VR_RECEITA",
                                   "dt_primeira_extracao", "dt_ultima_extracao") if c in df.columns]
            print(df[colunas].to_markdown(index=False))


def cmd_exportar(args):
    con = carga.conectar()
    arquivos = exportar.exportar(con)
    con.close()
    if args.publicar:
        exportar.publicar(arquivos)


def cmd_rotina(args):
    """Pipeline diário completo: baixar -> carregar/versionar -> verificar -> exportar/publicar."""
    def etapa(nome):
        from datetime import datetime
        print(f"\n=== [{datetime.now():%H:%M:%S}] {nome} ===")

    etapa("baixando dados do TSE")
    for c in tse.CONJUNTOS:
        try:
            tse.baixar_conjunto(c, args.ano, forcar=True)
        except RuntimeError as e:
            print(f"[erro] {c}: {e}")
    etapa("carregando no banco")
    carga.carregar(args.ano)
    con = carga.conectar()
    etapa("versionando extração")
    historico.versionar(con)
    etapa("enriquecendo CNPJs")
    cnpj.enriquecer_em_massa(con, limite=args.limite_cnpj)
    etapa("materializando agregados")
    agregados.materializar(con)
    etapa("verificando integridade")
    falhas = verificacao.verificar(con)
    if falhas:
        con.close()
        print("[abortado] verificação de dados falhou — nada foi publicado")
        sys.exit(1)
    etapa("exportando e publicando")
    arquivos = exportar.exportar(con)
    for titulo, df in historico.resumo_mudancas(con):
        print(f"[mudancas] {titulo}: {len(df)} linhas")
    con.close()
    if not args.sem_publicar:
        exportar.publicar(arquivos)


def cmd_candidato(args):
    con = carga.conectar()
    filtro = "NM_CANDIDATO ILIKE ? OR NM_URNA_CANDIDATO ILIKE ?"
    parametros = [f"%{args.nome}%", f"%{args.nome}%"]
    if args.uf:
        filtro = f"({filtro}) AND SG_UF = ?"
        parametros.append(args.uf)
    df = con.execute(f"""
        SELECT SQ_CANDIDATO, NR_CANDIDATO, NM_CANDIDATO, NM_URNA_CANDIDATO,
               DS_CARGO, SG_PARTIDO, SG_UF, DS_SITUACAO_CANDIDATURA
        FROM candidatos WHERE {filtro}
    """, parametros).df()
    print(df.to_markdown(index=False) if not df.empty else "Nenhum candidato encontrado.")


def cmd_analisar(args):
    con = carga.conectar()
    resultados = analises.executar_todas(con, numeros=args.numero, uf=args.uf)
    md = analises.gerar_markdown(resultados)
    if args.saida:
        Path(args.saida).parent.mkdir(parents=True, exist_ok=True)
        Path(args.saida).write_text(md, encoding="utf-8")
        print(f"[ok] relatório em {args.saida}")
    else:
        print(md)


def cmd_sql(args):
    con = carga.conectar()
    df = con.execute(args.consulta).df()
    print(df.to_markdown(index=False) if not df.empty else "(vazio)")


def cmd_enriquecer(args):
    import pandas as pd
    con = carga.conectar()
    f = analises.montar_filtro(args.numero, args.uf)
    cnpjs = con.execute(f"""
        SELECT DISTINCT NR_CPF_CNPJ_FORNECEDOR AS cnpj, ROUND(SUM(VR),2) AS total
        FROM v_despesas WHERE {f} AND LENGTH(NR_CPF_CNPJ_FORNECEDOR) = 14
        GROUP BY 1 ORDER BY total DESC
    """).df()
    print(f"Consultando {len(cnpjs)} CNPJs na BrasilAPI (com cache)...")
    linhas = []
    for _, linha in cnpjs.iterrows():
        dados = cnpj.consultar(linha["cnpj"])
        if dados:
            resumo = cnpj.resumir(dados)
            resumo["total_recebido"] = linha["total"]
            linhas.append(resumo)
    df = pd.DataFrame(linhas)
    if df.empty:
        print("Nenhum CNPJ consultado.")
        return
    df = df.sort_values("data_abertura", ascending=False)
    if args.saida:
        Path(args.saida).parent.mkdir(parents=True, exist_ok=True)
        Path(args.saida).write_text(df.to_markdown(index=False), encoding="utf-8")
        print(f"[ok] relatório em {args.saida}")
    else:
        print(df.to_markdown(index=False))


def principal():
    p = argparse.ArgumentParser(description="Analisador de gastos de campanha (dados públicos do TSE)")
    sub = p.add_subparsers(dest="comando", required=True)

    b = sub.add_parser("baixar", help="baixa os dados do TSE")
    b.add_argument("--ano", type=int, default=2026)
    b.add_argument("--conjunto", default="tudo", choices=["tudo", *tse.CONJUNTOS])
    b.add_argument("--forcar", action="store_true")
    b.set_defaults(func=cmd_baixar)

    c = sub.add_parser("carregar", help="extrai e carrega os CSVs no DuckDB")
    c.add_argument("--ano", type=int, default=2026)
    c.set_defaults(func=cmd_carregar)

    d = sub.add_parser("candidato", help="procura candidatos por nome")
    d.add_argument("--nome", required=True)
    d.add_argument("--uf")
    d.set_defaults(func=cmd_candidato)

    a = sub.add_parser("analisar", help="roda as análises de red flags")
    a.add_argument("--numero", action="append", help="NR_CANDIDATO (repetível); omitir = todos")
    a.add_argument("--uf")
    a.add_argument("--saida", help="arquivo .md de saída")
    a.set_defaults(func=cmd_analisar)

    m = sub.add_parser("mudancas", help="linhas removidas/alteradas entre extrações")
    m.set_defaults(func=cmd_mudancas)

    x = sub.add_parser("exportar", help="exporta Parquet (e publica no GitHub Releases)")
    x.add_argument("--publicar", action="store_true", help="sobe para o release 'dados' via gh CLI")
    x.set_defaults(func=cmd_exportar)

    r = sub.add_parser("rotina", help="pipeline diário: baixar + carregar + verificar + exportar + publicar")
    r.add_argument("--ano", type=int, default=2026)
    r.add_argument("--sem-publicar", action="store_true")
    r.add_argument("--limite-cnpj", type=int, default=250, help="máx. de CNPJs a enriquecer por execução")
    r.set_defaults(func=cmd_rotina)

    v = sub.add_parser("verificar", help="checagens de integridade dos dados carregados")
    v.set_defaults(func=cmd_verificar)

    s = sub.add_parser("sql", help="consulta SQL livre no banco")
    s.add_argument("consulta")
    s.set_defaults(func=cmd_sql)

    e = sub.add_parser("enriquecer", help="consulta os CNPJs dos fornecedores na Receita (BrasilAPI)")
    e.add_argument("--numero", action="append")
    e.add_argument("--uf")
    e.add_argument("--saida")
    e.set_defaults(func=cmd_enriquecer)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    principal()
