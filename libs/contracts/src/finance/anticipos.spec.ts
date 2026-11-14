/**
 * `[PGP.118]` Las reglas del submódulo de Anticipos.
 *
 * Vectores SINTÉTICOS (el repo es público): reproducen la forma de los casos medidos en prod sin
 * nombres ni montos reales.
 */
import { disponibleDeAnticipo, etapaDeSolicitud, faltaSolicitudAnticipo, grupoDeAnticipo, llaveAnticipo, neteableHoy, parearSolicitudes, tipoDeAcreedor, tramoDeAnticipo } from './anticipos.contract';

describe('[PGP.118] tipoDeAcreedor', () => {
  it('C* es mercancía, G* gasto, TC* tarjeta', () => {
    expect(tipoDeAcreedor('CF001')).toBe('mercancia');
    expect(tipoDeAcreedor('GL002')).toBe('gasto');
    expect(tipoDeAcreedor('TC003')).toBe('tarjeta');
  });
  it('⛔ TC no se confunde con otra cosa por empezar con T', () => {
    expect(tipoDeAcreedor('TI004')).toBe('otro');
  });
  it('tolera espacios y minúsculas de Kepler', () => {
    expect(tipoDeAcreedor('  cf001 ')).toBe('mercancia');
  });
  it('sin código no se inventa un tipo', () => {
    expect(tipoDeAcreedor(null)).toBe('otro');
    expect(tipoDeAcreedor('')).toBe('otro');
  });
});

describe('[PGP.118] grupoDeAnticipo', () => {
  it('mercancía con deuda viva: aplicable hoy', () => {
    expect(grupoDeAnticipo('CF001', 1000)).toBe('aplicable');
  });
  it('mercancía sin deuda: sin contra qué (pedir factura o reembolso)', () => {
    expect(grupoDeAnticipo('CF001', 0)).toBe('sin_contra_que');
    expect(grupoDeAnticipo('CF001', 0.004)).toBe('sin_contra_que');
  });
  it('⛔ la deuda que todavía no llegó es «calculando», NUNCA «sin contra qué»', () => {
    expect(grupoDeAnticipo('CF001', null)).toBe('calculando');
    expect(grupoDeAnticipo('CF001', undefined)).toBe('calculando');
    expect(grupoDeAnticipo('CF001', Number.NaN)).toBe('calculando');
  });
  it('⛔ gasto y tarjeta nunca son «aplicables», aunque se les deba', () => {
    expect(grupoDeAnticipo('GL002', 5000)).toBe('no_mercancia');
    expect(grupoDeAnticipo('TC003', 5000)).toBe('no_mercancia');
    expect(grupoDeAnticipo('XX009', 5000)).toBe('no_mercancia');
  });
});

describe('[PGP.118] tramoDeAnticipo', () => {
  it('los cortes son inclusivos: 30 y 90 quedan en su tramo', () => {
    expect(tramoDeAnticipo(0)).toBe('0-30');
    expect(tramoDeAnticipo(30)).toBe('0-30');
    expect(tramoDeAnticipo(31)).toBe('31-90');
    expect(tramoDeAnticipo(90)).toBe('31-90');
    expect(tramoDeAnticipo(91)).toBe('+90');
  });
  it('sin fecha se declara, no se cuenta como reciente', () => {
    expect(tramoDeAnticipo(null)).toBe('sin_fecha');
    expect(tramoDeAnticipo(Number.NaN)).toBe('sin_fecha');
  });
});

describe('[PGP.118] neteableHoy', () => {
  it('nunca más que el anticipo ni más que la deuda', () => {
    expect(neteableHoy(1000, 400)).toBe(400);
    expect(neteableHoy(400, 1000)).toBe(400);
  });
  it('sin deuda: cero, que es distinto de «no sé»', () => {
    expect(neteableHoy(1000, 0)).toBe(0);
  });
  it('⛔ la deuda que no llegó da null, no cero', () => {
    expect(neteableHoy(1000, null)).toBeNull();
    expect(neteableHoy(1000, undefined)).toBeNull();
  });
});

describe('[PGP.120] llaveAnticipo y disponibleDeAnticipo', () => {
  it('la llave junta acreedor y sucursal, sin espacios ni mayúsculas de por medio', () => {
    expect(llaveAnticipo(' cf001 ', '00')).toBe('CF001|00');
    expect(llaveAnticipo('CF001', '03')).not.toBe(llaveAnticipo('CF001', '00'));
  });
  it('lo disponible es lo de Kepler menos lo apartado en el Calendario, nunca negativo', () => {
    expect(disponibleDeAnticipo({ a_favor: 1000, apartado: 400 })).toBe(600);
    expect(disponibleDeAnticipo({ a_favor: 1000, apartado: 1200 })).toBe(0);
    expect(disponibleDeAnticipo({ a_favor: 1000, apartado: 0 })).toBe(1000);
  });
});

