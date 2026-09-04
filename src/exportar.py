"""Exportação dos dados para Parquet e publicação no GitHub Releases.

Os Parquet publicados são consultáveis remotamente por qualquer pessoa com
DuckDB, sem baixar o repositório:

    SELECT * FROM 'https://github.com/<repo>/releases/download/dados/despesas.parquet'

Antes de publicar, CPFs de pessoas físicas viram códigos pf-… determinísticos
(src/privacidade.py) — o banco local fica intacto; só a publicação é
pseudonimizada.
"""

import hashlib
import json
import subprocess
from pathlib import Path

from src import db, privacidade
from src import resumo as resumo_mod
from src.carga import filtro_placeholder

DIR_EXPORT = Path("data/export")
TAG_RELEASE = "dados"

# nome do parquet -> origem no banco (tabelas hist_* levam o versionamento junto)
EXPORTS = {
    "despesas.parquet": "hist_despesas_contratadas",
    "receitas.parquet": "hist_receitas",
    "despesas_pagas.parquet": "v_despesas_pagas",
    "receitas_doador_originario.parquet": "receitas_doador_originario",
    "candidatos.parquet": "candidatos",
    "bens.parquet": "v_bens",  # patrimônio declarado — conteúdo da ficha sem movimento
    "serie_diaria.parquet": "serie_diaria",
    "benchmark_precos.parquet": "benchmark_precos",
    "benchmark_indicadores.parquet": "benchmark_indicadores",
    "benchmark_categorias.parquet": "benchmark_categorias",
    "cota_fefc.parquet": "cota_fefc",  # FEFC por partido × gênero × cor (ficha do partido)
    "norma_documento.parquet": "norma_documento",
    "indicadores.parquet": "indicadores",
    "rede.parquet": "rede",
    "fornecedores.parquet": "fornecedores",
}

# Estado atual em parquet próprio, bem menor que o histórico completo: a maior
# parte das consultas do site (Explorar, fichas, console) é sobre a extração
# mais recente, e o histórico só cresce com a campanha. Mesmos filtros das
# views despesas_atual/receitas_atual do site (site/src/lib/duckdb.ts), com a
# coluna `valor` (DOUBLE, já multiplicada por qt_linhas) pronta.
# nome do parquet -> (tabela hist_*, coluna da contraparte, coluna de valor)
EXPORTS_ATUAL = {
    "despesas_atual.parquet": (
        "hist_despesas_contratadas", "NR_CPF_CNPJ_FORNECEDOR", "VR_DESPESA_CONTRATADA"),
    "receitas_atual.parquet": ("hist_receitas", "NR_CPF_CNPJ_DOADOR", "VR_RECEITA"),
}

# Removidas prontas: o backend já sabe o que sumiu (v_removidas_*); publicar o
# resultado evita que cada visitante refaça o anti-join histórico×atual no
# navegador (site/src/lib/duckdb.ts cai para a derivação se estes faltarem).
EXPORTS_REMOVIDAS = {
    "despesas_removidas.parquet": ("v_removidas_despesas_contratadas", "VR_DESPESA_CONTRATADA"),
    "receitas_removidas.parquet": ("v_removidas_receitas", "VR_RECEITA"),
}

# Retificações com o antes/depois pronto (v_alteradas_pares_*, uma linha por
# par). O pareamento é a mesma régua que decide o que NÃO é remoção — deixar o
# site refazê-lo seria a terceira cópia dela, então aqui não há derivação de
# fallback: sem estes parquet, a seção simplesmente não aparece.
EXPORTS_ALTERADAS = {
    "despesas_alteradas.parquet": "v_alteradas_pares_despesas_contratadas",
    "receitas_alteradas.parquet": "v_alteradas_pares_receitas",
}


