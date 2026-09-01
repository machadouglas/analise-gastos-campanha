"""As consultas prontas do console (site/src/lib/exemplos.ts) rodam de verdade.

Cada exemplo e cada pergunta com SQL pronto da página Consultar é executado
contra o banco real, com as MESMAS views que o release publica (nomes e
definições vindos de src/exportar.py) — se alguém renomear uma coluna do
backend ou escrever SQL inválido no front, o teste quebra aqui e não na cara
do visitante.
"""

import re
import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import exportar  # noqa: E402
from src.carga import filtro_placeholder  # noqa: E402

RAIZ = Path(__file__).parent.parent
BANCO = RAIZ / "data" / "db" / "gastos.duckdb"
EXEMPLOS_TS = RAIZ / "site" / "src" / "lib" / "exemplos.ts"
CONSULTAS_TS = RAIZ / "site" / "src" / "lib" / "consultas.ts"

pytestmark = pytest.mark.skipif(not BANCO.exists(), reason="banco local ainda não carregado")


def _corte_recem_aberto() -> str:
    """CORTE_RECEM_ABERTO de consultas.ts — os exemplos o interpolam."""
    achado = re.search(
        r"CORTE_RECEM_ABERTO = '([^']+)'", CONSULTAS_TS.read_text(encoding="utf-8"))
    assert achado, "CORTE_RECEM_ABERTO não encontrado em consultas.ts"
    return achado.group(1)


def _consultas() -> list[tuple[str, str]]:
    """(rótulo, SQL) de todo `rotulo:`/`pergunta:` seguido de `sql:` no arquivo.
    Resolve também `sql: NOME_DA_CONST` (consultas reaproveitadas) e a
    interpolação de CORTE_RECEM_ABERTO (o visitante recebe o valor resolvido)."""
    fonte = EXEMPLOS_TS.read_text(encoding="utf-8")
    consts = dict(re.findall(r"const (\w+) = `([^`]*)`", fonte))
    achados = re.findall(
        r"(?:rotulo|pergunta): '([^']*)',\s*\n?\s*sql: (?:`([^`]*)`|(\w+))", fonte
    )
    corte = _corte_recem_aberto()
    consultas = [
        (rotulo, (literal or consts[nome]).replace("${CORTE_RECEM_ABERTO}", corte))
        for rotulo, literal, nome in achados
    ]
    assert len(consultas) >= 25, f"parser achou só {len(consultas)} consultas em exemplos.ts"
    return consultas


CONSULTAS = _consultas()


@pytest.fixture(scope="module")
def con():
    """Conexão em memória com o banco real anexado só-leitura e as views do
    site por cima — o banco de produção nunca é tocado."""
    c = duckdb.connect()
    c.execute(f"ATTACH '{BANCO.as_posix()}' AS g (READ_ONLY)")

    def tem(nome: str) -> bool:
        return bool(c.execute(
            "SELECT count(*) FROM (SELECT table_name AS n FROM information_schema.tables "
            "WHERE table_catalog = 'g' UNION ALL SELECT view_name FROM duckdb_views() "
            "WHERE database_name = 'g') WHERE n = ?", [nome]).fetchone()[0])

    faltando = []
    # despesas_atual/receitas_atual: mesmos filtros de src/exportar.py
    for arquivo, (origem, contraparte, valor) in exportar.EXPORTS_ATUAL.items():
        nome = arquivo.removesuffix(".parquet")
        if not tem(origem):
            faltando.append(nome)
            continue
        c.execute(f"""
            CREATE VIEW {nome} AS
            SELECT *, TRY_CAST(REPLACE({valor}, ',', '.') AS DOUBLE) * qt_linhas AS valor
            FROM g.{origem}
            WHERE dt_ultima_extracao = (SELECT MAX(dt_ultima_extracao) FROM g.{origem})
              AND {filtro_placeholder(contraparte, valor)}
        """)
    for arquivo, (origem, valor) in exportar.EXPORTS_REMOVIDAS.items():
        nome = arquivo.removesuffix(".parquet")
        if not tem(origem):
            faltando.append(nome)
            continue
        c.execute(f"""
            CREATE VIEW {nome} AS
            SELECT *, TRY_CAST(REPLACE({valor}, ',', '.') AS DOUBLE) * qt_linhas AS valor
            FROM g.{origem}
        """)
    for arquivo, origem in exportar.EXPORTS.items():
        nome = arquivo.removesuffix(".parquet")
        if not tem(origem):
            faltando.append(nome)
            continue
        c.execute(f"CREATE VIEW {nome} AS SELECT * FROM g.{origem}")

    if faltando:
        pytest.skip(f"banco local sem as origens de: {', '.join(faltando)}")
    yield c
    c.close()


# Monitores: dependem de um evento que pode não ter acontecido ainda (mudança
# de situação cadastral entre duas consultas à Receita). Vazio é resposta
# legítima — o SQL declara isso num comentário para o visitante.
MONITORES = {"Situação cadastral alterada",
              "Mesmo número de nota em candidatos diferentes",
             "Algum fornecedor teve o CNPJ baixado na Receita depois de começar a receber da campanha?"}


@pytest.mark.parametrize("rotulo,sql", CONSULTAS, ids=[r for r, _ in CONSULTAS])
def test_consulta_do_site_executa_e_responde(con, rotulo, sql):
    """Executa a consulta como o visitante a receberia (sem alterar o SQL) e
    exige resposta: consulta válida que devolve zero linhas parece quebrada."""
    try:
        linhas = con.execute(sql).fetchall()
    except duckdb.Error as e:
        pytest.fail(f"consulta '{rotulo}' do console falhou: {e}\n\n{sql}")
    if rotulo not in MONITORES:
        assert linhas, f"consulta '{rotulo}' não devolveu nenhuma linha nos dados reais\n\n{sql}"


def test_monitores_declaram_que_podem_vir_vazios():
    """Quem pode vir vazio avisa no próprio SQL — senão o visitante acha que quebrou."""
    for rotulo, sql in CONSULTAS:
        if rotulo in MONITORES:
            assert "vem vazio" in sql, f"'{rotulo}' pode vir vazio e não avisa no comentário"


def test_corte_recem_aberto_do_site_bate_com_o_backend(con):
    """O site fixa a data de corte do 'CNPJ recém-aberto' (CORTE_RECEM_ABERTO)
    porque não tem o dado antes do boot; o backend a deriva dos próprios dados
    (_ano_eleicao em src/agregados.py). Se a eleição mudar e alguém esquecer o
    front, este teste quebra."""
    from src import agregados

    # deriva com a MESMA função do backend, sobre o banco real
    con.execute(
        "CREATE OR REPLACE VIEW despesas_contratadas AS SELECT * FROM g.despesas_contratadas")
    con.execute("CREATE OR REPLACE VIEW receitas AS SELECT * FROM g.receitas")
    ano = agregados._ano_eleicao(con)
    assert ano is not None
    assert _corte_recem_aberto() == f"{int(ano) - 1}-10-01", (
        f"backend deriva o corte {int(ano) - 1}-10-01; o site fixa {_corte_recem_aberto()}"
    )


def test_toda_pergunta_tem_sql_proprio():
    """Nenhuma pergunta ficou sem consulta (clique que não leva nada ao console)."""
    fonte = EXEMPLOS_TS.read_text(encoding="utf-8")
    perguntas = re.findall(r"pergunta: '([^']*)'", fonte)
    com_sql = {r for r, _ in CONSULTAS}
    assert set(perguntas) <= com_sql, f"perguntas sem SQL: {set(perguntas) - com_sql}"
    assert len(perguntas) >= 20
