"""Gate de leitura da ferramenta `sql`.

A validação é feita pelo parser do próprio DuckDB (`extract_statements`), não
por scanner de texto: exatamente UM statement, e do tipo SELECT. É o mesmo
espírito do gate do console do site (site/src/lib/sql-gate.ts), com uma
diferença documentada: PIVOT/UNPIVOT o parser reescreve como CREATE + SELECT
(macro temporária) e por isso são recusados aqui — tests/test_sincronia_site.py
registra a exceção em vez de fingir paridade.

O gate é a primeira barreira, não a única: a conexão é só leitura, sem acesso
externo e com configuração travada (src/mcp/dados.py), e cada consulta tem
timeout, teto de linhas e de bytes.
"""

import re

import duckdb

# Verbos que o console do site aceita e que o parser classifica como SELECT.
# DESCRIBE/SUMMARIZE/SHOW/FROM viram SELECT no DuckDB; PIVOT/UNPIVOT não.
TIPOS_ACEITOS = {"SELECT"}
INICIO_PIVOT = re.compile(r"^\s*(un)?pivot\b", re.IGNORECASE)
# O parser roda no event loop, antes do timeout da execução. Ele é rápido e
# recusa aninhamento fundo ("memory exhausted"), mas o texto não precisa ser
# ilimitado: o corpo HTTP já é limitado em 4 MB pelo SDK; aqui, folga larga
# para qualquer consulta legítima.
MAX_CHARS_SQL = 50_000


class ConsultaRecusada(ValueError):
    """SQL que o gate não deixa passar — a mensagem é para o modelo corrigir."""


def _sem_comentarios(sql: str) -> str:
    """Só para a detecção de PIVOT no início; o parser lida com o resto."""
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    return re.sub(r"--[^\n]*", " ", sql)


def validar_leitura(sql: str) -> str:
    """Devolve o SQL pronto para executar ou levanta ConsultaRecusada."""
    texto = (sql or "").strip().rstrip(";").strip()
    if not texto:
        raise ConsultaRecusada("consulta vazia.")
    if len(texto) > MAX_CHARS_SQL:
        raise ConsultaRecusada(
            f"consulta longa demais ({len(texto)} caracteres; o teto é {MAX_CHARS_SQL}). "
            "Use tabelas prontas e filtros em vez de listas literais gigantes."
        )
    if INICIO_PIVOT.match(_sem_comentarios(texto)):
        raise ConsultaRecusada(
            "PIVOT/UNPIVOT não são aceitos nesta versão (o parser os reescreve como "
            "CREATE + SELECT). Use agregação condicional: SUM(CASE WHEN ... END)."
        )
    try:
        statements = duckdb.extract_statements(texto)
    except duckdb.Error as e:
        raise ConsultaRecusada(f"SQL inválido: {e}") from None
    if len(statements) != 1:
        raise ConsultaRecusada(
            f"um statement por consulta (recebi {len(statements)}). "
            "Remova o ';' extra ou envie as consultas separadas."
        )
    tipo = statements[0].type.name
    if tipo not in TIPOS_ACEITOS:
        raise ConsultaRecusada(
            f"só leitura: statement do tipo {tipo} não é aceito. "
            "Envie SELECT/WITH (DESCRIBE e SUMMARIZE também valem)."
        )
    return texto
