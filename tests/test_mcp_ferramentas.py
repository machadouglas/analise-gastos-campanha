"""As ferramentas do MCP contra os Parquet PUBLICADOS por um pipeline real.

O fixture reaproveita o cenário do E2E (zip no formato do TSE → carregar →
versionar → agregados → exportar) e monta o banco do MCP a partir do diretório
exportado — exatamente o que o container faz com o release. Duas garantias:

1. cada ferramenta responde sobre o dado mascarado (pf-…/h-…), com as chaves
   que o modelo vai ler;
2. a ferramenta `sql` devolve o MESMO resultado que a execução direta para
   cada consulta pronta do console do site — gate, teto e formatação não
   alteram o dado.
"""

import asyncio
import json
import re
import sys
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import agregados, carga, exportar, historico, privacidade  # noqa: E402
from src.mcp import consultas, dados, servidor  # noqa: E402
from tests.test_consultas_do_site import _consultas  # noqa: E402
from tests.test_e2e_pipeline import _publicar_zip_do_dia  # noqa: E402

ANO = 2026
CNPJ_FORNECEDOR = "11222333000144"


@pytest.fixture(scope="module")
def banco(tmp_path_factory):
    """Pipeline real em tmp → export → banco do MCP (uma vez por módulo)."""
    from src import cnpj

    tmp = tmp_path_factory.mktemp("mcp-e2e")
    mp = pytest.MonkeyPatch()
    mp.setattr(carga, "DIR_RAW", tmp / "raw")
    mp.setattr(carga, "CAMINHO_BANCO", tmp / "db" / "gastos.duckdb")
    mp.setattr(exportar, "DIR_EXPORT", tmp / "export")
    mp.setenv(privacidade.VARIAVEL, "sal-de-teste")
    try:
        _publicar_zip_do_dia(carga.DIR_RAW, "20/08/2026",
                             com_removida=True, valor_editada="100,00", sq_editada="505")
        carga.carregar(ANO)
        con = carga.conectar()
        historico.versionar(con)
        con.close()
        _publicar_zip_do_dia(carga.DIR_RAW, "21/08/2026",
                             com_removida=False, valor_editada="150,00", sq_editada="905")
        carga.carregar(ANO)
        con = carga.conectar()
        historico.versionar(con)
        cnpj._garantir_tabela(con)
        con.execute("""
            INSERT INTO fornecedores VALUES
            (?, 'FORNECEDOR LTDA OFICIAL', '2025-11-15', 'ATIVA', 'ME',
             false, 'Agências de publicidade', 'SÃO PAULO', 'XX', 10000.0,
             'SÓCIO UM', DATE '2026-08-21', NULL, NULL)
        """, [CNPJ_FORNECEDOR])
        agregados.materializar(con)
        exportar.exportar(con)
        con.close()
        b = dados.construir_de_diretorio(tmp / "export", tmp / "radar.duckdb")
        servidor.usar_banco(b)
        yield b
        b.fechar()
    finally:
        mp.undo()


def _rodar(coro):
    return asyncio.run(coro)


def _sem_cpf_cru(obj) -> None:
    texto = json.dumps(obj, ensure_ascii=False, default=str)
    assert not re.search(r'"\d{11}"', texto), "valor de 11 dígitos (CPF cru?) na resposta"


def test_toda_resposta_traz_versao(banco):
    r = _rodar(servidor.visao_geral())
    assert r["versao_dado"] == banco.versao_dado == "2026-08-21"
    assert r["versao_codigo"]
    assert r["totais"]["candidatos_com_gastos"] > 0
    assert "despesas_atual" in r["tabelas_disponiveis"]


