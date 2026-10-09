/**
 * `[PVI.13]` — **Qué estás por mandar a autorización.**
 *
 * ── El hueco, medido ─────────────────────────────────────────────────────────────────────────
 *
 * El ciclo del ejercicio SE PUEDE operar desde la pantalla: «Enviar a autorización» → «Aprobar» →
 * «Cerrar» están los tres cableados, y `submitBudget` exige de verdad la compuerta de completitud
 * (`GET budgets/:id/completeness`, `[VE.5-F]`), que separa **bloqueos** de **avisos**.
 *
 * ⛔ Pero ese endpoint tiene **CERO consumidores en el frontend**. O sea que la persona descubre
 *    los bloqueos **apretando y fallando**, y los `avisos` —lo que conviene mirar y NO frena— no
 *    los ve nunca, porque nada los pinta. Medido en prod el 2026-10-09: los tres ejercicios están
 *    **listos, sin un solo bloqueo** (429 renglones de ventas, 158 de gastos, 13 de 13 periodos,
 *    47 partidas) y los tres siguen en `borrador`. La adopción no está trabada por falta de datos.
 *
 * ── Y lo que «listo» NO dice ─────────────────────────────────────────────────────────────────
 *
 * ⭐ `completeness` mide **cantidad**, no **respaldo**: cuenta renglones y periodos. Declara
 *    «listo» un ejercicio cuyo mayor supuesto de crecimiento no lo respalda nadie. En el ejercicio
 *    vivo, `mayoreo` está en **+26.67 %** —el `default` al decimal— sobre **$169,970,622** de meta,
 *    y el canal mide **−9.36 %**. Desde `[PVI.3]`/`[PVI.4]` eso ya vive en la base
 *    (`growth_provenance`), y desde `[PVI.11]` el motor lo escribe. Faltaba que llegara al ojo de
 *    quien firma: hasta acá el frontend pedía `settings` y **tiraba la procedencia**, exactamente
 *    como la tiraba el autopilot antes de corregirlo.
 *
 * Esta función no decide nada ni frena nada — el freno vive en el backend, donde no se puede
 * saltar. Lo que hace es que el acto de firmar sea **informado**.
 */

/** Los `basis` que `growth_provenance` admite. Espeja `ProcedenciaCrec` del backend. */
export type BasisCrec = 'yoy_paired' | 'global' | 'default' | 'manual' | 'preexistente';

export interface ProcedenciaCanal {
  basis: BasisCrec;
  paired_periods?: number;
  at?: string;
}

/** Lo que devuelve `GET budgets/:id/completeness`. */
export interface Completeness {
  budget_id: string;
  folio: string | null;
  listo: boolean;
  /** Lo que IMPIDE firmar: `submit` rechaza si hay algo acá. */
  bloqueos: string[];
  /** Lo que conviene mirar y NO impide firmar — se declara, no se esconde. */
  avisos: string[];
  conteos: {
    supuestos: number; plan_ventas: number; plan_gastos: number; partidas: number;
    periodos_con_meta: number; periodos_totales: number;
  };
}

export interface CanalSinRespaldo { canal: string; basis: BasisCrec }

export interface ResumenFirma {
  listo: boolean;
  bloqueos: string[];
  avisos: string[];
  conteos: Completeness['conteos'] | null;
  /** Canales cuyo supuesto NO lo respalda ni una medición ni una persona. */
  sinRespaldo: CanalSinRespaldo[];
  /** Cuántos canales tienen supuesto, respaldados o no. */
  canalesTotales: number;
  /**
   * ⛔ Ternario a propósito, NO booleano: `null` = **no se sabe**.
   *
   * `growth_provenance` en NULL significa que la fila se guardó antes de `[PVI.3]` y su procedencia
   * **no se puede reconstruir sin recomputar**. Eso no es «todo respaldado» (que sería `true`) ni
   * «nada respaldado» (`false`): es desconocido, y un booleano no puede decirlo. Es la misma razón
   * por la que `Freshness` del contrato es ternario (ADR-056).
   */
  respaldoMedido: boolean | null;
}

/** Un `basis` que significa «esto lo respalda algo»: una medición, o la firma de una persona. */
const RESPALDADOS: ReadonlySet<BasisCrec> = new Set<BasisCrec>(['yoy_paired', 'global', 'manual']);

export function resumenFirma(
  comp: Completeness | null,
  provenance: Record<string, ProcedenciaCanal> | null | undefined,
  growthByChannel: Record<string, number> | null | undefined,
): ResumenFirma {
  const canales = Object.keys(growthByChannel ?? {});

  // ⛔ `undefined` y `null` NO son lo mismo que `{}`: sin procedencia no se afirma nada.
  const hayProcedencia = provenance != null && Object.keys(provenance).length > 0;

  const sinRespaldo: CanalSinRespaldo[] = hayProcedencia
    ? canales
      .map((canal) => ({ canal, basis: (provenance as Record<string, ProcedenciaCanal>)[canal]?.basis }))
      .filter((x): x is CanalSinRespaldo => x.basis != null && !RESPALDADOS.has(x.basis))
    : [];

  return {
    // Sin la compuerta cargada no se afirma que esté listo: el optimismo por defecto es el defecto.
    listo: comp?.listo === true,
    bloqueos: comp?.bloqueos ?? [],
    avisos: comp?.avisos ?? [],
    conteos: comp?.conteos ?? null,
    sinRespaldo,
    canalesTotales: canales.length,
    respaldoMedido: hayProcedencia ? sinRespaldo.length === 0 : null,
  };
}

/** Una línea corta para el encabezado. `null` cuando no hay nada honesto que decir todavía. */
export function leyendaRespaldo(r: ResumenFirma): string | null {
  if (r.canalesTotales === 0) return null;
  if (r.respaldoMedido == null) {
    return `Respaldo de los supuestos: NO MEDIDO — se guardaron antes de que el motor lo registrara, y no se puede reconstruir sin recomputar.`;
  }
  if (r.sinRespaldo.length === 0) return null;
  const cuales = r.sinRespaldo.map((x) => x.canal).join(', ');
  return `${r.sinRespaldo.length} de ${r.canalesTotales} canales del crecimiento SIN respaldo (${cuales}): ni una medición ni una persona los firma.`;
}
