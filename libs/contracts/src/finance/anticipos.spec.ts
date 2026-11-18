/**
 * `[PGP.118]` Las reglas del submódulo de Anticipos.
 *
 * Vectores SINTÉTICOS (el repo es público): reproducen la forma de los casos medidos en prod sin
 * nombres ni montos reales.
 */
import { anticiposDelDia, anticiposDeOc, diasEnEtapa, embudoAnticipos, ETAPA_ANTICIPO_TEXTO, disponibleDeAnticipo, estadoCuentaAnticipo, etapaDeSolicitud, faltaCancelarAnticipo, faltaCuentaAnticipo, faltaCuentaParaTransferirAnticipo, faltaSolicitudAnticipo, grupoDeAnticipo, llaveAnticipo, MARCA_CANCELADO, neteableHoy, parearSolicitudes, partirMotivo, tipoDeAcreedor, topeDeOcs, tramoDeAnticipo } from './anticipos.contract';

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
  // `[PGP.127]` El pedido completo ya trae su OC de Kepler, su cotización y su cuenta.
  const OC = { sucursal: '00', serie: '1', folio: '0000101', total: 50000, pedidos: [] as { id: string; monto: number }[] };
  const ok = { supplier_code: 'CA001', sucursal: '00', monto: 1000, motivo: 'temporada', fecha: '2026-11-20', ocs: [OC], cotizacion: true, cuenta: { tipo: 'efectivo' as const } };
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
  it('⛔ con OC de la Suite no pasa del saldo: total − lo ya anticipado (D6), y al centavo sí', () => {
    const oc = { total: 10000, anticipado: 8000, folio: 'OC-9' };
    expect(faltaSolicitudAnticipo({ ...ok, monto: 2000.01, oc })).toMatch(/quedan \$2000\.00/);
    expect(faltaSolicitudAnticipo({ ...ok, monto: 2000, oc })).toBeNull();
  });
});

describe('[PGP.127] el pedido lleva su OC de Kepler, su cotización y su cuenta (D10–D12)', () => {
  const pedido = (id: string, monto: number) => ({ id, monto });
  const oc = (folio: string, total: number, pedidos: { id: string; monto: number }[] = [], sucursal = '03') => ({ sucursal, serie: '1', folio, total, pedidos });
  const ok = { supplier_code: 'CA001', sucursal: '03', monto: 1000, motivo: 'temporada', fecha: '2026-11-20', ocs: [oc('0000101', 5000)], cotizacion: true, cuenta: { tipo: 'efectivo' as const } };
  const CLABE = '012180001234567899';

  it('⛔ D11 — sin OC de Kepler no sale; OC de dos sucursales tampoco; la sucursal es la de la OC', () => {
    expect(faltaSolicitudAnticipo({ ...ok, ocs: [] })).toMatch(/orden de compra de Kepler/);
    expect(faltaSolicitudAnticipo({ ...ok, ocs: [oc('1', 5000), oc('2', 5000, [], '08')] })).toMatch(/sucursales distintas/);
    expect(faltaSolicitudAnticipo({ ...ok, sucursal: '08' })).toMatch(/sucursal del anticipo es la de su orden/);
  });
  it('⛔ D6 sobre varias OC: la suma de sus totales menos lo pedido, cada pedido UNA vez aunque abarque las dos', () => {
    // El pedido p1 abarca las dos OC: contarlo dos veces dejaría $2,000 en vez de $5,000.
    const ocs = [oc('1', 4000, [pedido('p1', 3000)]), oc('2', 4000, [pedido('p1', 3000)])];
    expect(topeDeOcs(ocs)).toEqual({ total: 8000, anticipado: 3000, queda: 5000 });
    expect(faltaSolicitudAnticipo({ ...ok, ocs, monto: 5000.01 })).toMatch(/Las 2 OC suman \$8000\.00 y ya tienen \$3000\.00 en anticipos: quedan \$5000\.00/);
    expect(faltaSolicitudAnticipo({ ...ok, ocs, monto: 5000 })).toBeNull();
  });
  it('⛔ D10 — sin cotización no sale', () => {
    expect(faltaSolicitudAnticipo({ ...ok, cotizacion: false })).toMatch(/cotización/);
  });
  it('⛔ D12 — sin decir la cuenta no sale; la CLABE nueva se revisa con su dígito de control', () => {
    expect(faltaSolicitudAnticipo({ ...ok, cuenta: null })).toMatch(/a qué cuenta/);
    expect(faltaCuentaAnticipo({ tipo: 'nueva', clabe: '0121800012345678', banco: 'BBVA' })).toMatch(/18 dígitos \(van 16\)/);
    expect(faltaCuentaAnticipo({ tipo: 'nueva', clabe: '012180001234567890', banco: 'BBVA' })).toMatch(/dígito de control/);
    expect(faltaCuentaAnticipo({ tipo: 'nueva', clabe: CLABE, banco: ' ' })).toMatch(/banco/);
    // Pegada con espacios, como viene en una cotización: se acepta (Postel: la forma, no el significado).
    expect(faltaCuentaAnticipo({ tipo: 'nueva', clabe: '012 180 00123456789 9', banco: 'BBVA' })).toBeNull();
    expect(faltaCuentaAnticipo({ tipo: 'aprobada', account_id: 'x' })).toMatch(/cuenta aprobada/);
    expect(faltaCuentaAnticipo({ tipo: 'aprobada', account_id: '00000000-0000-0000-0000-0000000000aa' })).toBeNull();
  });
});

