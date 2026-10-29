import { describe, expect, it } from 'vitest';
import { agruparObligaciones, allocationKey, fechaCorta, filasAgrupadas, obligationKey, sugerirArmado, type GroupableObligation } from './calendario-pagos-grupos';

describe('[TP.16.4] sugerirArmado — lo vencido, un pago por proveedor y sucursal, hasta el disponible', () => {
  const g = (id: string, suc: string, due: string, amt: number, sup = 'GONAC') => ({ ...ob(id, sup, due, amt), branch_code: suc });
  // El ejemplo de Francisco: Gonac 3 facturas en 08, 2 en 01, 1 en 06.
  const lista = [
    g('8a', '08', '2026-10-13', 16040.74), g('8b', '08', '2026-10-15', 48210.5), g('8c', '08', '2026-10-20', 22875),
    g('1a', '01', '2026-10-14', 35640.2), g('1b', '01', '2026-10-21', 18300), g('6a', '06', '2026-10-16', 27455.8),
    g('r', '08', '2026-10-06', 1600, 'RICO PAY'),
  ];

  it('el viernes 16: Gonac sale en 3 pagos (08, 01, 06), sólo con lo vencido; lo más viejo primero', () => {
    const s = sugerirArmado(lista, '2026-10-16', 1e9);
    expect(s.map((x) => `${x.beneficiary}·${x.branch}·${x.items.map((i) => i.obligation_id).join('+')}`)).toEqual([
      'RICO PAY·08·r', 'GONAC·08·8a+8b', 'GONAC·01·1a', 'GONAC·06·6a',
    ]);
    expect(s.every((x) => x.fits)).toBe(true);
  });

  it('no adelanta lo que vence después del día SI no gana descuento (8c y 1b se quedan)', () => {
    const ids = sugerirArmado(lista, '2026-10-16', 1e9).flatMap((x) => x.items.map((i) => i.obligation_id));
    expect(ids).not.toContain('8c');
    expect(ids).not.toContain('1b');
  });

  it('llena hasta el disponible: lo que no cabe queda marcado', () => {
    const s = sugerirArmado(lista, '2026-10-16', 70000);
    expect(s.map((x) => x.fits)).toEqual([true, true, false, false]);
  });
});

/**
 * `[PGP.38]` **Lo que NO vence todavía pero pierde descuento si se espera.**
 *
 * Medido contra prod el 2026-10-29: de los $2,427,564 de pronto pago con ventana abierta sobre la
 * deuda viva, **$1,522,587 (62.7 %) estaba en facturas que la propuesta nunca ofrecía** porque
 * todavía no vencen — y una factura dentro de su ventana, por definición, todavía no vence.
 *
 * ⭐ Cada caso de abajo tiene su CONTROL NEGATIVO al lado: la misma factura sin el motivo no entra.
 * Un gate sin prueba negativa es una intención.
 */
describe('[PGP.38] sugerirArmado — adelanta SÓLO lo que gana descuento, y lo dice', () => {
  /** Factura que vence el 30, con ventana de pronto pago que cierra el `limite`. */
  const pp = (id: string, limite: string | null, beneficio: number) => ({
    ...ob(id, 'MONDELEZ', '2026-10-30', 100000),
    branch_code: '00', pronto_fecha_limite: limite, pronto_beneficio: beneficio,
  });

  it('entra aunque NO haya vencido: su ventana cierra dentro de los 5 días', () => {
    const s = sugerirArmado([pp('m', '2026-10-19', 5100)], '2026-10-16', 1e9);
    expect(s.map((x) => x.items.map((i) => i.obligation_id).join('+'))).toEqual(['m']);
    expect(s[0].motivo).toBe('pronto_pago');
    expect(s[0].gana).toBe(5100);
  });

  it('CONTROL NEGATIVO · misma factura, misma fecha, pero beneficio 0 → NO entra', () => {
    expect(sugerirArmado([pp('m', '2026-10-19', 0)], '2026-10-16', 1e9)).toEqual([]);
  });

  it('CONTROL NEGATIVO · gana mucho pero su ventana cierra en 30 días → NO entra todavía', () => {
    expect(sugerirArmado([pp('m', '2026-11-15', 99999)], '2026-10-16', 1e9)).toEqual([]);
  });

  it('CONTROL NEGATIVO · su ventana YA cerró ayer → NO entra: adelantarse ya no gana nada', () => {
    expect(sugerirArmado([pp('m', '2026-10-15', 5100)], '2026-10-16', 1e9)).toEqual([]);
  });

  it('CONTROL NEGATIVO · sin ventana medida (null) → NO entra', () => {
    expect(sugerirArmado([pp('m', null, 5100)], '2026-10-16', 1e9)).toEqual([]);
  });

  it('lo VENCIDO va primero aunque el adelanto gane más: si no alcanza, se recorta el adelanto', () => {
    const vencida = { ...ob('v', 'GONAC', '2026-10-10', 60000), branch_code: '01' };
    const s = sugerirArmado([pp('m', '2026-10-19', 90000), vencida], '2026-10-16', 70000);
    expect(s.map((x) => `${x.items[0].obligation_id}·${x.motivo}·${x.fits}`)).toEqual([
      'v·vencida·true', 'm·pronto_pago·false',
    ]);
  });

  it('un grupo con UNA vencida y otra por descuento se marca «vencida», y suma lo que gana', () => {
    const vieja = { ...ob('a', 'MONDELEZ', '2026-10-10', 20000), branch_code: '00' };
    const s = sugerirArmado([vieja, pp('b', '2026-10-19', 5100)], '2026-10-16', 1e9);
    expect(s).toHaveLength(1);
    expect(s[0].motivo).toBe('vencida');
    expect(s[0].gana).toBe(5100);
    expect(s[0].items.map((i) => i.obligation_id).sort()).toEqual(['a', 'b']);
  });

});

