/**
 * [PU.VG.3] — Qué se puede materializar sin un supuesto de gasto FIRMADO.
 *
 * Módulo PURO (cero imports): es la decisión que hay que poder romper en una prueba.
 *
 * ── El problema ─────────────────────────────────────────────────────────────────────────────
 * `materialize` convierte el PLAN en PARTIDAS, o sea en presupuesto. Medido en prod el
 * 2026-10-08: los 374 renglones del plan de gasto tienen `monto = base_amount` al centavo y
 * `growth_pct` 0.0000, y `budget.expense_plan_settings` está en **0 filas**. Es decir que el
 * motor estaba publicando **el pasado copiado** con forma de presupuesto, sin que nadie firmara
 * un crecimiento. **Si nadie firma el crecimiento, no hay presupuesto.**
 *
 * ── Por qué «firmado» NO es «el valor es distinto de cero» ──────────────────────────────────
 * Un supuesto de `0 %` es una decisión legítima («congelar el gasto»), y se ve idéntica a no
 * haber decidido nada. La firma no puede ser un VALOR: es el **hecho** de que una persona haya
 * tocado los supuestos. Por eso el criterio es la existencia de la fila + quién la escribió.
 *
 * ⭐ Y la asimetría medida es la que lo hace posible: el autopiloto **sí** escribe
 * `sales_plan_settings` (de ahí las 3 filas con `created_by='autopilot'`) y **nunca** las de
 * gasto — `expensePlan.upsertSettings` sólo se llama desde el controlador. Así que para el gasto
 * una fila significa que alguien abrió la pantalla. Igual se exige que el autor NO sea la
 * máquina: si mañana alguien cablea el autopiloto a escribirlas, esta compuerta se volvería un
 * no-op en silencio, y un gate que se apaga solo es peor que no tenerlo.
 *
 * ⛔ LO QUE ESTA COMPUERTA NO PUEDE HACER, y costó encontrarlo: **no puede saltar las partidas de
 * gasto al armar el conjunto deseado**. `materialize` cierra toda partida `source='plan'` cuyo
 * `source_ref` no quedó en `seen` (pone `status='cerrada'` y `vigente_amount = 0`). Si la
 * compuerta las omitiera, las 40 partidas de gasto que ya existen en prod **se cerrarían con
 * vigente en cero** — una compuerta protectora destruyendo justo lo que protege. Por eso el
 * bloqueo frena la ESCRITURA y no la pertenencia al conjunto.
 */

export type FirmaSupuesto = {
  /** ¿existe la fila de supuestos del plan de gasto? */
  existe: boolean;
  /** quién la escribió (`created_by`). */
  autor?: string | null;
};

/** El autor que NO cuenta como firma: la máquina no firma presupuestos. */
export const AUTOR_MAQUINA = 'autopilot';

export function supuestoGastoFirmado(s: FirmaSupuesto | null | undefined): boolean {
  if (!s || !s.existe) return false;
  const autor = String(s.autor ?? '').trim().toLowerCase();
  if (!autor) return false;              // fila sin autor: no se sabe quién, no cuenta como firma
  return autor !== AUTOR_MAQUINA;
}

/**
 * Qué hacer con una entrada del conjunto deseado.
 *
 * `bloqueado` NO significa «sacala del conjunto»: significa «no escribas». La entrada sigue
 * perteneciendo a `seen` para que el barrido de huérfanas no la cierre (ver arriba).
 */
export function accionMaterializacion(args: {
  esGastoDerivadoDelPlan: boolean;
  firmado: boolean;
}): 'escribir' | 'bloqueado_sin_firma' {
  if (args.esGastoDerivadoDelPlan && !args.firmado) return 'bloqueado_sin_firma';
  return 'escribir';
}

/**
 * Qué `source_ref` cerraría el barrido de huérfanas, dado el conjunto deseado y lo que existe.
 * Existe para poder PROBAR la trampa: una entrada bloqueada no puede terminar acá nunca.
 */
export function huerfanasQueSeCierran(seen: Iterable<string>, existentes: Iterable<string>): string[] {
  const vistos = new Set(seen);
  return [...existentes].filter((s) => !vistos.has(s));
}
