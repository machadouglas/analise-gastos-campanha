"""Exportação dos dados para Parquet e publicação no GitHub Releases.

Os Parquet publicados são consultáveis remotamente por qualquer pessoa com
DuckDB, sem baixar o repositório:

    SELECT * FROM 'https://github.com/<repo>/releases/download/dados/despesas.parquet'
"""

import json
import subprocess
from pathlib import Path

from src import resumo as resumo_mod

DIR_EXPORT = Path("data/export")
TAG_RELEASE = "dados"

# nome do parquet -> origem no banco (tabelas hist_* levam o versionamento junto)
EXPORTS = {
    "despesas.parquet": "hist_despesas_contratadas",
    "receitas.parquet": "hist_receitas",
    "despesas_pagas.parquet": "v_despesas_pagas",
    "receitas_doador_originario.parquet": "receitas_doador_originario",
    "candidatos.parquet": "candidatos",
    "serie_diaria.parquet": "serie_diaria",
    "benchmark_precos.parquet": "benchmark_precos",
    "benchmark_indicadores.parquet": "benchmark_indicadores",
    "indicadores.parquet": "indicadores",
    "rede.parquet": "rede",
    "fornecedores.parquet": "fornecedores",
}


def exportar(con) -> list[Path]:
    DIR_EXPORT.mkdir(parents=True, exist_ok=True)
    gerados = []
    for nome, origem in EXPORTS.items():
        existe = con.execute("""
            SELECT count(*) FROM information_schema.tables WHERE table_name = ?
            UNION ALL SELECT count(*) FROM duckdb_views() WHERE view_name = ?
        """, [origem, origem]).fetchall()
        if not any(r[0] for r in existe):
            print(f"[aviso] {origem} não existe — pulando {nome}")
            continue
        destino = DIR_EXPORT / nome
        con.execute(f"""
            COPY (SELECT * FROM {origem}) TO '{destino.as_posix()}'
            (FORMAT PARQUET, COMPRESSION ZSTD)
        """)
        print(f"[exportado] {destino} ({destino.stat().st_size / 1e6:.1f} MB)")
        gerados.append(destino)

    destino = DIR_EXPORT / "resumo.json"
    destino.write_text(json.dumps(resumo_mod.gerar(con), ensure_ascii=False), encoding="utf-8")
    print(f"[exportado] {destino} ({destino.stat().st_size / 1e3:.0f} kB)")
    gerados.append(destino)
    return gerados


def publicar(arquivos: list[Path]) -> None:
    """Sobe os Parquet para o release rolling 'dados' do repositório (via gh CLI)."""
    if not arquivos:
        print("[aviso] nada para publicar")
        return
    existe = subprocess.run(
        ["gh", "release", "view", TAG_RELEASE], capture_output=True, text=True
    ).returncode == 0
    if not existe:
        subprocess.run(
            ["gh", "release", "create", TAG_RELEASE,
             "--title", "Dados extraídos (atualização contínua)",
             "--notes", "Parquet com histórico de extrações da prestação de contas do TSE. "
                        "Colunas dt_primeira_extracao/dt_ultima_extracao registram quando cada linha "
                        "apareceu e até quando permaneceu declarada. Consulte direto da URL com DuckDB."],
            check=True)
    subprocess.run(
        ["gh", "release", "upload", TAG_RELEASE, "--clobber",
         *[str(a) for a in arquivos]], check=True)
    print(f"[publicado] release '{TAG_RELEASE}' atualizado com {len(arquivos)} arquivos")
