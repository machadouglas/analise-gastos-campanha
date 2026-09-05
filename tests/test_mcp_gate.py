"""Gate e guarda-corpos da ferramenta `sql` do MCP.

O gate é o parser do DuckDB (um statement, tipo SELECT); a conexão de leitura
é só leitura, sem acesso externo e travada; cada consulta tem timeout, teto de
linhas e de bytes. Cada barreira é provada aqui contra um banco sintético.
"""

import asyncio
import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src.mcp import dados, gate  # noqa: E402


@pytest.mark.parametrize("sql", [
    "SELECT 1",
    "WITH a AS (SELECT 1 AS x) SELECT * FROM a",
    "DESCRIBE SELECT 1",
    "SUMMARIZE SELECT 1 AS x",
    "SHOW TABLES",
    "FROM range(3)",
    "-- comentário\nSELECT 1;",
    "/* bloco */ SELECT 1",
])
def test_gate_aceita_leitura(sql):
    assert gate.validar_leitura(sql)


@pytest.mark.parametrize("sql,trecho", [
    ("SELECT 1; CREATE TABLE x(a int)", "um statement"),
    ("CREATE TABLE x(a int)", "CREATE"),
    ("INSERT INTO x VALUES (1)", "INSERT"),
    ("COPY (SELECT 1) TO '/tmp/x.csv'", "COPY"),
    ("SET threads = 8", "SET"),
    ("INSTALL httpfs", "LOAD"),
    ("LOAD httpfs", "LOAD"),
    ("ATTACH 'x.duckdb' AS y", "ATTACH"),
    ("EXPLAIN SELECT 1", "EXPLAIN"),
    # PRAGMA com atribuição é SET; `PRAGMA database_list` o parser reescreve
    # como SELECT de uma função de leitura e passa (inofensivo)
    ("PRAGMA threads = 8", "SET"),
    ("CALL pragma_version()", "CALL"),
    ("", "vazia"),
    ("SELEC 1", "inválido"),
])
def test_gate_recusa_o_que_nao_e_leitura(sql, trecho):
    with pytest.raises(gate.ConsultaRecusada) as e:
        gate.validar_leitura(sql)
    assert trecho.lower() in str(e.value).lower()


def test_gate_recusa_pivot_com_explicacao():
    """O parser reescreve PIVOT como CREATE + SELECT; o gate explica a exceção
    (o console do site aceita PIVOT — tests/test_sincronia_site.py registra)."""
    with pytest.raises(gate.ConsultaRecusada) as e:
        gate.validar_leitura("PIVOT t ON a USING sum(b)")
    assert "PIVOT" in str(e.value)
    with pytest.raises(gate.ConsultaRecusada):
        gate.validar_leitura("  /* x */ unpivot t ON a INTO NAME n VALUE v")


# --------------------------------------------------------------------------- #
# guarda-corpos da execução
# --------------------------------------------------------------------------- #

@pytest.fixture(scope="module")
def banco(tmp_path_factory):
    dir_ = tmp_path_factory.mktemp("mcp")
    con = duckdb.connect()
    con.execute("COPY (SELECT i AS id, 'x' || i AS nome FROM range(2000) t(i)) "
                f"TO '{(dir_ / 'coisas.parquet').as_posix()}' (FORMAT PARQUET)")
    con.close()
    b = dados.construir_de_diretorio(dir_, dir_ / "radar.duckdb")
    yield b
    b.fechar()


@pytest.fixture
def executor(banco):
    servico = dados.Servico(banco.caminho.parent)
    servico.banco = banco
    return dados.Executor(servico, timeout=1.0, max_simultaneas=2, espera_fila=0.2,
                          max_linhas=100, max_bytes=10_000, max_simultaneas_sql=1)


def _rodar(coro):
    return asyncio.run(coro)


