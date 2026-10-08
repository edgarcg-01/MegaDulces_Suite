// El PDF real lo arma Chromium; acá sólo se prueba el HTML de la sección, sin levantar navegador.
vi.mock('puppeteer', () => ({}));

import type { TransferenciaGasto } from '@megadulces/contracts';
import { bloqueTransferenciasHtml, fecha } from './expediente-gasto-document.service';

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

  /**
   * ⛔ `pg` entrega `date`/`timestamp` como objeto `Date`. Visto en el PDF real armado contra prod:
   * la solicitud y el gasto decían «Mon Oct 05» (inglés, sin año) en vez de «5 oct 2026».
   */
  it('⛔ la fecha sale en español con año, venga como texto o como Date de pg', () => {
    expect(fecha('2026-10-05')).toBe('5 oct 2026');
    expect(fecha(new Date(2026, 9, 5))).toBe('5 oct 2026');
    expect(fecha(new Date(2026, 9, 5, 23, 59))).toBe('5 oct 2026');
    expect(fecha(null)).toBe('—');
    expect(fecha(new Date('no-es-fecha'))).toBe('—');
  });

  it('escapa lo que viene de Kepler y no inventa importe sin encabezado', () => {
    const h = bloqueTransferenciasHtml([T({ folio: '<b>1</b>', importe: null })], true);
    expect(h).toContain('&lt;b&gt;1&lt;/b&gt;');
    expect(h).toMatch(/<td class="num">—<\/td>/);
  });
});
