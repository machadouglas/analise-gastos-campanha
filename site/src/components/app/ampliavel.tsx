import { useRef } from 'react';
import { Maximize2, X } from 'lucide-react';

/** Envolve um gráfico responsivo (SVG com viewBox) e oferece um botão de
 *  ampliar: o mesmo conteúdo re-renderiza num <dialog> nativo ocupando quase a
 *  tela toda — zoom de verdade sem biblioteca de pan/zoom nem estado global.
 *  Fecha no X, no Esc (nativo do dialog) ou clicando no fundo. */
export function Ampliavel({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <div className="relative">
      <button
        onClick={() => ref.current?.showModal()}
        title="Ampliar este gráfico"
        aria-label={`Ampliar: ${titulo}`}
        className="absolute -top-1 right-0 z-10 rounded-md border bg-card p-1.5 text-muted-foreground shadow-sm transition-colors hover:border-[#264E9B]/40 hover:text-foreground"
      >
        <Maximize2 className="h-4 w-4" />
      </button>
      {children}
      <dialog
        ref={ref}
        onClick={(e) => {
          // clique no backdrop (o próprio dialog) fecha; cliques no conteúdo não
          if (e.target === ref.current) ref.current?.close();
        }}
        className="m-auto w-[96vw] max-w-[1500px] rounded-xl border bg-card p-0 shadow-xl backdrop:bg-black/50"
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <p className="font-semibold">{titulo}</p>
          <button
            onClick={() => ref.current?.close()}
            aria-label="Fechar"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[85vh] overflow-auto p-6">{children}</div>
      </dialog>
    </div>
  );
}
