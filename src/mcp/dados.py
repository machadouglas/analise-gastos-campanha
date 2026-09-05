"""Banco do MCP: os Parquet publicados viram tabelas num DuckDB local aberto
só para leitura, e um laço em segundo plano troca o banco inteiro (de forma
atômica) quando o release muda.

Não há recomputação de agregados nem view própria: cada parquet vira a tabela
de mesmo nome, exatamente como o site os consome. A régua de remoção,
retificação, sinais e pseudonimização é a do pipeline (src/), publicada pronta.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import duckdb

from src import publicado

log = logging.getLogger("radar.mcp")

NOME_TABELA = re.compile(r"^[a-z][a-z0-9_]*$")
NOME_PARQUET = re.compile(r"^[a-z][a-z0-9_]*\.parquet$")

# Configuração da conexão de leitura: sem acesso externo (read_csv/httpfs/glob/
# getenv fora), memória e threads limitadas, e tudo travado — uma consulta não
# consegue desfazer nada disso com SET.
CONFIG_LEITURA = {
    "enable_external_access": "false",
    "lock_configuration": "true",
    "memory_limit": os.environ.get("MCP_MEMORIA", "512MB"),
    "threads": os.environ.get("MCP_THREADS", "2"),
}


@dataclass
class Banco:
    caminho: Path
    resumo: dict
    arquivos: dict[str, str]          # md5 por parquet (assinatura da versão)
    tabelas: list[str]
    con: duckdb.DuckDBPyConnection = field(repr=False)

    @property
    def versao_dado(self) -> str | None:
        """Data da extração que o dado retrata (gerado_em do resumo.json)."""
        v = self.resumo.get("gerado_em")
        return str(v)[:10] if v else None

    @property
    def publicado_em(self) -> str | None:
        v = self.resumo.get("publicado_em")
        return str(v) if v else None

    @property
    def versao_pipeline(self) -> str | None:
        """stamp_codigo do pipeline que gerou o dado (quando o resumo o traz)."""
        v = self.resumo.get("versao_codigo")
        return str(v) if v else None

    def cursor(self) -> duckdb.DuckDBPyConnection:
        return self.con.cursor()

    def fechar(self) -> None:
        try:
            self.con.close()
        except duckdb.Error:  # pragma: no cover
            pass


def assinatura(arquivos: dict[str, str]) -> str:
    h = hashlib.md5(usedforsecurity=False)
    for nome in sorted(arquivos):
        h.update(f"{nome}={arquivos[nome]};".encode())
    return h.hexdigest()[:12]


def construir(parquets: dict[str, Path], resumo: dict, destino: Path) -> Banco:
    """Cria o arquivo DuckDB com uma tabela por parquet e o reabre só leitura."""
    if destino.exists():
        destino.unlink()
    destino.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(destino))
    tabelas = []
    try:
        for nome, caminho in sorted(parquets.items()):
            if not NOME_TABELA.match(nome):
                raise ValueError(f"nome de tabela inválido: {nome!r}")
            con.execute(
                f'CREATE TABLE "{nome}" AS SELECT * FROM read_parquet(?)', [caminho.as_posix()]
            )
            tabelas.append(nome)
        con.execute("CHECKPOINT")
    finally:
        con.close()
    leitura = duckdb.connect(str(destino), read_only=True, config=CONFIG_LEITURA)
    arquivos = {k: v for k, v in (resumo.get("arquivos") or {}).items()}
    return Banco(caminho=destino, resumo=resumo, arquivos=arquivos, tabelas=tabelas, con=leitura)


def construir_de_diretorio(dir_parquets: Path, destino: Path) -> Banco:
    """Para testes e uso local: um diretório com *.parquet (+ resumo.json)."""
    parquets = {p.stem: p for p in sorted(dir_parquets.glob("*.parquet"))}
    resumo_path = dir_parquets / "resumo.json"
    resumo = json.loads(resumo_path.read_text(encoding="utf-8")) if resumo_path.exists() else {}
    if not resumo.get("arquivos"):
        resumo["arquivos"] = {p.name: publicado.md5(p) for p in parquets.values()}
    return construir(parquets, resumo, destino)


def _nomes_parquet(resumo: dict) -> list[str]:
    nomes = [n for n in (resumo.get("arquivos") or {}) if n.endswith(".parquet")]
    if nomes:
        return nomes
    # release antigo sem o mapa `arquivos`: a lista do próprio pipeline
    from src import exportar

    return sorted(set(exportar.EXPORTS) | set(exportar.EXPORTS_ATUAL)
                  | set(exportar.EXPORTS_REMOVIDAS) | set(exportar.EXPORTS_ALTERADAS))


def baixar_e_construir(dir_cache: Path, base: str | None = None,
                       resumo: dict | None = None) -> Banco:
    """Baixa o que mudou (md5 do resumo × cache local) e monta o banco."""
    resumo = resumo or publicado.baixar_resumo(base)
    esperados = resumo.get("arquivos") or {}
    dir_cache.mkdir(parents=True, exist_ok=True)
    parquets: dict[str, Path] = {}
    for nome in _nomes_parquet(resumo):
        # o nome vem do resumo.json baixado e vira caminho de escrita: só
        # `nome.parquet` simples (sem '/', '..' ou maiúscula) chega ao disco
        if not NOME_PARQUET.match(nome):
            log.warning("nome de arquivo inesperado no resumo.json, ignorado: %r", nome)
            continue
        alvo = dir_cache / nome
        md5_esperado = esperados.get(nome)
        if not (alvo.exists() and md5_esperado and publicado.md5(alvo) == md5_esperado):
            log.info("baixando %s", nome)
            try:
                publicado.baixar_arquivo(nome, alvo, base)
            except Exception as e:  # noqa: BLE001 — um parquet a menos é degradação, não queda
                if alvo.exists():
                    log.warning("mantendo versão anterior de %s: %s", nome, e)
                else:
                    log.warning("sem %s no release (%s); a tabela fica ausente", nome, e)
                    continue
            if md5_esperado and publicado.md5(alvo) != md5_esperado:
                log.warning("md5 de %s não bate com o resumo.json — usando assim mesmo", nome)
        parquets[alvo.stem] = alvo
    destino = dir_cache / f"radar-{assinatura(esperados) if esperados else int(time.time())}.duckdb"
    return construir(parquets, resumo, destino)


class Servico:
    """Mantém o banco vivo e o troca quando o release muda.

    A troca é atômica: o banco novo é montado ao lado, a referência é trocada,
    e o antigo é fechado depois de uma carência (consultas em andamento
    terminam nele — os cursores seguram a instância).
    """

    def __init__(self, dir_cache: Path, base: str | None = None,
                 intervalo: float = 300, carencia: float = 60):
        self.dir_cache = dir_cache
        self.base = base
        self.intervalo = intervalo
        self.carencia = carencia
        self.banco: Banco | None = None
        self._parar = threading.Event()
        self._thread: threading.Thread | None = None
        self.ultima_verificacao: float | None = None

    def iniciar(self) -> None:
        self.banco = baixar_e_construir(self.dir_cache, self.base)
        log.info("banco pronto: %s tabelas, dado de %s",
                 len(self.banco.tabelas), self.banco.versao_dado)
        self._thread = threading.Thread(target=self._laco, name="radar-atualizador", daemon=True)
        self._thread.start()

    def parar(self) -> None:
        self._parar.set()
        if self._thread:
            self._thread.join(timeout=5)
        if self.banco:
            self.banco.fechar()

    def verificar(self) -> bool:
        """Uma rodada: True se trocou de banco."""
        self.ultima_verificacao = time.time()
        resumo = publicado.baixar_resumo(self.base)
        novos = resumo.get("arquivos") or {}
        if self.banco and novos and novos == self.banco.arquivos:
            return False
        novo = baixar_e_construir(self.dir_cache, self.base, resumo)
        antigo, self.banco = self.banco, novo
        log.info("banco trocado: dado de %s (%s)", novo.versao_dado, novo.caminho.name)
        if antigo:
            threading.Timer(self.carencia, self._descartar, args=[antigo]).start()
        return True

    @staticmethod
    def _descartar(banco: Banco) -> None:
        banco.fechar()
        try:
            banco.caminho.unlink(missing_ok=True)
            banco.caminho.with_name(banco.caminho.name + ".wal").unlink(missing_ok=True)
        except OSError:  # pragma: no cover
            pass

    def _laco(self) -> None:
        while not self._parar.wait(self.intervalo):
            try:
                self.verificar()
            except Exception as e:  # noqa: BLE001 — o laço nunca morre por falha de rede
                log.warning("verificação do release falhou: %s", e)


# --------------------------------------------------------------------------- #
# Execução de consultas com guarda-corpos
# --------------------------------------------------------------------------- #

class TempoEsgotado(Exception):
    pass


class Ocupado(Exception):
    pass


class ResultadoLargo(Exception):
    """Resultado com colunas demais — a mensagem é para o modelo corrigir."""


# Teto por célula e por número de colunas. O memory_limit do DuckDB só cobre o
# DuckDB: medido em 05/09/2026, `SELECT repeat('x', 50000000) FROM range(20)`
# (20 linhas) levava o processo a 2 GB e travava o event loop por 1 s, e uma
# lista de 5 M inteiros por linha segurava a thread 56 s depois do interrupt()
# — a conversão para Python e o json.dumps não são interrompíveis. Por isso a
# limitação acontece DENTRO do DuckDB, numa projeção externa montada a partir
# do esquema do resultado (ver Executor._executar).
MAX_COLUNAS = 100
MAX_CHARS_CELULA = 2_000

# Tipos cuja célula tem tamanho fixo pequeno: passam sem tratamento. O resto
# (VARCHAR, BLOB, BIT, JSON, VARINT, LIST/STRUCT/MAP/UNION/ARRAY...) é limitado.
_TIPOS_COMPACTOS = re.compile(
    r"^(BOOLEAN|U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?|FLOAT|DOUBLE|DECIMAL\([^\[]*\)"
    r"|DATE|TIME[A-Z_ ]*|INTERVAL|UUID|ENUM\([^\[]*\))$",   # o $ importa: 'BIGINT[]' é lista
    re.IGNORECASE,
)


def expressao_limitada(coluna: str, tipo: str) -> str:
    """Expressão de projeção que devolve a coluna com a célula limitada a
    MAX_CHARS_CELULA: texto é cortado; tipo aninhado grande demais vira NULL
    (cortar uma lista pela metade mudaria o significado)."""
    q = '"' + coluna.replace('"', '""') + '"'
    tipo = tipo.strip().upper()
    if _TIPOS_COMPACTOS.match(tipo):
        return q
    if tipo == "VARCHAR":
        return f"left({q}, {MAX_CHARS_CELULA}) AS {q}"
    condicao = f"length(CAST({q} AS VARCHAR)) <= {MAX_CHARS_CELULA}"
    if tipo.endswith("]"):  # LIST/ARRAY: len() antes do CAST poupa a string gigante
        # (medido: 20 listas de 5 M inteiros — 1.263 MB só com o CAST, 491 MB assim)
        condicao = f"len({q}) <= {MAX_CHARS_CELULA} AND {condicao}"
    return f"CASE WHEN {condicao} THEN {q} END AS {q}"


@dataclass
class Resultado:
    colunas: list[str]
    linhas: list[dict[str, Any]]
    truncado: bool            # havia mais linhas do que o teto
    truncado_bytes: bool      # a resposta foi cortada pelo teto de bytes
    duracao_ms: int

    def como_dict(self) -> dict[str, Any]:
        return {
            "colunas": self.colunas,
            "linhas": self.linhas,
            "n_linhas": len(self.linhas),
            "truncado": self.truncado or self.truncado_bytes,
            "duracao_ms": self.duracao_ms,
        }


def json_seguro(v: Any) -> Any:
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, float) and v != v:  # NaN
        return None
    if isinstance(v, (bytes, bytearray)):
        return v.hex()
    if isinstance(v, (list, tuple)):
        return [json_seguro(x) for x in v]
    if isinstance(v, dict):
        return {str(k): json_seguro(x) for k, x in v.items()}
    return v


class Executor:
    """Duas filas: as ferramentas curadas (consultas conhecidas, baratas) e a
    `sql` livre (custo imprevisível). Medido em 05/09/2026 com uma fila só:
    40 chamadas simultâneas, as 8 vagas tomadas por cross joins pesados, e
    TODAS as chamadas leves recusadas com "ocupado" — a sql não pode
    esgotar o que as fichas usam."""

    def __init__(self, servico: Servico, timeout: float = 10, max_simultaneas: int = 8,
                 espera_fila: float = 5, max_linhas: int = 500, max_bytes: int = 200_000,
                 max_simultaneas_sql: int = 4):
        self.servico = servico
        self.timeout = timeout
        self.espera_fila = espera_fila
        self.max_linhas = max_linhas
        self.max_bytes = max_bytes
        self.max_simultaneas = {"ferramentas": max_simultaneas, "sql": max_simultaneas_sql}
        # os semáforos nascem no primeiro uso, presos ao loop que os usa (um
        # Semaphore criado fora de loop se prende ao primeiro e quebra num novo)
        self._semaforo_loop: asyncio.AbstractEventLoop | None = None
        self._semaforos: dict[str, asyncio.Semaphore] = {}

    def _semaforo(self, fila: str) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        if self._semaforo_loop is not loop:
            self._semaforo_loop = loop
            self._semaforos = {}
        if fila not in self._semaforos:
            self._semaforos[fila] = asyncio.Semaphore(self.max_simultaneas[fila])
        return self._semaforos[fila]

    @property
    def banco(self) -> Banco:
        if self.servico.banco is None:
            raise RuntimeError("banco ainda não está pronto")
        return self.servico.banco

    def tem_tabela(self, nome: str) -> bool:
        return nome in self.banco.tabelas

    async def consultar(self, sql: str, parametros: list | None = None,
                        max_linhas: int | None = None, fila: str = "ferramentas") -> Resultado:
        teto = min(max_linhas or self.max_linhas, self.max_linhas)
        semaforo = self._semaforo(fila)
        try:
            await asyncio.wait_for(semaforo.acquire(), timeout=self.espera_fila)
        except TimeoutError:
            raise Ocupado(
                "servidor ocupado" + (" com consultas SQL livres" if fila == "sql" else "")
                + " — tente de novo em alguns segundos"
            ) from None
        try:
            return await self._executar(sql, parametros or [], teto)
        finally:
            semaforo.release()

    async def _executar(self, sql: str, parametros: list, teto: int) -> Resultado:
        cur = self.banco.cursor()
        inicio = time.perf_counter()
        # a quebra de linha antes do ')' protege um comentário `--` no fim
        interno = f"(\n{sql.strip().rstrip(';')}\n)"
        max_bytes = self.max_bytes

        def rodar():
            # 1) só o esquema do resultado (LIMIT 0 não executa o plano): é o
            #    que permite montar a projeção limitada antes de materializar
            cur.execute(f"SELECT * FROM {interno} LIMIT 0", parametros)
            descricao = cur.description or []
            if len(descricao) > MAX_COLUNAS:
                raise ResultadoLargo(
                    f"a consulta devolve {len(descricao)} colunas; o teto é {MAX_COLUNAS}. "
                    "Selecione só as colunas necessárias."
                )
            colunas = [d[0] for d in descricao]
            projecao = ", ".join(expressao_limitada(d[0], str(d[1])) for d in descricao)
            # 2) a consulta de verdade, já com cada célula limitada DENTRO do
            #    DuckDB (memória limitada e interrompível) — nada gigante chega
            #    ao Python
            cur.execute(f"SELECT {projecao} FROM {interno} LIMIT {teto + 1}", parametros)
            brutas = cur.fetchmany(teto + 1)
            truncado = len(brutas) > teto
            # 3) serialização aqui, na thread, com orçamento de bytes numa
            #    passada só — o event loop nunca vê o resultado cru
            linhas: list[dict[str, Any]] = []
            tamanho, truncado_bytes = 2, False
            for linha in brutas[:teto]:
                d = dict(zip(colunas, (json_seguro(v) for v in linha), strict=True))
                tamanho += len(json.dumps(d, ensure_ascii=False)) + 2
                if linhas and tamanho > max_bytes:
                    truncado_bytes = True
                    break
                linhas.append(d)
            return colunas, linhas, truncado, truncado_bytes

        tarefa = asyncio.get_running_loop().run_in_executor(None, rodar)
        # asyncio.wait não cancela a tarefa (cancelar não interrompe o DuckDB);
        # no estouro, interrupt() derruba a consulta e a tarefa termina sozinha
        pronto, _ = await asyncio.wait({tarefa}, timeout=self.timeout)
        if not pronto:
            cur.interrupt()
            try:
                await tarefa
            except Exception as e:  # noqa: BLE001 — a interrupção chega como erro do DuckDB
                log.debug("consulta interrompida: %s", e)
            cur.close()
            raise TempoEsgotado(
                f"a consulta passou de {self.timeout:.0f}s e foi interrompida. "
                "Restrinja por UF/cargo/candidato ou use as tabelas prontas "
                "(indicadores, rede, benchmark_*)."
            )
        try:
            colunas, linhas, truncado, truncado_bytes = tarefa.result()
        finally:
            cur.close()
        return Resultado(colunas, linhas, truncado, truncado_bytes,
                         int((time.perf_counter() - inicio) * 1000))

    async def consultar_opcional(self, sql: str, tabelas: tuple[str, ...] = (),
                                 **kw) -> Resultado | None:
        """None quando alguma tabela necessária ainda não foi publicada
        (release antigo) — a ferramenta degrada em vez de quebrar."""
        if any(not self.tem_tabela(t) for t in tabelas):
            return None
        try:
            return await self.consultar(sql, **kw)
        except duckdb.CatalogException:
            return None
