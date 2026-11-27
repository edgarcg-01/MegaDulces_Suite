'use strict';
/**
 * `[ICR.0.2][ICR.0.3][ICR.0.4]` — **Dónde está cada producto y en qué orden se camina hasta él**,
 * derivado (`derive-no-copy`, regla 1 / ADR-056): `commercial.v_product_bin_location`.
 *
 * Una fila por **asignación viva** (producto × ubicación), no por producto: un producto puede estar
 * en varias ubicaciones a la vez — medido el 2026-11-27 en prod: de 40 productos asignados, **5 están
 * en dos ubicaciones y 3 en tres**. Quien necesite UNA (la del surtido, el tramo del conteo) aplica
 * `ubicacionDe()` sobre estas filas; quien necesite todas (la ficha del conteo) las muestra todas.
 *
 * ── Por qué una vista y no una columna ───────────────────────────────────────────────────────
 * El inventario físico necesita saber en qué tramo del recorrido cae cada renglón del folio para
 * poder repartir el trabajo entre personas (fase ICR). Esa ubicación **no se copia al renglón**: si
 * alguien asigna una ubicación mientras el folio está abierto —que es justo lo que se quiere, porque
 * el conteo es el único momento en que alguien recorre la sucursal entera— el renglón tiene que
 * empezar a aparecer en el tramo de quien lo va a contar. Una foto tomada al sembrar no haría eso.
 *
 * ── Lo que esta vista SÍ decide, y lo que deja a quien la lee ────────────────────────────────
 * La vista **junta y filtra**: eso era lo que estaba duplicado. `apoyo-surtido.ts` (`[GP.RF.33]`,
 * decisión de Edgar del 2026-11-17) leía las dos tablas con un filtro, y el conteo físico, al
 * necesitar lo mismo tres meses después, escribió el suyo — con una diferencia real: **no excluía
 * las ubicaciones dadas de baja**. Hoy eso no cambia ningún número (476 de 476 están `activa`), pero
 * eran dos copias de la misma regla separándose, que es lo que ADR-056 cobra.
 *
 * ⛔ Lo que la vista **no** decide es **cuál ubicación gana** cuando hay varias (lugar fijo antes que
 * exhibición, y la reserva al final). Esa regla vive en UN solo lugar y es TypeScript:
 * `ubicacion-del-producto.ts` (`ORDEN_PAPEL` + `ubicacionDe`). Ponerla también acá, en un `CASE`,
 * volvería a ser dos copias — la trampa que esta migración existe para cerrar.
 *
 * ── `tramo`: el pedazo de recorrido, no el «pasillo» del otro catálogo ───────────────────────
 * `zona || '-' || pasillo` (`T-A`, `B-C`…), con `zona` ∈ {T = tienda, B = bodega} según
 * `ck_wh_bins_zona`. ⛔ **No** es `commercial.warehouse_aisles`, que tiene 4 filas («Pasillo 1»…
 * «Pasillo 4»), 0 ubicaciones colgando (`warehouse_bins.aisle_id`: 0 de 476) y 0 renglones de conteo
 * (`inventory_count_items.aisle_id`: 0 de 22,211). Lo que no tiene zona ni pasillo —las 3 carretas y
 * la ubicación legado— cae en `'sin-recorrido'`: **se declara, no se esconde** (regla 11).
 *
 * ⚠️ El producto que **no está en esta vista** no tiene ubicación, y eso es trabajo real: medido el
 * 2026-11-27 en Padre Hidalgo, **39 de 3,361** productos con existencia tienen ubicación (1.2 %). Su
 * tramo lo pone quien lee (el conteo lo llama «sin ubicar»); la vista no inventa una fila para él.
 *
 * ── Lo medido antes, sólo lectura, pg-prod `system_identifier` 7688376744939610156 (2026-11-27) ──
 *  · 51 asignaciones vivas · 40 productos · 5 ubicaciones ocupadas de 471 · 1 almacén.
 *  · Las 51 son `papel='exhibicion_tienda'` y caen todas en el tramo **`T-A`**.
 *  · ⛔ **Las 472 ubicaciones con recorrido son de TIENDA (`zona='T'`), ninguna de bodega.** El
 *    catálogo que existe es el del piso de venta de Padre Hidalgo; la bodega tiene **0**. El formato
 *    de `code` ya la contempla (`^([TB])([A-Z])(0[1-9]|[1-9][0-9])([1-9])$`), nadie la capturó.
 *  · `pick_sequence` es corrido por almacén y ya ordena los pasillos entre sí (A 20011–20995,
 *    B 40011–40995, … K 220011–220995). 472 de 476 lo tienen; las 4 sin él son las 3 carretas y el
 *    legado, que son las mismas que caen en `'sin-recorrido'`.
 *  · Las dos tablas tienen RLS **forzado** → la vista es `security_invoker`: quien la lee ve lo suyo.
 *
 * Sin tablas, sin filas, sin índices. Idempotente (`CREATE OR REPLACE VIEW`).
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'commercial.v_product_bin_location';

const SELECT_SQL = `
SELECT a.tenant_id,
       a.warehouse_id,
       a.product_id,
       a.bin_id,
       b.code                        AS bin_code,
       b.familia,
       b.zona,
       b.pasillo,
       b.rack,
       b.nivel,
       b.tipo,
       b.estado                      AS bin_estado,
       b.pick_sequence,
       a.papel,
       a.presentacion,
       a.presentacion_rotulo,
       -- El pedazo de recorrido al que pertenece la ubicación.
       CASE
         WHEN b.zona IS NOT NULL AND b.pasillo IS NOT NULL THEN b.zona || '-' || b.pasillo
         ELSE 'sin-recorrido'
       END                           AS tramo
  FROM commercial.bin_assignments a
  JOIN commercial.warehouse_bins b
    ON b.tenant_id = a.tenant_id AND b.id = a.bin_id
 WHERE a.deleted_at IS NULL
   AND b.estado <> 'baja'`;

exports.SELECT_SQL = SELECT_SQL;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} WITH (security_invoker = true) AS ${SELECT_SQL}`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    '[ICR.0.2] Donde esta cada producto y en que orden se camina hasta el. Una fila por asignacion VIVA (producto x ubicacion): un producto puede estar en varias. derive-no-copy sobre commercial.bin_assignments + warehouse_bins, sin las ubicaciones dadas de baja. tramo = zona-pasillo (T = tienda, B = bodega) o sin-recorrido. CUAL ubicacion gana cuando hay varias NO se decide aqui: esa regla vive en ubicacion-del-producto.ts (ORDEN_PAPEL), en un solo lugar. El producto que NO aparece no tiene ubicacion: es trabajo real, no una fila faltante.'`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);

  // Verificación: la vista tiene que existir, ser legible y no perder ni inventar filas contra su
  // fuente. Si no cuadra, la migración FALLA en vez de dejar una vista silenciosamente mal.
  const [{ vista }] = (await knex.raw(`SELECT count(*)::int AS vista FROM ${VISTA}`)).rows;
  const [{ fuente }] = (
    await knex.raw(`SELECT count(*)::int AS fuente
                      FROM commercial.bin_assignments a
                      JOIN commercial.warehouse_bins b
                        ON b.tenant_id = a.tenant_id AND b.id = a.bin_id
                     WHERE a.deleted_at IS NULL AND b.estado <> 'baja'`)
  ).rows;
  if (vista !== fuente) {
    throw new Error(`[ICR.0.2] la vista devuelve ${vista} filas y su fuente ${fuente}: no cuadra`);
  }
  const [{ sin_tramo }] = (
    await knex.raw(`SELECT count(*)::int AS sin_tramo FROM ${VISTA} WHERE tramo IS NULL`)
  ).rows;
  if (sin_tramo > 0) {
    throw new Error(`[ICR.0.2] ${sin_tramo} filas con tramo NULL: el 'sin-recorrido' no se aplicó`);
  }
  console.log(`  ✓ [ICR.0.2] ${VISTA} creada (security_invoker) · ${vista} asignaciones vivas`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista es nueva y nada dependía de ella antes. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
