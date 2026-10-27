import { hechoDeCaptura, piezasNetas, type CapturaVieja } from './captura';
import type { Contexto } from './reglas';

/** `[LE.5.1a]` Cada captura vieja a su destino: libro, cola o fuera — y nunca un peso dos veces. */
const CTX: Contexto = { actor: { kind: 'persona', user_id: '11111111-1111-1111-1111-111111111111' }, valueAt: '2026-10-20T12:00:00-06:00' };
const base = (o: Partial<CapturaVieja>): CapturaVieja => ({
  id: 'c1', folio: 'CG-2026-00100', tipo: 'gasto', origen_tipo: 'pago_proveedor', origen_ref: '00|X-D-26|0023639|0011',
  origen_efectivo: null, estado: 'en_corte', monto: '1060.00', morralla: null, concepto: 'PASIVO A PROVEEDORES',
  piezas: [{ denom_key: '500', flujo: 'recibido', piezas: 2 }, { denom_key: '50', flujo: 'recibido', piezas: 1 }, { denom_key: '10', flujo: 'recibido', piezas: 1 }],
  ligada_a_caos: false, ruta: null, sucursal: null, ...o,
});
const lineas = (d: ReturnType<typeof hechoDeCaptura>) => (d.destino === 'libro' ? d.propuesta.asiento.lines : []);

describe('[LE.5.1a] la captura vieja pasada por las reglas del libro', () => {
  it('gasto del cajón: sale del cajón con sus piezas, entra al egreso, con la llave de la captura', () => {
    const d = hechoDeCaptura(base({}), CTX);
    expect(d.destino).toBe('libro');
    expect(lineas(d)).toEqual([
      { account: 'EGRESO:PASIVO_A_PROVEEDORES', amount_minor: '106000' },
      { account: 'CAJA_MXN', amount_minor: '-106000', pieces: { 500: '-2', 50: '-1', 10: '-1' } },
    ]);
    if (d.destino === 'libro') expect(d.propuesta.asiento.event_ref).toBe('cash_ledger:c1');
  });

  it('D16: el cambio devuelto resta y la morralla va a su propia cuenta, en el mismo asiento', () => {
    const c = base({ monto: '450.50', morralla: '0.50', piezas: [{ denom_key: '500', flujo: 'recibido', piezas: 1 }, { denom_key: '50', flujo: 'devuelto', piezas: 1 }] });
    expect(piezasNetas(c)).toEqual({ 500: '1', 50: '-1' });
    expect(lineas(hechoDeCaptura(c, CTX))).toEqual([
      { account: 'EGRESO:PASIVO_A_PROVEEDORES', amount_minor: '45050' },
      { account: 'CAJA_MXN', amount_minor: '-45000', pieces: { 500: '-1', 50: '1' } },
      { account: 'MORRALLA_MXN', amount_minor: '-50' },
    ]);
  });

  it('cobro de ruta → entrega_ruta (baja el «por rendir» que Kepler dijo); de sucursal → otro_ingreso (D17)', () => {
    const cobro = base({ tipo: 'ingreso', origen_tipo: 'cobro', monto: '1000.00', piezas: [{ denom_key: '500', flujo: 'recibido', piezas: 2 }] });
    expect(lineas(hechoDeCaptura({ ...cobro, ruta: '27' }, CTX))).toEqual([
      { account: 'CAJA_MXN', amount_minor: '100000', pieces: { 500: '2' } },
      { account: 'POR_RENDIR:RUTA:27', amount_minor: '-100000' },
    ]);
    expect(lineas(hechoDeCaptura({ ...cobro, sucursal: 'Morelia Abastos' }, CTX))[1]).toEqual(
      { account: 'OTROS_INGRESOS:COBRO_DE_SUCURSAL_MORELIA_ABASTOS', amount_minor: '-100000' });
  });

  it('NO entra lo que ya explica la máquina: «ingreso caos» y el cobro ligado a un depósito', () => {
    expect(hechoDeCaptura(base({ tipo: 'ingreso', origen_tipo: 'caos' }), CTX).destino).toBe('fuera');
    expect(hechoDeCaptura(base({ tipo: 'ingreso', origen_tipo: 'cobro', ligada_a_caos: true, ruta: '27' }), CTX).destino).toBe('fuera');
  });

  it('a la cola: gasto pagado con retiro de CAOS, y piezas + morralla que no suman el monto', () => {
    expect(hechoDeCaptura(base({ origen_efectivo: 'caos' }), CTX)).toMatchObject({ destino: 'cola' });
    expect(hechoDeCaptura(base({ ligada_a_caos: true }), CTX)).toMatchObject({ destino: 'cola' });
    expect(hechoDeCaptura(base({ monto: '1061.00' }), CTX)).toMatchObject({ destino: 'cola', motivo: expect.stringContaining('≠ monto') });
  });

  it('cancelada → fuera', () => {
    expect(hechoDeCaptura(base({ estado: 'cancelado' }), CTX).destino).toBe('fuera');
  });
});
