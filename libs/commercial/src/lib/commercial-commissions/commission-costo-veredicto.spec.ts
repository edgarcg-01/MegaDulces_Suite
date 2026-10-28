import { CommercialCommissionsService } from './commercial-commissions.service';

/**
 * `[RD.96]` — **El peor veredicto de costo del periodo tiene que poder ser otro que «sin costo».**
 *
 * El defecto, medido en prod el 2026-10-28 (Q21): los 22 renglones de la corrida dicen
 * `costo_veredicto = 'sin_costo'` mientras la fuente de costo del mismo periodo tiene **70
 * ruta-día `dos_fuentes` y 51 `una_fuente_embarque` — cero sin costo**, y la columna Markup
 * de la pantalla muestra 16–21 %. La pantalla publicaba «sin costo» en 11 de 11 rutas.
 *
 * Causa: el pliegue de `ventaPorRuta()` elige el PEOR veredicto con `ORDEN_COSTO` (del peor al
 * mejor), pero arrancaba el acumulador en `'sin_costo'` — que ES el peor. La regla sólo lo
 * reemplaza por uno todavía peor, y no hay ninguno: quedaba `sin_costo` para siempre.
 */

/** Un `trx` falso: la primera `raw` es la venta del día, la segunda el costo del día. */
function trxCon(venta: Record<string, unknown>[], costo: Record<string, unknown>[]) {
  let n = 0;
  return { raw: async () => ({ rows: n++ === 0 ? venta : costo }) };
}

function servicio() {
  const tenantCtx = { get: () => ({ userId: 'u1' }), requireTenantId: () => 't1' } as never;
  const tk = { run: async (cb: (t: unknown) => unknown) => cb(null) } as never;
  return new CommercialCommissionsService(tk, tenantCtx) as unknown as {
    ventaPorRuta: (trx: unknown, t: string, a: string, b: string) => Promise<{ route_code: string; costo_veredicto: string; costo: number | null }[]>;
  };
}

const dia = (d: string) => ({ route_code: '21', business_date: d, subtotal: 1000, venta: 1100, costo_wincaja: null, fuentes_dia: 'push', dia_multifuente: false });
const costo = (d: string, veredicto: string) => ({ route_code: '21', business_date: d, cogs_ruta: 800, cogs_erp: 810, cogs_ruta_completo: true, costo_veredicto: veredicto });

describe('[RD.96] el peor veredicto de costo del periodo', () => {
  it('con todos los días en dos fuentes, el periodo es «dos_fuentes», no «sin_costo»', async () => {
    const [r] = await servicio().ventaPorRuta(
      trxCon([dia('2026-10-08'), dia('2026-10-09')], [costo('2026-10-08', 'dos_fuentes'), costo('2026-10-09', 'dos_fuentes')]),
      't1', '2026-10-08', '2026-10-21');
    expect(r.costo_veredicto).toBe('dos_fuentes');
    expect(r.costo).toBe(1600);
  });

  it('un día de una sola fuente vuelve el periodo «una_fuente_embarque» (el peor manda)', async () => {
    const [r] = await servicio().ventaPorRuta(
      trxCon([dia('2026-10-08'), dia('2026-10-09')], [costo('2026-10-08', 'dos_fuentes'), costo('2026-10-09', 'una_fuente_embarque')]),
      't1', '2026-10-08', '2026-10-21');
    expect(r.costo_veredicto).toBe('una_fuente_embarque');
  });

  it('un día SIN ninguna fuente de costo sí vuelve el periodo «sin_costo»', async () => {
    const [r] = await servicio().ventaPorRuta(
      trxCon([dia('2026-10-08'), dia('2026-10-09')], [costo('2026-10-08', 'dos_fuentes')]),
      't1', '2026-10-08', '2026-10-21');
    expect(r.costo_veredicto).toBe('sin_costo');
  });
});
