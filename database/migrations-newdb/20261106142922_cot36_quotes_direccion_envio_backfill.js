'use strict';
/**
 * `[COT.36]` — completa la dirección de entrega (`commercial.quotes.delivery_address_key`) de las
 * cotizaciones hechas antes de que la Suite la guardara (COT.26, 2026-11-05), con el dato de Kepler.
 * Pedido de Edgar (2026-11-06): «todas, ya sean borradores, aceptadas o canceladas».
 *
 * La regla es NO adivinar, por caso:
 *  1. **Ya es pedido en Kepler** (tiene `kepler_folio`): la verdad es el «Dir. envío» (`kdm1.c85`) de
 *     ESE pedido, buscado por sucursal + folio (U-D-40). ⛔ No por `c24`: el personal le agrega texto
 *     después del folio de la Suite («COT-2026-00142    CJA 4, PAQ 6, U1»), y comparar igual a igual
 *     no encontraba 10 de 11 pedidos (medido). Sólo si UN solo renglón de `kdm1` casa.
 *  2. **Todavía no es pedido**, cualquier estado: si el cliente tiene UNA sola dirección en Kepler
 *     (`kdudent`) en esa sucursal, ésa.
 *  Lo demás se queda como está: cliente sin direcciones (al mandarla va «Dir. envío» 0, como Kepler),
 *  cliente con varias (se elige antes de mandar: la pantalla lo exige), prospectos, y el pedido cuyo
 *  «Dir. envío» en Kepler está vacío.
 *  Sólo llena NULL: nunca pisa una dirección ya elegida.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-06 14:25) ──────────────────────────────────
 *  · 84 cotizaciones vivas (0 canceladas): 17 aceptadas en Kepler, 67 borradores.
 *  · Aceptadas: 6 ya cuadran con Kepler; 10 sin dirección en la Suite y con «Dir. envío» en Kepler
 *    (8 con la 1, 2 con la 2); 1 con «Dir. envío» vacío en Kepler (se queda sin).
 *  · Borradores: 33 de cliente con una sola dirección y sin guardar; 2 ya la tienen; 11 de cliente
 *    sin direcciones; 6 de cliente con 2 (5 sin elegir); 15 prospectos.
 *  · Esperado: 10 + 33 = 43 filas. Si sale distinto, lo dice la salida (no frena: el universo vivo
 *    cambia entre la medición y la aplicación).
 *
 * ⚠️ Sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO. Aplicala con
 *    `aplicar-migracion.sh` ANTES de soltar. No exige nada al código desplegado (expand/contract):
 *    la columna ya existe y la API ya la lee.
 *
 * Idempotente: sólo toca `delivery_address_key IS NULL`.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // commercial.quotes tiene RLS FORZADO: sin el tenant en la sesión, un rol que no sea superusuario
  // actualizaría 0 filas sin error.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);

  const pedidos = await knex.raw(
    `UPDATE commercial.quotes q
        SET delivery_address_key = k.c85, updated_at = now()
       FROM (
         SELECT m.sucursal, btrim(m.c6) AS folio, min(btrim(m.c85::text)) AS c85
           FROM kepler_ods.kdm1 m
          WHERE m.c2 = 'U' AND m.c3 = 'D' AND btrim(m.c4::text) = '40'
            AND nullif(btrim(m.c85::text), '') IS NOT NULL
          GROUP BY 1, 2
         HAVING count(*) = 1
       ) k
      WHERE q.tenant_id = ? AND q.deleted_at IS NULL
        AND q.delivery_address_key IS NULL
        AND q.kepler_folio IS NOT NULL
        AND k.sucursal = coalesce(q.kepler_sucursal, q.source_branch)
        AND k.folio = btrim(q.kepler_folio)
      RETURNING q.code, q.delivery_address_key`,
    [TENANT],
  );

  const borradores = await knex.raw(
    `UPDATE commercial.quotes q
        SET delivery_address_key = d.unica, updated_at = now()
       FROM (
         SELECT sucursal, btrim(c1) AS cliente, min(btrim(c2)) AS unica
           FROM kepler_ods.kdudent
          WHERE btrim(coalesce(c2, '')) <> ''
          GROUP BY 1, 2
         HAVING count(*) = 1
       ) d
      WHERE q.tenant_id = ? AND q.deleted_at IS NULL
        AND q.delivery_address_key IS NULL
        AND q.kepler_folio IS NULL
        AND q.erp_customer_code IS NOT NULL
        AND d.sucursal = q.source_branch
        AND d.cliente = btrim(q.erp_customer_code)
      RETURNING q.code, q.delivery_address_key`,
    [TENANT],
  );

  const resumen = (rows) => {
    const porClave = {};
    for (const r of rows) porClave[r.delivery_address_key] = (porClave[r.delivery_address_key] || 0) + 1;
    return `${rows.length} (${Object.entries(porClave).map(([k, n]) => `dir ${k}: ${n}`).join(', ') || 'ninguna'})`;
  };
  console.log(`[cot36_quotes_direccion_envio_backfill] pedidos en Kepler: ${resumen(pedidos.rows)} · `
    + `sin pedido, cliente con una sola dirección: ${resumen(borradores.rows)} · esperado 10 + 33`);
};

/**
 * No hay vuelta exacta: el `up` sólo llenó NULL con el dato de Kepler, y después de aplicarla una
 * persona puede elegir esa misma dirección a propósito; regresarlas a NULL borraría también esas.
 * Se declara en vez de fingir un `down` que deshace de más.
 */
exports.down = async function down(knex) {
  void knex;
};
