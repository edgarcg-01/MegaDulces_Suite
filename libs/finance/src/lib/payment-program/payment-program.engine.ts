/**
 * [PP.7] Cobertura del libro de Tesorería, en una función PURA (patrón `caja-lote.engine.ts`).
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 *
 * `/finanzas/programa-pagos` publica la ejecución de pagos de Tesorería — el único lugar donde
 * existen la **forma de pago real** (`CH-5237` / `TRANSF`) y los **folios de factura** que se
 * cubrieron. Medido contra prod el 2026-10-05:
 *
 *   · último mes cargado: **2026-08** · último write del importer: **2026-08-08** (58 días)
 *   · o sea **septiembre entero no está**, y la pantalla lo publicaba sin decirlo.
 *
 * No es descuido del operador: `import-payment-program.js` lee un `.xlsx` desde una ruta local, a
 * mano, sin agenda y sin latido. El estado NORMAL de este espejo es "congelado".
 *
 * ⛔ **Por qué un mes faltante no se puede dejar implícito.** La pantalla arma su filtro de Mes
 * desde los meses CARGADOS, así que un mes ausente ni siquiera aparece como opción: no se ve como
 * un hueco, se ve como si no existiera. Y en los totales llega como cero, que es indistinguible de
 * "ese mes no se pagó nada". Enumerarlos es la única forma de que la ausencia sea visible
 * (ADR-056: lo que falta se declara, nunca se dibuja como cero).
 *
 * ⚠️ **El mes EN CURSO no se exige, a propósito.** Todavía se está ejecutando; pedirlo dejaría el
 * aviso encendido los 30 días del mes y enseñaría a ignorarlo — el mismo defecto que una alarma
 * que grita en falso todas las noches.
 */

/** Lo que la pantalla necesita saber sobre la cobertura del libro. */
export interface CoberturaLibro {
  /** Meses presentes, ascendente (`YYYY-MM`). */
  cargados: string[];
  /** Meses ausentes entre el primero cargado y el mes anterior al corriente. */
  faltantes: string[];
  /** Primer mes del universo medido, o `null` si no hay nada cargado. */
  desde: string | null;
  /**
   * Último mes que SÍ se exige. `null` cuando no hay nada cargado: sin un punto de partida no se
   * puede afirmar que falte algo, y afirmarlo sería inventar un universo.
   */
  hasta_esperado: string | null;
}

/** `YYYY-MM` de un Date, leído en UTC (el mes de negocio no depende del huso del servidor). */
function ym(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Qué meses faltan en el libro.
 *
 * @param cargados meses presentes en `finance.payment_program` (`YYYY-MM`), en cualquier orden.
 * @param hoy      el ahora, inyectable para que la prueba no dependa del calendario del que la corre.
 *
 * Sin meses cargados devuelve todo vacío — **no "faltan todos"**: sin un primer mes no hay universo
 * contra el cual medir, y una pantalla recién estrenada no debe gritar que le falta la historia
 * entera.
 */
export function coberturaLibro(cargados: string[], hoy: Date = new Date()): CoberturaLibro {
  const limpios = Array.from(new Set((cargados || []).filter((m) => /^\d{4}-\d{2}$/.test(m)))).sort();
  if (!limpios.length) return { cargados: [], faltantes: [], desde: null, hasta_esperado: null };

  // Mes ANTERIOR al corriente. `Date.UTC` normaliza el mes -1 de enero a diciembre del año previo,
  // que es justo el borde donde un `mes - 1` escrito a mano se equivoca de año.
  const hasta = ym(new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1)));

  const tengo = new Set(limpios);
  const faltantes: string[] = [];
  const [y0, m0] = limpios[0].split('-').map(Number);
  const cur = new Date(Date.UTC(y0, m0 - 1, 1));
  // La comparación es lexicográfica y es segura porque `YYYY-MM` está cero-rellenado.
  for (let guard = 0; guard < 1200; guard++) {
    const m = ym(cur);
    if (m > hasta) break;
    if (!tengo.has(m)) faltantes.push(m);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return { cargados: limpios, faltantes, desde: limpios[0], hasta_esperado: hasta };
}
