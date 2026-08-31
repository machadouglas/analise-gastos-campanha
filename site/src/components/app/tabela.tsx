import { memo, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface Coluna {
  titulo: string;
  numerica?: boolean;
}

/** Largura mínima da tabela, em rem, derivada do número de colunas. Sem ela o
 *  navegador espreme todas as colunas na largura do celular e cada nome vira
 *  uma coluna de uma palavra por linha; com ela as colunas mantêm respiro e o
 *  excedente vira rolagem lateral (anunciada logo abaixo). No desktop o
 *  contêiner já é mais largo que esse mínimo — nada muda. */
function larguraMinima(nColunas: number): number {
  return Math.min(nColunas * 8.5, 54);
}

// memo: os inputs do Explorar re-renderizam a página a cada tecla
export const Tabela = memo(function Tabela({
  colunas,
  children,
  className,
}: {
  colunas: Coluna[];
  children: React.ReactNode;
  className?: string;
}) {
  const rolagemRef = useRef<HTMLDivElement>(null);
  const tabelaRef = useRef<HTMLTableElement>(null);
  const [rolavel, setRolavel] = useState(false);
  const [noFim, setNoFim] = useState(false);

  // observa contêiner E tabela: o primeiro muda com o viewport, a segunda com
  // o conteúdo (paginação, filtros) — juntos cobrem todos os casos sem
  // depender da identidade de `children`, que muda a cada tecla no Explorar.
  useEffect(() => {
    const el = rolagemRef.current;
    if (!el) return;
    const medir = () => {
      const sobra = el.scrollWidth - el.clientWidth;
      setRolavel(sobra > 8);
      setNoFim(el.scrollLeft >= sobra - 8);
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    if (tabelaRef.current) ro.observe(tabelaRef.current);
    el.addEventListener('scroll', medir, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', medir);
    };
  }, []);

  return (
    <div className={className}>
      {/* o relativo envolve só a área rolável: com a dica dentro, o esmaecido
          se esticava por cima do texto dela */}
      <div className="relative">
        <div ref={rolagemRef} className="overflow-x-auto rounded-xl border bg-card shadow-sm">
          <table
            ref={tabelaRef}
            className="w-full border-collapse text-sm"
            style={{ minWidth: `${larguraMinima(colunas.length)}rem` }}
          >
            <thead>
              <tr>
                {colunas.map((c) => (
                  <th
                    key={c.titulo}
                    className={cn(
                      'border-b px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:px-4 sm:py-3',
                      c.numerica && 'text-right',
                    )}
                  >
                    {c.titulo}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="[&_td]:border-b [&_td]:px-3 [&_td]:py-2 [&_td]:align-top sm:[&_td]:px-4 sm:[&_td]:py-2.5 [&_tr:last-child_td]:border-b-0">
              {children}
            </tbody>
          </table>
        </div>
        {/* esmaecido na borda direita: sinaliza que ainda há coluna adiante */}
        {rolavel && !noFim && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-8 rounded-r-xl bg-gradient-to-l from-card to-transparent"
          />
        )}
      </div>
      {rolavel && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Role a tabela para o lado para ver as demais colunas →
        </p>
      )}
    </div>
  );
});

/** Célula numérica; com `frac` (0–1, valor ÷ maior da coluna) desenha uma
 *  micro-barra proporcional atrás do número — a coluna vira legível de relance,
 *  sem precisar comparar dígitos linha a linha. */
export function CelulaNum({ children, frac }: { children: React.ReactNode; frac?: number }) {
  if (frac == null || !isFinite(frac)) {
    return <td className="text-right tabular-nums whitespace-nowrap">{children}</td>;
  }
  const pct = Math.min(Math.max(frac, 0), 1) * 100;
  return (
    <td className="text-right tabular-nums whitespace-nowrap">
      <span className="relative inline-block min-w-[7rem]">
        <span
          aria-hidden
          className="absolute inset-y-[-2px] right-0 rounded-sm bg-[#264E9B]/10"
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
        <span className="relative pr-1">{children}</span>
      </span>
    </td>
  );
}

/** Texto livre (descrições de contrato etc.): a coluna elástica da tabela —
 *  absorve o espaço que sobra (w-full) em vez de exigir largura própria, com
 *  no máximo duas linhas e o texto completo no title. Sem isso, uma única
 *  descrição enorme alarga a coluna e empurra o Valor para fora da tela. */
export function CelulaTexto({ children, title }: { children: React.ReactNode; title?: string }) {
  const texto = title ?? (typeof children === 'string' ? children : undefined);
  return (
    <td className="w-full">
      {/* overflow-wrap:anywhere (e não break-words): só ele entra no cálculo
          de largura mínima da coluna — um token gigante sem espaços deixa de
          ditar a largura da tabela inteira */}
      <div className="line-clamp-2 max-w-[18rem] [overflow-wrap:anywhere] sm:max-w-[26rem]" title={texto}>
        {children}
      </div>
    </td>
  );
}
