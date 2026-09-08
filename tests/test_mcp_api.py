"""A rota do site (GET /api/v1/consulta, src/mcp/api.py) contra o app ASGI.

O site manda o MESMO SQL que o DuckDB-WASM rodaria no navegador; a rota tem
de devolvê-lo no formato do console (colunas + linhas como listas), com os
cabeçalhos que fazem a borda cachear só o que é imutável, e com status HTTP
que digam ao site quando cair para o WASM (5xx) e quando não (4xx = erro da
consulta, o mesmo que o WASM devolveria).

Reaproveita o fixture do pipeline real (test_mcp_ferramentas.banco) para a
paridade: cada consulta pronta do console, pela rota, é linha a linha igual
ao cursor cru.
"""

import asyncio
import base64
import re
import sys
import zlib
from pathlib import Path

import duckdb
import httpx2
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src.mcp import api, dados, servidor  # noqa: E402
from tests.test_consultas_do_site import _consultas  # noqa: E402
from tests.test_mcp_ferramentas import banco  # noqa: E402, F401 — fixture do pipeline real

ROTA = "/api/v1/consulta"


def _comprimir(sql: str) -> str:
    """O que CompressionStream('deflate-raw') + base64url produz no navegador."""
    c = zlib.compressobj(wbits=-15)
    bruto = c.compress(sql.encode("utf-8")) + c.flush()
    return base64.urlsafe_b64encode(bruto).decode("ascii").rstrip("=")


async def _get(params: dict, **kw_executor):
    """App novo por chamada (o gerenciador de sessão do SDK roda uma vez por app)."""
    if kw_executor:
        servidor.usar_banco(servidor.executor().banco, **kw_executor)
    app = servidor.criar_app()
    async with app.router.lifespan_context(app):
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app),
                                      base_url="http://testserver", timeout=30) as c:
            return await c.get(ROTA, params=params)


def _rodar(coro):
    return asyncio.run(coro)


def test_devolve_o_formato_do_console_com_cors_e_versao(banco):
    r = _rodar(_get({"sql": "SELECT SQ_CANDIDATO, total_contratado FROM indicadores "
                            "ORDER BY 2 DESC LIMIT 2"}))
    assert r.status_code == 200, r.text
    corpo = r.json()
    assert corpo["colunas"] == ["SQ_CANDIDATO", "total_contratado"]
    assert len(corpo["linhas"]) == 2 and all(isinstance(l, list) for l in corpo["linhas"])
    assert corpo["versao_dado"] == banco.versao_dado and corpo["publicado_em"] == banco.publicado_em
    assert corpo["versao_codigo"] and corpo["truncado"] is False
    assert r.headers["Access-Control-Allow-Origin"] == "*"
    assert r.headers[api.CABECALHO_VERSAO] == banco.publicado_em


def test_cache_imutavel_so_quando_a_versao_bate(banco):
    sem_v = _rodar(_get({"sql": "SELECT 1"}))
    assert sem_v.headers["Cache-Control"] == api.SEM_CACHE
    certa = _rodar(_get({"sql": "SELECT 1", "v": banco.publicado_em}))
    assert certa.headers["Cache-Control"] == api.CACHE_IMUTAVEL
    errada = _rodar(_get({"sql": "SELECT 1", "v": "20200101T000000Z"}))
    assert errada.status_code == 200 and errada.headers["Cache-Control"] == api.SEM_CACHE


def test_versao_mais_nova_que_o_banco_pede_verificacao(banco, monkeypatch):
    """O site vê o release novo antes do processo (cache de 5 min do
    resumo.json na borda + poll de 5 min aqui): a requisição com `v` do
    futuro dispara a verificação fora do ciclo, e a resposta sai sem cache."""
    pedidos = []
    monkeypatch.setattr(dados.Servico, "pedir_verificacao", lambda self: pedidos.append(1) or True)
    r = _rodar(_get({"sql": "SELECT 1", "v": "29990101T000000Z"}))
    assert r.status_code == 200 and r.headers["Cache-Control"] == api.SEM_CACHE
    assert pedidos == [1]
    _rodar(_get({"sql": "SELECT 1", "v": banco.publicado_em}))
    assert pedidos == [1], "versão igual não pede verificação"


