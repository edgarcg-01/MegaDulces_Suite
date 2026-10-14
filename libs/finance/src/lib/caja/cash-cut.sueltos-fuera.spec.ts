import { calcularCorte } from './cash-cut.engine';

/**
 * ⛔⛔ `[CG.157]` **El conteo y el neto medían universos distintos.**
 *
 * En `sueltosFuera()` el neto llevaba `CASE WHEN estado = 'cancelado' THEN 0` y el
 * `count(*) FILTER (...)` **no filtraba `estado`**: un movimiento cancelado inflaba el contador y
 * no aportaba un peso al neto.
 *
 * Lo encontró una auditoría creando dos movimientos de prueba y cancelándolos: **el contador subió
 * de 37 a 39 sin que el dinero se moviera.** Verificado contra prod el 2026-10-14: `71` contra
 * `70` anteriores a hoy, y la diferencia es `CG-2026-00003`, un gasto de \$20 cancelado el 8-oct
 * que llevaba seis días contándose como pendiente de cortar.
 *
 * ⚠️ La consulta en sí vive en SQL y se arregló moviendo el filtro al `WHERE` (una sola condición,
 * un solo universo, incluidos `desde`/`hasta` que seguían una TERCERA definición). Lo que se fija
 * acá es el **criterio**, que es lo que podría volver a divergir: un cancelado no cuenta, y el
 * motor ya lo trataba así — por eso el arreglo fue alinearse con él en vez de inventar otro.
 */
describe('[CG.157] un movimiento cancelado no cuenta, en ningún lado', () => {
  const vivos = [
    { tipo: 'ingreso' as const, monto: 1000 },
    { tipo: 'gasto' as const, monto: 400 },
  ];

  it('el motor ya los descarta del conteo Y del dinero — es el criterio a alinear', () => {
    const t = calcularCorte({
      fondoInicial: 0,
      movimientos: [...vivos, { tipo: 'gasto', monto: 20, estado: 'cancelado' }],
      conteo: [{ denominacion: 500, piezas: 1 }],
      morralla: 0,
    });
    // Ni en el conteo…
    expect(t.movimientos).toBe(2);
    expect(t.cancelados).toBe(1);
    // …ni en el dinero. Los $20 cancelados no bajan el gasto.
    expect(t.gastos).toBe(400);
    expect(t.esperado).toBe(600);
  });

  it('⛔ PRUEBA NEGATIVA: cancelar NO puede mover el esperado', () => {
    // Es la aserción que define el defecto. Si cancelar cambiara el dinero, cancelar un
    // movimiento viejo movería el arqueo de hoy — y si cambiara sólo el conteo (lo que pasaba en
    // `sueltosFuera`), la pantalla contaría movimientos que no existen.
    const sin = calcularCorte({ fondoInicial: 0, movimientos: vivos, conteo: [], morralla: 0 });
    const con = calcularCorte({
      fondoInicial: 0,
      movimientos: [...vivos, { tipo: 'ingreso', monto: 999999, estado: 'cancelado' }],
      conteo: [], morralla: 0,
    });
    expect(con.esperado).toBe(sin.esperado);
    expect(con.movimientos).toBe(sin.movimientos);
    // Y se DECLARA que estuvo: no se borra de la vista, se cuenta aparte.
    expect(con.cancelados).toBe(1);
    expect(sin.cancelados).toBe(0);
  });
});
