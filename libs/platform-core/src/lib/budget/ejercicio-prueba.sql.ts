/**
 * `[PVI.17]` — **El ejercicio de prueba se excluye en UN solo lugar.**
 *
 * ── Por qué existe este archivo ─────────────────────────────────────────────────────────────
 *
 * `budget.budgets` tiene un duplicado marcado `is_test` que es copia **byte a byte** del real.
 * Medido en prod el 2026-10-09:
 *
 *     budget.expense_obligations, status 'propuesta'
 *       is_test = false   156 obligaciones   $74,809,091.57
 *       is_test = true    156 obligaciones   $74,809,091.57   ← el duplicado
 *
 * Exactamente la mitad. Cualquier cifra que no excluya la copia publica **el doble**, y se ve
 * perfectamente normal: no hay un decimal raro ni un renglón de más que delate el error.
 *
 * ⭐ Y ya pasó: esta misma sesión midió «312 obligaciones por $149,618,183.14» y lo reportó como
 * un hecho, a punto de cablearlo a la portada de Dirección. Lo atrapó otra sesión, que tenía el
 * filtro escrito adentro de su servicio. **Dos definiciones de la misma cola es cómo nacen los
 * dos números** — así que el filtro deja de vivir adentro de un servicio y pasa a ser un
 * primitivo compartido (ADR-056: un mecanismo genérico no cierra su fase hasta vivir en `libs/`).
 *
 * Hoy lo consumen `PendingApprovalsService` (`libs/finance`) y el registro de bandejas de «Mi
 * trabajo» (`libs/trade`), que son dos librerías distintas y no se pueden importar entre sí —
 * por eso el primitivo vive acá, junto a `branchKeySql`, que resolvió el mismo tipo de problema
 * (una regla de negocio copiada **en tres lugares distintos**, con uno de ellos ya divergido).
 *
 * ── ⛔ Por qué `NOT EXISTS` y no un `JOIN` ──────────────────────────────────────────────────
 *
 * `budget.expense_obligations` **no tiene `budget_id`**: el salto es de dos pasos,
 * `budget_line_id → budget_lines.budget_id → budgets.is_test`. Con un `JOIN` también se caerían
 * las obligaciones **sin partida**, que no son de prueba — sólo no están ligadas a un ejercicio.
 * Hoy son 0 (medido), y justamente por eso el defecto sería invisible: la primera obligación
 * suelta que alguien capture desaparecería de la cola sin que nadie lo note.
 */

/**
 * `[PVI.17]` **La obligación NO cuelga de un ejercicio de prueba.**
 *
 * Se usa con `whereRaw` del lado del filtro, nunca sobre el `JOIN`.
 *
 * @param colLineaId cómo se nombra `budget_line_id` en la consulta que lo usa. Se interpola como
 *   identificador —no es entrada de usuario, es el alias que elige el llamador— igual que el
 *   `alias` de `branchKeySql`.
 */
export const obligacionNoEsDePruebaSql = (colLineaId = 'budget_line_id'): string =>
  `NOT EXISTS (SELECT 1 FROM budget.budget_lines bl
                 JOIN budget.budgets bb ON bb.id = bl.budget_id
                WHERE bl.id = ${colLineaId} AND bb.is_test = true)`;

/**
 * `[PVI.17]` **El ejercicio mismo no es de prueba.**
 *
 * ⚠️ `IS NOT TRUE` y no `= false`: la columna admite `NULL`, y un ejercicio con `is_test` sin
 * poner **no es de prueba** — con `= false` se caería de la cola en silencio. Es la misma forma
 * que ya usa `PendingApprovalsService` (`where is_test false OR is_test IS NULL`), acá en una
 * sola expresión para que no se pueda escribir a medias.
 */
export const ejercicioNoEsDePruebaSql = (alias = 'budgets'): string =>
  `${alias}.is_test IS NOT TRUE`;
