/**
 * `[PVI.4]` — La procedencia del supuesto de crecimiento, en una función PURA.
 *
 * ── Por qué existe este archivo ──────────────────────────────────────────────────────────────
 *
 * `[PVI.3]` agregó la columna `budget.sales_plan_settings.growth_provenance` para que un número
 * refutado y uno defendible dejaran de verse igual. La columna se aplicó a prod (batch 853), el
 * código se desplegó, el autopilot corrió — **y la columna siguió en NULL en los 3 ejercicios.**
 *
 * Medido en prod el 2026-10-09 09:19 MX, con el código nuevo ya sirviendo (`commit 4e963f78`):
 *
 *   analytics.cron_runs job_key=budget_autopilot
 *     last_finish 2026-10-09 07:30:06 -06  ·  status ok  ·  2497 celdas  ·  "3/3 ejercicios"
 *   budget.sales_plan_settings
 *     growth_provenance = NULL  ×3
 *     growth_by_channel = {"ruta":0.0826,"mayoreo":0.2667,"preventa":0.5121,"mostrador":0.2105}
 *
 * ⭐ O sea: **el latido dijo `ok` y la parte nueva no se hizo.** Es la misma familia de fallas que
 * esta Suite ya pagó tres veces (ADR-053): el sistema reportando éxito sin hacer nada.
 *
 * ── Los DOS defectos, y por qué el segundo estaba escondido por el primero ────────────────────
 *
 * **(A) El único `upsert` que escribe la procedencia estaba gateado por `derivado`.**
 * `budget-autopilot.service.ts` armaba el objeto `procedencia` entero y después preguntaba
 * `if (Object.keys(derivado).length)`. Un canal entra a `derivado` **sólo si no tenía valor
 * guardado** — y los 4 canales del ejercicio vivo ya lo tenían. ⇒ `derivado` vacío ⇒ el `upsert`
 * nunca corre ⇒ la procedencia se calculaba y **se tiraba**. No es que fallara: es que preguntaba
 * por la cosa equivocada.
 *
 * **(B) Y si (A) se arreglaba solo, publicaba una MENTIRA.** La rama del `else` estampaba
 * `basis:'manual'` sobre todo canal con valor guardado, razonando «lo puso una persona». Falso:
 * esos 4 valores los escribió **una pasada vieja del autopilot**, antes de que la procedencia
 * existiera. Estampar `manual` **certifica como decisión humana** el `+26.67 %` de `mayoreo` —
 * el canal que mide **−9.36 %** — sobre **$169,970,622** de meta. Eso es peor que NULL, y es
 * exactamente lo que el comentario de la migración prohíbe: *«NULL = la fila se guardó antes de
 * PVI.3 y su procedencia NO se puede reconstruir sin recomputar — no es `{}` ni "sin procedencia",
 * es desconocida»*.
 *
 * ⇒ Arreglar (A) sin (B) habría convertido un hueco honesto en una firma falsa. Por eso van juntos.
 *
 * ── Las reglas que esta función implementa ───────────────────────────────────────────────────
 *
 *  1. Canal SIN valor guardado → se deriva, y su procedencia es la que trajo `proposeGrowth`
 *     (`yoy_paired` medido · `global` heredado · `default` = **no se pudo medir**).
 *  2. Canal CON valor guardado y CON procedencia previa → se **preserva verbatim**, incluido su
 *     `at`. Re-estampar la fecha mentiría sobre cuándo se decidió, y además haría churn: la
 *     columna se reescribiría cada madrugada sin que cambiara nada.
 *  3. Canal CON valor guardado y SIN procedencia → `basis:'preexistente'`. Hay un número y
 *     **nadie puede decir de dónde salió**. No es `manual` (nadie firmó) ni `default` (no se
 *     midió hoy): es desconocido, y se declara como tal (ADR-056).
 *  4. ⛔ **Si no hay un solo canal, NO se escribe.** Un `{}` sobre un NULL se leería como «se midió
 *     y no había nada». La ausencia de medición y la medición vacía no son el mismo hecho.
 *  5. Se escribe sólo si algo CAMBIA — hay canales derivados, o la procedencia difiere de la
 *     guardada. Una pasada que no cambia nada no toca la fila.
 *
 * ⚠️ Lo que esta función **NO** hace, a propósito: no corrige el `0.2667` de `mayoreo`. Cambiar un
 * supuesto publicado mueve $169,970,622 de meta y **es una decisión de negocio, no un arreglo de
 * datos** — y hoy no existe el permiso con el que alguien la firmaría (`PRESUPUESTOS_APROBAR` no
 * existe; Tesorería y Compras sí tienen su par preparar/autorizar). Lo que esta función logra es
 * que el número **declare que nadie lo respalda**, que es el paso previo a que alguien lo decida.
 */

