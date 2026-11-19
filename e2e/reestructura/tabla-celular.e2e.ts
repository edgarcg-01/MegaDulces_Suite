import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { LOCAL } from './desvio';

/**
 * `[AUD-UI.1]` Una tabla de PrimeNG SIN `.dt-stack` en el celular (390 px): ¿esconde columnas? ¿corta
 * el texto? ¿se puede llegar a cada dato? Con la hoja de estilos REAL que sirve la app, antes y con el
 * bloque «Mobile table optimizations» del árbol (styles.css) en su lugar.
 *
 * Se mide en una página de prueba con el mismo DOM que pinta p-table (contenedor + tabla + thead/tbody),
 * para no depender de los datos de ninguna pantalla. Control: una tabla `.dt-stack` sigue apilada con
 * todos sus campos (GP.RF.12).
 *
 *   E2E_LOCAL_URL=http://localhost:4200 npx playwright test -c e2e/reestructura/playwright.config.ts tabla-celular
 */
const RES = path.join(__dirname, '.resultados');
const COLS = ['Folio', 'Fecha', 'Sucursal', 'Cliente', 'Renglones', 'Etapa', 'Vendedor', 'Importe'];
const fila = (i: number) => [`UD4001-00${i}`, '18/11 10:15', 'Padre Hidalgo', `Abarrotes La Esperanza de Jiquilpan ${i}`, String(4 + i), 'Autorizado', 'Vendedor Prueba Dos', `$${1000 + i * 37}.00`];
const tabla = (id: string, clase: string) => `
  <div class="dt-scope" style="margin:16px 0">
    <div id="${id}" class="p-datatable p-component p-datatable-sm surf-table ${clase}">
      <div class="p-datatable-table-container">
        <table class="p-datatable-table" style="border-collapse:collapse">
          <thead class="p-datatable-thead"><tr>${COLS.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
          <tbody class="p-datatable-tbody">${[1, 2, 3].map((i) => `<tr style="background:#fff">${fila(i).map((v, k) => `<td role="cell" data-label="${COLS[k]}">${v}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
  </div>`;

function bloque(css: string): [number, number] {
  const i = css.indexOf('@media (max-width: 48rem) {\n  .p-datatable');
  const j = css.indexOf('.theme-monochrome .p-tabview .p-tabview-nav', i);
  if (i < 0 || j < 0) throw new Error('no se encontró el bloque de tablas en el celular');
  return [i, j];
}

async function medir(page: Page, css: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body style="margin:0;padding:0 16px">${tabla('t', '')}${tabla('s', 'dt-stack')}</body></html>`);
  return page.evaluate(() => {
    const t = document.getElementById('t')!;
    const celdas = Array.from(t.querySelectorAll('tbody td')) as HTMLElement[];
    const ocultas = celdas.filter((c) => getComputedStyle(c).display === 'none').map((c) => c.dataset['label']);
    const cortadas = celdas.filter((c) => getComputedStyle(c).display !== 'none' && c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).overflow === 'hidden').length;
    const caja = t.querySelector('.p-datatable-table-container') as HTMLElement;
    const desplaza = getComputedStyle(caja).overflowX !== 'visible' && caja.scrollWidth > caja.clientWidth;
    // ¿Se llega al «Vendedor» (7ª columna) desplazando la caja?
    caja.scrollLeft = caja.scrollWidth;
    const v = (t.querySelector('tbody tr td:nth-child(7)') as HTMLElement).getBoundingClientRect();
    const alcanzable = getComputedStyle(t.querySelector('tbody tr td:nth-child(7)')!).display !== 'none' && v.right <= innerWidth + 1 && v.left >= 0;
    const ultima = (t.querySelector('tbody tr td:last-child') as HTMLElement).getBoundingClientRect();
    const s = document.getElementById('s')!;
    const stackOcultas = Array.from(s.querySelectorAll('tbody td')).filter((c) => getComputedStyle(c).display === 'none').length;
    return {
      ocultas: [...new Set(ocultas)], celdas: celdas.length, cortadas, desplaza, vendedor_alcanzable: alcanzable,
      ultima_a_la_vista: ultima.right <= innerWidth + 1, letra_px: [...new Set(celdas.map((c) => getComputedStyle(c).fontSize))],
      pagina_desborda: document.documentElement.scrollWidth > innerWidth, dt_stack_ocultas: stackOcultas,
    };
  });
}

test.describe('[AUD-UI.1] Tabla sin .dt-stack en el celular', () => {
  test.skip(!LOCAL, 'NO MEDIDO: sin E2E_LOCAL_URL no hay hoja servida');

  test('antes esconde y corta; con el bloque nuevo se desplaza y se alcanza todo', async ({ page, request }) => {
    fs.mkdirSync(RES, { recursive: true });
    const servida = (await (await request.get(LOCAL + '/styles.css')).text()).split('\r\n').join('\n');
    const [i, j] = bloque(servida);
    const tramo = (texto: string): string => {
      const t = texto.split('\r\n').join('\n');
      const a = t.indexOf('@media (max-width: 48rem) {', t.indexOf('/* Mobile table optimizations */'));
      const b = t.indexOf('/* Force PrimeNG tabs to use theme colors in dark mode */', a);
      if (a < 0 || b < 0) throw new Error('no se encontró el bloque en styles.css');
      return t.slice(a, b);
    };
    // «Antes» = el bloque como estaba antes de GP.RF.12 (el commit previo a 8e78e5e9b); «ahora» = el del árbol.
    const original = execSync('git show 8e78e5e9b^:apps/view/src/styles.css', { cwd: path.join(__dirname, '../..'), encoding: 'utf8', maxBuffer: 1 << 26 });
    const fuente = fs.readFileSync(path.join(__dirname, '../../apps/view/src/styles.css'), 'utf8');
    const conBloque = (b: string): string => servida.slice(0, i) + b + servida.slice(j);

    const antes = await medir(page, conBloque(tramo(original)));
    const nueva = conBloque(tramo(fuente));
    const ahora = await medir(page, nueva);
    console.log('ANTES', JSON.stringify(antes));
    console.log('AHORA', JSON.stringify(ahora));
    fs.writeFileSync(path.join(RES, 'tabla-celular.json'), JSON.stringify({ medido_at: new Date().toISOString(), antes, ahora }, null, 2));

    // Control del instrumento: el bloque viejo SÍ escondía (si no, «ahora» no prueba nada).
    expect(antes.ocultas.length, 'control: antes se escondían columnas').toBeGreaterThan(0);
    expect(ahora.ocultas).toEqual([]);
    expect(ahora.cortadas).toBe(0);
    expect(ahora.desplaza && ahora.vendedor_alcanzable).toBe(true);
    expect(ahora.pagina_desborda, 'la página no se desborda a lo ancho').toBe(false);
    expect(ahora.dt_stack_ocultas, 'control: la tabla .dt-stack sigue con todos sus campos').toBe(0);
    expect(ahora.letra_px.every((x) => parseFloat(x) >= 12)).toBe(true);
  });
});