describe('[PGP.127] estadoCuentaAnticipo — se deriva del catálogo, nunca se copia', () => {
  const base = { payee_clabe: '012180001234567899', tiene_cotizacion: true, banco_aprobada: null as string | null, solicitud_estado: null as string | null };
  it('aprobada manda sobre la solicitud; luego pendiente, rechazada y sin cuenta', () => {
    expect(estadoCuentaAnticipo({ ...base, banco_aprobada: 'BBVA', solicitud_estado: 'pending_approval' })).toBe('aprobada');
    expect(estadoCuentaAnticipo({ ...base, solicitud_estado: 'pending_approval' })).toBe('en_aprobacion');
    expect(estadoCuentaAnticipo({ ...base, solicitud_estado: 'rejected' })).toBe('rechazada');
    // Aplicada y luego dada de baja: ya no hay cuenta activa → no se dice «aprobada».
    expect(estadoCuentaAnticipo({ ...base, solicitud_estado: 'applied' })).toBe('sin_cuenta');
  });
  it('sin CLABE: efectivo si se pidió con cotización; «sin dato» si es un pedido de antes de PGP.127', () => {
    expect(estadoCuentaAnticipo({ ...base, payee_clabe: null })).toBe('efectivo');
    expect(estadoCuentaAnticipo({ ...base, payee_clabe: null, tiene_cotizacion: false })).toBe('sin_dato');
  });
});

describe('[PGP.129] anticiposDelDia — lo que el Calendario ofrece en un día (D13)', () => {
  const s = (fecha_deseada: string | null, etapa: 'por_programar' | 'programado' = 'por_programar', disponible = 1000) => ({ fecha_deseada, etapa, disponible });
  const HOY = '2026-11-17';
  it('el día muestra lo pedido para ese día y nada más', () => {
    const r = anticiposDelDia([s('2026-11-18'), s('2026-11-19'), s('2026-11-16')], '2026-11-18', HOY);
    expect(r.map((x) => x.fecha_deseada)).toEqual(['2026-11-18']);
    expect(r[0].atrasado).toBe(false);
  });
  it('HOY también trae lo pedido para un día pasado que nadie programó, marcado atrasado', () => {
    const r = anticiposDelDia([s('2026-11-17'), s('2026-11-14')], HOY, HOY);
    expect(r.map((x) => [x.fecha_deseada, x.atrasado])).toEqual([['2026-11-14', true], ['2026-11-17', false]]);
  });
  it('⛔ NEGATIVA — lo ya programado, lo que no tiene nada que programar o no tiene día no se ofrece', () => {
    expect(anticiposDelDia([s(HOY, 'programado'), s(HOY, 'por_programar', 0), s(null)], HOY, HOY)).toEqual([]);
  });
});

