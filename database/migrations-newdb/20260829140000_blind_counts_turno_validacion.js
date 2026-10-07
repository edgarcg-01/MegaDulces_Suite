'use strict';
/**
 * `[SM.12]` — El arqueo se engancha al TURNO de Kepler y lo valida la encargada.
 *
 * Dos cosas que faltaban para que el arqueo de tienda sea auditable de punta a punta:
 *
 * 1. **A qué turno pertenece.** Hasta ahora el arqueo se ataba por
 *    `(sucursal, caja, fecha, cajero)` y el motor buscaba el corte que coincidiera.
 *    Eso funciona, pero deja el vínculo implícito: si hay dos cortes de la misma
 *    caja en el día (pasa en ~4.5% de caja-días) el match queda ambiguo y el
 *    servicio tiene que devolver `ambiguous` en vez de una comparación. Guardar el
 *    **folio del corte** convierte esa deducción en un hecho: se arquea ESE turno,
 *    el que Kepler abrió, con su caja y su hora.
 *
 * 2. **Quién lo validó.** El conteo lo captura la cajera; la encargada va a su
 *    lugar, verifica el efectivo y lo firma. Sin esas columnas, "validado" vivía
 *    en la palabra de alguien. `validado_por`/`validado_at` NULL = pendiente de
 *    validar, que es el estado inicial y el que alimenta la bandeja.
 *
 * `caja_kepler` guarda la caja **tal como la reporta Kepler** en el turno. Es
 * redundante con `caja` a propósito: `caja` es lo que se capturó y `caja_kepler`
 * lo que el ERP dice que le tocaba: si algún día divergen, quedó registrado en vez
 * de pisarse.
 *
 * Aditiva e idempotente (`hasColumn`). No toca RLS ni permisos de tabla. No
 * requiere re-login.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const has = await knex.schema.withSchema('reconciliation').hasTable('blind_counts');
  if (!has) return; // entorno sin SM.8 aplicado: nada que extender

  const add = async (col, cb) => {
    if (!(await knex.schema.withSchema('reconciliation').hasColumn('blind_counts', col))) {
      await knex.schema.withSchema('reconciliation').alterTable('blind_counts', cb);
    }
  };

  // ── 1. Vínculo con el turno de Kepler ──────────────────────────────────────
  await add('cash_cut_folio', (t) => t.text('cash_cut_folio'));   // kdpv_folio_caja.c3
  await add('caja_kepler', (t) => t.text('caja_kepler'));         // kdpv_folio_caja.c2
  await add('turno_abierto_at', (t) => t.timestamp('turno_abierto_at', { useTz: true })); // c5 + c6

  // ── 2. Validación presencial de la encargada ───────────────────────────────
  await add('validado_por', (t) => t.text('validado_por'));
  await add('validado_at', (t) => t.timestamp('validado_at', { useTz: true }));
  await add('validado_nota', (t) => t.text('validado_nota'));

  // Bandeja "arqueos por validar": el filtro real es tenant + pendiente, ordenado
  // por captura. Parcial para que el índice no cargue el histórico ya firmado.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_blind_counts_por_validar
      ON reconciliation.blind_counts (tenant_id, captured_at DESC)
      WHERE validado_at IS NULL
  `);
  // Un turno de Kepler se arquea una vez (por tipo): cierre y relevo conviven.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_blind_counts_folio
      ON reconciliation.blind_counts (tenant_id, warehouse_code, cash_cut_folio)
      WHERE cash_cut_folio IS NOT NULL
  `);

  await knex.raw(`COMMENT ON COLUMN reconciliation.blind_counts.cash_cut_folio IS
    'Folio del corte de Kepler (kdpv_folio_caja.c3) que este arqueo cuenta. NULL = capturado sin turno (supervisor/contingencia).'`);
  await knex.raw(`COMMENT ON COLUMN reconciliation.blind_counts.validado_at IS
    'NULL = pendiente de validación presencial de la encargada.'`);
};

exports.down = async function down() {
  /* aditiva; no se dropean columnas con datos de dinero */
};