describe('[TP.16.4] revisión independiente — los casos que separaban front y back', () => {
  it('dos proveedores que se llaman igual NO se juntan (manda el id, como en el backend)', () => {
    const a = { ...ob('a', 'DULCES SA', '2026-10-10', 1), obligation_source: 'supplier_payable', payee_id: 'p1', branch_code: '01' };
    const b = { ...ob('b', 'DULCES SA', '2026-10-10', 1), obligation_source: 'supplier_payable', payee_id: 'p2', branch_code: '01' };
    expect(agruparObligaciones([a, b])).toHaveLength(2);
  });
  it('gasto «ACME» y «Acme » es el mismo beneficiario (nombre normalizado, como en el backend)', () => {
    expect(agruparObligaciones([ob('a', 'ACME', null, 1, 'gasto'), ob('b', 'Acme ', null, 1, 'gasto')])).toHaveLength(1);
  });
  it('sucursal vacía o con espacios = sin sucursal / la misma sucursal', () => {
    expect(obligationKey({ classification: 'x', beneficiary: 'A', branch_code: '' })).toBe(obligationKey({ classification: 'x', beneficiary: 'A', branch_code: null }));
    expect(obligationKey({ classification: 'x', beneficiary: 'A', branch_code: '08 ' })).toBe(obligationKey({ classification: 'x', beneficiary: 'A', branch_code: '08' }));
  });
  it('una factura RENEGOCIADA a después del día no entra al armado aunque su fecha original ya pasó', () => {
    const reneg = { ...ob('r', 'GONAC', '2026-10-01', 100), negotiated_date: '2026-10-30', branch_code: '08' };
    expect(sugerirArmado([reneg], '2026-10-16', 1e9)).toHaveLength(0);
  });
});

describe('[TP.16.4] obligationKey / allocationKey — a qué pago se suma una factura', () => {
  it('misma clasificación, proveedor y sucursal → misma llave', () => {
    const o = { classification: 'proveedor_mercancia', beneficiary: 'GONAC', branch_code: '08' };
    expect(allocationKey({ classification: 'proveedor_mercancia', items: [{ beneficiary: 'GONAC', branch_code: '08' }] })).toBe(obligationKey(o));
  });
  it('otra sucursal → otra llave', () => {
    expect(obligationKey({ classification: 'proveedor_mercancia', beneficiary: 'GONAC', branch_code: '01' }))
      .not.toBe(obligationKey({ classification: 'proveedor_mercancia', beneficiary: 'GONAC', branch_code: '08' }));
  });
});

const ob = (id: string, beneficiary: string, due: string | null, amount: number | string, classification = 'proveedor_mercancia', critical = false): GroupableObligation => ({
  obligation_id: id, beneficiary, classification, concept: `Fact. ${id}`,
  original_due_date: due, available_amount: amount, is_critical: critical,
});

