/**
 * `[GP.1]` Pruebas del motor del tablero de pedidos del almacén.
 *
 * Los casos salen de pedidos REALES leídos en prod el 2026-10-06:
 *  · `UD4001-0000367` (suc 08, sucursal → TI009 Morelia Madero): ticket 07:43, en `CHECADO` a las
 *    09:41 → lleva ~2 h abierto.
 *  · `UD4001-0002781` (suc 01, RUTA 21): `EMBARCADO` → ya no cuenta antigüedad.
 * Y las pruebas negativas: sin hora NO se inventa una antigüedad (ADR-056), y el filtro de
 * estatus NO mueve los conteos de los botones.
 */
import type { WarehouseOrderRow } from '@megadulces/contracts';
import { armarRespuesta, destinoDe, horasAbierto, LIMITE_ITEMS, ordenEstatus, ordenLista, paginaDe, PaginaInvalida, periodo, PeriodoInvalido, relojMx, sinImportes } from './warehouse-orders.engine';

const fila = (over: Partial<WarehouseOrderRow>): WarehouseOrderRow => ({
  clave: '01-1-0002781', sucursal: '01', sucursal_nombre: 'Padre Hidalgo', serie: 1, folio: '0002781',
  documento: 'UD4001-0002781', fecha: '2026-10-05', hora: '18:10', origen: 'SUCURSAL', estatus: 'EMBARCADO', estatus_kepler: 'EMBARCADO',
  cliente_code: 'RUTA 21', destino_nombre: 'R.D. 21 PH Urbano Olivares Victorino', destino_ciudad: 'Santa Ana Pacueco',
  vendedor_code: '00021', vendedor_nombre: null, renglones: 102, volumen: [{ unidad: 'PAQ', cantidad: 164 }], importe: 22591.35, guia: '0001644',
  transporte: '00013', chofer: '00014', resp_surtido: '06', resp_checado: '03', resp_embarque: '02',
  horas_abierto: null, etapa: 'embarcado', etapa_fuente: 'kepler', desfase: null, order_id: null, ...over,
});
const ALCANCE = { todas: true, sucursales: [] };
const SIN_FILTRO = { estatus: [], etapa: [], origen: null, sucursal: null, q: null, preventa: false };

