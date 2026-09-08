"""Rota HTTP do site: `GET /api/v1/consulta` executa o SQL que as páginas do
site montam (fichas e Explorar) no DuckDB deste processo e devolve o resultado
no formato do console (`colunas` + `linhas` como listas).

Por que o site manda o SQL, e não chama as ferramentas curadas: o SQL das
páginas é construído em `site/src/lib/consultas.ts` e nas próprias páginas, e
é o MESMO que o DuckDB-WASM roda no navegador quando a API não responde. Um
único texto de consulta, dois executores — paridade por construção, sem uma
segunda camada de contrato para manter em sincronia.

Por que GET, e não POST: a URL é a chave do cache da borda. A consulta de uma
ficha é sempre a mesma string; com a versão do dado (`v`) na URL, a resposta é
imutável e a Cloudflare a serve sem tocar neste processo — no pico, o servidor
só vê o *miss*. A consulta viaja comprimida (`q` = deflate-raw + base64url) ou
crua (`sql`); ver `viaApi` em site/src/lib/dados.ts.

Guarda-corpos: os mesmos da ferramenta `sql` (parser do DuckDB, conexão só
leitura, timeout por interrupt, teto de linhas/bytes/célula), numa fila
própria (`site`) com timeout menor. Não há autenticação nem sessão: é o mesmo
dado público que o release já entrega a qualquer um.
"""

from __future__ import annotations

import base64
import binascii
import logging
import zlib
from collections.abc import Callable

import duckdb
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from src.mcp import dados, gate

log = logging.getLogger("radar.mcp")

# Resposta imutável por versão do dado: a URL já carrega `v`, então cache
# longo não serve dado velho — release novo é URL nova. A borda (s-maxage) e o
# navegador (max-age) podem guardar por um dia.
CACHE_IMUTAVEL = "public, max-age=86400, s-maxage=86400, immutable"
SEM_CACHE = "no-store"
# Dado público, sem credencial: a origem do site não precisa ser conhecida
# aqui, e um valor fixo é o único que sobrevive ao cache da borda (que ignora
# `Vary: Origin`).
CORS = {"Access-Control-Allow-Origin": "*"}
CABECALHO_VERSAO = "X-Radar-Versao-Dado"


class RequisicaoInvalida(ValueError):
    pass


def descomprimir(q: str) -> str:
    """`q` = deflate-raw (CompressionStream('deflate-raw')) em base64url sem
    padding. O descompressor tem teto: um `q` pequeno que explodisse em
    dezenas de MB pararia no limite do gate, não na memória do processo."""
    try:
        # validate=True: o decodificador padrão ignora caracteres estranhos em
        # silêncio, e lixo viraria "deflate inválido" em vez do erro certo
        bruto = base64.b64decode(q.replace("-", "+").replace("_", "/") + "=" * (-len(q) % 4),
                                 validate=True)
    except (binascii.Error, ValueError) as e:
        raise RequisicaoInvalida(f"q não é base64url válido: {e}") from None
    d = zlib.decompressobj(-15)
    try:
        texto = d.decompress(bruto, gate.MAX_CHARS_SQL * 4 + 1)
    except zlib.error as e:
        raise RequisicaoInvalida(f"q não é deflate-raw válido: {e}") from None
    if d.unconsumed_tail or len(texto) > gate.MAX_CHARS_SQL * 4:
        raise RequisicaoInvalida("consulta comprimida grande demais")
    try:
        return texto.decode("utf-8")
    except UnicodeDecodeError as e:
        raise RequisicaoInvalida(f"q não é UTF-8: {e}") from None


def sql_da_requisicao(request: Request) -> str:
    q = request.query_params.get("q")
    if q:
        return descomprimir(q)
    sql = request.query_params.get("sql")
    if sql:
        return sql
    raise RequisicaoInvalida("informe a consulta em `sql` (texto) ou `q` (deflate-raw + base64url)")


def cabecalhos_de_cache(versao_pedida: str | None, versao_banco: str | None) -> dict[str, str]:
    """Imutável só quando o cliente pediu exatamente a versão que este processo
    serve; qualquer descompasso sai sem cache, para a borda não fixar uma
    resposta de versão trocada na chave da versão nova."""
    bate = bool(versao_pedida) and versao_pedida == versao_banco
    h = {"Cache-Control": CACHE_IMUTAVEL if bate else SEM_CACHE, **CORS}
    if versao_banco:
        h[CABECALHO_VERSAO] = versao_banco
    return h


def _erro(status: int, mensagem: str, extra: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse({"erro": mensagem}, status_code=status,
                        headers={"Cache-Control": SEM_CACHE, **CORS, **(extra or {})})


def criar_rotas(obter_executor: Callable[[], dados.Executor],
                versao_codigo: Callable[[], str]) -> list[Route]:
    """As rotas recebem o executor e a versão por função (não por import) para
    não haver ciclo com servidor.py, que é quem as registra."""

    async def consulta(request: Request) -> JSONResponse:
        try:
            ex = obter_executor()
            banco = ex.banco
        except Exception:  # noqa: BLE001 — sem banco é 503, não stack
            return _erro(503, "o servidor ainda está carregando os dados", {"Retry-After": "10"})
        try:
            sql = gate.validar_leitura(sql_da_requisicao(request))
        except (RequisicaoInvalida, gate.ConsultaRecusada) as e:
            return _erro(400, str(e))

        versao_pedida = request.query_params.get("v") or None
        versao_banco = banco.publicado_em
        # o site sabe do release novo antes deste processo (ver
        # Servico.pedir_verificacao): a resposta sai sem cache, e a próxima
        # rodada de verificação vem já — não daqui a 5 min
        if versao_pedida and versao_banco and versao_pedida > versao_banco:
            ex.servico.pedir_verificacao()

        try:
            r = await ex.consultar(sql, fila="site", listas=True)
        except dados.Ocupado as e:
            return _erro(503, str(e), {"Retry-After": "2"})
        except dados.TempoEsgotado as e:
            return _erro(504, str(e))
        except dados.ResultadoLargo as e:
            return _erro(400, str(e))
        except duckdb.Error as e:
            # erro do próprio SQL (coluna ausente num parquet antigo, por
            # exemplo): o site trata como trataria no WASM — é erro da consulta,
            # não indisponibilidade
            return _erro(400, f"erro do DuckDB: {e}")
        except Exception:  # noqa: BLE001
            log.exception("falha inesperada na rota do site")
            return _erro(500, "erro inesperado")

        corpo = {
            "versao_dado": banco.versao_dado,
            "publicado_em": versao_banco,
            "versao_codigo": versao_codigo(),
            **r.como_dict(),
        }
        return JSONResponse(corpo, headers=cabecalhos_de_cache(versao_pedida, versao_banco))

    return [Route("/api/v1/consulta", consulta, methods=["GET"])]
