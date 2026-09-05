"""Prévia local: roda o pipeline do código ATUAL sobre os dados REAIS já
publicados, e entrega o resultado em `site/public/dados/`.

Para que serve:

- **antes de publicar** — ver exatamente o que a rotina do servidor vai gerar
  com o código do branch, incluindo o que mudou nas views de mudanças. Bugs de
  volume e de dado sujo não aparecem nos testes: só com a base inteira.
- **para quem contribui** — subir o site com dados reais sem `baixar` (mais de
  200 MB de zips do TSE) nem `carregar`. Os Parquet publicados são bem menores.

O que ele NÃO faz: não toca no banco local (`data/db`) nem em `data/export`. O
banco é montado em memória a partir dos Parquet do release.

    python scripts/previa-local.py            # usa o cache em data/previa/
    python scripts/previa-local.py --atualizar # rebaixa os Parquet do release

Depois:

    python site/serve.py 8778   # (com o site já buildado: cd site && npm run build)

Duas notas:

- **sobrescreve `site/public/dados/`** (gitignorado e regenerável — é o mesmo
  destino que você usaria copiando `data/export/`).
- `RADAR_SAL_CPF` pode ser qualquer valor aqui. Os CPFs dos Parquet publicados
  já vêm como `pf-…`, e a pseudonimização é idempotente sobre eles: nenhum sal
  real é necessário para a prévia (nem seria seguro exigi-lo).
"""

import argparse
import os
import shutil
import sys
from pathlib import Path

import duckdb

RAIZ = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RAIZ))

CACHE = RAIZ / "data" / "previa"
SAIDA = CACHE / "export"
DESTINO = RAIZ / "site" / "public" / "dados"

REPO = os.environ.get("GH_REPO", "machadouglas/analise-gastos-campanha")
BASE = f"https://github.com/{REPO}/releases/download/dados"

# o que o pipeline precisa para reconstruir o banco: o histórico versionado
# (despesas/receitas) e as tabelas que os agregados leem
ARQUIVOS = [
    "despesas", "receitas", "despesas_pagas", "receitas_doador_originario",
    "candidatos", "bens", "fornecedores",
]


def baixar(atualizar: bool) -> None:
    """Download do release pelo mesmo módulo que o servidor MCP usa (src/publicado.py)."""
    from src import publicado

    CACHE.mkdir(parents=True, exist_ok=True)
    for nome in ARQUIVOS:
        alvo = CACHE / f"{nome}.parquet"
        if alvo.exists() and not atualizar:
            continue
        print(f"[baixando] {nome}.parquet")
        publicado.baixar_arquivo(f"{nome}.parquet", alvo, BASE)


def montar(con) -> None:
    """Reconstrói o banco a partir do release.

    As tabelas hist_* vêm prontas; as tabelas BRUTAS são o retrato vivo
    re-expandido por `qt_linhas` — é assim que o TSE entrega (uma linha por item
    de nota, com repetições legítimas), e é o que a carga real produz.
    """
    for tabela, arquivo in (("despesas_contratadas", "despesas"), ("receitas", "receitas")):
        p = (CACHE / f"{arquivo}.parquet").as_posix()
        colunas = [c[0] for c in con.execute(f"DESCRIBE SELECT * FROM '{p}'").fetchall()]
        # o parquet publicado traz 'valor' pronto; a tabela hist_* do banco não
        do_hist = ", ".join(c for c in colunas if c != "valor")
        con.execute(f"CREATE TABLE hist_{tabela} AS SELECT {do_hist} FROM '{p}'")
        do_bruto = ", ".join(
            c for c in colunas
            if c not in ("valor", "hash_linha", "qt_linhas",
                         "dt_primeira_extracao", "dt_ultima_extracao")
        )
        con.execute(f"""
            CREATE TABLE {tabela} AS
            SELECT {do_bruto},
                   STRFTIME(dt_ultima_extracao, '%d/%m/%Y') AS DT_GERACAO,
                   '04:00:00' AS HH_GERACAO
            FROM hist_{tabela}, UNNEST(RANGE(qt_linhas))
            WHERE dt_ultima_extracao = (SELECT MAX(dt_ultima_extracao) FROM hist_{tabela})
        """)
        n = con.execute(f"SELECT COUNT(*) FROM {tabela}").fetchone()[0]
        print(f"[montado] {tabela}: {n} linhas brutas")

    for nome in ARQUIVOS[2:]:
        con.execute(f"CREATE TABLE {nome} AS SELECT * FROM '{(CACHE / (nome + '.parquet')).as_posix()}'")

    # a série diária precisa de todos os dias de extração já vistos
    con.execute("""
        CREATE TABLE extracoes AS
        SELECT DISTINCT dt AS dt_extracao FROM (
            SELECT dt_primeira_extracao AS dt FROM hist_despesas_contratadas
            UNION SELECT dt_ultima_extracao FROM hist_despesas_contratadas
            UNION SELECT dt_primeira_extracao FROM hist_receitas
            UNION SELECT dt_ultima_extracao FROM hist_receitas)
        WHERE dt IS NOT NULL
    """)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--atualizar", action="store_true",
                        help="rebaixa os Parquet do release (o padrão reusa o cache)")
    args = parser.parse_args()

    os.environ.setdefault("RADAR_SAL_CPF", "previa-local")
    from src import agregados, carga, exportar, historico, verificacao

    baixar(args.atualizar)
    con = duckdb.connect()
    montar(con)
    carga.criar_views(con)
    historico.criar_views_mudancas(con)
    agregados.materializar(con)

    falhas = verificacao.verificar(con)
    if falhas:
        print(f"\n[prévia] {len(falhas)} checagem(ns) falharam — a rotina NÃO publicaria assim.")

    exportar.DIR_EXPORT = SAIDA
    arquivos, _ = exportar.exportar(con)
    DESTINO.mkdir(parents=True, exist_ok=True)
    for a in arquivos:
        shutil.copy2(a, DESTINO / a.name)
    shutil.copy2(SAIDA / "resumo.json", DESTINO / "resumo.json")

    print(f"\n[prévia] {len(arquivos)} arquivos em {DESTINO.relative_to(RAIZ)}")
    print("[prévia] agora: cd site && npm run build && python serve.py 8778")


if __name__ == "__main__":
    main()
