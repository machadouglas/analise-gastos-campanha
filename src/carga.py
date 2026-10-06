"""Extração dos zips do TSE e carga em um banco DuckDB local."""

import codecs
import io
import shutil
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

# Votação nominal (votacao_candidato_munzona): uma linha por candidato × município
# × zona × turno. O zip de uma eleição geral passa de 600 MB e o consolidado
# _BRASIL, sozinho, de 4 GB descompactado — por isso ele NÃO passa por
# extrair_zips nem vira tabela bruta: carregar_votos lê só o consolidado, de
# dentro do zip, agrega por candidato e apaga o CSV.
ZIP_VOTACAO = "votacao_candidato_munzona_{ano}.zip"
CSV_VOTACAO = "votacao_candidato_munzona_{ano}_BRASIL.csv"
# o consolidado NÃO traz a eleição presidencial: ela vive no membro _BR (abrangência
# nacional, com o voto do exterior), publicado à parte — e vazio enquanto o TSE não
# totaliza o país. Lido sempre, só para candidatos que o consolidado não tem.
CSV_VOTACAO_BR = "votacao_candidato_munzona_{ano}_BR.csv"

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

# despesas_pagas não traz colunas do candidato — liga pelo SQ_PRESTADOR_CONTAS.
# Lista de comandos, não um bloco separado por ';': um ponto e vírgula dentro de
# comentário partiria o SQL ao meio.
SQL_VIEWS_PAGAS = ["""
-- UMA linha por prestador, sempre: o join abaixo e o da doação originária
-- (agregados._rede) multiplicariam pagamento e aresta se o prestador duplicasse.
-- A identidade do prestador é o SQ_CANDIDATO; nome, número, sigla, cargo e UF são
-- descritivos, e o TSE os declara divergentes entre despesa e receita (nome com
-- espaço duplo na receita, p.ex.). Colapsar o descritivo com MIN (determinístico,
-- ao contrário de ANY_VALUE) tira do TSE o poder de dobrar valor por um espaço.
-- Divergência de IDENTIDADE não se colapsa em silêncio: `verificar` aborta a
-- rotina se um prestador apontar para dois candidatos.
CREATE OR REPLACE VIEW v_prestadores AS
SELECT SQ_PRESTADOR_CONTAS,
       MIN(SQ_CANDIDATO) AS SQ_CANDIDATO,
       MIN(NR_CANDIDATO) AS NR_CANDIDATO,
       MIN(NM_CANDIDATO) AS NM_CANDIDATO,
       MIN(SG_PARTIDO) AS SG_PARTIDO,
       MIN(DS_CARGO) AS DS_CARGO,
       MIN(SG_UF) AS SG_UF
FROM (SELECT SQ_PRESTADOR_CONTAS, SQ_CANDIDATO, NR_CANDIDATO, NM_CANDIDATO,
             SG_PARTIDO, DS_CARGO, SG_UF FROM despesas_contratadas
      UNION ALL
      SELECT SQ_PRESTADOR_CONTAS, SQ_CANDIDATO, NR_CANDIDATO, NM_CANDIDATO,
             SG_PARTIDO, DS_CARGO, SG_UF FROM receitas)
GROUP BY SQ_PRESTADOR_CONTAS
""", """
CREATE OR REPLACE VIEW v_despesas_pagas AS
SELECT p.*, c.SQ_CANDIDATO, c.NR_CANDIDATO, c.NM_CANDIDATO, c.SG_PARTIDO, c.DS_CARGO,
       TRY_CAST(REPLACE(p.VR_PAGTO_DESPESA, ',', '.') AS DOUBLE) AS VR,
       TRY_CAST(TRY_STRPTIME(p.DT_PAGTO_DESPESA, '%d/%m/%Y') AS DATE) AS DT
FROM despesas_pagas p
LEFT JOIN v_prestadores c USING (SQ_PRESTADOR_CONTAS)
"""]


def extrair_zips(ano: int) -> Path:
    """Extrai todos os zips de data/raw/{ano}/ para data/raw/{ano}/extraido/."""
    origem = DIR_RAW / str(ano)
    destino = origem / "extraido"
    destino.mkdir(parents=True, exist_ok=True)
    for zp in origem.glob("*.zip"):
        if zp.name == ZIP_VOTACAO.format(ano=ano):
            continue  # gigante: carregar_votos lê só o consolidado, sob demanda
        with zipfile.ZipFile(zp) as z:
            # nunca extrair membro que resolva fora do destino (zip malicioso com ../)
            for m in z.namelist():
                if not (destino / m).resolve().is_relative_to(destino.resolve()):
                    raise RuntimeError(f"{zp.name}: membro suspeito no zip: {m}")
            z.extractall(destino)
        print(f"[extraido] {zp.name}")
    return destino


