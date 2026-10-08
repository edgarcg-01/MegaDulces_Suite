// El PDF real lo arma Chromium; acá sólo se prueba el HTML de la sección, sin levantar navegador.
vi.mock('puppeteer', () => ({}));

import type { TransferenciaGasto } from '@megadulces/contracts';
import { bloqueTransferenciasHtml } from './expediente-gasto-document.service';

/**
 * `[GX.75]` La sección «La transferencia» del expediente en PDF. Cada ausencia se dice distinto,
 * y la transferencia cancelada se lista pero no suma.
 */
const T = (o: Partial<TransferenciaGasto> = {}): TransferenciaGasto => ({
  gasto_folio: '0008808', folio: '0022034', fecha: '2026-09-25', importe: 1053.5, aplicado: 1053.5, cancelada: false, ...o,
});

describe('[GX.75] bloqueTransferenciasHtml', () => {
  it('lista la transferencia con su folio, fecha, gasto y lo aplicado', () => {
    const h = bloqueTransferenciasHtml([T()], true);
    expect(h).toContain('0022034');
    expect(h).toContain('25 sep 2026');
    expect(h).toContain('0008808');
    expect(h).toContain('$1,053.50');
    expect(h).toContain('Vigente');
    // Con una sola no hace falta renglón de suma.
    expect(h).not.toContain('Aplicado por transferencias vigentes');
  });

  it('⛔ la cancelada se marca y NO entra a la suma', () => {
    const h = bloqueTransferenciasHtml([T({ aplicado: 500 }), T({ folio: '0022099', aplicado: 999, cancelada: true })], true);
    expect(h).toContain('class="cancelada"');
    expect(h).toContain('Cancelada — no cuenta');
    expect(h).toMatch(/Aplicado por transferencias vigentes<\/td><td class="num">\$500\.00/);
  });

  it('⛔ cada ausencia dice algo distinto', () => {
    expect(bloqueTransferenciasHtml([], false)).toContain('Todavía no hay gasto que pagar');
    expect(bloqueTransferenciasHtml(null, true)).toContain('No se pudo consultar Kepler');
    expect(bloqueTransferenciasHtml([], true)).toContain('no tiene una transferencia (XD2601) aplicada');
  });

  it('escapa lo que viene de Kepler y no inventa importe sin encabezado', () => {
    const h = bloqueTransferenciasHtml([T({ folio: '<b>1</b>', importe: null })], true);
    expect(h).toContain('&lt;b&gt;1&lt;/b&gt;');
    expect(h).toMatch(/<td class="num">—<\/td>/);
  });
});
