// Proxy dos dados publicados no GitHub Releases para a mesma origem do site.
// Necessário porque os assets de release do GitHub não enviam cabeçalhos CORS,
// o que impediria o navegador de lê-los diretamente.
//
// Desenho (revisado em 08/09/2026, depois de medir 429 do GitHub em produção):
// o GitHub limita downloads por IP, e os IPs de saída dos Workers são
// compartilhados com o mundo. O DuckDB-WASM faz dezenas de leituras `Range`
// por Parquet, e cada uma virava uma ida ao GitHub — num pico, 429 em cascata.
// Agora a Function busca o arquivo INTEIRO uma vez, guarda no cache da borda,
// e serve dali tanto o GET completo quanto os `Range` (a Cache API fatia uma
// resposta 200 cacheada e devolve 206) e o HEAD. O GitHub é tocado uma vez por
// arquivo, por data center, por hora (5 min para o resumo.json). Uma cópia de
// reserva com TTL de 7 dias, sob outra chave, sai marcada quando o GitHub
// falha — o dado tem no máximo a idade do último sucesso.
const BASE = "https://github.com/machadouglas/analise-gastos-campanha/releases/download/dados/";
const TTL_RESERVA = "public, max-age=604800";

function ttl(nome) {
  // dados mudam 1x/dia; cache curto na borda e no navegador é suficiente
  return nome.endsWith(".json") ? "public, max-age=300" : "public, max-age=3600";
}

/** Cabeçalhos que saem para o navegador (e ficam gravados no cache). */
function cabecalhosDe(upstream, nome, tamanho) {
  const h = new Headers();
  for (const c of ["Content-Type", "ETag", "Last-Modified"]) {
    const v = upstream.headers.get(c);
    if (v) h.set(c, v);
  }
  h.set("Content-Length", String(tamanho));
  h.set("Accept-Ranges", "bytes");
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Cache-Control", ttl(nome));
  return h;
}

/** Pedido ao cache com os cabeçalhos que a Cache API honra: Range vira 206,
 *  If-None-Match/If-Modified-Since viram 304. */
function pedidoAoCache(url, request) {
  const h = {};
  for (const c of ["Range", "If-None-Match", "If-Modified-Since"]) {
    const v = request.headers.get(c);
    if (v) h[c] = v;
  }
  return new Request(url, { method: "GET", headers: h });
}

function semCorpo(resposta) {
  return new Response(null, { status: resposta.status, headers: resposta.headers });
}

/** Último recurso se a Cache API não fatiar: 206 calculado aqui (um intervalo
 *  só, que é o que o DuckDB-WASM pede — inclusive o sufixo `bytes=-N` do rodapé). */
function fatiar(corpo, cabecalhos, range) {
  const total = corpo.byteLength;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range || "");
  if (!m || (m[1] === "" && m[2] === "")) {
    return new Response(corpo, { status: 200, headers: cabecalhos });
  }
  let inicio, fim;
  if (m[1] === "") {
    inicio = Math.max(0, total - Number(m[2]));
    fim = total - 1;
  } else {
    inicio = Number(m[1]);
    fim = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  if (inicio > fim || inicio >= total) {
    const h = new Headers(cabecalhos);
    h.set("Content-Range", `bytes */${total}`);
    return new Response(null, { status: 416, headers: h });
  }
  const h = new Headers(cabecalhos);
  h.set("Content-Range", `bytes ${inicio}-${fim}/${total}`);
  h.set("Content-Length", String(fim - inicio + 1));
  return new Response(corpo.slice(inicio, fim + 1), { status: 206, headers: h });
}

export async function onRequest({ params, request }) {
  // só leitura: qualquer outro verbo não tem significado aqui
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("método não permitido", { status: 405, headers: { Allow: "GET, HEAD" } });

  // allowlist estrita do que o release publica (nada de "..", "/" ou extensões estranhas)
  const nome = params.arquivo;
  if (!/^[a-z0-9_]+\.(parquet|json)$/.test(nome))
    return new Response("nome inválido", { status: 400 });

  const cache = caches.default;
  const urlBase = new URL(request.url).toString().split("?")[0];
  const urlReserva = `${urlBase}?copia=reserva`;
  const range = request.headers.get("Range");
  const entregar = (r) => (request.method === "HEAD" ? semCorpo(r) : r);

  // 1) cache da borda: completo, fatiado (206) ou 304 — sem tocar no GitHub
  const emCache = await cache.match(pedidoAoCache(urlBase, request));
  if (emCache) return entregar(emCache);

  // 2) miss: o arquivo inteiro do GitHub, uma vez, para o cache e a reserva
  let upstream;
  try {
    upstream = await fetch(BASE + nome, { method: "GET", redirect: "follow" });
  } catch (e) {
    upstream = new Response(`upstream inacessível: ${e && e.message ? e.message : e}`, { status: 502 });
  }
  if (upstream.status === 200) {
    const corpo = await upstream.arrayBuffer();
    const h = cabecalhosDe(upstream, nome, corpo.byteLength);
    const hr = new Headers(h);
    hr.set("Cache-Control", TTL_RESERVA);
    await Promise.all([
      cache.put(new Request(urlBase, { method: "GET" }), new Response(corpo, { status: 200, headers: h })),
      cache.put(new Request(urlReserva, { method: "GET" }), new Response(corpo, { status: 200, headers: hr })),
    ]);
    const agora = await cache.match(pedidoAoCache(urlBase, request));
    return entregar(agora || fatiar(corpo, h, range));
  }

  // 3) GitHub falhou (429, 5xx, rede): a última cópia boa, marcada, também em Range
  const reserva = await cache.match(pedidoAoCache(urlReserva, request));
  if (reserva) {
    const h = new Headers(reserva.headers);
    h.set("Cache-Control", "no-store"); // volta a tentar o upstream na próxima
    h.set("X-Radar-Copia", `reserva; upstream ${upstream.status}`);
    return entregar(new Response(reserva.body, { status: reserva.status, headers: h }));
  }

  // 4) sem nada em cache: repassa o erro, nunca cacheado — um 404 transitório
  //    cacheado por 1h derrubaria a página
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });
}
