# Imagem para rodar a rotina diária de extração (ex.: agendada no Coolify).
# O container fica ocioso; o agendador executa `python gastos.py rotina`.
FROM python:3.12-slim

# gh CLI para publicar os Parquet no GitHub Releases (autentica via env GH_TOKEN).
# TARGETARCH (amd64/arm64) é preenchido pelo BuildKit conforme a máquina do build.
ARG GH_VERSION=2.63.2
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
       | tar -xz -C /tmp \
    && mv "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh" /usr/local/bin/gh \
    && rm -rf "/tmp/gh_${GH_VERSION}_linux_${TARGETARCH}" \
    && gh --version \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# imagem quebrada não sobe: o deploy falha aqui se algum teste falhar
# (os testes de dados reais se auto-pulam — não há data/ no contexto de build)
RUN python -m pytest tests/ -q

# data/ deve ser um volume persistente (banco DuckDB + histórico + cache)
VOLUME /app/data

# O container não tem git/.git, então o gh precisa saber o repo de destino dos
# releases. Num fork, sobrescreva GH_REPO nas variáveis de ambiente do deploy.
ENV GH_REPO=machadouglas/analise-gastos-campanha

CMD ["sleep", "infinity"]
