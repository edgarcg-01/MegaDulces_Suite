'use strict';
/**
 * `[FLT.21]` — El quinto motivo: **estaba en la tienda y no estaba en el anaquel**.
 *
 * ── Por qué falta un motivo ─────────────────────────────────────────────────────────────────
 * La primera versión tenía cuatro motivos y **colapsaba el caso más recuperable de todos**.
 * Cuando la persona del mostrador decía "no hay" y el ERP decía que sí había, la pantalla lo
 * rotulaba *"puede estar guardado o mal contado — se revisa como diferencia de inventario"* y la
 * bandeja de Compras lo mandaba a inventario.
 *
 * Eso está mal enfocado, y el negocio lo dijo antes que la medición: **la mayoría de esas veces no
 * hay ningún error de inventario — el producto está en la tienda y no está en el anaquel.** Es una
 * venta que se recupera HOY, caminando a la bodega, y se estaba mandando a la cola más lenta.
 *
 * ── Los tres destinos, que antes eran dos ───────────────────────────────────────────────────
 *   · `no_en_anaquel`  → **PISO**: hay existencia, falta surtir. Se recupera el mismo día.
 *   · `agotado` / `no_en_sucursal` / `no_en_catalogo` → **COMPRAS**: reposición o alta.
 *   · `agotado` CON existencia > 0 → **INVENTARIO**: la persona insiste en que no hay y el
 *     sistema dice que sí. Eso sí es un descuadre afirmado, y sólo se afirma cuando alguien lo
 *     buscó. Antes se afirmaba solo, por construcción.
 *
 * El destino **NO se guarda**: se deriva de (`kind`, `on_hand_at_report`) en el servicio. Guardarlo
 * sería una segunda copia de algo que ya se puede calcular, y el día que cambie la regla quedarían
 * filas viejas afirmando un destino que la regla nueva no les daría.
 *
 * ── Aditiva de verdad ───────────────────────────────────────────────────────────────────────
 * Sólo AMPLÍA el CHECK. Las 9 filas que ya viven en producción siguen siendo válidas y no se
 * tocan; ninguna se reclasifica, porque reclasificar a posteriori sería inventarle a la cajera una
 * intención que no expresó.
 *
 * @param { import("knex").Knex } knex
 */

const KINDS = ['agotado', 'no_en_anaquel', 'no_en_sucursal', 'no_en_catalogo', 'codigo_no_pasa'];

exports.up = async function up(knex) {
  const existe = await knex.schema.withSchema('commercial').hasTable('floor_stockouts');
  if (!existe) return; // la tabla base la crea 20260919150000

  // Idempotente: si el CHECK ya admite el motivo nuevo, no hay nada que hacer.
  const { rows } = await knex.raw(
    `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid = 'commercial.floor_stockouts'::regclass
        AND conname = 'commercial_floor_stockouts_kind_chk'`,
  );
  if (rows[0]?.def?.includes('no_en_anaquel')) return;

  const lista = KINDS.map((k) => `'${k}'`).join(',');
  await knex.raw(`
    ALTER TABLE commercial.floor_stockouts
      DROP CONSTRAINT IF EXISTS commercial_floor_stockouts_kind_chk`);
  await knex.raw(`
    ALTER TABLE commercial.floor_stockouts
      ADD CONSTRAINT commercial_floor_stockouts_kind_chk
      CHECK (kind IN (${lista}))`);

  await knex.raw(`
    COMMENT ON COLUMN commercial.floor_stockouts.kind IS
      'agotado=no hay en la tienda (existencia 0) · no_en_anaquel=SI hay en la tienda pero no estaba en el anaquel, va a PISO y se recupera el mismo dia · no_en_sucursal=existe pero esta plaza no lo maneja · no_en_catalogo=nadie lo compra nunca (product_id NULL) · codigo_no_pasa=el codigo existe y el escaneo fallo igual. El DESTINO no se guarda: se deriva de (kind, on_hand_at_report).'`);

  // ⚠️ NO se agrega indice para el motivo nuevo, a proposito. Se midio contra los 7 que ya
  // existen: ninguna consulta filtra por (motivo, sucursal) — la bandeja de Compras la sirve
  // `ix_floor_stockouts_bandeja (tenant_id, status, est_lost_revenue DESC NULLS LAST)` y el
  // resumen es un agregado sobre toda la tabla. El parcial que si existe
  // (`ix_floor_stockouts_codigo_no_pasa`) tiene un consumidor real: el endpoint de codigos que
  // fallan. Este no lo tendria hasta que exista una bandeja de Piso por sucursal, y un indice
  // sin consulta no es prevencion: es peso en cada INSERT y una linea que despues nadie se
  // anima a borrar porque no sabe si alguien la usa.
};

exports.down = async function down(knex) {
  const existe = await knex.schema.withSchema('commercial').hasTable('floor_stockouts');
  if (!existe) return;

  // ⚠️ Volver atrás con filas `no_en_anaquel` vivas dejaría el CHECK imposible de crear. Se
  // DECLARA en vez de borrarlas a escondidas: el dato lo capturó una persona.
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM commercial.floor_stockouts WHERE kind = 'no_en_anaquel'`);
  if (rows[0].n > 0) {
    throw new Error(
      `Hay ${rows[0].n} reporte(s) con motivo 'no_en_anaquel'. Revertir dejaria el CHECK sin poder ` +
      'crearse. Decidir que se hace con esas filas ANTES de bajar esta migracion.',
    );
  }
  const viejos = ['agotado', 'no_en_sucursal', 'no_en_catalogo', 'codigo_no_pasa']
    .map((k) => `'${k}'`).join(',');
  await knex.raw(`ALTER TABLE commercial.floor_stockouts DROP CONSTRAINT IF EXISTS commercial_floor_stockouts_kind_chk`);
  await knex.raw(`
    ALTER TABLE commercial.floor_stockouts
      ADD CONSTRAINT commercial_floor_stockouts_kind_chk CHECK (kind IN (${viejos}))`);
};
