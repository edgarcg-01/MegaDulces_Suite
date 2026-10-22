'use strict';
/**
 * `[PGP.5]` — **Un documento de Kepler no puede tener dos obligaciones vivas.**
 *
 * ── Qué lo motiva ───────────────────────────────────────────────────────────────────────────
 * Medido el 2026-10-22 en prod: `commercial.supplier_payment_obligations` tiene **un solo**
 * candado de unicidad, `ux_spo_delivery_line`, y es sobre `purchase_delivery_line_id`. Protege
 * al único camino que existía (`[TP.15]`, aceptar un renglón de entrega) y **a ningún otro**.
 *
 * `[PGP.6]` agrega el camino que faltaba —elegir un documento del pendiente vivo de Kepler y
 * programarlo— y ése **no tiene renglón de entrega**: su `purchase_delivery_line_id` es `NULL`,
 * así que el índice parcial existente no lo mira. Sin este candado, **dos clics crean dos
 * obligaciones del mismo documento**, cada una reservable y pagable por separado. El resultado
 * no es una fila de más: es un pago duplicado, que es el defecto que la Fase CXP ya tiene un
 * detector para cazar DESPUÉS de que ocurre.
 *
 * ── Por qué parcial, y por qué excluye las canceladas ───────────────────────────────────────
 * `WHERE kepler_folio IS NOT NULL` — la obligación capturada a mano (sin procedencia de Kepler)
 * es legítima y no se toca; hoy son 0 de 37, pero el camino existe.
 * `AND status <> 'cancelled'` — cancelar una obligación equivocada y volver a crearla bien es el
 * flujo normal. Sin esta mitad, el primer error dejaría el documento bloqueado para siempre.
 *
 * ── Por qué UNA obligación por documento y no varias ────────────────────────────────────────
 * El pago parcial ya se modela **dentro** de la obligación (`reserved_amount`, `paid_amount`) y
 * los montos se aplican con `payment_allocation_items`. Dos obligaciones para el mismo documento
 * no son dos parcialidades: son el mismo saldo contado dos veces.
 *
 * ── ⛔ Los caminos que insertan, recorridos uno por uno ──────────────────────────────────────
 * (La regla de `CLAUDE.md`: al cambiar una llave, se recorren TODOS los que escriben.)
 *
 *  1. `supplier-payment-obligations.service.ts` → `create()` — captura a mano. **No setea
 *     `kepler_*`**, así que el índice parcial no le aplica. Sin cambios.
 *  2. `purchase-deliveries.service.ts` → `toCalendar()` (`[TP.15]`) — **SÍ le aplica.** Su
 *     `ON CONFLICT` nombra el otro índice, así que un choque contra éste sería un error y no un
 *     `DO NOTHING`. Se le agrega un `NOT EXISTS` por la tupla de Kepler en el mismo commit.
 *  3. El backfill de la migración `20261016002604` — ya corrió y es `ON CONFLICT DO NOTHING`
 *     sobre el índice de entrega; no vuelve a correr.
 *  4. `[PGP.6]`, el camino nuevo — nace con `ON CONFLICT` sobre **este** índice.
 *
 * ── Verificación previa ─────────────────────────────────────────────────────────────────────
 * Medido antes de escribirla: **cero** documentos de Kepler con más de una obligación viva, así
 * que el índice entra sin tener que limpiar nada. El `up` igual lo comprueba y **se niega** si
 * encuentra duplicados, en vez de reventar con un error de índice que no dice qué pasó.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const INDICE = 'ux_spo_kepler_doc';

exports.up = async function up(knex) {
  const { rows: dup } = await knex.raw(`
    SELECT tenant_id, kepler_sucursal, kepler_doc_tipo, kepler_doc_sub, kepler_folio, count(*) AS n
      FROM commercial.supplier_payment_obligations
     WHERE kepler_folio IS NOT NULL AND status <> 'cancelled'
     GROUP BY 1,2,3,4,5 HAVING count(*) > 1`);
  if (dup.length > 0) {
    console.error(`  [PGP.5] ⛔ ${dup.length} documento(s) de Kepler ya tienen más de una obligación viva:`);
    for (const d of dup.slice(0, 10)) {
      console.error(`           ${d.kepler_sucursal}-${d.kepler_folio} (tipo ${d.kepler_doc_tipo}/${d.kepler_doc_sub}): ${d.n} obligaciones`);
    }
    throw new Error(
      '[PGP.5] Hay documentos con obligación duplicada. Se cancelan las sobrantes ANTES de poner el candado: ' +
        'el índice no decide cuál se queda, y esa decisión es de quien paga.',
    );
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${INDICE}
        ON commercial.supplier_payment_obligations
           (tenant_id, kepler_sucursal, kepler_doc_tipo, kepler_doc_sub, kepler_folio)
     WHERE kepler_folio IS NOT NULL AND status <> 'cancelled'`);
  console.log(`  [PGP.5] índice ${INDICE}: un documento de Kepler = una obligación viva`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.${INDICE}`);
};
