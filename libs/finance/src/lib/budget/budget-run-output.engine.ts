/**
 * `[PVI.14]` — **La huella de una pasada: qué CIFRA produjo, no sólo cuántas celdas tocó.**
 *
 * ── El hueco, medido en prod el 2026-10-09 ───────────────────────────────────────────────────
 *
 * `budget.generation_runs` existe, está poblada (**23 pasadas, las 23 con los supuestos
 * snapshotados**) y `closeRun(output)` ya guarda lo que entregó cada una. Pero el `output` cuenta
 * **celdas**, no dice **cuánta meta quedó**:
 *
 *   GEN-20261009-001 → ventas {escritas: 429, proxy_canal_monto: 197160564.29, proxy_canal_pct: 0.2446}
 *   GEN-20261009-003 → ventas {escritas: 429, proxy_canal_monto: 0,             proxy_canal_pct: 0}
 *
 * ⭐ Algo cambió entre esas dos pasadas del MISMO día —el proxy pasó de $197 M a cero— y **no hay
 *    forma de saber qué meta publicó cada una**. Las dos escribieron 429 renglones: por el conteo
 *    son idénticas. La pregunta «¿por qué cambió la meta de P7 entre ayer y hoy?» no tiene
 *    respuesta, y es textualmente lo que el comentario `[VE.5-D]` del autopilot dice que la
 *    procedencia viene a resolver.
 *
 * ⛔ Y no es que el dato falte: `proposePlan` **devuelve `meta_total`** desde `[PVI.2]`. El
 *    autopilot simplemente no lo ponía en el `output`. Mismo patrón que la procedencia antes de
 *    `[PVI.4]`: el motor lo calcula, el registro lo tira.
 *
 * ── Y una ausencia dibujada como cero, en la línea de al lado ────────────────────────────────
 *
 * `proxy_canal_monto: ... ?? 0` convertía «la API no lo emitió» en «vale cero», mientras
 * `proxy_canal_pct: ... ?? null` —el renglón siguiente— lo declaraba bien. **Dos criterios para la
 * misma ausencia, pegados.** Un cero en el registro histórico es peor que en una pantalla: se lee
 * como una medición y nadie va a recomputar una pasada de hace tres meses para desmentirlo.
 *
 * Esta función no decide nada: arma la huella y **declara lo que no vino**. Reusa la tabla, el
 * folio y la ranura que ya existen — no inventa un noveno registro (ADR-056).
 */

/** Lo que `proposePlan` devuelve, visto desde acá. Todo opcional: la API vieja no lo emite. */
export interface ResultadoPropuesta {
  coverage?: Record<string, number> | null;
  coverage_monto?: { proxy_canal?: number | null } | null;
  proxy_canal_pct?: number | null;
  meta_total?: number | null;
}

export interface HuellaVentas {
  /** Celdas escritas por el motor (no incluye las respetadas a mano). */
  escritas: number;
  manual_kept: number;
  /**
   * ⭐ La CIFRA que produjo la pasada. `null` = la API no la emitió — **nunca 0**: un presupuesto
   * de cero y un presupuesto no medido son hechos distintos, y en un registro histórico la
   * diferencia no se puede recuperar después.
   */
  meta_total: number | null;
  proxy_canal_monto: number | null;
  proxy_canal_pct: number | null;
}

/** `null` salvo que venga un número de verdad. `Number(null)` es 0, no NaN: hay que preguntar antes. */
const num = (v: unknown): number | null => (v == null || typeof v !== 'number' || !Number.isFinite(v) ? null : v);

const cuenta = (c: Record<string, number> | null | undefined, k: string): number => {
  const v = c?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

export function huellaVentas(r: ResultadoPropuesta | null | undefined): HuellaVentas {
  const c = r?.coverage ?? null;
  return {
    // Las celdas SÍ son un conteo: ausente significa «ninguna», y eso sí es cero.
    escritas: cuenta(c, 'historico_ajustado') + cuenta(c, 'estacional') + cuenta(c, 'proxy_canal') + cuenta(c, 'sin_base_declarado'),
    manual_kept: cuenta(c, 'manual_kept'),
    // El DINERO no: ausente significa «no lo sé».
    meta_total: num(r?.meta_total),
    proxy_canal_monto: num(r?.coverage_monto?.proxy_canal),
    proxy_canal_pct: num(r?.proxy_canal_pct),
  };
}

/**
 * ¿Cambió la cifra entre dos pasadas? `null` cuando alguna de las dos no la registró — que es el
 * estado de las 23 pasadas anteriores a `[PVI.14]` y **no se puede reconstruir**.
 */
export function cambioDeMeta(antes: HuellaVentas | null, ahora: HuellaVentas | null): number | null {
  if (antes?.meta_total == null || ahora?.meta_total == null) return null;
  return ahora.meta_total - antes.meta_total;
}
