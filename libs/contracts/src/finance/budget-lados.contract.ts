/**
 * `[PVI.17]` — **Los lados de un ejercicio de presupuesto, y cuáles hacen falta para restar.**
 *
 * ── Por qué sube a `libs/contracts` ─────────────────────────────────────────────────────────
 *
 * La regla nació en `[PVI.16]` dentro de `apps/view` para contestar una sola pregunta en una sola
 * pantalla. Hoy tiene un **segundo consumidor** —el desglose de la cola de ejercicios en «Mi
 * trabajo» (`libs/trade`)— y el `apps/view` no es importable desde ahí. ADR-056: un primitivo no
 * cierra su fase hasta vivir en `libs/` compartido.
 *
 * ⚠️ Y el motivo de fondo, no la conveniencia: si el módulo dice «falta el costo de ventas» y la
 * portada de Dirección dice otra cosa, el que hace clic no encuentra lo que le dijeron. Es la
 * misma razón por la que `[PVI.17]` subió el filtro del ejercicio de prueba.
 *
 * ── Lo medido en prod el 2026-10-09 ─────────────────────────────────────────────────────────
 *
 *     PRE-2026-002   ingreso 33   costo_ventas 0   gasto 12
 *     PRE-2027-002   ingreso 33   costo_ventas 0   gasto 14
 *     (duplicado)    ingreso 33   costo_ventas 0   gasto 14
 *
 * El `CHECK` de `budget.budget_lines.line_type` admite SEIS tipos y en toda la base existen DOS.
 * **El casillero del costo de ventas existe y está vacío** — no es un hueco de diseño, es uno sin
 * llenar, y por eso se puede nombrar en vez de decir «no se puede calcular».
 *
 * ⛔ Sin `costo_ventas`, `ingreso − gasto` publicaría **87.6 % de margen** sobre un ejercicio que
 * todavía no presupuestó lo que vende. Por eso el resultado se declara `null` con su motivo.
 */

/** Los seis tipos que el `CHECK` de `budget.budget_lines` admite, en el orden en que se leen. */
export const TIPOS_LEDGER = [
  'ingreso',
  'costo_ventas',
  'gasto',
  'compra_inventario',
  'inversion',
  'flujo',
] as const;

export type TipoLedger = (typeof TIPOS_LEDGER)[number];

/**
 * Los tres lados que la cuenta del resultado necesita sí o sí.
 *
 * ⚠️ `compra_inventario`, `inversion` y `flujo` quedan fuera a propósito: no entran al estado de
 * resultados (son balance y tesorería). Agregar uno acá cambia qué ejercicios pueden declarar
 * resultado, así que es una decisión contable, no una línea de código.
 */
export const LADOS_NECESARIOS: readonly TipoLedger[] = ['ingreso', 'costo_ventas', 'gasto'];

/** Rótulo legible de un tipo de partida. */
export function tipoLedgerLabel(t: TipoLedger): string {
  return (
    {
      ingreso: 'Ingreso',
      costo_ventas: 'Costo de ventas',
      gasto: 'Gasto operativo',
      compra_inventario: 'Compra de inventario',
      inversion: 'Inversión',
      flujo: 'Flujo',
    } as Record<TipoLedger, string>
  )[t];
}

/**
 * `[PVI.17]` **Qué lados le faltan a un ejercicio para poder declarar un resultado.**
 *
 * @param presentes los `line_type` que ese ejercicio SÍ tiene. «Vale cero» no es «no existe»: un
 *   `costo_ventas` presupuestado en $0 **está presente** y permite restar; uno ausente, no.
 */
export function ladosFaltantes(presentes: Iterable<string>): TipoLedger[] {
  const hay = new Set(presentes);
  return LADOS_NECESARIOS.filter((t) => !hay.has(t));
}

/** Lo que hace falta saber de un ejercicio para decidir si se firma o se devuelve. */
export interface EstadoEjercicioPendiente {
  /** Los `line_type` que ese ejercicio tiene. */
  tipos: readonly string[];
  /** El crecimiento supuesto por canal. */
  crecimiento: Readonly<Record<string, number>> | null;
  /**
   * Con qué se respalda cada canal.
   *
   * ⚠️ `null` **no es «nadie lo respalda»**: es que la columna nunca se escribió — la fila puede
   * ser anterior a `[PVI.3]`, o el autopiloto todavía no pasó. Por eso el texto dice «sin
   * procedencia registrada» y no «sin respaldo»: son dos afirmaciones distintas y sólo una es
   * medible con esta columna.
   */
  procedencia: Readonly<Record<string, unknown>> | null;
}

/**
 * `[PVI.17]` **Qué decir de un ejercicio que espera firma, en una línea.**
 *
 * Vive acá y no dentro del registro de bandejas porque es **lo que se afirma**, no cómo se
 * consulta — y afirmar de más es el riesgo real: decir «4 supuestos sin respaldo» cuando lo
 * medible es «sin procedencia registrada» convierte una columna vacía en una acusación.
 *
 * ⛔ Un canal cuenta sólo si **tiene un número que defender**. Medido en prod el 2026-10-09:
 * `PRE-2026-002` tiene sus 4 canales en 0 —no hay supuesto que respaldar— y `PRE-2027-002` tiene
 * los 4 con número y `growth_provenance` en NULL. Marcar los ceros sería inventar trabajo.
 */
export function resumenEjercicioPendiente(e: EstadoEjercicioPendiente): {
  faltan: TipoLedger[];
  supuestos_sin_procedencia: number;
  nota: string;
  hay_pendiente: boolean;
} {
  const faltan = ladosFaltantes(e.tipos ?? []);
  const crec = e.crecimiento ?? {};
  const proc = e.procedencia ?? null;
  const supuestos = Object.entries(crec).filter(
    ([canal, pct]) => Number(pct) !== 0 && !(proc && proc[canal] != null),
  ).length;

  const partes: string[] = [];
  if (faltan.length) partes.push(`falta ${faltan.map(tipoLedgerLabel).join(' y ')}`);
  if (supuestos) {
    partes.push(
      `${supuestos} supuesto${supuestos === 1 ? '' : 's'} de crecimiento sin procedencia registrada`,
    );
  }

  return {
    faltan,
    supuestos_sin_procedencia: supuestos,
    // «Listo para firmar» es una afirmación fuerte: sólo cuando de verdad no falta nada.
    nota: partes.length ? partes.join(' · ') : 'Listo para firmar',
    hay_pendiente: partes.length > 0,
  };
}
