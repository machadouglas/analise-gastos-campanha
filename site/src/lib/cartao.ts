import { brl } from './format';

/* Cartão de compartilhamento da ficha (PNG 1200×630, formato de link social):
   desenhado em canvas no navegador do visitante — nada é gerado nem armazenado
   em servidor. A foto oficial do TSE é tentada com CORS; sem permissão do CDN
   (canvas ficaria "tainted" e o PNG não exporta), caem as iniciais. */

export interface DadosCartao {
  nome: string;
  numero: string;
  cargo: string;
  partido: string;
  uf: string;
  arrecadado: number | null;
  contratado: number;
  pctPublico: number | null;
  flags: string[];
  fotoUrl: string | null;
  geradoEm?: string;
  url: string;
}

const NAVY = '#10244A';
const NAVY_CLARO = '#264E9B';
const AMBAR = '#B45309';
const PAPEL = '#fffdfa';
const TINTA = '#1c1a17';
const TINTA_SUAVE = '#6e6a60';

function carregarFoto(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('foto indisponível'));
    img.src = url;
  });
}

function elipse(ctx: CanvasRenderingContext2D, texto: string, larguraMax: number): string {
  if (ctx.measureText(texto).width <= larguraMax) return texto;
  let t = texto;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > larguraMax) t = t.slice(0, -1);
  return `${t}…`;
}

export async function gerarCartaoCandidato(d: DadosCartao): Promise<Blob | null> {
  const L = 1200;
  const A = 630;
  const canvas = document.createElement('canvas');
  canvas.width = L;
  canvas.height = A;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = PAPEL;
  ctx.fillRect(0, 0, L, A);

  // faixa superior com a marca
  ctx.fillStyle = NAVY;
  ctx.fillRect(0, 0, L, 76);
  ctx.fillStyle = PAPEL;
  ctx.font = '600 30px Inter, system-ui, sans-serif';
  ctx.fillText('Radar dos Gastos', 48, 49);
  ctx.font = '400 22px Inter, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,253,250,0.75)';
  ctx.textAlign = 'right';
  ctx.fillText('prestação de contas, dia após dia', L - 48, 49);
  ctx.textAlign = 'left';

  // foto (ou iniciais)
  const cx = 128;
  const cy = 210;
  const raio = 80;
  let desenhouFoto = false;
  if (d.fotoUrl) {
    try {
      const img = await carregarFoto(d.fotoUrl);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, raio, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, cx - raio, cy - raio, raio * 2, raio * 2);
      ctx.restore();
      desenhouFoto = true;
    } catch {
      // sem CORS no CDN do TSE — segue para as iniciais
    }
  }
  if (!desenhouFoto) {
    ctx.fillStyle = 'rgba(38,78,155,0.12)';
    ctx.beginPath();
    ctx.arc(cx, cy, raio, 0, Math.PI * 2);
    ctx.fill();
    const partes = d.nome.trim().split(/\s+/);
    const iniciais = (partes.length > 1
      ? `${partes[0][0]}${partes[partes.length - 1][0]}`
      : (partes[0]?.slice(0, 2) ?? '?')
    ).toUpperCase();
    ctx.fillStyle = NAVY_CLARO;
    ctx.font = '700 58px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(iniciais, cx, cy + 20);
    ctx.textAlign = 'left';
  }
  ctx.strokeStyle = 'rgba(38,78,155,0.25)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, raio, 0, Math.PI * 2);
  ctx.stroke();

  // identificação
  const xTexto = 248;
  ctx.fillStyle = TINTA;
  ctx.font = '700 46px Inter, system-ui, sans-serif';
  ctx.fillText(elipse(ctx, d.nome, L - xTexto - 48), xTexto, 188);
  ctx.fillStyle = TINTA_SUAVE;
  ctx.font = '400 26px Inter, system-ui, sans-serif';
  ctx.fillText(`nº ${d.numero} · ${d.cargo} · ${d.partido}/${d.uf}`, xTexto, 232);

  // KPIs
  const kpis: [string, string][] = [
    ['Arrecadado', d.arrecadado == null ? '—' : brl.format(d.arrecadado)],
    ['Contratado', brl.format(d.contratado)],
    ['Dinheiro público', d.pctPublico == null
      ? '—'
      : `${d.pctPublico.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`],
  ];
  const kpiY = 300;
  const kpiL = (L - 96 - 2 * 24) / 3;
  kpis.forEach(([rotulo, valor], i) => {
    const x = 48 + i * (kpiL + 24);
    ctx.fillStyle = 'rgba(38,78,155,0.06)';
    ctx.beginPath();
    ctx.roundRect(x, kpiY, kpiL, 96, 14);
    ctx.fill();
    ctx.fillStyle = TINTA_SUAVE;
    ctx.font = '600 18px Inter, system-ui, sans-serif';
    ctx.fillText(rotulo.toUpperCase(), x + 22, kpiY + 36);
    ctx.fillStyle = NAVY;
    ctx.font = '700 34px Inter, system-ui, sans-serif';
    ctx.fillText(elipse(ctx, valor, kpiL - 44), x + 22, kpiY + 76);
  });

  // indícios (até 3)
  let y = 452;
  ctx.font = '400 23px Inter, system-ui, sans-serif';
  const flags = d.flags.slice(0, 3);
  for (const f of flags) {
    ctx.fillStyle = AMBAR;
    ctx.beginPath();
    ctx.arc(58, y - 8, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = TINTA;
    ctx.fillText(elipse(ctx, f, L - 130), 78, y);
    y += 38;
  }
  if (d.flags.length > 3) {
    ctx.fillStyle = TINTA_SUAVE;
    ctx.fillText(`+ ${d.flags.length - 3} outros indícios na ficha completa`, 78, y);
  } else if (!flags.length) {
    ctx.fillStyle = TINTA_SUAVE;
    ctx.fillText('Nenhum indício contável nas declarações até aqui.', 48, y);
  }

  // rodapé
  ctx.fillStyle = TINTA_SUAVE;
  ctx.font = '400 20px Inter, system-ui, sans-serif';
  ctx.fillText(
    `Dados declarados ao TSE${d.geradoEm ? ` · extração de ${d.geradoEm}` : ''} · indícios para investigar, não acusações`,
    48, A - 58,
  );
  ctx.fillStyle = NAVY_CLARO;
  ctx.font = '600 22px Inter, system-ui, sans-serif';
  ctx.fillText(d.url, 48, A - 26);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
