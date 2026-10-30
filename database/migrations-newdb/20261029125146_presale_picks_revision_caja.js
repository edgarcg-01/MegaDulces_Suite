'use strict';
/**
 * `[MCP.10]` — la REVISIÓN EN CAJA de un pedido de preventa ya surtido: quién lo revisó, a qué hora
 * y qué cambió (lo que la cajera completó con el surtidor o confirmó que no hubo).
 *
 * ── Por qué columnas en `presale_picks` y no una tabla nueva ────────────────────────────────
 * La revisión es UNA por surtido y lo sigue: es el siguiente paso del mismo hecho (empezó → terminó
 * → se revisó). Una tabla aparte sería una segunda fila por pedido que hay que mantener alineada con
 * ésta (regla 2: se extiende la que existe).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-29) ────────────────────────────────────────
 *  · Padre Hidalgo (01): 28 pedidos surtidos, 8 con faltantes, 2 con un renglón BORRADO entero.
 *  · En los 8 con faltantes Kepler decía que sí había (lo que motivó la revisión en caja).
 *  · 109 renglones de pedidos surtidos, 0 sin `requested_quantity`, 6 recortados.
 *
 * ── Lo que guarda ───────────────────────────────────────────────────────────────────────────
 *  · `reviewed_by` / `reviewed_by_name` / `reviewed_at` — quién la cerró y a qué hora (el nombre de
 *    la ficha AL MOMENTO, como `started_by_name`).
 *  · `review` — cada renglón: lo pedido, lo que surtió el surtidor, lo que quedó y cómo se resolvió
 *    (bien · completo · no_hubo · devuelto), con el total antes y después.
 *  · `review_required` — si el surtido tiene que pasar por la caja. `false` para lo surtido antes de
 *    esta migración (medido: 30 surtidos en prod, todos `confirmed`), `true` para lo nuevo.
 *
 * ⚠️ El código nuevo lee estas columnas: aplicarla ANTES de desplegar.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const COLS = [
  ['reviewed_by', (t) => t.uuid('reviewed_by')],
  ['reviewed_by_name', (t) => t.string('reviewed_by_name', 160)],
  ['reviewed_at', (t) => t.timestamp('reviewed_at', { useTz: true })],
  ['review', (t) => t.jsonb('review')],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const [col, add] of COLS) {
    const tiene = await knex.schema.withSchema('commercial').hasColumn('presale_picks', col);
    if (!tiene) await knex.schema.withSchema('commercial').alterTable('presale_picks', (t) => add(t));
  }

  // ¿Este surtido tiene que pasar por la caja? Lo surtido ANTES de que existiera la revisión, no:
  // en prod los 30 surtidos de antes siguen `confirmed` (nada los pasa a entregado), y sin esto
  // aparecerían todos de golpe como «no revisados» y la lista crecería para siempre. Lo nuevo nace
  // en `true` y se queda en la lista de la cajera, sin límite de días, hasta que alguien lo revise.
  // El UPDATE sólo corre cuando la columna nace: re-aplicar la migración no toca lo ya decidido.
  const tieneRequiere = await knex.schema.withSchema('commercial').hasColumn('presale_picks', 'review_required');
  if (!tieneRequiere) {
    await knex.schema.withSchema('commercial').alterTable('presale_picks', (t) => {
      t.boolean('review_required').notNullable().defaultTo(true);
    });
    const n = await knex('commercial.presale_picks').whereNotNull('finished_at').update({ review_required: false });
    console.log(`  [MCP.10] ${n} surtido(s) de antes de la revisión quedan fuera de la lista de la caja.`);
  }

  // La revisión es coherente o no es: quién, cuándo y qué van JUNTOS, y sólo sobre algo surtido.
  await knex.raw('ALTER TABLE commercial.presale_picks DROP CONSTRAINT IF EXISTS presale_picks_revision_ck');
  await knex.raw(`
    ALTER TABLE commercial.presale_picks
      ADD CONSTRAINT presale_picks_revision_ck
      CHECK (
        (reviewed_at IS NULL AND reviewed_by IS NULL AND review IS NULL)
        OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND review IS NOT NULL
            AND finished_at IS NOT NULL AND reviewed_at >= finished_at)
      )`);
  // La bandeja de la caja busca «surtido y sin revisar» por sucursal.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_presale_picks_revision
      ON commercial.presale_picks (tenant_id, warehouse_id, reviewed_at, finished_at)`);

  await knex.raw(`COMMENT ON COLUMN commercial.presale_picks.review IS
    'MCP.10 — revisión en caja: por renglón lo pedido, lo surtido, lo que quedó y cómo se resolvió (bien/completo/no_hubo/devuelto), con total antes y después.'`);

  // ── COMPUERTA: PRUEBA NEGATIVA del CHECK ────────────────────────────────────────────────
  // Una revisión sin quién debe rebotar. En SAVEPOINT (la migración es una sola transacción) y
  // sobre un surtido TERMINADO: si no hay sujeto, se DECLARA en vez de darse por buena.
  const { rows: sujeto } = await knex.raw(`
    SELECT tenant_id, id FROM commercial.presale_picks
     WHERE finished_at IS NOT NULL AND reviewed_at IS NULL LIMIT 1`);
  if (!sujeto.length) {
    console.log('  [MCP.10] ◻ NO MEDIDO: no hay un surtido terminado sin revisar con el que probar el CHECK.');
  } else {
    await knex.raw('SAVEPOINT mcp10_neg');
    let reboto = false;
    try {
      await knex.raw(
        `UPDATE commercial.presale_picks SET reviewed_at = now(), review = '{}'::jsonb
          WHERE tenant_id = ? AND id = ?`,
        [sujeto[0].tenant_id, sujeto[0].id],
      );
    } catch (e) {
      reboto = /presale_picks_revision_ck|violates check/i.test(e.message);
    }
    await knex.raw('ROLLBACK TO SAVEPOINT mcp10_neg');
    await knex.raw('RELEASE SAVEPOINT mcp10_neg');
    if (!reboto) {
      throw new Error('[MCP.10] el CHECK de la revisión NO rechazó una revisión sin quién: es decorativo.');
    }
    console.log('  [MCP.10] prueba negativa de la revisión OK.');
  }
  console.log('  [MCP.10] presale_picks lista para la revisión en caja.');
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS commercial.idx_presale_picks_revision');
  await knex.raw('ALTER TABLE commercial.presale_picks DROP CONSTRAINT IF EXISTS presale_picks_revision_ck');
  await knex.raw('ALTER TABLE commercial.presale_picks DROP COLUMN IF EXISTS review_required');
  for (const [col] of [...COLS].reverse()) {
    await knex.raw(`ALTER TABLE commercial.presale_picks DROP COLUMN IF EXISTS ${col}`);
  }
};