describe('[GP.1] periodo', () => {
  it('sin nada = el mes en curso completo (hora de México)', () => {
    expect(periodo({}, '2026-10-06')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });
  it('mes explícito, incluido febrero bisiesto', () => {
    expect(periodo({ month: '2028-02' }, '2026-10-06')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
  it('from+to mandan sobre month', () => {
    expect(periodo({ month: '2026-09', from: '2026-10-01', to: '2026-10-06' }, '2026-10-06')).toEqual({ from: '2026-10-01', to: '2026-10-06' });
  });
  it('rango incompleto o invertido es error, no un default silencioso', () => {
    expect(() => periodo({ from: '2026-10-01' }, '2026-10-06')).toThrow(PeriodoInvalido);
    expect(() => periodo({ from: '2026-10-06', to: '2026-10-01' }, '2026-10-06')).toThrow(PeriodoInvalido);
  });
});

describe('[GP.1] antigüedad', () => {
  const reloj = { fecha: '2026-10-06', minutos: 9 * 60 + 41 };
  it('pedido 367: ticket 07:43, consultado 09:41 → 2 h', () => {
    expect(horasAbierto('2026-10-06', '07:43', 'CHECADO', reloj)).toBe(2);
  });
  it('cruza la medianoche: ayer 18:10 → hoy 09:41 = 15.5 h', () => {
    expect(horasAbierto('2026-10-05', '18:10', 'AUTORIZADO', reloj)).toBe(15.5);
  });
  it('EMBARCADO no cuenta antigüedad', () => {
    expect(horasAbierto('2026-10-05', '18:10', 'EMBARCADO', reloj)).toBeNull();
  });
  it('[GP.10.0] un CANCELADO no cuenta antigüedad: no espera a nadie', () => {
    expect(horasAbierto('2026-10-05', '18:10', 'CANCELADO', reloj)).toBeNull();
  });
  it('NEGATIVA: sin hora no se inventa una medianoche', () => {
    expect(horasAbierto('2026-10-05', null, 'AUTORIZADO', reloj)).toBeNull();
    expect(horasAbierto('2026-10-05', '', 'AUTORIZADO', reloj)).toBeNull();
  });
  it('relojMx usa la hora de México, no la del servidor', () => {
    // 2026-10-06 15:41 UTC = 09:41 en México (UTC-6, sin horario de verano).
    expect(relojMx(new Date('2026-10-06T15:41:00Z'))).toEqual({ fecha: '2026-10-06', minutos: 9 * 60 + 41 });
  });
});

describe('[GP.1] filtros y conteos', () => {
  const rows = [
    fila({}),
    fila({ clave: '08-1-0000367', sucursal: '08', folio: '0000367', documento: 'UD4001-0000367', estatus: 'CHECADO', renglones: 15, importe: 13369.96, horas_abierto: 2 }),
    fila({ clave: '01-1-0002790', folio: '0002790', documento: 'UD4001-0002790', origen: 'TELEMARK', estatus: 'AUTORIZADO', renglones: 14, importe: 1000, horas_abierto: 5 }),
    fila({ clave: '01-1-0002791', folio: '0002791', documento: 'UD4001-0002791', origen: 'TELEMARK', estatus: 'AUTORIZADO', renglones: 9, importe: 500, horas_abierto: 30 }),
  ];
  const ahora = new Date('2026-10-06T15:41:00Z');
  const per = { from: '2026-10-01', to: '2026-10-31' };

  it('los conteos traen los 5 estatus en orden, aunque alguno esté en cero', () => {
    const r = armarRespuesta(rows, SIN_FILTRO, per, ALCANCE, ahora);
    expect(r.conteos.map((c) => c.estatus)).toEqual(['CREADO', 'AUTORIZADO', 'SURTIDO', 'CHECADO', 'EMBARCADO']);
    expect(r.conteos.find((c) => c.estatus === 'AUTORIZADO')).toEqual({ estatus: 'AUTORIZADO', pedidos: 2, renglones: 23, mas_antiguo_horas: 30 });
  });

  it('NEGATIVA: filtrar por estatus cambia la lista pero NO los conteos de los botones', () => {
    const todo = armarRespuesta(rows, SIN_FILTRO, per, ALCANCE, ahora);
    const solo = armarRespuesta(rows, { ...SIN_FILTRO, estatus: ['CHECADO'] }, per, ALCANCE, ahora);
    expect(solo.items.map((i) => i.folio)).toEqual(['0000367']);
    expect(solo.conteos).toEqual(todo.conteos);
    expect(solo.totales).toMatchObject({ pedidos: 1, renglones: 15, importe: 13369.96, mas_antiguo_horas: 2 });
  });

  it('origen y sucursal sí mueven los conteos', () => {
    const r = armarRespuesta(rows, { ...SIN_FILTRO, origen: 'TELEMARK' }, per, ALCANCE, ahora);
    expect(r.totales.pedidos).toBe(2);
    expect(r.conteos.find((c) => c.estatus === 'EMBARCADO')?.pedidos).toBe(0);
    const s = armarRespuesta(rows, { ...SIN_FILTRO, sucursal: '08' }, per, ALCANCE, ahora);
    expect(s.items.map((i) => i.folio)).toEqual(['0000367']);
  });

  it('la búsqueda encuentra por folio, cliente o ciudad', () => {
    expect(armarRespuesta(rows, { ...SIN_FILTRO, q: '367' }, per, ALCANCE, ahora).items).toHaveLength(1);
    expect(armarRespuesta(rows, { ...SIN_FILTRO, q: 'pacueco' }, per, ALCANCE, ahora).items).toHaveLength(4);
  });

  it('un estatus que Kepler traiga nuevo no se pierde: va al final y se lista', () => {
    const r = armarRespuesta([...rows, fila({ clave: 'x', estatus: 'EN RUTA', estatus_kepler: 'EN RUTA' })], SIN_FILTRO, per, ALCANCE, ahora);
    expect(r.conteos[r.conteos.length - 1]).toMatchObject({ estatus: 'EN RUTA', pedidos: 1 });
    expect(r.items.some((i) => i.estatus === 'EN RUTA')).toBe(true);
    expect(ordenEstatus('EN RUTA', 'CREADO')).toBeGreaterThan(0);
  });
});

/**
 * `[GP.10.0]` Kepler cancela con `c43 = 'C'` (importe $0, renglones borrados) y CONSERVA el `c11`.
 * Caso real, 2026-11-13: `00|0001170` (CEDIS, 17-oct) sigue `SURTIDO` en `c11`, con $0 y sin renglones.
 */
describe('[GP.10.0] los cancelados no son trabajo pendiente', () => {
  const ahora = new Date('2026-11-13T22:00:00Z');
  const per = { from: '2026-11-01', to: '2026-11-30' };
  const vivo = fila({
    clave: '00-1-0001171', sucursal: '00', folio: '0001171', documento: 'UD4001-0001171',
    estatus: 'SURTIDO', estatus_kepler: 'SURTIDO', renglones: 12, importe: 4000, horas_abierto: 40,
  });
  const cancelado = fila({
    clave: '00-1-0001170', sucursal: '00', folio: '0001170', documento: 'UD4001-0001170',
    estatus: 'CANCELADO', estatus_kepler: 'SURTIDO', renglones: 0, importe: 0, horas_abierto: null,
  });
  const rows = [vivo, cancelado];

  it('«Todos» no lista al cancelado ni lo suma a los totales', () => {
    const r = armarRespuesta(rows, SIN_FILTRO, per, ALCANCE, ahora);
    expect(r.items.map((i) => i.folio)).toEqual(['0001171']);
    expect(r.totales).toMatchObject({ pedidos: 1, renglones: 12, importe: 4000, mas_antiguo_horas: 40 });
  });

  it('NEGATIVA: el cancelado NO cuenta en el botón de su estatus viejo', () => {
    const r = armarRespuesta(rows, SIN_FILTRO, per, ALCANCE, ahora);
    expect(r.conteos.find((c) => c.estatus === 'SURTIDO')?.pedidos).toBe(1);
  });

  it('tiene su propio botón, al final, y se ve eligiéndolo (con el estatus que tenía en Kepler)', () => {
    const r = armarRespuesta(rows, SIN_FILTRO, per, ALCANCE, ahora);
    expect(r.conteos[r.conteos.length - 1]).toEqual({ estatus: 'CANCELADO', pedidos: 1, renglones: 0, mas_antiguo_horas: null });
    const solo = armarRespuesta(rows, { ...SIN_FILTRO, estatus: ['CANCELADO'] }, per, ALCANCE, ahora);
    expect(solo.items.map((i) => [i.folio, i.estatus_kepler])).toEqual([['0001170', 'SURTIDO']]);
    expect(solo.totales.pedidos).toBe(1);
  });

  it('sin cancelados en el periodo no aparece un botón vacío', () => {
    const r = armarRespuesta([vivo], SIN_FILTRO, per, ALCANCE, ahora);
    expect(r.conteos.some((c) => c.estatus === 'CANCELADO')).toBe(false);
  });
});

/** `[GP.10.3]` La consola junta Kepler y preventa, y cuenta y filtra por ETAPA de almacén. */
describe('[GP.10.3] etapa de almacén y preventa', () => {
  const ahora = new Date('2026-11-13T22:00:00Z');
  const per = { from: '2026-11-01', to: '2026-11-30' };
  const k1 = fila({ clave: '01-1-0004001', folio: '0004001', estatus: 'AUTORIZADO', estatus_kepler: 'AUTORIZADO', etapa: 'surtido', etapa_fuente: 'piso', desfase: 'piso_adelante', renglones: 10, importe: 1000 });
  const k2 = fila({ clave: '01-1-0004002', folio: '0004002', estatus: 'SURTIDO', estatus_kepler: 'SURTIDO', etapa: 'surtido', etapa_fuente: 'kepler', renglones: 5, importe: 500 });
  const pv = fila({ clave: '01-PD-PD-000900', folio: 'PD-000900', documento: 'PD-000900', origen: 'PREVENTA', estatus: null, estatus_kepler: null, etapa: 'surtiendo', etapa_fuente: 'piso', order_id: 'o-900', renglones: 7, importe: 300 });
  const pvCancelado = fila({ clave: '01-PD-PD-000901', folio: 'PD-000901', origen: 'PREVENTA', estatus: null, estatus_kepler: null, etapa: 'cancelado', etapa_fuente: 'piso', order_id: 'o-901', renglones: 0, importe: 0 });
  const rows = [k1, k2, pv, pvCancelado];
  const conPv = { ...SIN_FILTRO, preventa: true };

  it('conteos por etapa: el flujo completo en orden, con cuántos van desfasados; cancelado al final', () => {
    const r = armarRespuesta(rows, conPv, per, ALCANCE, ahora);
    expect(r.conteos_etapa.map((c) => c.etapa)).toEqual(['creado', 'autorizado', 'en_cola', 'surtiendo', 'surtido', 'checando', 'checado', 'embarcado', 'cancelado']);
    expect(r.conteos_etapa.find((c) => c.etapa === 'surtido')).toEqual({ etapa: 'surtido', pedidos: 2, con_desfase: 1 });
    expect(r.conteos_etapa.find((c) => c.etapa === 'surtiendo')?.pedidos).toBe(1);
  });

  it('NEGATIVA: la preventa NO entra a los conteos por estatus de Kepler (no inventa un «sin estatus»)', () => {
    const r = armarRespuesta(rows, conPv, per, ALCANCE, ahora);
    expect(r.conteos.some((c) => c.estatus === 'SIN ESTATUS')).toBe(false);
    expect(r.conteos.reduce((t, c) => t + c.pedidos, 0)).toBe(2);
  });

  it('«Todos» lista Kepler y preventa vivos; el preventa cancelado queda fuera', () => {
    const r = armarRespuesta(rows, conPv, per, ALCANCE, ahora);
    expect(r.items.map((i) => i.folio)).toEqual(['0004001', '0004002', 'PD-000900']);
    expect(r.totales).toMatchObject({ pedidos: 3, renglones: 22, importe: 1800, mas_antiguo_horas: null });
  });

  it('filtrar por etapa cambia la lista pero no los conteos; se combina con el estatus', () => {
    const todo = armarRespuesta(rows, conPv, per, ALCANCE, ahora);
    const surtido = armarRespuesta(rows, { ...conPv, etapa: ['surtido'] }, per, ALCANCE, ahora);
    expect(surtido.items.map((i) => i.folio)).toEqual(['0004001', '0004002']);
    expect(surtido.conteos_etapa).toEqual(todo.conteos_etapa);
    const ambos = armarRespuesta(rows, { ...conPv, etapa: ['surtido'], estatus: ['AUTORIZADO'] }, per, ALCANCE, ahora);
    expect(ambos.items.map((i) => i.folio)).toEqual(['0004001']);
  });

  it('el origen PREVENTA filtra sólo los PD-', () => {
    const r = armarRespuesta(rows, { ...conPv, origen: 'PREVENTA' }, per, ALCANCE, ahora);
    expect(r.items.map((i) => i.folio)).toEqual(['PD-000900']);
  });
});

describe('[MCP.3.2] sinImportes: lo que recibe el surtidor', () => {
  const ahora = new Date('2026-10-06T15:41:00Z');
  const per = { from: '2026-10-01', to: '2026-10-31' };
  const r = armarRespuesta(
    [fila({}), fila({ clave: '01-1-0002790', folio: '0002790', documento: 'UD4001-0002790', estatus: 'AUTORIZADO', importe: 1000 })],
    SIN_FILTRO, per, ALCANCE, ahora,
  );

  it('ningún importe viaja: ni por renglón ni en el total', () => {
    const s = sinImportes(r);
    expect(s.items.every((x) => x.importe === null)).toBe(true);
    expect(s.totales.importe).toBeNull();
    // null y no 0: "no lo puedes ver" no es "vale cero".
    expect(s.totales.importe).not.toBe(0);
  });

  it('lo que sí ve queda intacto: folio, cliente, conteos', () => {
    const s = sinImportes(r);
    expect(s.items.map((x) => x.documento)).toEqual(r.items.map((x) => x.documento));
    expect(s.items.map((x) => x.destino_nombre)).toEqual(r.items.map((x) => x.destino_nombre));
    expect(s.totales.pedidos).toBe(r.totales.pedidos);
    expect(s.conteos).toEqual(r.conteos);
  });

  it('no muta la respuesta original (la del tablero sigue con dinero)', () => {
    sinImportes(r);
    expect(r.totales.importe).toBeGreaterThan(0);
    expect(r.items.some((x) => x.importe !== null)).toBe(true);
  });
});

/**
 * `[GP.10.5]` La lista por páginas y en el orden de la fecha que pinta. Medido en prod el 2026-11-17
 * (mes en curso): 2,348 pedidos, 830 de preventa; la respuesta se topaba en 2,000 (1.40 MB) y la
 * preventa iba pegada al final, desde la posición 1,518: 348 no se veían.
 */
describe('[GP.10.5] página y orden de la lista', () => {
  const ahora = new Date('2026-11-17T20:00:00Z');
  const per = { from: '2026-11-01', to: '2026-11-30' };
  const conPv = { ...SIN_FILTRO, preventa: true };
  const k = (folio: string, fecha: string, hora: string | null, extra: Partial<WarehouseOrderRow> = {}) =>
    fila({ clave: `01-1-${folio}`, folio, documento: `UD4001-${folio}`, fecha, hora, estatus: 'AUTORIZADO', estatus_kepler: 'AUTORIZADO', etapa: 'autorizado', ...extra });
  const pv = (code: string, fecha: string) =>
    fila({ clave: `01-PD-${code}`, folio: code, documento: code, fecha, hora: null, origen: 'PREVENTA', estatus: null, estatus_kepler: null, etapa: 'autorizado', etapa_fuente: 'piso', order_id: `o-${code}` });

  it('la preventa se intercala por su fecha: no queda al final de los de Kepler', () => {
    // Así llegan del servicio: los de Kepler ya ordenados y la preventa pegada después.
    const rows = [k('0000003', '2026-11-17', '10:00'), k('0000002', '2026-11-16', '09:00'), k('0000001', '2026-11-15', '08:00'), pv('PD-1', '2026-11-16'), pv('PD-2', '2026-11-17')];
    const r = armarRespuesta(rows, conPv, per, ALCANCE, ahora);
    expect(r.items.map((i) => i.folio)).toEqual(['0000003', 'PD-2', '0000002', 'PD-1', '0000001']);
  });

  it('el mismo día: por hora, lo sin hora al final y lo empatado en el orden en que llegó', () => {
    const rows = [k('0000010', '2026-11-17', '08:00'), pv('PD-9', '2026-11-17'), k('0000011', '2026-11-17', '12:30'), k('0000012', '2026-11-17', '12:30')];
    expect([...rows].sort(ordenLista).map((i) => i.folio)).toEqual(['0000011', '0000012', '0000010', 'PD-9']);
  });

  it('con página llega sólo ese tramo y el total de todas; nada queda fuera', () => {
    const rows = Array.from({ length: 450 }, (_, i) => k(String(i).padStart(7, '0'), '2026-11-10', null));
    const p1 = armarRespuesta(rows, conPv, per, ALCANCE, ahora, { offset: 0, limit: 200 });
    const p3 = armarRespuesta(rows, conPv, per, ALCANCE, ahora, { offset: 400, limit: 200 });
    expect(p1.items).toHaveLength(200);
    expect(p3.items).toHaveLength(50);
    expect(p1.pagina).toEqual({ offset: 0, limit: 200, total: 450 });
    expect(p1.truncado).toBe(false);
    expect(p1.totales.pedidos).toBe(450);
    // Las tres páginas juntas son la lista entera, sin repetir ni saltar ninguno.
    const todas = [0, 200, 400].flatMap((o) => armarRespuesta(rows, conPv, per, ALCANCE, ahora, { offset: o, limit: 200 }).items.map((i) => i.clave));
    expect(new Set(todas).size).toBe(450);
  });

  it('NEGATIVA: sin página la respuesta es la de siempre (topada y avisada, sin `pagina`)', () => {
    const rows = Array.from({ length: LIMITE_ITEMS + 5 }, (_, i) => k(String(i).padStart(7, '0'), '2026-11-10', null));
    const r = armarRespuesta(rows, conPv, per, ALCANCE, ahora);
    expect(r.items).toHaveLength(LIMITE_ITEMS);
    expect(r.truncado).toBe(true);
    expect(r.pagina).toBeUndefined();
  });

  it('el más antiguo sin embarcar sale de TODO lo filtrado, no de la página', () => {
    const rows = [k('0000001', '2026-11-17', '10:00', { horas_abierto: 3 }), k('0000002', '2026-11-01', '10:00', { horas_abierto: 390 })];
    const r = armarRespuesta(rows, conPv, per, ALCANCE, ahora, { offset: 0, limit: 1 });
    expect(r.items.map((i) => i.folio)).toEqual(['0000001']);
    expect(r.totales.mas_antiguo_horas).toBe(390);
  });

  it('NEGATIVA: las sucursales del selector no dependen del filtro de sucursal ni de la página', () => {
    const rows = [k('0000001', '2026-11-17', '10:00'), fila({ clave: '08-1-0000367', sucursal: '08', sucursal_nombre: 'Morelia Madero', folio: '0000367', fecha: '2026-11-01' })];
    const r = armarRespuesta(rows, { ...conPv, sucursal: '01' }, per, ALCANCE, ahora, { offset: 0, limit: 1 });
    expect(r.items.every((i) => i.sucursal === '01')).toBe(true);
    expect(r.sucursales_periodo).toEqual([{ codigo: '01', nombre: 'Padre Hidalgo' }, { codigo: '08', nombre: 'Morelia Madero' }]);
  });
});

describe('[GP.10.5] paginaDe', () => {
  it('sin limit no hay página (la respuesta de siempre)', () => {
    expect(paginaDe({})).toBeNull();
    expect(paginaDe({ limit: '' })).toBeNull();
  });
  it('limit con o sin offset', () => {
    expect(paginaDe({ limit: '200' })).toEqual({ offset: 0, limit: 200 });
    expect(paginaDe({ limit: '200', offset: '400' })).toEqual({ offset: 400, limit: 200 });
  });
  it('NEGATIVA: lo mal escrito es error, no la página 1 por default', () => {
    expect(() => paginaDe({ offset: '200' })).toThrow(PaginaInvalida);
    expect(() => paginaDe({ limit: 'abc' })).toThrow(PaginaInvalida);
    expect(() => paginaDe({ limit: '200', offset: '-1' })).toThrow(PaginaInvalida);
    expect(() => paginaDe({ limit: '0' })).toThrow(PaginaInvalida);
    expect(() => paginaDe({ limit: '501' })).toThrow(PaginaInvalida);
  });
});

/**
 * `[GP.10.5]` D4: el total separado por destino. Medido en prod (noviembre, al 17): de $35.3 M de
 * pedidos de Kepler, $22.1 M eran traspasos a sucursal (`TI###`) y $2.05 M cargas a ruta (`RD`/`RUTA`).
 */
describe('[GP.10.5] D4 importe por destino', () => {
  it('clasifica por el cliente de Kepler: TI### traspaso, RD/RUTA carga, lo demás clientes', () => {
    expect(destinoDe('TI009')).toBe('traspaso_sucursal');
    expect(destinoDe('RD 502')).toBe('carga_ruta');
    expect(destinoDe('RUTA 21')).toBe('carga_ruta');
    expect(destinoDe('C3031')).toBe('clientes');
    expect(destinoDe(null)).toBe('clientes'); // preventa a un abarrote sin clave de Kepler
  });
  it('NEGATIVA: lo que sólo se parece no es traspaso ni ruta', () => {
    expect(destinoDe('TIENDA LUPITA')).toBe('clientes');
    expect(destinoDe('TI12')).toBe('clientes');
    expect(destinoDe('RDZ 1')).toBe('clientes');
  });
  it('las tres partes suman el total, y el traspaso ya no se cuenta como venta', () => {
    const per = { from: '2026-11-01', to: '2026-11-30' };
    const rows = [
      fila({ clave: 'a', cliente_code: 'TI004', importe: 1000.1 }),
      fila({ clave: 'b', cliente_code: 'RD 502', importe: 200.2 }),
      fila({ clave: 'c', cliente_code: 'C1121', importe: 30.3 }),
      fila({ clave: 'd', cliente_code: null, importe: 4.4 }),
    ];
    const r = armarRespuesta(rows, SIN_FILTRO, per, ALCANCE, new Date('2026-11-17T20:00:00Z'));
    expect(r.totales.importe_por_destino).toEqual({ clientes: 34.7, traspaso_sucursal: 1000.1, carga_ruta: 200.2 });
    const p = r.totales.importe_por_destino!;
    expect(Math.round((p.clientes + p.traspaso_sucursal + p.carga_ruta) * 100) / 100).toBe(r.totales.importe);
  });
  it('el surtidor no recibe ni el total ni sus partes', () => {
    const r = armarRespuesta([fila({ cliente_code: 'TI004' })], SIN_FILTRO, { from: '2026-11-01', to: '2026-11-30' }, ALCANCE, new Date());
    expect(sinImportes(r).totales.importe_por_destino).toBeNull();
  });
});