def _copiar(con, sql_origem: str, destino: Path) -> None:
    con.execute(f"COPY ({sql_origem}) TO '{destino.as_posix()}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    print(f"[exportado] {destino} ({destino.stat().st_size / 1e6:.1f} MB)")


def _md5_arquivo(caminho: Path) -> str:
    h = hashlib.md5(usedforsecurity=False)
    with open(caminho, "rb") as f:
        for bloco in iter(lambda: f.read(1 << 20), b""):
            h.update(bloco)
    return h.hexdigest()


def exportar(con) -> tuple[list[Path], dict[str, str]]:
    """Gera todos os Parquet + resumo.json em data/export/.

    Retorna (arquivos, hashes-por-nome). O hash de cada parquet vai também
    dentro do resumo.json (chave "arquivos") — é o cache-buster por arquivo do
    site: só o que mudou é rebaixado pelos visitantes.
    """
    sal_cpf = privacidade.sal()
    DIR_EXPORT.mkdir(parents=True, exist_ok=True)
    gerados = []
    for nome, (origem, contraparte, valor) in EXPORTS_ATUAL.items():
        if not _existe(con, origem):
            print(f"[aviso] {origem} não existe — pulando {nome}")
            continue
        destino = DIR_EXPORT / nome
        selecao = privacidade.selecao_publicavel(con, origem, sal_cpf)
        _copiar(con, f"""
            SELECT {selecao},
                   TRY_CAST(REPLACE({valor}, ',', '.') AS DOUBLE) * qt_linhas AS valor
            FROM {origem}
            WHERE dt_ultima_extracao = (SELECT MAX(dt_ultima_extracao) FROM {origem})
              AND {filtro_placeholder(contraparte, valor)}
        """, destino)
        gerados.append(destino)
    for nome, (origem, valor) in EXPORTS_REMOVIDAS.items():
        if not _existe(con, origem):
            print(f"[aviso] {origem} não existe — pulando {nome}")
            continue
        destino = DIR_EXPORT / nome
        selecao = privacidade.selecao_publicavel(con, origem, sal_cpf)
        _copiar(con, f"""
            SELECT {selecao},
                   TRY_CAST(REPLACE({valor}, ',', '.') AS DOUBLE) * qt_linhas AS valor
            FROM {origem}
        """, destino)
        gerados.append(destino)
    for nome, origem in {**EXPORTS_ALTERADAS, **EXPORTS}.items():
        if not _existe(con, origem):
            print(f"[aviso] {origem} não existe — pulando {nome}")
            continue
        destino = DIR_EXPORT / nome
        selecao = privacidade.selecao_publicavel(con, origem, sal_cpf)
        _copiar(con, f"SELECT {selecao} FROM {origem}", destino)
        gerados.append(destino)

    hashes = {p.name: _md5_arquivo(p) for p in gerados}

    destino = DIR_EXPORT / "resumo.json"
    conteudo = resumo_mod.gerar(con)
    conteudo["arquivos"] = hashes
    destino.write_text(json.dumps(conteudo, ensure_ascii=False), encoding="utf-8")
    print(f"[exportado] {destino} ({destino.stat().st_size / 1e3:.0f} kB)")
    gerados.append(destino)
    return gerados, hashes


# o que entra no "estado publicável": se nada disso mudou, republicar só
# forçaria os visitantes a rebaixar parquet idênticos (o site usa o hash de
# cada arquivo como cache-buster). dt_consulta fica de fora de propósito: uma
# reconsulta de CNPJ que não muda o cadastro não é mudança visível.
CONSULTAS_FINGERPRINT = {
    "hist_despesas_contratadas":
        "SELECT MAX(dt_ultima_extracao), COUNT(*), SUM(qt_linhas) FROM hist_despesas_contratadas",
    "hist_receitas":
        "SELECT MAX(dt_ultima_extracao), COUNT(*), SUM(qt_linhas) FROM hist_receitas",
    "candidatos": "SELECT COUNT(*) FROM candidatos",
    "bens": "SELECT COUNT(*) FROM bens",
    "despesas_pagas": "SELECT COUNT(*) FROM despesas_pagas",
    "fornecedores": """
        SELECT COUNT(*), md5(COALESCE(STRING_AGG(
            cnpj || '|' || COALESCE(razao_social, '') || '|' || COALESCE(situacao, '')
                 || '|' || COALESCE(situacao_anterior, ''),
            ';' ORDER BY cnpj), ''))
        FROM fornecedores""",
}


_existe = db.existe

# raiz dos fontes do pipeline — o fingerprint carimba o código junto do dado
DIR_CODIGO = Path(__file__).parent


def stamp_codigo(raiz: Path = DIR_CODIGO) -> str:
    """Hash dos fontes do pipeline (src/*.py + gastos.py).

    Sem ele, o gate da rotina lia só as tabelas-base do TSE: num dia de 304
    pós-deploy, uma view/coluna/parquet novo do código jamais chegava ao release
    até o TSE mudar algum dado (aconteceu com despesas_alteradas.parquet em
    31/08/2026 — o fix que criava a view não furava o gate que barrava a
    exportação dela). Com o carimbo, todo deploy que toca o pipeline exporta uma
    vez; o upload seletivo por md5 continua evitando subir arquivo idêntico."""
    h = hashlib.md5(usedforsecurity=False)
    arquivos = sorted(raiz.glob("*.py")) + [raiz.parent / "gastos.py"]
    for a in arquivos:
        if a.exists():
            h.update(a.name.encode("utf-8"))
            h.update(a.read_bytes())
    return h.hexdigest()


def fingerprint(con) -> str:
    """Resumo do estado publicável: muda quando algo que o site exibe PODE ter
    mudado — extração nova, retificação, cadastro de CNPJ novo, ou deploy que
    altera o próprio pipeline (ver stamp_codigo)."""
    partes = [stamp_codigo()]
    for nome, sql in CONSULTAS_FINGERPRINT.items():
        partes.append(str(con.execute(sql).fetchone()) if _existe(con, nome) else "ausente")
    return hashlib.md5("|".join(partes).encode("utf-8"), usedforsecurity=False).hexdigest()


def ultima_publicacao(con) -> str | None:
    """Fingerprint da última publicação registrada (None se nunca publicou)."""
    if not _existe(con, "publicacoes"):
        return None
    linha = con.execute("SELECT fingerprint FROM publicacoes").fetchone()
    return linha[0] if linha else None


def hashes_publicados(con) -> dict[str, str] | None:
    """Hashes por arquivo da última publicação (None se nunca publicou ou se o
    registro é de uma versão antiga do esquema)."""
    if not _existe(con, "publicacoes"):
        return None
    try:
        linha = con.execute("SELECT arquivos FROM publicacoes").fetchone()
    except Exception:
        return None  # esquema antigo, sem a coluna — trata como primeira publicação
    return json.loads(linha[0]) if linha and linha[0] else None


def registrar_publicacao(con, fp: str, hashes: dict[str, str] | None = None) -> None:
    """Guarda o estado da última publicação (uma linha só — o histórico de
    publicações já fica no log da rotina e no próprio release)."""
    con.execute("""
        CREATE OR REPLACE TABLE publicacoes
            (dt_publicacao TIMESTAMP, fingerprint VARCHAR, arquivos VARCHAR)
    """)
    con.execute("INSERT INTO publicacoes VALUES (now(), ?, ?)",
                [fp, json.dumps(hashes) if hashes else None])


def publicar(
    arquivos: list[Path],
    hashes: dict[str, str] | None = None,
    anteriores: dict[str, str] | None = None,
) -> None:
    """Sobe os Parquet para o release rolling 'dados' do repositório (via gh CLI).

    Com os hashes da publicação anterior em mãos, sobe apenas o que mudou
    (resumo.json sempre sobe — carrega o mapa de hashes/cache-buster do site).
    """
    if hashes and anteriores:
        mudados = [a for a in arquivos
                   if a.name == "resumo.json" or anteriores.get(a.name) != hashes.get(a.name)]
        pulados = len(arquivos) - len(mudados)
        if pulados:
            print(f"[publicar] {pulados} arquivos idênticos à última publicação — upload pulado")
        arquivos = mudados
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
                        "apareceu e até quando permaneceu declarada. CPFs de pessoas físicas são "
                        "pseudonimizados (códigos pf-…). Consulte direto da URL com DuckDB."],
            check=True)
    subprocess.run(
        ["gh", "release", "upload", TAG_RELEASE, "--clobber",
         *[str(a) for a in arquivos]], check=True)
    print(f"[publicado] release '{TAG_RELEASE}' atualizado com {len(arquivos)} arquivos")