import type { CoberturaYoY, ProcedenciaCrec } from './budget-sales-plan.service';

/** Lo que `proposeGrowth` devuelve por canal, visto desde acá. */
export interface PropuestaCanal {
  growth_pct: number;
  basis?: string;
  paired_periods?: number;
  years_used?: number[];
  cobertura?: CoberturaYoY;
}

export interface EntradaProcedencia {
  /** lo que propuso `proposeGrowth`, por canal. */
  byChannel: Record<string, PropuestaCanal>;
  /** `growth_by_channel` tal como está guardado hoy. */
  yaGuardado: Record<string, number>;
  /** `growth_provenance` guardado. **NULL = fila anterior a PVI.3**, no «sin procedencia». */
  yaProc: Record<string, ProcedenciaCrec> | null;
  /** marca de tiempo de ESTA pasada (ISO). Sólo se estampa en lo que se decide hoy. */
  at: string;
}

export interface ResumenProcedencia {
  /** canales que esta pasada calculó por primera vez. */
  derivados: number;
  /** canales que ya tenían número y no se tocan. */
  respetados: number;
  /** de los derivados, cuántos salieron con `default` = **no se pudo medir**. */
  sin_medir: number;
  /** canales con número y sin respaldo: nadie puede decir de dónde salieron. */
  preexistentes: number;
}

export interface SalidaProcedencia {
  /** canales a escribir en `growth_by_channel` (sólo los nuevos). */
  derivado: Record<string, number>;
  /** procedencia completa, misma llave de canal. */
  procedencia: Record<string, ProcedenciaCrec>;
  /** ⇐ el gate. `false` = esta pasada no cambia nada y no debe tocar la fila. */
  escribir: boolean;
  resumen: ResumenProcedencia;
}

/** JSON con llaves ordenadas: dos objetos iguales dan la misma cadena, venga como venga. */
function canonico(o: unknown): string {
  if (o === null || o === undefined) return 'null';
  if (Array.isArray(o)) return `[${o.map(canonico).join(',')}]`;
  if (typeof o === 'object') {
    const e = Object.entries(o as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${e.map(([k, v]) => `${JSON.stringify(k)}:${canonico(v)}`).join(',')}}`;
  }
  return JSON.stringify(o);
}

export function decidirProcedencia(e: EntradaProcedencia): SalidaProcedencia {
  const yaGuardado = e.yaGuardado ?? {};
  const yaProc = e.yaProc ?? null;

  const derivado: Record<string, number> = {};
  const procedencia: Record<string, ProcedenciaCrec> = {};
  let sinMedir = 0;
  let preexistentes = 0;
  let respetados = 0;

  for (const [canal, v] of Object.entries(e.byChannel ?? {})) {
    const c = (v ?? {}) as PropuestaCanal;

    if (yaGuardado[canal] == null) {
      // Regla 1 — se deriva hoy, con la procedencia que trajo el cálculo.
      const basis = (c.basis ?? 'default') as ProcedenciaCrec['basis'];
      derivado[canal] = Number(c.growth_pct);
      procedencia[canal] = {
        basis,
        paired_periods: c.paired_periods,
        years_used: c.years_used,
        cobertura: c.cobertura,
        at: e.at,
      };
      if (basis === 'default') sinMedir++;
      continue;
    }

    respetados++;
    const previa = yaProc?.[canal];
    if (previa) {
      // Regla 2 — se preserva verbatim. NO se re-estampa `at`.
      procedencia[canal] = previa;
      if (previa.basis === 'preexistente') preexistentes++;
    } else {
      // Regla 3 — hay número y nadie puede decir de dónde salió. NUNCA `manual`.
      procedencia[canal] = { basis: 'preexistente', at: e.at };
      preexistentes++;
    }
  }

  // Regla 4 — sin un solo canal no se escribe: un `{}` sobre NULL se leería como medición vacía.
  const hayCanales = Object.keys(procedencia).length > 0;
  // Regla 5 — sólo si algo cambia.
  const cambio = Object.keys(derivado).length > 0 || canonico(procedencia) !== canonico(yaProc);

  return {
    derivado,
    procedencia,
    escribir: hayCanales && cambio,
    resumen: {
      derivados: Object.keys(derivado).length,
      respetados,
      sin_medir: sinMedir,
      preexistentes,
    },
  };
}
