"""Transcodificação do CSV do TSE (Windows-1252) para UTF-8 antes do read_csv.

Em 12/09/2026 a rotina caiu com "File is not latin-1 encoded": o DuckDB recusa
o arquivo inteiro se um único byte estiver em 0x80–0x9F (controles C1 na
ISO-8859-1, ’ “ ” – … no cp1252 que o Windows brasileiro grava). A carga agora
converte em Python — nenhum byte derruba a carga e nenhuma linha se perde.
"""

import codecs
import sys
from pathlib import Path

import duckdb

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src import carga  # noqa: E402


def _transcodifica(tmp_path: Path, conteudo: bytes) -> bytes:
    origem = tmp_path / "tse.csv"
    origem.write_bytes(conteudo)
    destino = carga.transcodificar_para_utf8(origem, tmp_path / "utf8" / "tse.csv")
    assert not list(tmp_path.glob("utf8/*.part")), "cópia parcial ficou para trás"
    return destino.read_bytes()


def test_bytes_do_cp1252_viram_os_caracteres_impressos(tmp_path):
    # 0x92 ’  0x93 “  0x94 ”  0x96 –  0x85 …  0xE3 ã (igual nas duas tabelas)
    saida = _transcodifica(tmp_path, b'"A"\r\n"D\x92\xc1GUA \x93x\x94 \x96 \x85 Jo\xe3o"\r\n')
    assert saida == '"A"\r\n"D’ÁGUA “x” – … João"\r\n'.encode()


def test_byte_que_nem_o_cp1252_define_nao_derruba_a_carga(tmp_path):
    # 0x81 0x8D 0x8F 0x90 0x9D não têm glifo no cp1252: caem no controle C1 do latin-1
    saida = _transcodifica(tmp_path, b'"A"\n"x\x81\x8d\x8f\x90\x9dy"\n')
    assert saida.decode("utf-8") == '"A"\n"x\u0081\u008d\u008f\u0090\u009dy"\n'


def test_bom_utf8_no_inicio_e_descartado(tmp_path):
    saida = _transcodifica(tmp_path, codecs.BOM_UTF8 + b'"A";"B"\n"Jo\xe3o";"z"\n')
    assert saida == '"A";"B"\n"João";"z"\n'.encode()


def test_arquivo_maior_que_um_pedaco_sai_inteiro(tmp_path):
    linha = b'"Jo\xe3o \x92 " ;"1"\n'
    conteudo = b'"A";"B"\n' + linha * (2 * (1 << 20) // len(linha) + 7)
    saida = _transcodifica(tmp_path, conteudo)
    assert saida == conteudo.decode("cp1252").encode("utf-8")


def test_duckdb_le_o_transcodificado_e_recusaria_o_original(tmp_path):
    origem = tmp_path / "tse.csv"
    origem.write_bytes(b'"NM_FORNECEDOR";"VR"\n"D\x92\xc1GUA LTDA";"10,00"\n')
    con = duckdb.connect()
    try:
        con.execute(f"SELECT * FROM read_csv('{origem.as_posix()}', encoding='latin-1')")
    except duckdb.Error as e:
        assert "latin-1" in str(e)
    else:  # pragma: no cover - se o DuckDB passar a aceitar, o motivo do teste mudou
        raise AssertionError("DuckDB aceitou 0x92 como latin-1; revise o comentário em carga.py")
    utf8 = carga.transcodificar_para_utf8(origem, tmp_path / "utf8" / "tse.csv")
    linhas = con.execute(
        f"SELECT * FROM read_csv('{utf8.as_posix()}', delim=';', quote='\"', header=true, "
        "encoding='utf-8', all_varchar=true)"
    ).fetchall()
    assert linhas == [("D’ÁGUA LTDA", "10,00")]