# O TSE diz "latin-1", mas grava Windows-1252 — o que qualquer Windows brasileiro
# produz. As duas só divergem nos bytes 0x80–0x9F: controles C1 na ISO-8859-1,
# caracteres impressos no cp1252 (’ “ ” – — … €). Basta um apóstrofo curvo
# digitado num nome de fornecedor para o `encoding='latin-1'` do DuckDB recusar o
# arquivo INTEIRO ("File is not latin-1 encoded" — derrubou a rotina em
# 12/09/2026). Por isso a carga transcodifica o CSV para UTF-8 em Python antes
# do read_csv: cp1252 para o que ele define, e os 5 bytes que nem ele define
# (0x81 0x8D 0x8F 0x90 0x9D) caem no latin-1 — nenhum byte derruba a carga, e
# nenhuma linha é descartada (ignore_errors faria uma declaração viva parecer
# apagada no histórico).
ENCODING_TSE = "cp1252"
_TRATAMENTO_BYTE_INDEFINIDO = "radar_cp1252_ou_latin1"
_BOM_UTF8_LIDO_COMO_CP1252 = codecs.BOM_UTF8.decode(ENCODING_TSE)  # 'ï»¿'


def _byte_indefinido_como_latin1(erro: UnicodeError) -> tuple[str, int]:
    return erro.object[erro.start:erro.end].decode("latin-1"), erro.end


codecs.register_error(_TRATAMENTO_BYTE_INDEFINIDO, _byte_indefinido_como_latin1)


def transcodificar_para_utf8(origem: Path, destino: Path) -> Path:
    """Copia o CSV do TSE (Windows-1252) para `destino` em UTF-8, em streaming.

    Nunca falha por byte "inválido": codificação de um byte só não tem byte inválido,
    só byte sem glifo — e esse vira o controle C1 correspondente, em vez de derrubar
    a carga. `newline=''` preserva o fim de linha do TSE tal como está. Um BOM UTF-8
    no início (o DuckDB o descartava ao ler direto) é descartado também, senão viraria
    'ï»¿' colado no nome da primeira coluna."""
    with open(origem, "rb") as bruto:
        return _gravar_como_utf8(bruto, destino)


def _gravar_como_utf8(bruto, destino: Path) -> Path:
    """O miolo de transcodificar_para_utf8 sobre um fluxo binário qualquer — o
    arquivo extraído ou o membro lido direto de dentro do zip."""
    destino.parent.mkdir(parents=True, exist_ok=True)
    parcial = destino.with_suffix(destino.suffix + ".part")
    with io.TextIOWrapper(bruto, encoding=ENCODING_TSE, errors=_TRATAMENTO_BYTE_INDEFINIDO,
                          newline="") as entrada, \
         open(parcial, "w", encoding="utf-8", newline="") as saida:
        primeiro = entrada.read(1 << 20)
        saida.write(primeiro.removeprefix(_BOM_UTF8_LIDO_COMO_CP1252))
        shutil.copyfileobj(entrada, saida, 1 << 20)
    parcial.replace(destino)
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
        utf8 = [transcodificar_para_utf8(a, pasta / "utf8" / a.name) for a in arquivos]
        lista = ", ".join(f"'{a.as_posix()}'" for a in utf8)
        try:
            con.execute(f"""
                CREATE OR REPLACE TABLE {tabela} AS
                SELECT * FROM read_csv([{lista}], delim=';', quote='"', header=true,
                                       encoding='utf-8', all_varchar=true,
                                       union_by_name=true)
            """)
        except duckdb.Error as e:
            # o DuckDB não diz qual arquivo recusou; sem isso o log da rotina
            # mostra só "Invalid Input Error" e o diagnóstico começa do zero
            nomes = ", ".join(a.name for a in arquivos)
            raise RuntimeError(f"falha ao carregar {tabela} ({nomes}): {e}") from e
        n = con.execute(f"SELECT count(*) FROM {tabela}").fetchone()[0]
        print(f"[carregado] {tabela}: {n} linhas")

    try:
        carregar_votos(con, ano)
    except RuntimeError as e:
        # voto é dado complementar: um zip de votação quebrado não pode barrar a
        # carga da prestação de contas. A tabela `votos` anterior fica como está.
        print(f"[erro] votos: {e} — tabela anterior mantida")

    criar_views(con)
    con.close()


# marcadores de nulo do TSE no arquivo de votação (candidato sem totalização)
_NULOS_VOTACAO = "'#NULO#', '#NULO', '#NE', '#NE#'"