describe('[PGP.119] faltaSolicitudAnticipo — la misma regla en la pantalla y en el servidor', () => {
  const ok = { supplier_code: 'CA001', sucursal: '00', monto: 1000, motivo: 'temporada', fecha: '2026-11-20' };
  it('completo: se puede pedir', () => {
    expect(faltaSolicitudAnticipo(ok)).toBeNull();
  });
  it('⛔ gasto o tarjeta no llevan anticipo (D2)', () => {
    expect(faltaSolicitudAnticipo({ ...ok, supplier_code: 'GL002' })).toMatch(/mercancía/);
    expect(faltaSolicitudAnticipo({ ...ok, supplier_code: 'TC003' })).toMatch(/mercancía/);
  });
  it('⛔ sin sucursal, sin importe, sin motivo o con fecha imposible no sale', () => {
    expect(faltaSolicitudAnticipo({ ...ok, sucursal: '' })).toMatch(/sucursal/);
    expect(faltaSolicitudAnticipo({ ...ok, monto: 0 })).toMatch(/importe/);
    expect(faltaSolicitudAnticipo({ ...ok, motivo: ' ' })).toMatch(/motivo/);
    expect(faltaSolicitudAnticipo({ ...ok, fecha: '2026-02-30' })).toMatch(/fecha/);
  });
  it('⛔ con OC no pasa del saldo: total − lo ya anticipado (D6), y al centavo sí', () => {
    const oc = { total: 10000, anticipado: 8000, folio: 'OC-9' };
    expect(faltaSolicitudAnticipo({ ...ok, monto: 2000.01, oc })).toMatch(/quedan \$2000\.00/);
    expect(faltaSolicitudAnticipo({ ...ok, monto: 2000, oc })).toBeNull();
  });
});

describe('[PGP.119] parearSolicitudes — cada pedido con su X-D-60, uno a uno', () => {
  const cand = (folio: string, fecha: string) => ({ folio, fecha, importe: 1000, remanente: 1000 });
  it('toma el de fecha más cercana al pedido y dice cuántos podían ser', () => {
    const m = parearSolicitudes([{ obligation_id: 'a', proveedor: 'CA001', sucursal: '00', creado: '2026-11-10', candidatos: [cand('0000001', '2026-11-20'), cand('0000002', '2026-11-11')] }]);
    expect(m.get('a')).toEqual({ kepler: cand('0000002', '2026-11-11'), posibles: 2 });
  });
  it('⛔ dos pedidos iguales no se quedan con el mismo documento: el más viejo escoge primero', () => {
    const cs = [cand('0000001', '2026-11-10'), cand('0000002', '2026-11-12')];
    const m = parearSolicitudes([
      { obligation_id: 'b', proveedor: 'CA001', sucursal: '00', creado: '2026-11-11', candidatos: cs },
      { obligation_id: 'a', proveedor: 'CA001', sucursal: '00', creado: '2026-11-10', candidatos: cs },
    ]);
    expect(m.get('a')?.kepler?.folio).toBe('0000001');
    expect(m.get('b')?.kepler?.folio).toBe('0000002');
  });
  it('sin candidatos no se inventa uno', () => {
    expect(parearSolicitudes([{ obligation_id: 'a', proveedor: 'CA001', sucursal: '00', creado: '2026-11-10', candidatos: [] }]).get('a')).toEqual({ kepler: null, posibles: 0 });
  });
});

describe('[PGP.119] etapaDeSolicitud — Kepler manda sobre la Suite', () => {
  const base = { estado_obligacion: 'pending', monto: 1000, pagado: 0, programado_dia: null as string | null, kepler: null as null | { folio: string; fecha: string; importe: number; remanente: number } };
  it('por programar → programado → pagado', () => {
    expect(etapaDeSolicitud(base)).toBe('por_programar');
    expect(etapaDeSolicitud({ ...base, programado_dia: '2026-11-12' })).toBe('programado');
    expect(etapaDeSolicitud({ ...base, programado_dia: '2026-11-12', pagado: 1000 })).toBe('pagado');
  });
  it('⛔ si Kepler ya lo tiene, es «en Kepler» aunque la Suite no lo haya marcado pagado; aplicado cuando no queda nada', () => {
    const k = { folio: '0000001', fecha: '2026-11-12', importe: 1000, remanente: 1000 };
    expect(etapaDeSolicitud({ ...base, programado_dia: '2026-11-12', kepler: k })).toBe('en_kepler');
    expect(etapaDeSolicitud({ ...base, kepler: { ...k, remanente: 0 } })).toBe('aplicado');
  });
  it('cancelado gana a todo', () => {
    expect(etapaDeSolicitud({ ...base, estado_obligacion: 'cancelled', pagado: 1000 })).toBe('cancelado');
  });
});
