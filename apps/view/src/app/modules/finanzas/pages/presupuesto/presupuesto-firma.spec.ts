import { leyendaRespaldo, resumenFirma, type Completeness, type ProcedenciaCanal } from './presupuesto-firma';

/**
 * `[PVI.13]` — **Qué estás por mandar a autorización.**
 *
 * El caso que define el éxito es el tercero: un ejercicio que la compuerta declara **LISTO**, sin
 * un solo bloqueo, y cuyos cuatro supuestos de crecimiento **no los respalda nadie**. Es el estado
 * real de producción medido el 2026-10-09, y es exactamente lo que la pantalla no decía: `mayoreo`
 * en **+26.67 %** —el `default` al decimal— sobre **$169,970,622** de meta, contra un canal que
 * mide **−9.36 %**.
 *
 * ⛔ Lo demás vigila las dos formas de mentir por omisión, que son simétricas:
 *   · afirmar que está listo cuando la compuerta todavía no cargó (optimismo por defecto);
 *   · afirmar que NO hay respaldo cuando lo que pasa es que **no se sabe** — `growth_provenance`
 *     en NULL es una fila anterior a `[PVI.3]`, no un veredicto. Por eso `respaldoMedido` es
 *     ternario y no booleano (ADR-056, misma razón que `Freshness`).
 */

const comp = (over: Partial<Completeness> = {}): Completeness => ({
  budget_id: 'b1', folio: 'PRE-2027-002', listo: true, bloqueos: [], avisos: [],
  conteos: { supuestos: 1, plan_ventas: 429, plan_gastos: 158, partidas: 47, periodos_con_meta: 13, periodos_totales: 13 },
  ...over,
});

/** El `growth_by_channel` real del ejercicio vivo. */
const CRECIMIENTO = { ruta: 0.0826, mayoreo: 0.2667, preventa: 0.5121, mostrador: 0.2105 };

const proc = (basis: Record<string, ProcedenciaCanal['basis']>): Record<string, ProcedenciaCanal> =>
  Object.fromEntries(Object.entries(basis).map(([k, b]) => [k, { basis: b, at: '2026-10-09T13:30:00.000Z' }]));

describe('[PVI.13] el estado de la compuerta llega a la pantalla', () => {
  it('pinta los bloqueos y los avisos que el backend ya calculaba y nadie mostraba', () => {
    const r = resumenFirma(
      comp({ listo: false, bloqueos: ['El plan de ventas cubre 10 de 13 periodos.'], avisos: ['Sin plan de gastos.'] }),
      null, CRECIMIENTO,
    );
    expect(r.listo).toBe(false);
    expect(r.bloqueos).toHaveLength(1);
    expect(r.avisos).toEqual(['Sin plan de gastos.']);     // ⭐ no frenan, y por eso nadie los veía
    expect(r.conteos?.plan_ventas).toBe(429);
  });

  it('⛔ sin la compuerta cargada NO se afirma que esté listo', () => {
    const r = resumenFirma(null, proc({ ruta: 'yoy_paired' }), CRECIMIENTO);
    expect(r.listo).toBe(false);
    expect(r.conteos).toBeNull();
    expect(r.bloqueos).toEqual([]);
  });
});

describe('[PVI.13] «listo» no es «respaldado»', () => {
  it('⭐ EL CASO DE PROD: listo, sin bloqueos, y los CUATRO canales sin respaldo', () => {
    const r = resumenFirma(comp(), proc({
      ruta: 'preexistente', mayoreo: 'preexistente', preventa: 'preexistente', mostrador: 'preexistente',
    }), CRECIMIENTO);

    expect(r.listo).toBe(true);           // la compuerta dice que sí
    expect(r.bloqueos).toEqual([]);
    expect(r.respaldoMedido).toBe(false); // …y aun así nadie firma el número
    expect(r.sinRespaldo.map((x) => x.canal).sort()).toEqual(['mayoreo', 'mostrador', 'preventa', 'ruta']);
    expect(leyendaRespaldo(r)).toContain('4 de 4 canales');
    expect(leyendaRespaldo(r)).toContain('mayoreo');
  });

  it('una medición respalda, y la firma de una persona también', () => {
    const r = resumenFirma(comp(), proc({
      ruta: 'yoy_paired', mayoreo: 'manual', preventa: 'global', mostrador: 'default',
    }), CRECIMIENTO);
    // `default` = se intentó medir y no alcanzó ⇒ sigue sin respaldo.
    expect(r.sinRespaldo).toEqual([{ canal: 'mostrador', basis: 'default' }]);
    expect(r.respaldoMedido).toBe(false);
    expect(leyendaRespaldo(r)).toContain('1 de 4 canales');
  });

  it('con todos respaldados no inventa una advertencia', () => {
    const r = resumenFirma(comp(), proc({
      ruta: 'yoy_paired', mayoreo: 'yoy_paired', preventa: 'manual', mostrador: 'global',
    }), CRECIMIENTO);
    expect(r.sinRespaldo).toEqual([]);
    expect(r.respaldoMedido).toBe(true);
    expect(leyendaRespaldo(r)).toBeNull();
  });
});

describe('[PVI.13] las dos ausencias, que no son la misma', () => {
  it('⛔ procedencia NULL es NO SE SABE, no «sin respaldo»', () => {
    const r = resumenFirma(comp(), null, CRECIMIENTO);
    expect(r.respaldoMedido).toBeNull();            // ← ni true ni false
    expect(r.sinRespaldo).toEqual([]);              // no se acusa a ningún canal
    expect(leyendaRespaldo(r)).toContain('NO MEDIDO');
  });

  it('⛔ un `{}` tampoco se lee como medido: es la fila vieja, no una medición vacía', () => {
    const r = resumenFirma(comp(), {}, CRECIMIENTO);
    expect(r.respaldoMedido).toBeNull();
  });

  it('PRUEBA NEGATIVA: si NULL se tratara como «sin respaldo», acusaría a los 4 sin evidencia', () => {
    const conNull = resumenFirma(comp(), null, CRECIMIENTO);
    const conDatos = resumenFirma(comp(), proc({
      ruta: 'preexistente', mayoreo: 'preexistente', preventa: 'preexistente', mostrador: 'preexistente',
    }), CRECIMIENTO);
    // Los dos casos se ven parecidos en pantalla y NO son el mismo hecho.
    expect(conNull.sinRespaldo).toEqual([]);
    expect(conDatos.sinRespaldo).toHaveLength(4);
    expect(conNull.respaldoMedido).not.toBe(conDatos.respaldoMedido);
  });

  it('sin canales no hay nada honesto que decir', () => {
    const r = resumenFirma(comp(), null, {});
    expect(r.canalesTotales).toBe(0);
    expect(leyendaRespaldo(r)).toBeNull();
  });

  it('un canal con procedencia pero sin supuesto guardado no se cuenta', () => {
    const r = resumenFirma(comp(), proc({ ruta: 'preexistente', canal_fantasma: 'default' }), { ruta: 0.0826 });
    expect(r.canalesTotales).toBe(1);
    expect(r.sinRespaldo.map((x) => x.canal)).toEqual(['ruta']);
  });
});
