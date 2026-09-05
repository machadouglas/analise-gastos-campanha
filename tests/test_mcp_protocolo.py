"""Conformidade de protocolo: o servidor de verdade (app ASGI, transporte
Streamable HTTP) conversando com o cliente oficial do SDK, em processo.

Duas eras atendidas ao mesmo tempo:
- o `Client` do SDK 2.x negocia a revisão MAIS RECENTE que o SDK implementa
  (via `server/discover`) — o teste compara com LATEST_PROTOCOL_VERSION, então
  um bump do SDK que traga revisão nova é cobrado aqui;
- o `initialize` clássico (`ClientSession`) continua funcionando para clientes
  que ainda não falam a revisão nova.

O que a especificação exige e este teste cobre: identidade e instructions,
tools/list (descrição, input/output schema, anotações de só-leitura),
tools/call com structured_content e is_error para erro de execução,
resources/list e resources/read com mime_type, e a rota /saude do container.
Sem Node nem Inspector — o build da imagem roda isto.
"""

import asyncio
import sys
from pathlib import Path

import duckdb
import httpx2
import pytest
from mcp.client.client import Client
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.types import LATEST_PROTOCOL_VERSION

sys.path.insert(0, str(Path(__file__).parent.parent))
from src.mcp import dados, servidor  # noqa: E402


@pytest.fixture(scope="module")
def banco(tmp_path_factory):
    """Banco mínimo com as tabelas que as ferramentas exigem."""
    dir_ = tmp_path_factory.mktemp("mcp-proto")
    con = duckdb.connect()
    con.execute(f"""
        COPY (SELECT '160001' AS SQ_CANDIDATO, 'FULANO' AS NM_CANDIDATO, '12345' AS NR_CANDIDATO,
                     'XYZ' AS SG_PARTIDO, 'Deputado Estadual' AS DS_CARGO, 'XX' AS SG_UF,
                     1000.0 AS total_contratado, 2000.0 AS total_receitas, 1 AS n_fornecedores,
                     0.5 AS razao_gasto_receita, 100.0 AS pct_maior_fornecedor,
                     0.0 AS pct_sem_nota, 0.0 AS pct_pessoa_fisica, 0.0 AS valor_sem_nota)
        TO '{(dir_ / "indicadores.parquet").as_posix()}' (FORMAT PARQUET)
    """)
    con.execute(f"""
        COPY (SELECT '160001' AS SQ_CANDIDATO, 'FULANO' AS NM_CANDIDATO, 'FULANO' AS NM_URNA_CANDIDATO,
                     '12345' AS NR_CANDIDATO, 'Deputado Estadual' AS DS_CARGO, 'XYZ' AS SG_PARTIDO,
                     'XX' AS SG_UF, 'APTO' AS DS_SITUACAO_CANDIDATURA)
        TO '{(dir_ / "candidatos.parquet").as_posix()}' (FORMAT PARQUET)
    """)
    con.close()
    (dir_ / "resumo.json").write_text(
        '{"gerado_em": "2026-09-03", "publicado_em": "20260903T170000Z", '
        '"totais": {"candidatos_com_gastos": 1}}', encoding="utf-8")
    b = dados.construir_de_diretorio(dir_, dir_ / "radar.duckdb")
    servidor.usar_banco(b)
    yield b
    b.fechar()


def _cliente_http(app) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app),
                              base_url="http://testserver", timeout=30)


class _TransporteEmProcesso:
    """Transport do SDK (context manager que entrega os dois streams) sobre o
    app ASGI — o Client fala Streamable HTTP de verdade, sem porta aberta."""

    def __init__(self, app):
        self._cm = streamable_http_client("http://testserver/mcp", http_client=_cliente_http(app))

    async def __aenter__(self):
        return await self._cm.__aenter__()

    async def __aexit__(self, *exc):
        return await self._cm.__aexit__(*exc)


async def _com_cliente(corpo):
    """App novo por sessão: o gerenciador de sessão do SDK roda uma vez por app."""
    app = servidor.criar_app()
    async with app.router.lifespan_context(app):
        async with Client(_TransporteEmProcesso(app), mode="auto") as cliente:
            return await corpo(cliente)