def test_pedir_verificacao_tem_debounce(banco):
    servico = servidor.executor().servico
    chamadas = []
    servico.verificar = lambda: chamadas.append(1) or False  # type: ignore[method-assign]
    servico.ultima_verificacao = None
    assert servico.pedir_verificacao() is True
    for _ in range(50):  # espera a thread
        if chamadas:
            break
        asyncio.run(asyncio.sleep(0.02))
    assert chamadas == [1]
    assert servico.pedir_verificacao() is False, "dentro da janela de debounce"
    assert chamadas == [1]


def test_consulta_comprimida_equivale_a_crua(banco):
    sql = "SELECT SG_UF, COUNT(*) AS n FROM despesas_atual GROUP BY 1 ORDER BY 1 -- fim"
    crua = _rodar(_get({"sql": sql})).json()
    comprimida = _rodar(_get({"q": _comprimir(sql)})).json()
    assert comprimida["colunas"] == crua["colunas"] and comprimida["linhas"] == crua["linhas"]
    assert crua["linhas"]


def test_colunas_de_nome_repetido_sobrevivem(banco):
    """Colunas sem alias distinto: o formato em listas preserva ordem e valor
    (um dicionário fundiria as duas). O nome repetido sai desambiguado
    (`a_1`) pela projeção limitada do executor — as páginas leem por índice,
    e o cabeçalho da tabela do Explorar sempre tem alias próprio."""
    r = _rodar(_get({"sql": "SELECT 1 AS a, 2 AS a, NULL AS b"})).json()
    assert r["colunas"] == ["a", "a_1", "b"] and r["linhas"] == [[1, 2, None]]


@pytest.mark.parametrize("params,trecho", [
    ({}, "informe a consulta"),
    ({"sql": "CREATE TABLE x(a int)"}, "só leitura"),
    ({"sql": "SELECT 1; SELECT 2"}, "um statement"),
    ({"sql": "SELECT coluna_que_nao_existe FROM indicadores"}, "erro do DuckDB"),
    ({"q": "!!!nao-e-base64"}, "base64url"),
    ({"q": base64.urlsafe_b64encode(b"nao e deflate").decode().rstrip("=")}, "deflate"),
])
def test_erro_da_consulta_e_400_sem_cache(banco, params, trecho):
    """4xx = a consulta está errada e o WASM daria o mesmo erro: o site NÃO
    cai para o fallback (uma página que tenta uma variante e recua no catch,
    como o Explorar, precisa ver o erro)."""
    r = _rodar(_get(params))
    assert r.status_code == 400, r.text
    assert trecho in r.json()["erro"]
    assert r.headers["Cache-Control"] == api.SEM_CACHE
    assert r.headers["Access-Control-Allow-Origin"] == "*"


def test_bomba_de_descompressao_para_no_teto():
    """40 MB de espaços viram poucos KB em deflate; o descompressor tem de
    parar no teto do gate em vez de materializar tudo."""
    with pytest.raises(api.RequisicaoInvalida, match="grande demais"):
        api.descomprimir(_comprimir(" " * 40_000_000))


def test_tempo_esgotado_na_fila_do_site_e_504(banco):
    """A fila do site tem timeout próprio, menor: uma consulta que passa dele
    não é do site. 5xx = o site cai para o WASM."""
    pesada = "SELECT COUNT(*) FROM range(100000000) a, range(100000) b"
    try:
        r = _rodar(_get({"sql": pesada}, timeout_site=0.3))
        assert r.status_code == 504, r.text
        assert r.headers["Cache-Control"] == api.SEM_CACHE
        # o processo segue respondendo
        assert _rodar(_get({"sql": "SELECT 1 AS a"})).json()["linhas"] == [[1]]
    finally:
        servidor.usar_banco(servidor.executor().banco)


