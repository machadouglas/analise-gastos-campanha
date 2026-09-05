"""O que o modelo lê sobre os dados: o MESMO texto que o site oferece ao
visitante em site/src/lib/prompt.ts (a parte de contexto, tabelas e regras),
com um preâmbulo próprio do MCP. tests/test_sincronia_site.py garante que o
trecho compartilhado é idêntico — mudou o prompt do console, mudou aqui.
"""

import re
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
PROMPT_TS = RAIZ / "site" / "src" / "lib" / "prompt.ts"

INICIO_COMPARTILHADO = "CONTEXTO:"
FIM_COMPARTILHADO = "EXEMPLOS:"

PREAMBULO = """Você está conectado ao Radar dos Gastos: dados públicos oficiais da prestação de contas das Eleições Gerais 2026 (TSE, Brasil), extraídos diariamente e publicados já pseudonimizados. Tudo aqui é DECLARATÓRIO: trate achados como indícios a conferir, nunca como prova; descreva fatos ("fornecedor X recebeu R$ Y de N candidatos") em vez de acusar pessoas ou empresas.

COMO USAR AS FERRAMENTAS:
- Comece por buscar_candidato / ficha_candidato / ficha_fornecedor / ficha_partido para perguntas sobre alguém específico — elas devolvem exatamente o que o site mostra, com as red flags já aplicadas.
- fora_da_curva, declaracoes_removidas, fornecedores_compartilhados, sem_nota e gastos_por_categoria respondem as perguntas de panorama (por UF, cargo, partido).
- visao_geral traz os totais do dia e o que mudou desde a última extração.
- sql é livre (dialeto DuckDB, só leitura, um statement, até 500 linhas) para o que as ferramentas prontas não cobrem. O esquema completo está abaixo e no recurso radar://esquema.
- Toda resposta traz versao_dado (data da extração retratada) e versao_codigo (versão do pipeline); cite a data ao reportar números.

"""


def prompt_do_site() -> str:
    fonte = PROMPT_TS.read_text(encoding="utf-8")
    achado = re.search(r"export const PROMPT_IA = `(.*?)`;", fonte, re.DOTALL)
    if not achado:
        raise RuntimeError(f"PROMPT_IA não encontrado em {PROMPT_TS}")
    return achado.group(1)


def trecho_compartilhado(texto: str | None = None) -> str:
    """Do CONTEXTO até antes dos EXEMPLOS: as tabelas, os atalhos e as regras."""
    texto = texto if texto is not None else prompt_do_site()
    inicio = texto.index(INICIO_COMPARTILHADO)
    fim = texto.index(FIM_COMPARTILHADO, inicio)
    return texto[inicio:fim].rstrip() + "\n"


def instrucoes() -> str:
    return PREAMBULO + trecho_compartilhado()
