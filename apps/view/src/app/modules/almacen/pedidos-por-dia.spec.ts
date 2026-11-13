import { deVendedor, etiquetaDia, pendientesDeOtrosDias, sumarDiasIso, vendedoresDe } from './pedidos-por-dia';

type Fila = { code: string; seller_name: string | null; fecha: string; pendiente: boolean; llegada: string };
const f = (code: string, seller_name: string | null, fecha: string, pendiente = true, llegada = '2026-11-12T15:00:00.000Z'): Fila =>
  ({ code, seller_name, fecha, pendiente, llegada });

describe('[MCP.24] las bandejas del surtidor y de la caja, un día a la vez', () => {
  const HOY = '2026-11-12';

  it('⭐ lo pendiente de otros días se cuenta por día (el más reciente primero); lo de hoy y lo cerrado no', () => {
    const filas = [
      f('PD-1', 'PRUEBA UNO', HOY),
      f('PD-2', 'PRUEBA UNO', '2026-11-11'),
      f('PD-3', 'PRUEBA DOS', '2026-11-11'),
      f('PD-4', 'PRUEBA DOS', '2026-09-28'),
      f('PD-5', 'PRUEBA UNO', '2026-11-11', false),
      f('PD-6', 'PRUEBA UNO', '2026-11-13'),
    ];
    expect(pendientesDeOtrosDias(filas, (x) => x.fecha, (x) => x.pendiente, HOY)).toEqual([
      { fecha: '2026-11-13', n: 1 },
      { fecha: '2026-11-11', n: 2 },
      { fecha: '2026-09-28', n: 1 },
    ]);
    // Control: la suma es todo lo pendiente menos lo de hoy.
    expect(filas.filter((x) => x.pendiente && x.fecha !== HOY).length).toBe(4);
  });

  it('prueba negativa: sin fecha o sin pendientes, no hay aviso', () => {
    expect(pendientesDeOtrosDias([f('PD-1', 'PRUEBA UNO', '')], (x) => x.fecha || null, () => true, HOY)).toEqual([]);
    expect(pendientesDeOtrosDias([f('PD-1', 'PRUEBA UNO', '2026-11-11', false)], (x) => x.fecha, (x) => x.pendiente, HOY)).toEqual([]);
  });

  it('las fechas se suman sin pasar por la zona horaria (fin de mes y de año)', () => {
    expect(sumarDiasIso('2026-11-01', -1)).toBe('2026-10-31');
    expect(sumarDiasIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(sumarDiasIso(HOY, 0)).toBe(HOY);
  });

  it('el día se nombra como lo dice la gente', () => {
    expect(etiquetaDia(HOY, HOY)).toBe('Hoy');
    expect(etiquetaDia('2026-11-11', HOY)).toBe('Ayer');
    expect(etiquetaDia('2026-11-13', HOY)).toBe('Mañana');
    expect(etiquetaDia('2026-11-10', HOY)).toBe('mar 10 nov');
    expect(etiquetaDia('2026-09-28', HOY)).toBe('lun 28 sep');
  });
});

describe('[MCP.24] elegir un vendedor', () => {
  const filas = [
    f('PD-3', 'PRUEBA DOS', '2026-11-12', true, '2026-11-12T16:00:00.000Z'),
    f('PD-1', 'PRUEBA UNO', '2026-11-12', true, '2026-11-12T15:00:00.000Z'),
    f('PD-2', 'PRUEBA UNO', '2026-11-12', true, '2026-11-12T17:00:00.000Z'),
    f('PD-4', null, '2026-11-12'),
  ];

  it('⭐ las opciones van en el orden de los encabezados, con cuántos pedidos; «Sin vendedor» al final', () => {
    expect(vendedoresDe(filas, (x) => x.llegada)).toEqual([
      { vendedor: 'PRUEBA UNO', n: 2 },
      { vendedor: 'PRUEBA DOS', n: 1 },
      { vendedor: 'Sin vendedor', n: 1 },
    ]);
  });

  it('elegir uno deja sólo los suyos; «Todos» (null) deja todo', () => {
    expect(deVendedor(filas, 'PRUEBA UNO').map((x) => x.code)).toEqual(['PD-1', 'PD-2']);
    expect(deVendedor(filas, 'Sin vendedor').map((x) => x.code)).toEqual(['PD-4']);
    expect(deVendedor(filas, null)).toHaveLength(4);
  });

  it('⭐ prueba negativa: un vendedor sin pedidos en ESTA lista da vacío, nunca los de todos', () => {
    // (Que la pantalla regrese a «Todos» cuando el vendedor ya no está lo prueban las specs de cada pantalla.)
    expect(deVendedor(filas, 'Carla')).toEqual([]);
    expect(deVendedor(filas.filter((x) => x.seller_name !== 'PRUEBA UNO'), 'PRUEBA UNO')).toEqual([]);
  });
});
