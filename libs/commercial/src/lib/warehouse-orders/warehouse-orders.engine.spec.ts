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
import { armarRespuesta, horasAbierto, ordenEstatus, periodo, PeriodoInvalido, relojMx } from './warehouse-orders.engine';

const fila = (over: Partial<WarehouseOrderRow>): WarehouseOrderRow => ({
  clave: '01-1-0002781', sucursal: '01', sucursal_nombre: 'Padre Hidalgo', serie: 1, folio: '0002781',
  documento: 'UD4001-0002781', fecha: '2026-10-05', hora: '18:10', origen: 'SUCURSAL', estatus: 'EMBARCADO',
  cliente_code: 'RUTA 21', destino_nombre: 'R.D. 21 PH Urbano Olivares Victorino', destino_ciudad: 'Santa Ana Pacueco',
  vendedor_code: '00021', vendedor_nombre: null, renglones: 102, volumen: [{ unidad: 'PAQ', cantidad: 164 }], importe: 22591.35, guia: '0001644',
  transporte: '00013', chofer: '00014', resp_surtido: '06', resp_checado: '03', resp_embarque: '02',
  horas_abierto: null, ...over,
});
const ALCANCE = { todas: true, sucursales: [] };
const SIN_FILTRO = { estatus: [], origen: null, sucursal: null, q: null };

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
    expect(solo.totales).toEqual({ pedidos: 1, renglones: 15, importe: 13369.96 });
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

  it('un estatus que Kepler traiga nuevo no se pierde: va al final', () => {
    const r = armarRespuesta([...rows, fila({ clave: 'x', estatus: 'CANCELADO' })], SIN_FILTRO, per, ALCANCE, ahora);
    expect(r.conteos[r.conteos.length - 1]).toMatchObject({ estatus: 'CANCELADO', pedidos: 1 });
    expect(ordenEstatus('CANCELADO', 'CREADO')).toBeGreaterThan(0);
  });
});