describe('[TP.16.2] agruparObligaciones — una fila por proveedor con sus facturas', () => {
  const lista = [
    ob('f1', 'FERRERO', '2026-10-27T06:00:00.000Z', '139876.62'),
    ob('g1', 'GONAC', '2026-10-13T06:00:00.000Z', 16040.74),
    ob('f2', 'FERRERO', '2026-10-20T06:00:00.000Z', 100),
    ob('r1', 'RICO PAY', null, 1600),
  ];

  it('junta las facturas del mismo proveedor y suma su disponible (los numeric llegan como texto)', () => {
    const g = agruparObligaciones(lista).find((x) => x.beneficiary === 'FERRERO')!;
    expect(g.count).toBe(2);
    expect(g.total).toBeCloseTo(139976.62, 2);
    expect(g.firstDue).toBe('2026-10-20');
    expect(g.items.map((i) => i.obligation_id)).toEqual(['f2', 'f1']);
  });

  it('ordena por el primer vencimiento; sin fecha al final', () => {
    expect(agruparObligaciones(lista).map((g) => g.beneficiary)).toEqual(['GONAC', 'FERRERO', 'RICO PAY']);
  });

  it('no mezcla el mismo nombre en dos clasificaciones (un pago no puede juntarlas)', () => {
    const gs = agruparObligaciones([ob('a', 'CFE', '2026-10-20', 10, 'gasto'), ob('b', 'CFE', '2026-10-21', 20, 'proveedor_mercancia')]);
    expect(gs).toHaveLength(2);
    expect(gs.every((g) => g.count === 1)).toBe(true);
  });

  it('[TP.16.3] el mismo proveedor en 3 sucursales da 3 grupos, juntos y por sucursal', () => {
    const b = (id: string, suc: string | null, due: string) => ({ ...ob(id, 'GONAC', due, 10), branch_code: suc });
    const gs = agruparObligaciones([
      b('a', '08', '2026-10-20'), b('b', '01', '2026-10-18'), b('c', '08', '2026-10-21'),
      ob('x', 'ABARROTES', '2026-10-19', 5), b('d', '06', '2026-10-25'), b('e', '01', '2026-10-30'),
    ]);
    expect(gs.map((g) => `${g.beneficiary}·${g.branch}·${g.count}`)).toEqual([
      'GONAC·01·2', 'GONAC·08·2', 'GONAC·06·1', 'ABARROTES·null·1',
    ]);
  });

  it('el grupo es crítico si alguna factura lo es', () => {
    const [g] = agruparObligaciones([ob('a', 'X', null, 1), ob('b', 'X', null, 1, 'proveedor_mercancia', true)]);
    expect(g.critical).toBe(true);
  });

  it('no pierde ni duplica facturas', () => {
    const ids = agruparObligaciones(lista).flatMap((g) => g.items.map((i) => i.obligation_id)).sort();
    expect(ids).toEqual(['f1', 'f2', 'g1', 'r1']);
  });
});

describe('[TP.16.2] filasAgrupadas — encabezado + facturas, salvo plegado', () => {
  const gs = agruparObligaciones([ob('f1', 'FERRERO', '2026-10-27', 1), ob('f2', 'FERRERO', '2026-10-20', 1), ob('g1', 'GONAC', '2026-10-13', 1)]);

  it('proveedor con una factura = UN renglón; con varias = encabezado + facturas', () => {
    expect(filasAgrupadas(gs, new Set()).map((r) => r.kind)).toEqual(['single', 'group', 'item', 'item']);
  });
  it('un proveedor plegado deja sólo su encabezado', () => {
    expect(filasAgrupadas(gs, new Set(['proveedor_mercancia|b:FERRERO|-'])).map((r) => r.kind)).toEqual(['single', 'group']);
  });
});

/**
 * `[PGP.10]` **La fecha de la columna «Vence» distingue el año — o $14 M se leen como del mes.**
 *
 * El caso real, medido contra prod el 2026-10-24: los dos renglones que el Calendario pone
 * primero son del **01/01/2025** por $8 M y $6 M, y se pintaban «1 ene». La auditoría los
 * encontró mirando la pantalla, no el código: en el fuente «1 ene» se ve perfectamente bien.
 */
describe('[PGP.10] fechaCorta', () => {
  const HOY = '2026-10-24';

  it('⛔ el caso real: un documento de 2025 NO se lee como uno de este año', () => {
    // El mismo día y mes, dos años distintos: lo que se pinta tiene que diferir.
    expect(fechaCorta('2025-01-01', HOY)).toBe('1 ene 25');
    expect(fechaCorta('2026-01-01', HOY)).toBe('1 ene');
  });

  it('una fecha de este año se queda corta: día y mes, sin ensanchar la columna', () => {
    expect(fechaCorta('2026-03-05', HOY)).toBe('5 mar');
  });

  it('una fecha de otro año lleva el año en DOS dígitos', () => {
    expect(fechaCorta('2025-01-01', HOY)).toBe('1 ene 25');
    expect(fechaCorta('2027-12-31', HOY)).toBe('31 dic 27');
  });

  it('sin fecha devuelve una raya, no «hoy» ni una cadena vacía', () => {
    expect(fechaCorta(null, HOY)).toBe('—');
  });

  it('⛔ no se corre un día por zona horaria: el 1 de enero es el 1, no el 31 de diciembre', () => {
    expect(fechaCorta('2025-01-01', HOY)).toContain('1 ene');
    expect(fechaCorta('2026-01-01', HOY)).toBe('1 ene');
  });

  it('acepta un ISO con hora y se queda con el día', () => {
    expect(fechaCorta('2025-01-01T06:00:00.000Z', HOY)).toBe('1 ene 25');
  });

  it('el año de corte es el de HOY, no uno fijo', () => {
    // Con el presente en 2025, el documento de 2025 ya no necesita año…
    expect(fechaCorta('2025-01-01', '2025-06-01')).toBe('1 ene');
    // …y el de 2026 sí.
    expect(fechaCorta('2026-01-01', '2025-06-01')).toBe('1 ene 26');
  });
});