def test_cliente_novo_negocia_a_revisao_mais_recente_do_sdk(banco):
    async def corpo(c: Client):
        return c.protocol_version, c.server_info, c.instructions, c.server_capabilities

    versao, info, instrucoes, caps = asyncio.run(_com_cliente(corpo))
    assert versao == LATEST_PROTOCOL_VERSION, (
        f"servidor negociou {versao}; o SDK implementa {LATEST_PROTOCOL_VERSION}")
    assert info.name == "Radar dos Gastos"
    assert "despesas_atual" in (instrucoes or "")
    assert caps.tools is not None and caps.resources is not None


def test_initialize_classico_continua_atendendo_clientes_antigos(banco):
    async def tudo():
        app = servidor.criar_app()
        async with app.router.lifespan_context(app):
            async with streamable_http_client("http://testserver/mcp",
                                              http_client=_cliente_http(app)) as (r, w):
                async with ClientSession(r, w) as s:
                    init = await s.initialize()
                    tools = (await s.list_tools()).tools
                    return init, tools

    init, tools = asyncio.run(tudo())
    assert init.server_info.name == "Radar dos Gastos"
    assert init.protocol_version  # a revisão que o initialize clássico acordou
    assert {t.name for t in tools} >= {"visao_geral", "sql"}


def test_tools_list_tem_schema_e_anotacoes_de_leitura(banco):
    async def corpo(c: Client):
        return (await c.list_tools()).tools

    tools = asyncio.run(_com_cliente(corpo))
    nomes = {t.name for t in tools}
    assert {"buscar_candidato", "ficha_candidato", "ficha_fornecedor", "ficha_partido",
            "fora_da_curva", "declaracoes_removidas", "fornecedores_compartilhados",
            "sem_nota", "gastos_por_categoria", "visao_geral", "sql"} <= nomes
    for t in tools:
        assert t.description and len(t.description) > 40, t.name
        assert t.input_schema.get("type") == "object", t.name
        assert t.output_schema is not None, f"{t.name} sem output_schema"
        assert t.annotations is not None, t.name
        assert t.annotations.read_only_hint is True, t.name
        assert t.annotations.destructive_hint is False, t.name
        assert t.annotations.idempotent_hint is True, t.name
        assert t.annotations.open_world_hint is False, t.name


def test_tools_call_devolve_structured_content_e_versao(banco):
    async def corpo(c: Client):
        return await c.call_tool("buscar_candidato", {"nome": "fulano"})

    r = asyncio.run(_com_cliente(corpo))
    assert r.is_error is False
    assert r.structured_content and r.structured_content["versao_dado"] == "2026-09-03"
    assert r.structured_content["candidatos"][0]["sq_candidato"] == "160001"
    assert r.content and r.content[0].type == "text"


def test_erro_de_execucao_vira_is_error_e_nao_erro_de_protocolo(banco):
    async def corpo(c: Client):
        return await c.call_tool("sql", {"consulta": "CREATE TABLE x(a int)"})

    r = asyncio.run(_com_cliente(corpo))
    assert r.is_error is True
    assert "recusada" in r.content[0].text


def test_resources_com_mime_type(banco):
    async def corpo(c: Client):
        lista = (await c.list_resources()).resources
        esquema = await c.read_resource("radar://esquema")
        resumo = await c.read_resource("radar://resumo")
        return lista, esquema, resumo

    lista, esquema, resumo = asyncio.run(_com_cliente(corpo))
    uris = {str(r.uri) for r in lista}
    assert {"radar://esquema", "radar://resumo"} <= uris
    assert esquema.contents[0].mime_type == "text/markdown"
    assert "REGRAS OBRIGATÓRIAS" in esquema.contents[0].text
    assert resumo.contents[0].mime_type == "application/json"
    assert '"candidatos_com_gastos"' in resumo.contents[0].text


def test_rota_de_saude_e_raiz(banco):
    async def tudo():
        app = servidor.criar_app()
        async with app.router.lifespan_context(app):
            async with _cliente_http(app) as c:
                return await c.get("/saude"), await c.get("/")

    saude, raiz = asyncio.run(tudo())
    assert saude.status_code == 200 and saude.json()["ok"] is True
    assert saude.json()["versao_dado"] == "2026-09-03"
    assert raiz.status_code == 200 and raiz.json()["mcp"].startswith("/mcp")
