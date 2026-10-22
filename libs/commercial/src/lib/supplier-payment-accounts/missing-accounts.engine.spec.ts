import { repartirFaltantes, type FilaPagoPorBanco } from './missing-accounts.engine';

const RANGO = { dias: 120, desde: '2026-06-24', hasta: '2026-10-22' };

const fila = (o: Partial<FilaPagoPorBanco> & { proveedor_code: string; monto: number }): FilaPagoPorBanco => ({
  nombre: o.nombre ?? 'PROVEEDOR ' + o.proveedor_code,
  pagos: o.pagos ?? 1,
  ultimo_pago_date: o.ultimo_pago_date ?? '2026-10-20',
  ultimo_pago_monto: o.ultimo_pago_monto ?? o.monto,
  supplier_id: o.supplier_id === undefined ? 'sup-' + o.proveedor_code : o.supplier_id,
  tiene_cuenta: o.tiene_cuenta ?? false,
  ...o,
});

describe('[PGP.1] repartirFaltantes', () => {
  it('ordena por dinero y el acumulado llega a 100 cuando nadie tiene cuenta', () => {
    const r = repartirFaltantes(
      [fila({ proveedor_code: 'C1', monto: 60 }), fila({ proveedor_code: 'C2', monto: 30 }), fila({ proveedor_code: 'C3', monto: 10 })],
      RANGO,
    );
    expect(r.universo.monto_total).toBe(100);
    expect(r.universo.pct_monto_cubierto).toBe(0);
    expect(r.faltantes.map((f) => f.codigo)).toEqual(['C1', 'C2', 'C3']);
    expect(r.faltantes.map((f) => f.acumulado_pct)).toEqual([60, 90, 100]);
    // 60 no alcanza, 90 sí → el corte es el segundo renglón.
    expect(r.universo.corte_80pct).toBe(2);
  });

  it('⭐ el denominador NO se recorta: quien ya tiene cuenta sigue contando, y el acumulado arranca de la cobertura', () => {
    const r = repartirFaltantes(
      [
        fila({ proveedor_code: 'C1', monto: 70, tiene_cuenta: true }),
        fila({ proveedor_code: 'C2', monto: 20 }),
        fila({ proveedor_code: 'C3', monto: 10 }),
      ],
      RANGO,
    );
    expect(r.universo.monto_total).toBe(100);
    expect(r.universo.proveedores_con_cuenta).toBe(1);
    expect(r.universo.pct_monto_cubierto).toBe(70);
    // C2 vale 20 % del TOTAL (no el 66 % de lo que falta) y con él ya se cruza el 80 %.
    expect(r.faltantes.map((f) => f.pct_del_total)).toEqual([20, 10]);
    expect(r.faltantes.map((f) => f.acumulado_pct)).toEqual([90, 100]);
    expect(r.universo.corte_80pct).toBe(1);
  });

  it('declara al proveedor que no resuelve al catálogo en vez de perderlo', () => {
    const r = repartirFaltantes(
      [fila({ proveedor_code: 'C1', monto: 80 }), fila({ proveedor_code: 'XX', monto: 20, supplier_id: null })],
      RANGO,
    );
    expect(r.universo.proveedores_total).toBe(2);
    expect(r.universo.proveedores_sin_catalogo).toBe(1);
    expect(r.universo.monto_sin_catalogo).toBe(20);
    // No se puede abrir solicitud de alta sin `supplier_id`: no se lista como accionable…
    expect(r.faltantes).toHaveLength(1);
    // …pero su dinero sigue en el denominador, así que el acumulado NO miente diciendo 100 %.
    expect(r.faltantes[0].acumulado_pct).toBe(80);
    expect(r.faltantes.every((f) => f.supplier_id)).toBe(true);
  });

  it('sin pagos en la ventana: corte null y cero — ⛔ nunca un corte inventado', () => {
    const r = repartirFaltantes([], RANGO);
    expect(r.universo.proveedores_total).toBe(0);
    expect(r.universo.monto_total).toBe(0);
    expect(r.universo.corte_80pct).toBeNull();
    expect(r.universo.pct_monto_cubierto).toBe(0);
    expect(r.faltantes).toEqual([]);
  });

  it('todos sembrados: no quedan faltantes y la cobertura es 100 %', () => {
    const r = repartirFaltantes(
      [fila({ proveedor_code: 'C1', monto: 60, tiene_cuenta: true }), fila({ proveedor_code: 'C2', monto: 40, tiene_cuenta: true })],
      RANGO,
    );
    expect(r.faltantes).toEqual([]);
    expect(r.universo.pct_monto_cubierto).toBe(100);
    // ⚠️ El corte es `null` tanto acá como cuando no hay datos: se lee JUNTO a `pct_monto_cubierto`.
    expect(r.universo.corte_80pct).toBeNull();
  });

  it('el dinero se publica al centavo y las fechas en ISO, vengan como vengan del driver', () => {
    const r = repartirFaltantes(
      [fila({ proveedor_code: 'C1', monto: 10.005 as number, ultimo_pago_date: '2026-10-13T06:00:00.000Z', ultimo_pago_monto: '826508.314' })],
      RANGO,
    );
    expect(r.faltantes[0].monto).toBe(10.01);
    expect(r.faltantes[0].ultimo_pago_monto).toBe(826508.31);
    expect(r.faltantes[0].ultimo_pago_date).toBe('2026-10-13');
  });

  it('la edad del dato es la más reciente, y sin fechas es null — ⛔ nunca «ahora»', () => {
    const conFechas = repartirFaltantes(
      [
        fila({ proveedor_code: 'C1', monto: 10, computed_at: '2026-10-22T18:30:00.000Z' }),
        fila({ proveedor_code: 'C2', monto: 5, computed_at: new Date('2026-10-22T19:45:00.000Z') }),
        fila({ proveedor_code: 'C3', monto: 1, computed_at: 'no es una fecha' }),
      ],
      RANGO,
    );
    expect(conFechas.universo.data_as_of).toBe('2026-10-22T19:45:00.000Z');

    const sinFechas = repartirFaltantes([fila({ proveedor_code: 'C1', monto: 10 })], RANGO);
    expect(sinFechas.universo.data_as_of).toBeNull();
  });

  it('la suma de las partes es el universo, siempre', () => {
    const rows = [
      fila({ proveedor_code: 'C1', monto: 23912981.1 }),
      fila({ proveedor_code: 'C2', monto: 14542878.98, tiene_cuenta: true }),
      fila({ proveedor_code: 'XX', monto: 1234.56, supplier_id: null }),
    ];
    const r = repartirFaltantes(rows, RANGO);
    const faltante = r.faltantes.reduce((a, f) => a + f.monto, 0);
    expect(r.universo.monto_cubierto + r.universo.monto_sin_catalogo + faltante).toBeCloseTo(r.universo.monto_total, 2);
  });
});
