"""Carga dos votos (carga.carregar_votos) nas bordas que o E2E não percorre: o
zip só com cabeçalho que o TSE publica antes de totalizar, o zip ausente e o
zip quebrado — nenhum deles pode derrubar a carga da prestação de contas."""

import sys
import zipfile
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
from src import carga  # noqa: E402

ANO = 2026
CABECALHO = ('"DT_GERACAO";"NR_TURNO";"SQ_CANDIDATO";"QT_VOTOS_NOMINAIS";'
             '"QT_VOTOS_NOMINAIS_VALIDOS";"DS_SIT_TOT_TURNO"\n')


@pytest.fixture
def raw(tmp_path, monkeypatch):
    monkeypatch.setattr(carga, "DIR_RAW", tmp_path)
    (tmp_path / str(ANO)).mkdir()
    return tmp_path / str(ANO)


def _zip_votacao(pasta: Path, csv: str, br: str = CABECALHO) -> None:
    with zipfile.ZipFile(pasta / carga.ZIP_VOTACAO.format(ano=ANO), "w") as z:
        z.writestr(carga.CSV_VOTACAO.format(ano=ANO), csv.encode("cp1252"))
        z.writestr(carga.CSV_VOTACAO_BR.format(ano=ANO), br.encode("cp1252"))


def test_sem_o_membro_presidencial_a_carga_falha_sem_deixar_csv(raw):
    with zipfile.ZipFile(raw / carga.ZIP_VOTACAO.format(ano=ANO), "w") as z:
        z.writestr(carga.CSV_VOTACAO.format(ano=ANO), CABECALHO.encode("cp1252"))
    con = duckdb.connect()
    with pytest.raises(RuntimeError, match="falha ao carregar votos"):
        carga.carregar_votos(con, ANO)
    assert not list(raw.rglob("*.csv*"))


def test_zip_so_com_cabecalho_gera_tabela_vazia(raw, capsys):
    # é o que o TSE serve entre a abertura das urnas e a totalização
    _zip_votacao(raw, CABECALHO)
    con = duckdb.connect()
    carga.carregar_votos(con, ANO)
    assert con.execute("SELECT COUNT(*) FROM votos").fetchone()[0] == 0
    assert "ainda não publicou a totalização" in capsys.readouterr().out


def test_sem_o_zip_nao_cria_nem_apaga_a_tabela(raw):
    con = duckdb.connect()
    con.execute("CREATE TABLE votos AS SELECT '1' AS SQ_CANDIDATO, 10 AS votos_1t")
    carga.carregar_votos(con, ANO)
    assert con.execute("SELECT votos_1t FROM votos").fetchall() == [(10,)]


def test_zip_quebrado_preserva_os_votos_ja_carregados(raw):
    _zip_votacao(raw, CABECALHO + '"05/10/2026";"1";"160001";"7";"7";"SUPLENTE"\n')
    con = duckdb.connect()
    carga.carregar_votos(con, ANO)
    (raw / carga.ZIP_VOTACAO.format(ano=ANO)).write_bytes(b"download truncado")
    with pytest.raises(RuntimeError, match="falha ao carregar votos"):
        carga.carregar_votos(con, ANO)
    assert con.execute("SELECT * FROM votos").fetchall() == [
        ("160001", 7, 7, None, None, "SUPLENTE")]


def test_extrair_zips_nao_descompacta_a_votacao(raw):
    # o consolidado passa de 4 GB numa eleição geral: só carregar_votos o lê
    _zip_votacao(raw, CABECALHO)
    extraido = carga.extrair_zips(ANO)
    assert not list(extraido.rglob("*.csv"))
