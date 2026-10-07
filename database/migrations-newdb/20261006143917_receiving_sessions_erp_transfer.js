/**
 * `[WMS-REC.17]` — **El vale del Andén también se abre desde un EMBARQUE de traspaso.**
 *
 * Reporte (2026-10-06): *«CEDIS mandó mercancía a Padre Hidalgo y no aparece en la sección
 * para dar de alta las caducidades»*. El Andén sólo leía la orden de entrada `XA2001`, que es
 * el documento de las COMPRAS. Un traspaso viaja en otro: el embarque `U-D-41` de quien manda
 * (y la recepción `U-A-50` de quien recibe). Mientras el CEDIS vivió en Wincaja, la sucursal
 * registraba su mercancía como una compra a `TI000` y por eso se veía; desde que el CEDIS
 * entró a Kepler (30-sep) la manda con su embarque, y el Andén no la encontraba.
 *
 * Esta migración sólo amplía el CHECK de `source_kind` con `erp_transfer`. La referencia del
 * vale (`source_ref`) toma la forma `UD41/<origen>/<serie>/<folio>`: el primer segmento NO es
 * una sucursal a propósito, para que los lectores de `source_ref` como `sucursal/folio` no lo
 * crucen con una orden de entrada que tenga el mismo folio.
 *
 * Sin tabla, sin columna, sin importer: el embarque se lee en vivo de `kepler_ods`.
 *
 * ⚠️ **Va ANTES que el código.** Sin ella, abrir un vale de traspaso choca con el CHECK
 * (`commercial_recv_sessions_source_chk`) y la pantalla muestra el error del servidor.
 *
 * Idempotente: el CHECK se reemplaza por nombre. La tabla es chica (un renglón por camión
 * recibido), así que validar las filas existentes dentro de la misma transacción es instantáneo;
 * el `lock_timeout` evita quedarse esperando detrás de una captura larga.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`SET LOCAL lock_timeout = '10s'`);
  await knex.raw(`ALTER TABLE commercial.receiving_sessions DROP CONSTRAINT IF EXISTS commercial_recv_sessions_source_chk`);
  await knex.raw(`
    ALTER TABLE commercial.receiving_sessions
      ADD CONSTRAINT commercial_recv_sessions_source_chk
      CHECK (source_kind IN ('manual', 'erp_receipt', 'erp_transfer'))
  `);
  await knex.raw(`
    COMMENT ON COLUMN commercial.receiving_sessions.source_kind IS
      'manual | erp_receipt (orden de entrada XA2001, source_ref = sucursal/folio) | erp_transfer (embarque U-D-41 de traspaso, source_ref = UD41/origen/serie/folio) — WMS-REC.17'
  `);
};

exports.down = async function (knex) {
  // Sólo si no quedó ningún vale de traspaso: si hay, bajar el CHECK lo rompería.
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM commercial.receiving_sessions WHERE source_kind = 'erp_transfer'`,
  );
  if (rows[0].n > 0) throw new Error(`Hay ${rows[0].n} vales de traspaso: no se puede quitar 'erp_transfer' del CHECK`);
  await knex.raw(`ALTER TABLE commercial.receiving_sessions DROP CONSTRAINT IF EXISTS commercial_recv_sessions_source_chk`);
  await knex.raw(`
    ALTER TABLE commercial.receiving_sessions
      ADD CONSTRAINT commercial_recv_sessions_source_chk
      CHECK (source_kind IN ('manual', 'erp_receipt'))
  `);
};
