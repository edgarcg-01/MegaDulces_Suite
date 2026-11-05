import type { ZonaHojaGastos } from '@megadulces/contracts';
import type { PagoDeZona } from '../caja/hoja-gastos.engine';
import { hojaDeReposicion } from './reposicion-en-ventanilla';

/** `[LE.6.8]` La hoja que ve la Ventanilla: la regla de siempre, sin lo anterior a la apertura ni lo ya pedido. */
const ZONA: ZonaHojaGastos = { clave: 'morelia', nombre: 'Zona Morelia', sucursales: ['08', '07'], desde: '2026-10-12', cuenta_deposito: null };
const pago = (folio: string, fecha: string, importe: number, over: Partial<PagoDeZona> = {}): PagoDeZona => ({
  origen_ref: `07|X-D-26|${folio}|0011`, sucursal: '07', doc_tipo: 'X-D-26', folio, fecha_pago: fecha, fecha_captura: fecha,
  beneficiario: 'GASTOS GENERALES', clave: 'G001', centro: '007', referencia: null, importe, en_libro: null, cg_folio: null, en_hoja: false, ...over,
});

describe('[LE.6.8] la hoja de reposición de la Ventanilla', () => {
  it('lo anterior a la apertura NO entra: se cuenta aparte (lo reconstruye E3)', () => {
    // $1,550.50: la máquina da $1,550 en billetes (3 de $500 y uno de $50) y el cajón pone los 50 centavos.
    const h = hojaDeReposicion(ZONA, [pago('1', '2026-10-15', 1000), pago('2', '2026-11-05', 1250.5), pago('3', '2026-11-05', 300)], '2026-11-05', new Set());
    expect(h.anteriores).toEqual({ n: 1, monto_minor: '100000' });
    expect(h.renglones.map((r) => r.folio)).toEqual(['2', '3']);
    expect(h).toMatchObject({ total_minor: '155050', maquina_minor: '155000', cajon_minor: '50', sin_arranque: false });
  });

  it('sin apertura no hay hoja: todo se declara como anterior', () => {
    const h = hojaDeReposicion(ZONA, [pago('1', '2026-11-05', 1000)], null, new Set());
    expect(h).toMatchObject({ sin_arranque: true, renglones: [], total_minor: '0', anteriores: { n: 1, monto_minor: '100000' } });
  });

  it('lo que no se repone sale con su motivo (la misma regla de la hoja), y lo ya pedido no vuelve a entrar', () => {
    const h = hojaDeReposicion(ZONA, [
      pago('1', '2026-11-05', 500),
      pago('2', '2026-11-05', 900, { centro: '009' }),
      pago('3', '2026-11-05', 700, { referencia: 'C-237' }),
      pago('4', '2026-11-05', 200),
    ], '2026-11-05', new Set(['07|X-D-26|4|0011']));
    expect(h.renglones.map((r) => r.folio)).toEqual(['1']);
    expect(h.fuera.map((f) => [f.folio, f.motivo])).toEqual([['2', 'nomina'], ['3', 'compra_registrada']]);
  });
});