def test_buscar_e_ficha_do_candidato(banco):
    r = _rodar(servidor.buscar_candidato("candidato 0001", uf="xx"))
    assert r["n"] >= 1
    achado = next(c for c in r["candidatos"] if c["sq_candidato"] == "160001")
    assert achado["nome"] == "CANDIDATO 0001" and achado["tem_movimento"]
    # por número de urna, com filtro de cargo parcial
    r = _rodar(servidor.buscar_candidato("10001", cargo="estadual"))
    assert [c["sq_candidato"] for c in r["candidatos"]] == ["160001"]
    # registro sem movimento também aparece
    r = _rodar(servidor.buscar_candidato("CAND 1050"))
    assert r["n"] == 1 and r["candidatos"][0]["tem_movimento"] is False

    f = _rodar(servidor.ficha_candidato("160001"))
    assert f["registro"]["nome_urna"] == "CAND 0001"
    assert f["sem_movimento"] is False
    assert f["indicadores"]["total_contratado"] > 0
    assert f["gasto_por_categoria"] and f["maiores_fornecedores"]
    assert f["patrimonio_declarado"]["total"] == pytest.approx(350000.0)
    assert isinstance(f["sinais_fora_da_curva"], list)
    assert "total_contratado" in f["grupo_de_comparacao"]
    _sem_cpf_cru(f)

    f = _rodar(servidor.ficha_candidato("161050"))
    assert f["sem_movimento"] is True and f["indicadores"] is None

    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError):
        _rodar(servidor.ficha_candidato("999999"))


def test_remocoes_e_correcoes_sao_as_do_backend(banco):
    """A ferramenta lê o parquet pronto: uma remoção e uma retificação, as
    mesmas que o E2E confere direto no export."""
    r = _rodar(servidor.declaracoes_removidas())
    assert [d["descricao"] for d in r["declaracoes"]] == ["CARRO DE SOM QUE SOME"]
    assert r["valor_listado"] > 0
    sq = r["declaracoes"][0]["sq_candidato"]
    f = _rodar(servidor.ficha_candidato(sq))
    assert [d["descricao"] for d in f["declaracoes_removidas"]] == ["CARRO DE SOM QUE SOME"]

    corrigidas = [c for sq_ in {sq, "160001"}
                  for c in (_rodar(servidor.ficha_candidato(sq_))["declaracoes_corrigidas"] or [])]
    todas = _rodar(servidor.sql("SELECT campo_alterado, valor_antes, valor_depois FROM despesas_alteradas"))
    assert todas["linhas"] == [{"campo_alterado": "valor", "valor_antes": 100.0, "valor_depois": 150.0}]
    assert all(c["campo_alterado"] == "valor" for c in corrigidas)


def test_ficha_do_fornecedor_e_privacidade(banco):
    f = _rodar(servidor.ficha_fornecedor("11.222.333/0001-44"))
    assert f["id"] == CNPJ_FORNECEDOR and f["tipo_id"] == "cnpj"
    assert f["perfil"]["candidatos"] > 1
    assert f["cadastro_rfb"]["razao_social"] == "FORNECEDOR LTDA OFICIAL"
    assert f["cadastro_rfb"]["data_abertura"] == "2025-11-15"
    assert f["candidatos_atendidos"] and f["maiores_notas"]
    assert f["cnpj_nao_encontrado_na_base_publica"] is False

    # pessoa física: o id é o código pf-… publicado; o CPF nunca aparece
    pf = _rodar(servidor.sql(
        "SELECT NR_CPF_CNPJ_FORNECEDOR AS id FROM despesas_atual "
        "WHERE NM_FORNECEDOR = 'PRESTADOR PESSOA FISICA' LIMIT 1"))["linhas"][0]["id"]
    assert pf.startswith("pf-")
    f = _rodar(servidor.ficha_fornecedor(pf))
    assert f["tipo_id"] == "pessoa_fisica_pseudonimizada" and f["cadastro_rfb"] is None
    _sem_cpf_cru(f)

    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError):
        _rodar(servidor.ficha_fornecedor("123"))


