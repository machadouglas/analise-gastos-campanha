"""Servidor MCP público do Radar dos Gastos.

Consome exclusivamente os Parquet publicados no release (src/publicado.py):
o container nunca enxerga o banco da extração nem segredo algum. Desenho em
docs/arquitetura-mcp.md.
"""
