"""Conformidade de protocolo: o servidor de verdade (app ASGI, transporte
Streamable HTTP) conversando com o cliente oficial do SDK, em processo.

O que a especificação exige e este teste cobre: initialize (nome, versão de
protocolo, instructions), tools/list (descrição, inputSchema, outputSchema,
anotações de só-leitura), tools/call com structuredContent e isError para
erro de execução, resources/list e resources/read com mimeType, e a rota
/saude do container. Sem Node nem Inspector — o build da imagem roda isto.
"""

import asyncio
import sys
from pathlib import Path

import duckdb
import httpx
import pytest
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
from pydantic import AnyUrl

sys.path.insert(0, str(Path(__file__).parent.parent))
from src.mcp import dados, servidor  # noqa: E402


@pytest.fixture(scope="module")
def app(tmp_path_factory):
    """Banco mínimo com as tabelas que as ferramentas exigem e o app pronto."""
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
    banco = dados.construir_de_diretorio(dir_, dir_ / "radar.duckdb")
    servidor.usar_banco(banco)
    yield banco
    banco.fechar()


def _cliente(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://testserver", timeout=30)


async def _sessao(_, corpo):
    """App novo por sessão: o gerenciador de sessão do SDK roda uma vez por app."""
    app = servidor.criar_app()
    async with app.router.lifespan_context(app):
        async with streamable_http_client("http://testserver/mcp",
                                          http_client=_cliente(app)) as (r, w, _):
            async with ClientSession(r, w) as sessao:
                await sessao.initialize()
                return await corpo(sessao)


def test_initialize_declara_servidor_e_instrucoes(app):
    async def corpo(s: ClientSession):
        return await s.initialize()

    async def tudo():
        app_ = servidor.criar_app()
        async with app_.router.lifespan_context(app_):
            async with streamable_http_client("http://testserver/mcp",
                                              http_client=_cliente(app_)) as (r, w, _):
                async with ClientSession(r, w) as s:
                    return await s.initialize()

    init = asyncio.run(tudo())
    assert init.serverInfo.name == "Radar dos Gastos"
    assert init.protocolVersion
    assert "despesas_atual" in (init.instructions or "")
    assert init.capabilities.tools is not None and init.capabilities.resources is not None


def test_tools_list_tem_schema_e_anotacoes_de_leitura(app):
    async def corpo(s: ClientSession):
        return (await s.list_tools()).tools

    tools = asyncio.run(_sessao(app, corpo))
    nomes = {t.name for t in tools}
    assert {"buscar_candidato", "ficha_candidato", "ficha_fornecedor", "ficha_partido",
            "fora_da_curva", "declaracoes_removidas", "fornecedores_compartilhados",
            "sem_nota", "gastos_por_categoria", "visao_geral", "sql"} <= nomes
    for t in tools:
        assert t.description and len(t.description) > 40, t.name
        assert t.inputSchema.get("type") == "object", t.name
        assert t.outputSchema is not None, f"{t.name} sem outputSchema"
        assert t.annotations is not None, t.name
        assert t.annotations.readOnlyHint is True, t.name
        assert t.annotations.destructiveHint is False, t.name
        assert t.annotations.idempotentHint is True, t.name
        assert t.annotations.openWorldHint is False, t.name


def test_tools_call_devolve_structured_content_e_versao(app):
    async def corpo(s: ClientSession):
        return await s.call_tool("buscar_candidato", {"nome": "fulano"})

    r = asyncio.run(_sessao(app, corpo))
    assert r.isError is False
    assert r.structuredContent and r.structuredContent["versao_dado"] == "2026-09-03"
    assert r.structuredContent["candidatos"][0]["sq_candidato"] == "160001"
    assert r.content and r.content[0].type == "text"


def test_erro_de_execucao_vira_is_error_e_nao_erro_de_protocolo(app):
    async def corpo(s: ClientSession):
        return await s.call_tool("sql", {"consulta": "CREATE TABLE x(a int)"})

    r = asyncio.run(_sessao(app, corpo))
    assert r.isError is True
    assert "recusada" in r.content[0].text


def test_resources_com_mime_type(app):
    async def corpo(s: ClientSession):
        lista = (await s.list_resources()).resources
        esquema = await s.read_resource(AnyUrl("radar://esquema"))
        resumo = await s.read_resource(AnyUrl("radar://resumo"))
        return lista, esquema, resumo

    lista, esquema, resumo = asyncio.run(_sessao(app, corpo))
    uris = {str(r.uri) for r in lista}
    assert {"radar://esquema", "radar://resumo"} <= uris
    assert esquema.contents[0].mimeType == "text/markdown"
    assert "REGRAS OBRIGATÓRIAS" in esquema.contents[0].text
    assert resumo.contents[0].mimeType == "application/json"
    assert '"candidatos_com_gastos"' in resumo.contents[0].text


def test_rota_de_saude_e_raiz(app):
    async def tudo():
        app_ = servidor.criar_app()
        async with app_.router.lifespan_context(app_):
            async with _cliente(app_) as c:
                return await c.get("/saude"), await c.get("/")

    saude, raiz = asyncio.run(tudo())
    assert saude.status_code == 200 and saude.json()["ok"] is True
    assert saude.json()["versao_dado"] == "2026-09-03"
    assert raiz.status_code == 200 and raiz.json()["mcp"].startswith("/mcp")