def test_ficha_do_partido_e_visoes(banco):
    p = _rodar(servidor.ficha_partido("xyz"))
    assert p["partido"] == "XYZ" and p["totais"]["candidatos_com_movimento"] > 0
    assert p["maiores_candidatos"]

    c = _rodar(servidor.fornecedores_compartilhados(uf="XX"))
    assert any(f["fornecedor_id"] == CNPJ_FORNECEDOR for f in c["fornecedores"])
    assert all(f["candidatos"] >= 2 for f in c["fornecedores"])

    fc = _rodar(servidor.fora_da_curva(uf="XX"))
    assert isinstance(fc["candidatos"], list)
    for cand in fc["candidatos"]:
        assert cand["sinais"] and all(s["valor"] > s["p95_do_grupo"] for s in cand["sinais"])

    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError):
        _rodar(servidor.fora_da_curva(sinal="inexistente"))

    g = _rodar(servidor.gastos_por_categoria(uf="XX"))
    assert g["categorias"] and g["categorias"][0]["total"] > 0
    s = _rodar(servidor.sem_nota())
    assert isinstance(s["candidatos"], list)


def test_buscar_fornecedor_acha_pelos_dois_papeis(banco):
    """O id que a busca devolve é o mesmo que a ficha consome — sem ele, achar
    uma empresa pelo nome só era possível pela ferramenta sql."""
    r = _rodar(servidor.buscar_fornecedor("fornecedor ltda"))
    achado = next(c for c in r["contrapartes"] if c["id"] == CNPJ_FORNECEDOR)
    assert achado["tipo_id"] == "cnpj" and achado["candidatos"] > 1
    assert "fornecedor" in achado["papeis"]
    assert _rodar(servidor.ficha_fornecedor(achado["id"]))["id"] == CNPJ_FORNECEDOR

    # por CNPJ pontuado, o mesmo caminho de limpar_id da ficha
    assert any(c["id"] == CNPJ_FORNECEDOR
               for c in _rodar(servidor.buscar_fornecedor("11.222.333/0001-44"))["contrapartes"])
    # doadora pessoa física, que não aparece em despesas_atual: a busca cobre
    # os dois papéis, e o id devolvido é o código pf-… (nunca o CPF)
    doadora = _rodar(servidor.buscar_fornecedor("doadora aparecida"))
    assert doadora["n"] == 1 and doadora["contrapartes"][0]["papeis"] == "doador"
    assert doadora["contrapartes"][0]["id"].startswith("pf-")
    _sem_cpf_cru(r)

    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError):
        _rodar(servidor.buscar_fornecedor("  "))


def test_candidatos_conectados_diz_por_onde_a_ligacao_passa(banco):
    """Nível 1 são os que dividem contraparte; `por_meio_de` nomeia a ponte —
    sem isso a lista não é conferível."""
    # no cenário, TODA contraparte atende os 30 candidatos: com o teto padrão
    # (20) nenhuma sobra, e o resultado honesto é vazio com o corte declarado
    r = _rodar(servidor.candidatos_conectados("160001", niveis=1))
    assert r["conectados"] == [] and r["criterio_do_corte"] and r["ressalvas"]
    ignoradas = {i["contraparte_id"] for i in r["contrapartes_ignoradas"]}
    assert CNPJ_FORNECEDOR in ignoradas

    # afrouxando o teto, as mesmas contrapartes voltam a ligar
    r = _rodar(servidor.candidatos_conectados("160001", niveis=1,
                                              max_candidatos_por_contraparte=1000))
    assert r["niveis"] == 1 and r["conectados"]
    assert all(c["nivel"] == 1 for c in r["conectados"])
    assert all(c["por_meio_de"] for c in r["conectados"]), "ligação sem ponte nomeada"
    assert "160001" not in [c["sq_candidato"] for c in r["conectados"]], "o próprio candidato"
    assert any(CNPJ_FORNECEDOR in c["por_meio_de"] or "FORNECEDOR" in c["por_meio_de"]
               for c in r["conectados"])

    # nível 2 alcança pelo menos o que o nível 1 alcança, e cada um aparece uma vez
    r2 = _rodar(servidor.candidatos_conectados("160001", niveis=2,
                                               max_candidatos_por_contraparte=1000))
    sqs = [c["sq_candidato"] for c in r2["conectados"]]
    assert len(sqs) == len(set(sqs)), "candidato repetido em níveis diferentes"
    assert len(sqs) >= len(r["conectados"])

    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError):
        _rodar(servidor.candidatos_conectados("160001", tipos="amizade"))
    with pytest.raises(ToolError):
        _rodar(servidor.candidatos_conectados("nao-numerico"))


