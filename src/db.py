"""Utilitários mínimos de banco compartilhados pelos módulos."""


def existe(con, nome: str) -> bool:
    """A tabela OU view `nome` existe no banco? (no DuckDB as views também
    aparecem em information_schema.tables, mas duckdb_views cobre qualquer
    versão/config em que isso mude)."""
    return bool(con.execute("""
        SELECT (SELECT count(*) FROM information_schema.tables WHERE table_name = ?)
             + (SELECT count(*) FROM duckdb_views() WHERE view_name = ?)
    """, [nome, nome]).fetchone()[0])
