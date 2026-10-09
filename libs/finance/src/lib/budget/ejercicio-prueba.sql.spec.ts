import knexFactory from 'knex';
import { ejercicioNoEsDePruebaSql, obligacionNoEsDePruebaSql } from '@megadulces/platform-core';

/**
 * `[PVI.17]` — **El filtro del ejercicio de prueba, ejercido.**
 *
 * ── Qué cubre y qué NO ──────────────────────────────────────────────────────────────────────
 *
 * Knex arma el SQL **sin conectarse a nada** (`client: 'pg'` basta). Eso deja probar el camino de
 * código real —el predicado tal como lo va a mandar el servicio— sin base y sin red. ⚠️ Lo que
 * NO prueba es que ese SQL sea correcto contra el esquema: un doble de knex nunca ejecuta nada.
 * Esa mitad se midió a mano contra prod el 2026-10-09 y queda escrita abajo, con sus cifras.
 *
 * ── La prueba negativa, medida ──────────────────────────────────────────────────────────────
 *
 *     con el predicado      156 obligaciones    $74,809,091.57
 *     sin el predicado      312 obligaciones   $149,618,183.14   ← el doble exacto
 *
 * El duplicado `is_test` es copia byte a byte del real, así que el error no deja rastro: no hay
 * un decimal raro ni un renglón de más que lo delate. Esta sesión lo publicó como un hecho antes
 * de que otra lo atrapara.
 *
 * ── ⛔ DOS protecciones que HOY NO SE PUEDEN MEDIR, y se declaran ───────────────────────────
 *
 * 1. **`NOT EXISTS` en vez de `JOIN`.** El `JOIN` también se comería las obligaciones SIN partida.
 *    Medido en prod: hay **0** obligaciones sueltas, así que las dos formas dan 156 y la mutación
 *    **no se pone roja**. La protección es para la primera obligación suelta que alguien capture.
 * 2. **`IS NOT TRUE` en vez de `= false`.** `budgets.is_test` admite `NULL`, y un ejercicio con la
 *    columna sin poner NO es de prueba. Medido: **0 nulos** hoy, así que las dos formas dan 2.
 *
 * Por eso estas dos se vigilan por la FORMA del SQL emitido —que es lo único medible sin esos
 * datos— y se dice que es una vigilancia de forma, no una comprobación de comportamiento. Un gate
 * que no puede fallar con los datos de hoy se declara; no se presenta como verde (ADR-056).
 */

const k = knexFactory({ client: 'pg' });

/** El SQL que de verdad sale hacia el driver, con sus bindings ya puestos. */
const sql = (qb: { toString(): string }) => qb.toString();

describe('[PVI.17] el predicado se emite y filtra', () => {
  it('⛔ LA PRUEBA NEGATIVA: sin el predicado la consulta no distingue el duplicado', () => {
    const conFiltro = sql(
      k('budget.expense_obligations').where({ status: 'propuesta' }).whereRaw(obligacionNoEsDePruebaSql()),
    );
    const sinFiltro = sql(k('budget.expense_obligations').where({ status: 'propuesta' }));

    // Medido contra prod: sinFiltro → 312 / $149,618,183.14; conFiltro → 156 / $74,809,091.57.
    expect(sinFiltro).not.toContain('is_test');
    expect(conFiltro).toContain('is_test');
    expect(conFiltro).not.toEqual(sinFiltro);
  });

  it('la obligación se filtra por los DOS saltos, no por una columna que no existe', () => {
    const s = sql(k('budget.expense_obligations').whereRaw(obligacionNoEsDePruebaSql()));
    // `expense_obligations` NO tiene `budget_id`: el salto es budget_line_id → budget_lines → budgets.
    expect(s).toContain('budget.budget_lines');
    expect(s).toContain('budget.budgets');
    expect(s).toContain('bl.budget_id');
    // El ÚNICO `budget_id` del SQL es el de `budget_lines`. Si apareciera uno colgado de la
    // obligación, sería una columna que esa tabla no tiene y la consulta reventaría en runtime.
    expect(s.match(/\bbudget_id\b/g)).toHaveLength(1);
    expect(s).not.toMatch(/(expense_obligations"?\.|\bo\.)budget_id\b/);
  });

  it('⛔ VIGILANCIA DE FORMA (hoy no falsable): NOT EXISTS, nunca un JOIN', () => {
    // Con 0 obligaciones sueltas en prod, un JOIN daría el mismo 156. Lo único medible sin ese
    // dato es que la forma emitida siga siendo la que protege al caso que todavía no ocurrió.
    expect(obligacionNoEsDePruebaSql()).toContain('NOT EXISTS');
    expect(obligacionNoEsDePruebaSql()).not.toMatch(/^\s*(inner\s+)?join/i);
  });

  it('el nombre de la columna lo elige el llamador (igual que el alias de branchKeySql)', () => {
    expect(obligacionNoEsDePruebaSql('o.budget_line_id')).toContain('bl.id = o.budget_line_id');
    expect(obligacionNoEsDePruebaSql()).toContain('bl.id = budget_line_id');
  });
});

describe('[PVI.17] el ejercicio mismo', () => {
  it('⛔ VIGILANCIA DE FORMA (hoy no falsable): IS NOT TRUE, nunca = false', () => {
    // Medido: 0 ejercicios con `is_test` nulo, así que las dos formas coinciden hoy. La diferencia
    // aparece con el primer ejercicio que se inserte sin tocar la columna — y ahí `= false` lo
    // sacaría de la cola en silencio.
    expect(ejercicioNoEsDePruebaSql()).toBe('budgets.is_test IS NOT TRUE');
    expect(ejercicioNoEsDePruebaSql()).not.toContain('= false');
  });

  it('acepta el alias de la consulta que lo usa', () => {
    expect(ejercicioNoEsDePruebaSql('b')).toBe('b.is_test IS NOT TRUE');
  });

  it('se emite dentro de la consulta de la cola de ejercicios', () => {
    const s = sql(
      k('budget.budgets').where({ status: 'pendiente' }).whereRaw(ejercicioNoEsDePruebaSql('budget.budgets')),
    );
    expect(s).toContain('budget.budgets.is_test IS NOT TRUE');
  });
});
