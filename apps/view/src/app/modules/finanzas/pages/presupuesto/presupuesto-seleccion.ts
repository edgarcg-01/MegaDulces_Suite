/**
 * `[PVI.15]` — **Qué ejercicio abre la pantalla.**
 *
 * ── El defecto, medido en prod el 2026-10-09 ─────────────────────────────────────────────────
 *
 * El front abría sobre `rows[0]`, y `listBudgets()` ordenaba por `fiscal_year DESC, created_at
 * DESC`. El duplicado marcado `is_test` quedaba **primero justo por ser el más nuevo**:
 *
 *   1 | SIN FOLIO     | PRUEBA ciclo ledger — no usar | fy=2027 | is_test=true   ← se abría acá
 *   2 | PRE-2027-002  | Presupuesto 2027              | fy=2027 | is_test=false
 *
 * ⇒ Los **$604,775,116** de meta, los 429 renglones y los supuestos que se veían en pantalla eran
 * los de la **copia de prueba**. Y nada lo decía: el chip sólo imprime `borrador`.
 *
 * ⭐ Es la cara de LECTURA del mismo defecto que `[PVI.11]` cortó del lado de la ESCRITURA.
 *
 * ── Por qué esto vive acá y no en el `ORDER BY` ──────────────────────────────────────────────
 *
 * El backend ya manda los de prueba al final, y con eso solo el síntoma desaparece. Pero
 * **apoyar una garantía en el orden de una consulta es exactamente como nació este defecto**: el
 * `ORDER BY` estaba bien para lo que se escribió (lo más nuevo primero) y mal para lo que alguien
 * dedujo de él. La elección se declara, se prueba, y no depende de cómo llegó la lista.
 *
 * ⚠️ No esconde nada: un ejercicio de prueba es legítimo y se puede elegir a mano. Lo que no
 * puede es **abrirse solo**.
 */

/** Lo mínimo que hace falta para elegir. Estructural: cualquier encabezado lo satisface. */
export interface EjercicioElegible {
  id: string;
  is_test?: boolean | null;
}

/**
 * El ejercicio con el que abre la pantalla.
 *
 * ⛔ `is_test === true` y no un truthy: `null`/`undefined` es «la columna no existía cuando se
 * guardó», no «es de prueba». Tratarlo como prueba escondería ejercicios REALES viejos — el daño
 * simétrico, y el más difícil de notar porque la pantalla simplemente abriría en otro.
 */
export function ejercicioInicial<T extends EjercicioElegible>(rows: readonly T[] | null | undefined): T | null {
  if (!rows?.length) return null;
  const real = rows.find((r) => r.is_test !== true);
  // Si TODOS son de prueba no se inventa un vacío: se abre en el primero, que es honesto —
  // hay algo que mirar— y el rótulo de la pantalla dice lo que es.
  return real ?? rows[0];
}

/** `true` cuando el ejercicio elegido es de prueba y hay que rotularlo en pantalla. */
export function esDePrueba(b: EjercicioElegible | null | undefined): boolean {
  return b?.is_test === true;
}