def test_conexao_e_so_leitura_e_sem_acesso_externo(banco):
    cur = banco.cursor()
    for sql in ("CREATE TABLE t(a int)", "INSERT INTO coisas VALUES (1, 'a')",
                "DELETE FROM coisas"):
        with pytest.raises(duckdb.Error):
            cur.execute(sql)
    for sql in ("SELECT * FROM read_csv('/etc/passwd')",
                "SELECT * FROM 'https://exemplo.invalido/x.parquet'",
                "SELECT * FROM read_parquet('*.parquet')"):
        with pytest.raises(duckdb.Error):
            cur.execute(sql).fetchall()
    # a configuração está travada: nem a própria consulta desfaz
    with pytest.raises(duckdb.Error):
        cur.execute("SET enable_external_access = true")
    assert cur.execute("SELECT current_setting('enable_external_access')").fetchone()[0] is False
    cur.close()


def test_teto_de_linhas_marca_truncado(executor):
    r = _rodar(executor.consultar("SELECT * FROM coisas ORDER BY id"))
    assert len(r.linhas) == 100 and r.truncado
    r = _rodar(executor.consultar("SELECT * FROM coisas ORDER BY id", max_linhas=10))
    assert len(r.linhas) == 10 and r.truncado
    assert r.linhas[0] == {"id": 0, "nome": "x0"}
    r = _rodar(executor.consultar("SELECT COUNT(*) AS n FROM coisas"))
    assert r.linhas == [{"n": 2000}] and not r.truncado


def test_teto_de_bytes_corta_a_resposta(executor):
    r = _rodar(executor.consultar("SELECT id, repeat('a', 200) AS txt FROM coisas"))
    assert r.truncado_bytes and 0 < len(r.linhas) < 100


def test_timeout_interrompe_e_a_conexao_sobrevive(executor):
    pesada = "SELECT COUNT(*) FROM range(100000000) a, range(100000) b"
    with pytest.raises(dados.TempoEsgotado):
        _rodar(executor.consultar(pesada))
    r = _rodar(executor.consultar("SELECT 1 AS a"))
    assert r.linhas == [{"a": 1}]


def test_fila_cheia_recusa_em_vez_de_enfileirar_para_sempre(executor):
    pesada = "SELECT COUNT(*) FROM range(100000000) a, range(100000) b"

    async def cenario():
        lentas = [asyncio.create_task(executor.consultar(pesada)) for _ in range(2)]
        await asyncio.sleep(0.05)
        with pytest.raises(dados.Ocupado):
            await executor.consultar("SELECT 1")
        for t in lentas:
            with pytest.raises(dados.TempoEsgotado):
                await t

    _rodar(cenario())


def test_valores_saem_serializaveis(executor):
    r = _rodar(executor.consultar(
        "SELECT DATE '2026-09-03' AS d, TIMESTAMP '2026-09-03 04:00:00' AS ts, "
        "CAST(1.5 AS DECIMAL(10,2)) AS dec, 'NaN'::DOUBLE AS nan, [1, 2] AS lista"))
    assert r.linhas == [{"d": "2026-09-03", "ts": "2026-09-03T04:00:00", "dec": 1.5,
                         "nan": None, "lista": [1, 2]}]


def test_tabela_ausente_degrada_para_none(executor):
    assert _rodar(executor.consultar_opcional("SELECT 1", ("nao_existe",))) is None
    assert _rodar(executor.consultar_opcional("SELECT * FROM nao_existe")) is None
    assert _rodar(executor.consultar_opcional("SELECT 1 AS a")).linhas == [{"a": 1}]


def test_sql_livre_tem_fila_propria_e_nao_esgota_as_ferramentas(executor):
    """Medido em produção com uma fila só: cross joins na `sql` tomavam todas
    as vagas e as fichas recebiam "ocupado". Com filas separadas, a sql cheia
    recusa só sql; a ferramenta curada passa."""
    pesada = "SELECT COUNT(*) FROM range(100000000) a, range(100000) b"

    async def cenario():
        lenta = asyncio.create_task(executor.consultar(pesada, fila="sql"))
        await asyncio.sleep(0.05)
        with pytest.raises(dados.Ocupado, match="SQL livres"):
            await executor.consultar("SELECT 1", fila="sql")
        r = await executor.consultar("SELECT 1 AS a")  # fila das ferramentas, livre
        assert r.linhas == [{"a": 1}]
        with pytest.raises(dados.TempoEsgotado):
            await lenta

    _rodar(cenario())
