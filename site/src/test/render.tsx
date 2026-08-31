/* Render das páginas dentro de um router de memória: as páginas usam
 * useParams/useSearchParams/Link, então a rota faz parte do cenário. */
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render } from '@testing-library/react';

/** `caminho` é o padrão da rota (ex.: '/candidato/:sq') e `url` a entrada
 *  concreta (ex.: '/candidato/123'); sem eles a página é montada em '/'. */
export function renderizarRota(
  elemento: ReactElement,
  { caminho = '/', url = '/' }: { caminho?: string; url?: string } = {},
) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path={caminho} element={elemento} />
      </Routes>
    </MemoryRouter>,
  );
}