describe('[PGP.128] faltaCuentaParaTransferirAnticipo — sólo a la cuenta aprobada de su cotización (D12)', () => {
  const C = '012180001234567899';
  it('un pago sin anticipos no se toca', () => {
    expect(faltaCuentaParaTransferirAnticipo({ clabesDeAnticipos: [], cuentaElegida: null })).toBeNull();
  });
  it('⛔ con anticipo y sin cuenta del catálogo (CLABE tecleada a mano) no se transfiere', () => {
    expect(faltaCuentaParaTransferirAnticipo({ clabesDeAnticipos: [C], cuentaElegida: null })).toMatch(/cuenta aprobada por Dirección \(la de su cotización, CLABE terminación 7899\)/);
  });
  it('⛔ con una cuenta aprobada que NO es la de la cotización tampoco; con la suya, sí', () => {
    expect(faltaCuentaParaTransferirAnticipo({ clabesDeAnticipos: [C], cuentaElegida: { clabe: '072180009999999993' } })).toMatch(/no es la de la cotización/);
    expect(faltaCuentaParaTransferirAnticipo({ clabesDeAnticipos: [C], cuentaElegida: { clabe: C } })).toBeNull();
  });
  it('un anticipo de antes (sin CLABE) pide igual una cuenta aprobada, la que sea', () => {
    expect(faltaCuentaParaTransferirAnticipo({ clabesDeAnticipos: [null], cuentaElegida: null })).toMatch(/cuenta aprobada/);
    expect(faltaCuentaParaTransferirAnticipo({ clabesDeAnticipos: [null], cuentaElegida: { clabe: C } })).toBeNull();
  });
  it('⛔ dos anticipos con CLABE distintas en un mismo pago se separan', () => {
    expect(faltaCuentaParaTransferirAnticipo({ clabesDeAnticipos: [C, '072180009999999993'], cuentaElegida: { clabe: C } })).toMatch(/separados/);
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

describe('[PGP.126] cancelar un pedido de anticipo', () => {
  const cand = (folio: string, fecha: string) => ({ folio, fecha, importe: 5000, remanente: 5000 });
  it('⛔ NEGATIVA — un pedido cancelado no toma candidato: el vivo, aunque sea más nuevo, se queda con su X-D-60', () => {
    const cs = [cand('0000001', '2026-11-10')];
    const m = parearSolicitudes([
      { obligation_id: 'viejo', proveedor: 'CA001', sucursal: '00', creado: '2026-11-09', candidatos: cs, estado_obligacion: 'cancelled' },
      { obligation_id: 'vivo', proveedor: 'CA001', sucursal: '00', creado: '2026-11-10', candidatos: cs, estado_obligacion: 'pending' },
    ]);
    expect(m.get('vivo')?.kepler?.folio).toBe('0000001');
    expect(m.get('viejo')).toEqual({ kepler: null, posibles: 0 });
  });
  it('separa el motivo de la razón de la cancelación (la marca del servidor)', () => {
    expect(partirMotivo('temporada')).toEqual({ motivo: 'temporada', cancelacion: null });
    expect(partirMotivo(`temporada\n${MARCA_CANCELADO}ya no lo pide`)).toEqual({ motivo: 'temporada', cancelacion: 'ya no lo pide' });
    expect(partirMotivo(MARCA_CANCELADO + 'sin motivo previo')).toEqual({ motivo: null, cancelacion: 'sin motivo previo' });
    expect(partirMotivo(null)).toEqual({ motivo: null, cancelacion: null });
  });
  it('⛔ sólo se cancela lo que no tiene pago, y con razón', () => {
    expect(faltaCancelarAnticipo({ etapa: 'por_programar' }, 'ya no se necesita')).toBeNull();
    expect(faltaCancelarAnticipo({ etapa: 'por_programar' }, '  ')).toMatch(/por qué/);
    expect(faltaCancelarAnticipo({ etapa: 'programado' }, 'ya no se necesita')).toMatch(/quítalo primero/);
    for (const e of ['pagado', 'en_kepler', 'aplicado'] as const) expect(faltaCancelarAnticipo({ etapa: e }, 'ya no se necesita')).toMatch(/Ya se pagó/);
    expect(faltaCancelarAnticipo({ etapa: 'cancelado' }, 'otra vez')).toMatch(/Ya está cancelado/);
  });
});

describe('[PGP.143] anticiposDeOc — la OC de Compras muestra sus anticipos', () => {
  const oc = (sucursal: string, folio: string) => ({ sucursal, serie: '1', folio });
  const a = (monto: number, ocs: ReturnType<typeof oc>[], etapa: 'por_programar' | 'pagado' | 'cancelado' = 'por_programar') => ({ monto, ocs, etapa });
  it('junta los de esa OC y suma su importe', () => {
    const r = anticiposDeOc([a(1000, [oc('03', '0000101')]), a(500.5, [oc('03', '0000101')], 'pagado'), a(9, [oc('03', '0000999')])], '03', '0000101');
    expect(r.filas.map((f) => f.anticipo.monto)).toEqual([1000, 500.5]);
    expect(r.total).toBe(1500.5);
  });
  it('⛔ NEGATIVA — el mismo folio en OTRA sucursal no es esa OC, y el cancelado no cuenta', () => {
    const r = anticiposDeOc([a(1000, [oc('08', '0000101')]), a(700, [oc('03', '0000101')], 'cancelado')], '03', '0000101');
    expect(r).toEqual({ filas: [], total: 0 });
  });
  it('el pedido sobre dos OC sale en las dos con su importe entero, y dice con cuál más va', () => {
    const doble = a(3000, [oc('03', '0000101'), oc('03', '0000102')]);
    expect(anticiposDeOc([doble], '03', '0000101').filas[0].otras).toEqual(['0000102']);
    expect(anticiposDeOc([doble], '03', '0000102')).toMatchObject({ total: 3000, filas: [{ otras: ['0000101'] }] });
  });
  it('el pedido de antes de PGP.127 (sin OC de Kepler) no se pega a ninguna', () => {
    expect(anticiposDeOc([{ monto: 10, ocs: null, etapa: 'por_programar' as const }], '03', '0000101').total).toBe(0);
  });
  it('cada etapa tiene su palabra', () => {
    expect(Object.keys(ETAPA_ANTICIPO_TEXTO).sort()).toEqual(['aplicado', 'cancelado', 'en_kepler', 'pagado', 'por_programar', 'programado']);
  });
});

describe('[PGP.144] embudoAnticipos — de la solicitud de Compras al anticipo aplicado en Kepler', () => {
  const HOY = '2026-11-17';
  type E = 'por_programar' | 'programado' | 'pagado' | 'en_kepler' | 'aplicado' | 'cancelado';
  const r = (etapa: E, monto: number, f: { creado?: string; programado_dia?: string | null; cubierto_el?: string | null; kepler?: { fecha: string } | null } = {}) => ({
    etapa, monto, creado: f.creado ?? '2026-11-10', programado_dia: f.programado_dia ?? null, cubierto_el: f.cubierto_el ?? null, kepler: f.kepler ?? null,
  });
  const ROWS = [
    r('por_programar', 100, { creado: '2026-11-07' }),            // 10 días sin programar
    r('por_programar', 50, { creado: '2026-11-15' }),
    r('programado', 200, { programado_dia: '2026-11-20' }),        // su día no llega: 0
    r('pagado', 300, { cubierto_el: '2026-11-11' }),               // 6 días cubierto sin X-D-60
    r('en_kepler', 400, { kepler: { fecha: '2026-11-01' } }),
    r('aplicado', 500),
    r('cancelado', 999),
  ];
  it('cada paso cuenta a los que LLEGARON y a los que se quedaron AHÍ, con el más viejo', () => {
    const { pasos, cancelados } = embudoAnticipos(ROWS, HOY);
    expect(pasos.map((p) => [p.paso, p.llegaron.n, p.llegaron.monto, p.aqui.n, p.aqui.masViejo])).toEqual([
      ['por_programar', 6, 1550, 2, 10],
      ['programado', 4, 1400, 1, 0],
      ['pagado', 3, 1200, 1, 6],
      ['en_kepler', 2, 900, 1, 16],
      ['aplicado', 1, 500, 1, null],
    ]);
    expect(pasos.map((p) => p.pct)).toEqual([100, 66.7, 50, 33.3, 16.7]);
    expect(cancelados).toEqual({ n: 1, monto: 999 });
  });
  it('⛔ NEGATIVA — el cancelado sale del embudo: no infla «Solicitado» ni ningún paso', () => {
    const { pasos } = embudoAnticipos([r('cancelado', 999)], HOY);
    expect(pasos.every((p) => p.llegaron.n === 0 && p.aqui.n === 0)).toBe(true);
  });
  it('⛔ NEGATIVA — sin solicitudes no hay porcentajes (no se pinta 0 %)', () => {
    expect(embudoAnticipos([], HOY).pasos.every((p) => p.pct === null)).toBe(true);
  });
  it('⛔ NEGATIVA — un cubierto sin fecha de pago no se inventa «0 días»', () => {
    expect(diasEnEtapa(r('pagado', 1, { cubierto_el: null }), HOY)).toBeNull();
    expect(embudoAnticipos([r('pagado', 1, { cubierto_el: null })], HOY).pasos[2].aqui.masViejo).toBeNull();
  });
  it('programado cuenta atraso sólo cuando su día ya pasó', () => {
    expect(diasEnEtapa(r('programado', 1, { programado_dia: '2026-11-20' }), HOY)).toBe(0);
    expect(diasEnEtapa(r('programado', 1, { programado_dia: '2026-11-14' }), HOY)).toBe(3);
  });
  it('las palabras de Francisco: «Solicitado» y «Cubierto»', () => {
    expect(ETAPA_ANTICIPO_TEXTO.por_programar).toBe('Solicitado');
    expect(ETAPA_ANTICIPO_TEXTO.pagado).toBe('Cubierto');
  });
});