def test_notas_fora_do_preco_exige_recorte(banco):
    """Sem recorte a consulta varreria o país inteiro por nota — o teto de
    linhas esconderia o custo, não o evitaria."""
    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError):
        _rodar(servidor.notas_fora_do_preco())

    r = _rodar(servidor.notas_fora_do_preco(uf="XX"))
    assert isinstance(r["notas"], list) and r["ressalvas"] and r["o_que_esta_medido"]
    for nota in r["notas"]:
        assert nota["valor"] > nota["p95_do_grupo"]
        assert nota["mediana_do_grupo"] is not None and nota["notas_no_grupo"] >= 5


def test_notas_fora_do_preco_compara_nota_contra_nota(tmp_path):
    """A régua do benchmark é a NOTA (itens de mesma SQ_DESPESA somados). Se a
    ferramenta comparasse item a item, uma nota fatiada nunca apareceria e o
    número comparado teria forma diferente da régua que gerou o p95."""
    con = duckdb.connect(str(tmp_path / "b.duckdb"))
    con.execute("""
        CREATE TABLE despesas_atual (
            SQ_CANDIDATO VARCHAR, NM_CANDIDATO VARCHAR, SG_PARTIDO VARCHAR,
            DS_CARGO VARCHAR, SG_UF VARCHAR, SQ_DESPESA VARCHAR,
            NM_FORNECEDOR VARCHAR, NM_FORNECEDOR_RFB VARCHAR,
            NR_CPF_CNPJ_FORNECEDOR VARCHAR, DS_ORIGEM_DESPESA VARCHAR,
            DS_DESPESA VARCHAR, DS_TIPO_DOCUMENTO VARCHAR, NR_DOCUMENTO VARCHAR,
            DT_DESPESA VARCHAR, valor DOUBLE)""")
    linha = ("1", "FULANO", "XYZ", "Deputado Estadual", "XX", "{sq}", "GRAFICA",
             "#NULO", "11222333000144", "Publicidade", "PANFLETO", "Nota Fiscal",
             "10", "15/08/2026", None)
    # uma nota fatiada em 5 itens de 300 (total 1500) e uma nota inteira de 400
    for _ in range(5):
        con.execute("INSERT INTO despesas_atual VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [*linha[:5], "nota-fatiada", *linha[6:14], 300.0])
    con.execute("INSERT INTO despesas_atual VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [*linha[:5], "nota-inteira", *linha[6:14], 400.0])
    con.execute("""
        CREATE TABLE benchmark_precos AS
        SELECT 'Publicidade' AS DS_ORIGEM_DESPESA, 'XX' AS SG_UF, 40 AS notas,
               100.0 AS p25, 200.0 AS mediana, 300.0 AS p75, 500.0 AS p95, 900.0 AS maximo""")
    sql_ = consultas.sql_notas_fora_do_preco("XX", None, None, None, None, 10)
    achado = con.execute(sql_).fetchall()
    colunas = [d[0] for d in con.description]
    con.close()
    linhas = [dict(zip(colunas, linha, strict=True)) for linha in achado]
    # a nota fatiada (5 × 300 = 1500) passa do p95; nenhum item de 300 passaria
    assert [(x["valor"], x["itens"]) for x in linhas] == [(1500.0, 5)]
    assert linhas[0]["vezes_o_p95"] == 3.0


def test_novidades_traz_o_que_entrou_com_o_total_do_recorte(banco):
    """O contrário de declaracoes_removidas. `resumo` cobre o recorte inteiro —
    somar só a lista (cortada por `limite`) daria um número menor sem avisar."""
    r = _rodar(servidor.novidades(limite=5))
    assert r["tipo"] == "despesa" and r["declaracoes"]
    assert all(d["entrou_em"] == r["resumo"]["da_extracao"] for d in r["declaracoes"])
    assert r["resumo"]["linhas"] >= len(r["declaracoes"])
    assert r["resumo"]["valor_total"] >= sum(d["valor"] for d in r["declaracoes"])
    assert r["o_que_esta_medido"] and r["ressalvas"]

    # `desde` anterior à 1ª extração pega tudo o que existe
    tudo = _rodar(servidor.novidades(desde="2020-01-01", limite=5))
    assert tudo["resumo"]["linhas"] >= r["resumo"]["linhas"]

    rec = _rodar(servidor.novidades(tipo="receita", desde="2020-01-01", limite=5))
    assert rec["tipo"] == "receita" and rec["declaracoes"]
    assert "fonte" in rec["declaracoes"][0]
    _sem_cpf_cru(rec)

    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError):
        _rodar(servidor.novidades(tipo="bem"))


def test_fornecedores_por_cadastro_declara_a_cobertura(banco):
    """A tabela `fornecedores` é preenchida aos poucos: sem o denominador,
    "poucas empresas baixadas" se confunde com "poucas empresas verificadas"."""
    r = _rodar(servidor.fornecedores_por_cadastro())
    achado = next(f for f in r["fornecedores"] if f["fornecedor_id"] == CNPJ_FORNECEDOR)
    assert achado["fornecedor"] == "FORNECEDOR LTDA OFICIAL"
    assert achado["situacao"] == "ATIVA" and achado["candidatos"] > 1
    cob = r["cobertura"]
    assert cob["cnpjs_consultados"] >= 1
    assert cob["cnpjs_no_recorte"] >= cob["cnpjs_consultados"]
    assert r["ressalvas"]

    # filtro por situação e por data de abertura (a régua do "recém-aberto")
    assert _rodar(servidor.fornecedores_por_cadastro(situacao="ativa"))["n"] >= 1
    assert _rodar(servidor.fornecedores_por_cadastro(situacao="baixada"))["n"] == 0
    assert _rodar(servidor.fornecedores_por_cadastro(aberto_apos="2025-10-01"))["n"] >= 1
    assert _rodar(servidor.fornecedores_por_cadastro(aberto_apos="2030-01-01"))["n"] == 0


@pytest.mark.parametrize("rotulo,consulta", _consultas(), ids=[r for r, _ in _consultas()])
def test_sql_devolve_o_mesmo_que_a_execucao_direta(banco, rotulo, consulta):
    """Gate + teto + formatação não alteram o resultado: linha a linha igual ao
    cursor cru (sobre o mesmo banco), para cada consulta pronta do console."""
    pela_ferramenta = _rodar(servidor.sql(consulta))
    cur = banco.cursor()
    cur.execute(consulta)
    colunas = [d[0] for d in cur.description]
    direto = [dict(zip(colunas, (dados.json_seguro(v) for v in linha), strict=True))
              for linha in cur.fetchmany(500)]
    cur.close()
    assert pela_ferramenta["colunas"] == colunas
    assert pela_ferramenta["linhas"] == direto


def test_sql_recusa_e_explica(banco):
    from mcp.server.mcpserver.exceptions import ToolError

    with pytest.raises(ToolError, match="recusada"):
        _rodar(servidor.sql("DELETE FROM despesas_atual"))
    with pytest.raises(ToolError, match="DuckDB"):
        _rodar(servidor.sql("SELECT coluna_inexistente FROM despesas_atual"))
    with pytest.raises(ToolError, match="DuckDB"):
        _rodar(servidor.sql("SELECT * FROM read_csv('/etc/passwd')"))