def carregar_votos(con, ano: int) -> None:
    """Carrega a tabela `votos`: UMA linha por candidato, com os votos nominais
    somados de todos os municípios e zonas, por turno.

    - `votos_1t`/`votos_2t`: QT_VOTOS_NOMINAIS — todo voto digitado no número do
      candidato. `votos_2t` é NULL para quem não disputou o 2º turno.
    - `votos_validos_1t`/`votos_validos_2t`: QT_VOTOS_NOMINAIS_VALIDOS — os que
      contaram na totalização (candidatura indeferida tem nominais e zero válidos).
    - `resultado`: DS_SIT_TOT_TURNO do ÚLTIMO turno disputado (ELEITO, ELEITO POR
      QP, SUPLENTE, NÃO ELEITO, 2º TURNO...).

    Antes da totalização o TSE publica o zip só com o cabeçalho: a tabela nasce
    vazia, e é isso que ela deve dizer."""
    zp = DIR_RAW / str(ano) / ZIP_VOTACAO.format(ano=ano)
    if not zp.exists():
        print(f"[aviso] {zp.name} não baixado — votos não carregados")
        return
    membros = [CSV_VOTACAO.format(ano=ano), CSV_VOTACAO_BR.format(ano=ano)]
    pasta = DIR_RAW / str(ano) / "extraido" / "utf8"
    utf8 = [pasta / m for m in membros]

    def agregado(csv: Path) -> str:
        return f"""
            SELECT SQ_CANDIDATO,
                   TRY_CAST(NR_TURNO AS INTEGER) AS turno,
                   CAST(SUM(TRY_CAST(QT_VOTOS_NOMINAIS AS BIGINT)) AS BIGINT) AS votos,
                   CAST(SUM(TRY_CAST(QT_VOTOS_NOMINAIS_VALIDOS AS BIGINT)) AS BIGINT) AS validos,
                   MAX(CASE WHEN DS_SIT_TOT_TURNO NOT IN ({_NULOS_VOTACAO})
                            THEN DS_SIT_TOT_TURNO END) AS situacao
            FROM read_csv('{csv.as_posix()}', delim=';', quote='"', header=true,
                          encoding='utf-8', all_varchar=true)
            WHERE SQ_CANDIDATO IS NOT NULL
            GROUP BY 1, 2"""

    try:
        with zipfile.ZipFile(zp) as z:
            for membro, destino in zip(membros, utf8, strict=True):
                with z.open(membro) as bruto:
                    _gravar_como_utf8(bruto, destino)
        # cada arquivo agregado uma vez (o consolidado tem 4 GB); o _BR entra
        # só com quem o consolidado não tem — se um dia o TSE o incluir lá,
        # nada dobra
        con.execute(f"CREATE OR REPLACE TEMP TABLE votos_consolidado AS {agregado(utf8[0])}")
        con.execute(f"""
            CREATE OR REPLACE TEMP TABLE votos_nacional AS
            SELECT * FROM ({agregado(utf8[1])})
            WHERE SQ_CANDIDATO NOT IN (SELECT SQ_CANDIDATO FROM votos_consolidado)""")
        con.execute("""
            CREATE OR REPLACE TABLE votos AS
            WITH por_turno AS (
                SELECT * FROM votos_consolidado UNION ALL SELECT * FROM votos_nacional)
            SELECT SQ_CANDIDATO,
                   MAX(votos) FILTER (WHERE turno = 1) AS votos_1t,
                   MAX(validos) FILTER (WHERE turno = 1) AS votos_validos_1t,
                   MAX(votos) FILTER (WHERE turno = 2) AS votos_2t,
                   MAX(validos) FILTER (WHERE turno = 2) AS votos_validos_2t,
                   ARG_MAX(situacao, turno) AS resultado
            FROM por_turno
            GROUP BY 1
        """)
        con.execute("DROP TABLE votos_consolidado")
        con.execute("DROP TABLE votos_nacional")
    except (zipfile.BadZipFile, KeyError, duckdb.Error) as e:
        raise RuntimeError(f"falha ao carregar votos ({zp.name}): {e}") from e
    finally:
        # 4 GB+ numa eleição geral: os CSVs só servem para esta agregação
        for arquivo in utf8:
            arquivo.unlink(missing_ok=True)
            arquivo.with_suffix(arquivo.suffix + ".part").unlink(missing_ok=True)
    n, com_voto = con.execute(
        "SELECT COUNT(*), COUNT(*) FILTER (WHERE votos_1t > 0) FROM votos").fetchone()
    if n:
        print(f"[carregado] votos: {n} candidatos ({com_voto} com voto no 1º turno)")
    else:
        print("[carregado] votos: 0 candidatos — o TSE ainda não publicou a totalização")


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
        for sql in SQL_VIEWS_PAGAS:
            con.execute(sql)
        print("[view] v_prestadores, v_despesas_pagas")
