/**
 * `[ETQ-CAMBIOS.2]` Los cambios de precio con su ANTES y su DESPUÉS, derivados del ODS.
 *
 * Vista `derive-no-copy` sobre `kepler_ods.kdpv_bitacora_precios`, la bitácora NATIVA de Kepler.
 * Es la única fuente del sistema que guarda el precio anterior: medido, ninguna tabla propia lo
 * tiene (deuda `VP.3`). Sin ella la pantalla de cambios no puede tener ni selector de fechas ni
 * "antes vs después" — `product_label_prices.updated_at` guarda el ÚLTIMO toque, no un registro,
 * así que preguntarle "qué cambió el martes" sólo acierta por casualidad.
 *
 * ── ⭐ El filtro, y por qué NO es un umbral inventado ────────────────────────────────────────
 * Kepler escribe una fila cada vez que RECALCULA, no cada vez que el precio cambia. Medido el
 * 2026-09-21 contra los replicas de origen: de **~54,500 filas de ayer** en las 9 ramas, sólo
 * **~102 cambian el precio que se imprime**. El 99.8% son deltas de menos de un centavo
 * (`3.3500 → 3.3480`), residuo de redondeo.
 *
 * El criterio es `round(c6,2) <> round(c7,2)`: **un cambio importa si cambia el número que sale
 * en la etiqueta**. No hay constante mágica que justificar — la etiqueta imprime dos decimales,
 * así que por debajo del centavo el papel sale idéntico. (Se probó `abs(c8) >= 0.01` primero y
 * dice casi lo mismo, pero éste se explica solo.)
 *
 * ⛔ El ruido se filtra ACÁ y no al shipear: el ODS es un espejo de Kepler, y un espejo que
 * filtra miente. La regla del proyecto es derivar en `analytics`, no recortar en la ingesta.
 *
 * ── ⚠️ Lo que se DECLARA en vez de esconderse ───────────────────────────────────────────────
 * `es_baja`: hay filas cuyo precio nuevo es **0.0000** (medido: `15173 ROLLO CHICO` pasó de
 * $1,726.15 a $0.00). Eso no es "bajó de precio", es que el ERP le quitó el precio — la etiqueta
 * de ese producto diría SIN PRECIO. Se publica con bandera en vez de filtrarse, porque es
 * exactamente lo que hay que ir a mirar al anaquel.
 *
 * `unidad` puede venir VACÍA: la bitácora registra por presentación y algunas filas no la traen.
 * Va como NULL, no como texto vacío, para que el consumidor pueda decidir.
 *
 * ── Índice ──────────────────────────────────────────────────────────────────────────────────
 * El PK de la tabla es `(sucursal, c1, c2, c3, c4)` sobre columnas CRUDAS, así que el filtro de
 * la pantalla —`sucursal = ? AND fecha = ?`— entra por ahí. Medido: 4 bloques, 0.1 ms.
 * ⛔ Por eso `sucursal` y `c1` NO van envueltos en `btrim()` en el `WHERE` del consumidor
 * (GOTCHAS §28); acá el `btrim` está sólo en la lista de selección, donde es gratis.
 */
const VIEW = `
CREATE OR REPLACE VIEW analytics.v_label_price_changes AS
SELECT
  btrim(b.sucursal)                    AS sucursal,
  b.c1::date                           AS fecha,
  nullif(btrim(b.c2), '')              AS hora,
  btrim(b.c3)                          AS sku,
  nullif(upper(btrim(b.c4)), '')       AS unidad,
  nullif(btrim(b.c5), '')              AS nombre,
  round(b.c6, 2)                       AS precio_anterior,
  round(b.c7, 2)                       AS precio_nuevo,
  round(b.c7 - b.c6, 2)                AS delta,
  -- El precio nuevo en cero NO es una rebaja: es que el ERP le quitó el precio. Va con bandera
  -- para que la pantalla lo diga; filtrarlo escondería justo lo que hay que ir a ver al anaquel.
  (b.c7 <= 0)                          AS es_baja
FROM kepler_ods.kdpv_bitacora_precios b
WHERE round(b.c6, 2) IS DISTINCT FROM round(b.c7, 2)`;

exports.up = async function up(knex) {
  await knex.raw(VIEW);
  await knex.raw('GRANT SELECT ON analytics.v_label_price_changes TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_label_price_changes IS
    'derive-no-copy sobre kepler_ods.kdpv_bitacora_precios: cambios de precio con anterior/nuevo/delta por (sucursal, fecha, sku, unidad). Filtra a los que cambian el precio IMPRESO (round 2 decimales): Kepler escribe una fila por recalculo y el 99.8% son deltas sub-centavo. es_baja marca el precio nuevo en cero, que no es rebaja sino retiro de precio. Requiere que la tabla este en el carril del ODS: estuvo EXCLUIDA del espejo hasta ETQ-CAMBIOS.2.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_label_price_changes');
};
