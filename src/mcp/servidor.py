"""Servidor MCP público (Streamable HTTP, stateless) sobre os Parquet publicados.

    python -m src.mcp.servidor            # http://localhost:8000/mcp

Variáveis de ambiente (todas opcionais): GH_REPO (repo do release),
MCP_PORTA, MCP_DIR_CACHE, MCP_INTERVALO (s entre verificações do release),
MCP_TIMEOUT (s por consulta), MCP_MAX_SIMULTANEAS, MCP_MEMORIA, MCP_THREADS,
RADAR_GIT_SHA (commit da imagem, para versao_codigo).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import duckdb
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from src.mcp import consultas, dados, esquema, gate

log = logging.getLogger("radar.mcp")

HOST = os.environ.get("MCP_HOST", "0.0.0.0")  # noqa: S104 — container
PORTA = int(os.environ.get("MCP_PORTA", "8000"))
DIR_CACHE = Path(os.environ.get("MCP_DIR_CACHE", "data/mcp"))
INTERVALO = float(os.environ.get("MCP_INTERVALO", "300"))
TIMEOUT = float(os.environ.get("MCP_TIMEOUT", "10"))
MAX_SIMULTANEAS = int(os.environ.get("MCP_MAX_SIMULTANEAS", "8"))
MAX_LINHAS = 500
SITE = "https://radardosgastos.com.br"

SOMENTE_LEITURA = ToolAnnotations(
    readOnlyHint=True, idempotentHint=True, destructiveHint=False, openWorldHint=False
)

mcp = FastMCP(
    name="Radar dos Gastos",
    instructions=esquema.instrucoes(),
    website_url=SITE,
    stateless_http=True,
    json_response=True,
    host=HOST,
    port=PORTA,
    # servidor público atrás de proxy: a proteção contra DNS rebinding é para
    # servidores locais e recusaria o Host do domínio público
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)

# preenchidos no boot (ver ciclo_de_vida) ou por usar_banco() nos testes
_servico: dados.Servico | None = None
_executor: dados.Executor | None = None


def versao_codigo() -> str:
    """Commit da imagem: RADAR_GIT_SHA (build arg) ou SOURCE_COMMIT (o Coolify
    injeta em runtime, mas não como build arg — o deploy de 05/09 saiu
    'desconhecido'); sem os dois, o stamp do pipeline."""
    for nome in ("RADAR_GIT_SHA", "SOURCE_COMMIT"):
        sha = os.environ.get(nome, "").strip()
        if sha and sha != "desconhecido":
            return sha[:12]
    from src import exportar

    return "pipeline-" + exportar.stamp_codigo()[:12]


def usar_banco(banco: dados.Banco, **kw_executor) -> dados.Executor:
    """Liga as ferramentas a um banco já montado (testes e uso embutido)."""
    global _servico, _executor
    servico = dados.Servico(banco.caminho.parent)
    servico.banco = banco
    _servico = servico
    _executor = dados.Executor(servico, timeout=kw_executor.pop("timeout", TIMEOUT),
                               max_simultaneas=kw_executor.pop("max_simultaneas", MAX_SIMULTANEAS),
                               max_linhas=MAX_LINHAS, **kw_executor)
    return _executor


def executor() -> dados.Executor:
    if _executor is None:
        raise ToolError("o servidor ainda está carregando os dados — tente de novo em instantes")
    return _executor


def _resposta(dados_: dict[str, Any]) -> dict[str, Any]:
    banco = executor().banco
    return {
        "versao_dado": banco.versao_dado,
        "publicado_em": banco.publicado_em,
        "versao_codigo": versao_codigo(),
        **dados_,
    }


async def _linhas(sql: str, tabelas: tuple[str, ...] = (), **kw) -> list[dict] | None:
    r = await executor().consultar_opcional(sql, tabelas, **kw)
    return None if r is None else r.linhas


async def _uma(sql: str, tabelas: tuple[str, ...] = ()) -> dict | None:
    linhas = await _linhas(sql, tabelas, max_linhas=1)
    return linhas[0] if linhas else None


def _erro_de_consulta(e: Exception) -> ToolError:
    if isinstance(e, gate.ConsultaRecusada):
        return ToolError(f"consulta recusada: {e}")
    if isinstance(e, dados.TempoEsgotado | dados.Ocupado):
        return ToolError(str(e))
    if isinstance(e, duckdb.Error):
        return ToolError(
            f"erro do DuckDB: {e}\n\nConfira nomes de tabelas/colunas no recurso radar://esquema "
            "e prefira as tabelas prontas (despesas_atual, receitas_atual, indicadores, rede)."
        )
    return ToolError(f"erro inesperado: {e}")


# --------------------------------------------------------------------------- #
# ferramentas
# --------------------------------------------------------------------------- #

@mcp.tool(annotations=SOMENTE_LEITURA)
async def buscar_candidato(nome: str, uf: str | None = None, cargo: str | None = None,
                           partido: str | None = None, limite: int = 20) -> dict[str, Any]:
    """Localiza candidaturas por nome (parcial, tolerante a conectivos) ou número
    de urna, com filtros opcionais de UF, cargo (parcial: 'governador') e partido
    (sigla). Devolve sq_candidato — a chave das demais ferramentas — e os totais
    já declarados. Inclui quem registrou candidatura e ainda não movimentou nada."""
    if not (nome or "").strip():
        raise ToolError("informe um nome (parcial) ou o número de urna")
    sql = consultas.sql_buscar_candidato(nome, uf, cargo, partido, min(max(int(limite), 1), 100))
    try:
        linhas = await _linhas(sql, ("candidatos", "indicadores"))
    except Exception as e:  # noqa: BLE001
        raise _erro_de_consulta(e) from None
    if linhas is None:
        raise ToolError("tabela de candidatos ainda não publicada nesta versão do dado")
    return _resposta({"candidatos": linhas, "n": len(linhas)})


@mcp.tool(annotations=SOMENTE_LEITURA)
async def ficha_candidato(sq_candidato: str) -> dict[str, Any]:
    """A ficha completa de um candidato, como no site: scorecard (indicadores),
    sinais fora da curva com a régua do grupo (mesmo cargo e UF), composição do
    gasto e da receita, maiores fornecedores e doadores, "dinheiro que volta"
    (doador que também é fornecedor, sem plataforma de vaquinha), declarações
    removidas e corrigidas, notas marcadas pelas red flags 7/12/13 e o
    patrimônio declarado. Use buscar_candidato para obter o sq_candidato."""
    sq = (sq_candidato or "").strip()
    if not sq.isdigit():
        raise ToolError("sq_candidato é o código numérico do TSE (obtenha com buscar_candidato)")
    ex = executor()
    sqls = consultas.sql_ficha_candidato(sq, ex.tem_tabela("fornecedores"))
    tabelas_de = {
        "registro": ("candidatos",), "bens": ("bens",), "serie": ("serie_diaria",),
        "dinheiro_que_volta": ("rede",), "sinais": ("indicadores", "benchmark_indicadores"),
        "comparacao": ("benchmark_indicadores",),
        "removidas": ("despesas_removidas",), "receitas_removidas": ("receitas_removidas",),
        "corrigidas_despesas": ("despesas_alteradas",), "corrigidas_receitas": ("receitas_alteradas",),
    }
    try:
        chaves = list(sqls)
        resultados = await asyncio.gather(
            *(_linhas(sqls[k], tabelas_de.get(k, ())) for k in chaves))
    except Exception as e:  # noqa: BLE001
        raise _erro_de_consulta(e) from None
    r = dict(zip(chaves, resultados, strict=True))
    indicadores = (r["indicadores"] or [None])[0]
    registro = (r["registro"] or [None])[0]
    if registro and registro.get("nome") is None:
        registro = None  # ANY_VALUE sobre zero linhas devolve uma linha só de nulos
    if not indicadores and not registro:
        raise ToolError(f"nenhum candidato com sq_candidato {sq}")
    comparacao: dict[str, dict] = {}
    for faixa in r["comparacao"] or []:
        # o grupo local (UF) vale mais que o nacional; o SQL ordena o local antes
        comparacao.setdefault(faixa["metrica"], faixa)
    bens = r["bens"] or []
    return _resposta({
        "sq_candidato": sq,
        "registro": registro,
        "sem_movimento": indicadores is None,
        "indicadores": indicadores,
        "sinais_fora_da_curva": r["sinais"] or [],
        "grupo_de_comparacao": comparacao,
        "gasto_por_categoria": r["categorias"] or [],
        "receita_por_origem": r["origens_receita"] or [],
        "maiores_fornecedores": r["fornecedores"] or [],
        "maiores_doadores": r["doadores"] or [],
        "dinheiro_que_volta": r["dinheiro_que_volta"] or [],
        "declaracoes_removidas": r["removidas"],
        "receitas_removidas": r["receitas_removidas"],
        "declaracoes_corrigidas": r["corrigidas_despesas"],
        "receitas_corrigidas": r["corrigidas_receitas"],
        "notas_marcadas": r["notas_marcadas"] or [],
        "patrimonio_declarado": {"total": round(sum(b["valor"] or 0 for b in bens), 2), "bens": bens}
        if bens else None,
        "serie_diaria": r["serie"] or [],
        "ressalvas": [
            "Dados declaratórios e prestação em aberto: indícios, não prova.",
            f"Razão gasto÷arrecadado só é sinal acima de {consultas.MARGEM_GASTO_ACIMA}× "
            "(descompasso de calendário não conta).",
        ],
    })


@mcp.tool(annotations=SOMENTE_LEITURA)
async def ficha_fornecedor(id: str) -> dict[str, Any]:  # noqa: A002 — nome da API pública
    """A ficha de um fornecedor/doador pelo CNPJ (14 dígitos) ou pelo código
    'pf-…' de pessoa física (o CPF não é publicado): quem ele atende, quanto
    recebeu, cadastro na Receita (abertura, situação, sócios), quanto doou
    (com a doação direta separada do repasse de vaquinha), notas marcadas pelas
    red flags 12/13, declarações removidas e corrigidas."""
    id_ = consultas.limpar_id(id)
    if not id_:
        raise ToolError("informe um CNPJ com 14 dígitos ou um código pf-… de pessoa física")
    ex = executor()
    sqls = consultas.sql_ficha_fornecedor(id_, ex.tem_tabela("norma_documento"))
    tabelas_de = {"cadastro_rfb": ("fornecedores",), "removidas": ("despesas_removidas",),
                  "corrigidas_despesas": ("despesas_alteradas",)}
    try:
        chaves = list(sqls)
        resultados = await asyncio.gather(
            *(_linhas(sqls[k], tabelas_de.get(k, ())) for k in chaves))
    except Exception as e:  # noqa: BLE001
        raise _erro_de_consulta(e) from None
    r = dict(zip(chaves, resultados, strict=True))
    perfil = (r["perfil"] or [None])[0]
    doador = (r["como_doador"] or [None])[0]
    if not (perfil and perfil.get("itens")) and not (doador and doador.get("candidatos")):
        raise ToolError(f"nenhuma despesa ou doação com a contraparte {id_}")
    cadastro = (r["cadastro_rfb"] or [None])[0]
    return _resposta({
        "id": id_,
        "tipo_id": "cnpj" if id_.isdigit() else "pessoa_fisica_pseudonimizada",
        "perfil": perfil,
        "cadastro_rfb": cadastro,
        "cnpj_nao_encontrado_na_base_publica": bool(
            cadastro and cadastro.get("situacao") == "NAO ENCONTRADO NA BASE PUBLICA"),
        "como_doador": doador,
        "numeros_de_nota_repetidos_entre_candidatos": r["numeros_repetidos"] or [],
        "candidatos_atendidos": r["candidatos"] or [],
        "gasto_por_categoria": r["categorias"] or [],
        "maiores_notas": r["notas"] or [],
        "doacoes": r["doacoes"] or [],
        "declaracoes_removidas": r["removidas"],
        "declaracoes_corrigidas": r["corrigidas_despesas"],
    })


@mcp.tool(annotations=SOMENTE_LEITURA)
async def ficha_partido(sigla: str, uf: str | None = None) -> dict[str, Any]:
    """A ficha de um partido (sigla, opcionalmente numa UF): totais, dinheiro
    público, doadores originários, fornecedores compartilhados entre candidatos
    do partido, maiores candidatos e a cota do Fundo Eleitoral por gênero e
    cor/raça (termômetro: mede só o que chegou a candidato)."""
    sigla = (sigla or "").strip()
    if not sigla or len(sigla) > 30:
        raise ToolError("informe a sigla do partido")
    sqls = consultas.sql_ficha_partido(sigla, uf)
    tabelas_de = {"doadores_originarios": ("rede",), "cota_fefc": ("cota_fefc",)}
    try:
        chaves = list(sqls)
        resultados = await asyncio.gather(
            *(_linhas(sqls[k], tabelas_de.get(k, ())) for k in chaves))
    except Exception as e:  # noqa: BLE001
        raise _erro_de_consulta(e) from None
    r = dict(zip(chaves, resultados, strict=True))
    kpis = (r["kpis"] or [None])[0]
    if not kpis or not kpis.get("candidatos_com_movimento"):
        raise ToolError(f"nenhum movimento declarado para o partido {sigla.upper()}"
                        + (f" em {uf.upper()}" if uf else ""))
    cota = (r["cota_fefc"] or [None])[0]
    return _resposta({
        "partido": sigla.upper(), "uf": (uf or "").upper() or None,
        "totais": kpis,
        "receita_por_origem": r["origens_receita"] or [],
        "doadores_originarios": r["doadores_originarios"] or [],
        "fornecedores_compartilhados": r["fornecedores_compartilhados"] or [],
        "maiores_candidatos": r["candidatos"] or [],
        "cota_fefc": cota,
        "ressalvas": [
            "cota_fefc é termômetro, não a conta oficial: a lei mede o total aplicado pelo "
            "partido (inclui gasto direto do diretório) e a prestação está aberta. Piso legal: "
            "30% para mulheres; proporcional às candidaturas negras (pretas + pardas).",
        ],
    })


@mcp.tool(annotations=SOMENTE_LEITURA)
async def fora_da_curva(sinal: str | None = None, uf: str | None = None,
                        cargo: str | None = None, partido: str | None = None,
                        limite: int = 20) -> dict[str, Any]:
    """Candidatos com métricas estritamente acima do p95 do próprio grupo de
    comparação (mesmo cargo e UF; nacional quando o grupo local não existe).
    `sinal` filtra por métrica: total_contratado, razao_gasto_receita,
    pct_maior_fornecedor, pct_sem_nota, pct_pessoa_fisica. Cada sinal vem com
    valor, mediana e p95 do grupo — fatos conferíveis."""
    if sinal and sinal not in consultas.SINAIS:
        raise ToolError(f"sinal desconhecido: {sinal}. Use um de {', '.join(consultas.SINAIS)}")
    sql = consultas.sql_fora_da_curva(sinal, uf, cargo, partido, min(max(int(limite), 1), 100))
    try:
        linhas = await _linhas(sql, ("indicadores", "benchmark_indicadores"))
    except Exception as e:  # noqa: BLE001
        raise _erro_de_consulta(e) from None
    if linhas is None:
        raise ToolError("benchmark ainda não publicado nesta versão do dado")
    for cand in linhas:
        cand["sinais"] = consultas.desmontar_sinais(cand.pop("sinais", ""))
    return _resposta({"sinal": sinal, "candidatos": linhas, "n": len(linhas),
                      "regua": "sinal = métrica > p95 do grupo cargo×UF (BR-TODAS se o grupo "
                               f"local não existe); razão gasto÷arrecadado só acima de "
                               f"{consultas.MARGEM_GASTO_ACIMA}×"})


@mcp.tool(annotations=SOMENTE_LEITURA)
async def declaracoes_removidas(tipo: str = "despesa", uf: str | None = None,
                                cargo: str | None = None, partido: str | None = None,
                                sq_candidato: str | None = None, limite: int = 50) -> dict[str, Any]:
    """Declarações que estavam na prestação de contas, sumiram e NÃO voltaram
    de outra forma — já sem os dois falsos positivos (retransmissão renumerada
    pelo TSE e retificação de um campo). `tipo` = 'despesa' ou 'receita'."""
    if tipo not in ("despesa", "receita"):
        raise ToolError("tipo deve ser 'despesa' ou 'receita'")
    tabela = "receitas_removidas" if tipo == "receita" else "despesas_removidas"
    sql = consultas.sql_declaracoes_removidas(tipo, uf, cargo, partido, sq_candidato,
                                              min(max(int(limite), 1), MAX_LINHAS))
    try:
        linhas = await _linhas(sql, (tabela,))
    except Exception as e:  # noqa: BLE001
        raise _erro_de_consulta(e) from None
    if linhas is None:
        raise ToolError("tabela de removidas ainda não publicada nesta versão do dado")
    return _resposta({"tipo": tipo, "declaracoes": linhas, "n": len(linhas),
                      "valor_total": round(sum(d.get("valor") or 0 for d in linhas), 2)})


@mcp.tool(annotations=SOMENTE_LEITURA)
async def fornecedores_compartilhados(uf: str | None = None, cargo: str | None = None,
                                      partido: str | None = None, minimo_candidatos: int = 2,
                                      limite: int = 30) -> dict[str, Any]:
    """Fornecedores identificados que atendem N ou mais candidatos no recorte
    (rateio, esquema, ou só um fornecedor grande — a lista diz quem é quem)."""
    sql = consultas.sql_fornecedores_compartilhados(
        uf, cargo, partido, max(int(minimo_candidatos), 2), min(max(int(limite), 1), 200))
    try:
        linhas = await _linhas(sql)
    except Exception as e:  # noqa: BLE001
        raise _erro_de_consulta(e) from None
    return _resposta({"fornecedores": linhas or [], "n": len(linhas or [])})


@mcp.tool(annotations=SOMENTE_LEITURA)
async def sem_nota(uf: str | None = None, cargo: str | None = None,
                   partido: str | None = None, limite: int = 30) -> dict[str, Any]:
    """Candidatos com mais gasto declarado SEM documento fiscal onde a nota é a
    norma (fornecedor PJ, categoria em que a maioria emite nota) — a régua do
    indicador valor_sem_nota, com o p95 do grupo ao lado."""
    sql = consultas.sql_sem_nota(uf, cargo, partido, min(max(int(limite), 1), 200))
    try:
        linhas = await _linhas(sql, ("indicadores",))
    except Exception as e:  # noqa: BLE001
        raise _erro_de_consulta(e) from None
    return _resposta({"candidatos": linhas or [], "n": len(linhas or [])})


@mcp.tool(annotations=SOMENTE_LEITURA)
async def gastos_por_categoria(uf: str | None = None, cargo: str | None = None,
                               partido: str | None = None, categoria: str | None = None,
                               limite: int = 30) -> dict[str, Any]:
    """Total gasto por tipo de despesa (categoria oficial do TSE) no recorte,
    com a mediana nacional do preço por nota como régua. `categoria` filtra
    por texto parcial ('carro de som', 'impulsionamento')."""
    sql = consultas.sql_gastos_por_categoria(uf, cargo, partido, categoria,
                                             min(max(int(limite), 1), 200))
    try:
        linhas = await _linhas(sql)
    except Exception as e:  # noqa: BLE001
        raise _erro_de_consulta(e) from None
    return _resposta({"categorias": linhas or [], "n": len(linhas or [])})


@mcp.tool(annotations=SOMENTE_LEITURA)
async def visao_geral() -> dict[str, Any]:
    """Panorama do dia: totais nacionais, o que mudou desde a última extração
    (removidas, corrigidas, novas), série dos últimos dias, maiores candidatos
    e a data do dado. Comece por aqui para saber "como está" antes de aprofundar."""
    banco = executor().banco
    r = banco.resumo
    return _resposta({
        "primeira_extracao": r.get("primeira_extracao"),
        "totais": r.get("totais"),
        "mudancas_desde_a_ultima_extracao": r.get("mudancas"),
        "serie_nacional_ultimos_dias": (r.get("serie_nacional") or [])[-7:],
        "maiores_candidatos": (r.get("top_candidatos") or [])[:10],
        "fora_da_curva_destaques": (r.get("fora_da_curva") or [])[:10],
        "tabelas_disponiveis": banco.tabelas,
    })


@mcp.tool(annotations=SOMENTE_LEITURA)
async def sql(consulta: str, limite: int = MAX_LINHAS) -> dict[str, Any]:
    """Consulta livre em SQL (dialeto DuckDB) sobre todas as tabelas publicadas
    — só leitura, um statement, até 500 linhas, 10 s. O esquema está nas
    instruções do servidor e no recurso radar://esquema. Prefira despesas_atual
    e receitas_atual (extração mais recente, coluna `valor` pronta) e as views
    despesas_removidas/receitas_removidas para remoções. Erros voltam com a
    mensagem do DuckDB para você corrigir e tentar de novo."""
    try:
        texto = gate.validar_leitura(consulta)
        r = await executor().consultar(texto, max_linhas=min(max(int(limite), 1), MAX_LINHAS))
    except Exception as e:  # noqa: BLE001
        raise _erro_de_consulta(e) from None
    saida = r.como_dict()
    if r.truncado:
        saida["aviso"] = ("resultado cortado no teto de linhas/bytes — agregue, filtre por "
                          "UF/cargo/candidato ou use LIMIT menor")
    return _resposta(saida)


# --------------------------------------------------------------------------- #
# recursos
# --------------------------------------------------------------------------- #

@mcp.resource("radar://esquema", name="Esquema dos dados", mime_type="text/markdown")
def recurso_esquema() -> str:
    """Tabelas, colunas, atalhos e regras de consulta — o mesmo texto do site."""
    return esquema.instrucoes()


@mcp.resource("radar://resumo", name="Resumo do dia", mime_type="application/json")
def recurso_resumo() -> str:
    """O resumo.json publicado junto dos Parquet (totais, mudanças, série)."""
    banco = executor().banco
    return json.dumps({k: v for k, v in banco.resumo.items() if k != "arquivos"},
                      ensure_ascii=False)


# --------------------------------------------------------------------------- #
# app HTTP: /mcp (protocolo), /saude e /
# --------------------------------------------------------------------------- #

async def saude(_: Request) -> JSONResponse:
    if _executor is None or _servico is None or _servico.banco is None:
        return JSONResponse({"ok": False, "motivo": "carregando"}, status_code=503)
    b = _servico.banco
    return JSONResponse({"ok": True, "versao_dado": b.versao_dado, "publicado_em": b.publicado_em,
                         "versao_codigo": versao_codigo(), "tabelas": len(b.tabelas)})


async def raiz(_: Request) -> JSONResponse:
    return JSONResponse({
        "nome": "Radar dos Gastos — servidor MCP",
        "mcp": "/mcp (Streamable HTTP)",
        "site": SITE,
        "dados": "https://github.com/machadouglas/analise-gastos-campanha/releases/tag/dados",
    })


def criar_app(servico: dados.Servico | None = None):
    """App ASGI com o boot do banco no ciclo do Starlette (em modo stateless o
    SDK entra no lifespan do MCP a cada requisição — o boot não pode viver lá)."""
    # o gerenciador de sessão do SDK só pode ser iniciado uma vez por instância;
    # cada app criado ganha o seu (em produção criar_app roda uma vez)
    mcp._session_manager = None
    app = mcp.streamable_http_app()
    ciclo_mcp = app.router.lifespan_context

    @asynccontextmanager
    async def ciclo(app_):
        global _servico, _executor
        iniciado_aqui = None
        if _executor is None:
            _servico = servico or dados.Servico(DIR_CACHE, intervalo=INTERVALO)
            await asyncio.to_thread(_servico.iniciar)
            _executor = dados.Executor(_servico, timeout=TIMEOUT, max_simultaneas=MAX_SIMULTANEAS,
                                       max_linhas=MAX_LINHAS)
            iniciado_aqui = _servico
        async with ciclo_mcp(app_):
            yield
        # só para o que este ciclo iniciou: um banco injetado (usar_banco) segue vivo
        if iniciado_aqui is not None:
            iniciado_aqui.parar()

    app.router.lifespan_context = ciclo
    app.router.routes.append(Route("/saude", saude, methods=["GET"]))
    app.router.routes.append(Route("/", raiz, methods=["GET"]))
    return app


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    uvicorn.run(criar_app(), host=HOST, port=PORTA, log_level="info", proxy_headers=True)


if __name__ == "__main__":
    main()
