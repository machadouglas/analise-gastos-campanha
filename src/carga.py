"""Extração dos zips do TSE e carga em um banco DuckDB local."""

import zipfile
from pathlib import Path

import duckdb

DIR_RAW = Path("data/raw")
CAMINHO_BANCO = Path("data/db/gastos.duckdb")

# tabela -> padrão de arquivo dentro dos zips (o consolidado _BRASIL evita duplicar as UFs)
TABELAS = {
    "despesas_contratadas": "despesas_contratadas_candidatos_{ano}_BRASIL.csv",
    "despesas_pagas": "despesas_pagas_candidatos_{ano}_BRASIL.csv",
    "receitas": "receitas_candidatos_{ano}_BRASIL.csv",
    "receitas_doador_originario": "receitas_candidatos_doador_originario_{ano}_BRASIL.csv",
    "candidatos": "consulta_cand_{ano}_BRASIL.csv",  # consolidado (há também _BR e um por UF)
    "bens": "bem_candidato_{ano}_BRASIL.csv",  # patrimônio declarado no registro
}

# views tipadas: (view, tabela, coluna de valor, coluna de data, coluna da contraparte)
# O SPCE emite linhas-placeholder (prestação sem movimento: contraparte '-1'/'#NULO'
# E valor zero) — não são fatos declarados e ficam fora das views tipadas.
VIEWS_VALOR = [
    ("v_despesas", "despesas_contratadas", "VR_DESPESA_CONTRATADA", "DT_DESPESA", "NR_CPF_CNPJ_FORNECEDOR"),
    ("v_receitas", "receitas", "VR_RECEITA", "DT_RECEITA", "NR_CPF_CNPJ_DOADOR"),
    ("v_bens", "bens", "VR_BEM_CANDIDATO", "DT_ULT_ATUAL_BEM_CANDIDATO", None),
]


def filtro_placeholder(col_contraparte: str, col_valor: str) -> str:
    """Condição SQL que descarta a linha-placeholder (sem contraparte E sem valor).
    Contraparte anônima com valor declarado NÃO é placeholder — é fato (e indício)."""
    return (f"NOT ({col_contraparte} IN ('-1', '#NULO') AND "
            f"COALESCE(TRY_CAST(REPLACE({col_valor}, ',', '.') AS DOUBLE), 0) = 0)")

# despesas_pagas não traz colunas do candidato — liga pelo SQ_PRESTADOR_CONTAS
SQL_VIEWS_PAGAS = """
CREATE OR REPLACE VIEW v_prestadores AS
SELECT DISTINCT SQ_PRESTADOR_CONTAS, SQ_CANDIDATO, NR_CANDIDATO, NM_CANDIDATO,
                SG_PARTIDO, DS_CARGO, SG_UF
FROM (SELECT SQ_PRESTADOR_CONTAS, SQ_CANDIDATO, NR_CANDIDATO, NM_CANDIDATO,
             SG_PARTIDO, DS_CARGO, SG_UF FROM despesas_contratadas
      UNION
      SELECT SQ_PRESTADOR_CONTAS, SQ_CANDIDATO, NR_CANDIDATO, NM_CANDIDATO,
             SG_PARTIDO, DS_CARGO, SG_UF FROM receitas);

CREATE OR REPLACE VIEW v_despesas_pagas AS
SELECT p.*, c.SQ_CANDIDATO, c.NR_CANDIDATO, c.NM_CANDIDATO, c.SG_PARTIDO, c.DS_CARGO,
       TRY_CAST(REPLACE(p.VR_PAGTO_DESPESA, ',', '.') AS DOUBLE) AS VR,
       TRY_CAST(TRY_STRPTIME(p.DT_PAGTO_DESPESA, '%d/%m/%Y') AS DATE) AS DT
FROM despesas_pagas p
LEFT JOIN v_prestadores c USING (SQ_PRESTADOR_CONTAS);
"""


def extrair_zips(ano: int) -> Path:
    """Extrai todos os zips de data/raw/{ano}/ para data/raw/{ano}/extraido/."""
    origem = DIR_RAW / str(ano)
    destino = origem / "extraido"
    destino.mkdir(parents=True, exist_ok=True)
    for zp in origem.glob("*.zip"):
        with zipfile.ZipFile(zp) as z:
            # nunca extrair membro que resolva fora do destino (zip malicioso com ../)
            for m in z.namelist():
                if not (destino / m).resolve().is_relative_to(destino.resolve()):
                    raise RuntimeError(f"{zp.name}: membro suspeito no zip: {m}")
            z.extractall(destino)
        print(f"[extraido] {zp.name}")
    return destino


def conectar() -> duckdb.DuckDBPyConnection:
    CAMINHO_BANCO.parent.mkdir(parents=True, exist_ok=True)
    return duckdb.connect(str(CAMINHO_BANCO))


def carregar(ano: int) -> None:
    """Carrega os CSVs extraídos nas tabelas do banco (recriando-as)."""
    pasta = extrair_zips(ano)
    con = conectar()
    for tabela, padrao in TABELAS.items():
        arquivos = sorted(pasta.glob(padrao.format(ano=ano)))
        if not arquivos:
            print(f"[aviso] nenhum arquivo para {tabela} ({padrao.format(ano=ano)})")
            continue
        lista = ", ".join(f"'{a.as_posix()}'" for a in arquivos)
        con.execute(f"""
            CREATE OR REPLACE TABLE {tabela} AS
            SELECT * FROM read_csv([{lista}], delim=';', quote='"', header=true,
                                   encoding='latin-1', all_varchar=true,
                                   union_by_name=true)
        """)
        n = con.execute(f"SELECT count(*) FROM {tabela}").fetchone()[0]
        print(f"[carregado] {tabela}: {n} linhas")

    criar_views(con)
    con.close()


def criar_views(con) -> None:
    """(Re)cria as views tipadas sobre as tabelas brutas existentes."""
    for view, tabela, col_valor, col_data, col_contraparte in VIEWS_VALOR:
        if not con.execute(
            "SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [tabela]
        ).fetchone()[0]:
            continue
        filtro = filtro_placeholder(col_contraparte, col_valor) if col_contraparte else "1=1"
        # TRY_STRPTIME, nunca STRPTIME: o STRPTIME estrito estoura em '#NULO', e
        # o otimizador pode avaliá-lo ANTES de qualquer filtro que removeria a
        # linha (dependente do plano — funciona num banco e explode noutro)
        con.execute(f"""
            CREATE OR REPLACE VIEW {view} AS
            SELECT *,
                   TRY_CAST(REPLACE({col_valor}, ',', '.') AS DOUBLE) AS VR,
                   TRY_CAST(TRY_STRPTIME({col_data}, '%d/%m/%Y') AS DATE) AS DT
            FROM {tabela}
            WHERE {filtro}
        """)
        print(f"[view] {view}")

    if con.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'despesas_pagas'"
    ).fetchone()[0]:
        for sql in SQL_VIEWS_PAGAS.split(";"):
            if sql.strip():
                con.execute(sql)
        print("[view] v_prestadores, v_despesas_pagas")
