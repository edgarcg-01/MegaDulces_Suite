'use strict';
/**
 * `[COT.39]` — la última cotización aceptada sin dirección de entrega toma la ÚNICA de su cliente.
 * Pedido de Edgar (2026-11-06): «insertemos en todos los borradores y completas antes de la
 * actualización».
 *
 * COT.36 (`20261106142922`) llenó las aceptadas con el «Dir. envío» de su pedido en Kepler. Quedó
 * una: su pedido (Canindo, ya embarcado) tiene la dirección vacía en Kepler, así que no había de
 * dónde leerla. Su cliente tiene UNA sola dirección en `kdudent`: ésa es a donde se entregó.
 * ⚠️ El pedido en Kepler sigue vacío hasta que alguien la ponga allá con F9: la Suite no tiene
 *    permiso de UPDATE en Kepler.
 *
 * Lo que NO hace, por decisión de Edgar: los 5 borradores de clientes con dos direcciones se quedan
 * sin elegir (la pantalla obliga a elegir antes de mandarlos); los 11 de clientes sin direcciones
 * no tienen qué insertar.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-06 15:45) ──────────────────────────────────
 *  · Aceptadas con cliente y sin dirección: 1. Su cliente: 1 dirección en `kdudent`.
 *
 * Genérica a propósito (no nombra el folio): toma toda aceptada sin dirección cuyo cliente tenga
 * UNA sola dirección; hoy es una fila. Sólo llena NULL. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // RLS forzado en commercial.quotes (ver COT.36).
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  const r = await knex.raw(
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
        AND q.status = 'accepted'
        AND q.delivery_address_key IS NULL
        AND q.erp_customer_code IS NOT NULL
        AND d.sucursal = coalesce(q.kepler_sucursal, q.source_branch)
        AND d.cliente = btrim(q.erp_customer_code)
      RETURNING q.code, q.delivery_address_key`,
    [TENANT],
  );
  console.log(`[cot39_quote_139_direccion_unica] ${r.rows.length} fila(s): ${r.rows.map((x) => `${x.code}=${x.delivery_address_key}`).join(', ') || '(ninguna)'} · esperado 1`);
};

/** Sin vuelta exacta, por la misma razón que COT.36: sólo llenó NULL con el dato de Kepler. */
exports.down = async function down(knex) {
  void knex;
};