def test_fila_do_site_cheia_e_503_com_retry_after(banco):
    pesada = "SELECT COUNT(*) FROM range(100000000) a, range(100000) b"
    servidor.usar_banco(servidor.executor().banco, max_simultaneas_site=1,
                        timeout_site=1.0, espera_fila=0.1)
    try:
        app = servidor.criar_app()

        async def cenario():
            async with app.router.lifespan_context(app):
                async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app),
                                              base_url="http://testserver", timeout=30) as c:
                    lenta = asyncio.create_task(c.get(ROTA, params={"sql": pesada}))
                    await asyncio.sleep(0.1)
                    rapida = await c.get(ROTA, params={"sql": "SELECT 1"})
                    return rapida, await lenta

        rapida, lenta = _rodar(cenario())
        assert rapida.status_code == 503 and rapida.headers["Retry-After"] == "2"
        assert lenta.status_code == 504
    finally:
        servidor.usar_banco(servidor.executor().banco)


def test_teto_de_linhas_do_site_cobre_a_dispersao_do_explorar(banco):
    """O Explorar pede até 1.500 pontos (LIMITE_DISPERSAO); o teto da fila do
    site é maior que o da sql livre (500) para a página não sair truncada."""
    r = _rodar(_get({"sql": "SELECT range AS i FROM range(1500)"})).json()
    assert len(r["linhas"]) == 1500 and r["truncado"] is False
    r = _rodar(_get({"sql": "SELECT range AS i FROM range(5000)"})).json()
    assert len(r["linhas"]) == 2000 and r["truncado"] is True


def test_view_nomes_urna_existe_como_no_wasm(banco):
    """As páginas fazem LEFT JOIN nomes_urna (JOIN_NOMES_URNA em consultas.ts)
    — no navegador a view é criada por duckdb.ts; aqui, por dados.construir.
    Sem ela toda ficha voltaria 400 com a API ligada."""
    consultas_ts = (Path(__file__).parent.parent / "site/src/lib/consultas.ts").read_text(
        encoding="utf-8")
    join = re.search(r"JOIN_NOMES_URNA = '([^']+)'", consultas_ts).group(1)
    r = _rodar(_get({"sql": f"SELECT i.SQ_CANDIDATO, n.NM_URNA_CANDIDATO FROM indicadores i {join} "
                            "WHERE n.NM_URNA_CANDIDATO IS NOT NULL LIMIT 3"}))
    assert r.status_code == 200, r.text
    assert r.json()["linhas"], "o fixture tem registro com nome de urna; a view veio vazia"


def test_view_nomes_urna_vazia_sem_o_parquet_de_candidatos(tmp_path):
    con = duckdb.connect()
    con.execute(f"COPY (SELECT '1' AS SQ_CANDIDATO, 1.0 AS total_contratado) "
                f"TO '{(tmp_path / 'indicadores.parquet').as_posix()}' (FORMAT PARQUET)")
    con.close()
    b = dados.construir_de_diretorio(tmp_path, tmp_path / "radar.duckdb")
    try:
        assert b.cursor().execute("SELECT COUNT(*) FROM nomes_urna").fetchone()[0] == 0
        assert b.cursor().execute(
            "SELECT n.NM_URNA_CANDIDATO FROM indicadores i LEFT JOIN nomes_urna n USING (SQ_CANDIDATO)"
        ).fetchall() == [(None,)]
    finally:
        b.fechar()


@pytest.mark.parametrize("rotulo,consulta", _consultas(), ids=[r for r, _ in _consultas()])
def test_rota_devolve_o_mesmo_que_a_execucao_direta(banco, rotulo, consulta):
    """Paridade por construção: o site manda o texto, a rota executa — cada
    consulta pronta do console, pela rota, igual ao cursor cru (em listas)."""
    pela_rota = _rodar(_get({"q": _comprimir(consulta), "v": banco.publicado_em})).json()
    cur = banco.cursor()
    cur.execute(consulta)
    colunas = [d[0] for d in cur.description]
    direto = [[dados.json_seguro(v) for v in linha] for linha in cur.fetchmany(2000)]
    cur.close()
    assert pela_rota["colunas"] == colunas
    assert pela_rota["linhas"] == direto
