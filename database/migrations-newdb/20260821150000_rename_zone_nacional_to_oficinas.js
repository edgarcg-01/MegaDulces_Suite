'use strict';
/**
 * Renombra la zona `NACIONAL` a `OFICINAS`.
 *
 * "NACIONAL" nunca fue una zona de venta: no tiene ni una tienda asignada, y
 * los 22 usuarios que cuelgan de ella son el personal corporativo (superadmin,
 * compras, finanzas, contabilidad, presupuestos, prevención, almacén,
 * marketing). El nombre venía de las zonas semilla de 2026-04 y se usaba como
 * cajón de "los que no son de ruta", así que la etiqueta miente en todos los
 * filtros donde aparece.
 *
 * Es solo la etiqueta: todo lo que apunta a la zona lo hace por UUID
 * (`users.zona_id`, `stores.zona_id`), así que no se mueve ninguna relación y
 * no hay que reasignar a nadie.
 *
 * Idempotente y por tenant. Si un tenant ya tuviera una zona `OFICINAS`, NO
 * fusiona (eso implicaría mover usuarios y es otra decisión): avisa y lo salta,
 * porque `zones_tenant_name_unique` lo rechazaría de todos modos.
 *
 * No toca permisos ni requiere re-login: la zona no otorga nada.
 *
 * @param { import("knex").Knex } knex
 */

const VIEJO = 'NACIONAL';
const NUEVO = 'OFICINAS';

exports.up = async function up(knex) {
  const cand = await knex.raw(
    `SELECT z.id, z.tenant_id, z.name,
            EXISTS (SELECT 1 FROM trade.zones o
                     WHERE o.tenant_id = z.tenant_id AND upper(o.name) = ?::text) AS choca
       FROM trade.zones z
      WHERE upper(z.name) = ?::text`,
    [NUEVO, VIEJO],
  );

  if (!cand.rows.length) {
    console.log(`[rename_zone] no hay zona ${VIEJO}: nada por hacer`);
    return;
  }

  for (const z of cand.rows) {
    if (z.choca) {
      console.log(
        `[rename_zone] tenant ${z.tenant_id}: ya existe una zona ${NUEVO}, se salta ${z.name} (fusionar es otra decisión)`,
      );
      continue;
    }
    const usuarios = await knex.raw(
      `SELECT count(*) n FROM identity.users WHERE zona_id = ? AND deleted_at IS NULL`,
      [z.id],
    );
    await knex('trade.zones').where({ id: z.id }).update({ name: NUEVO, updated_at: knex.fn.now() });
    console.log(
      `[rename_zone] tenant ${z.tenant_id}: ${VIEJO} -> ${NUEVO} (${usuarios.rows[0].n} usuario(s) conservan su zona)`,
    );
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  const res = await knex.raw(
    `UPDATE trade.zones z
        SET name = ?::text, updated_at = now()
      WHERE upper(z.name) = ?::text
        AND NOT EXISTS (SELECT 1 FROM trade.zones o
                         WHERE o.tenant_id = z.tenant_id AND upper(o.name) = ?::text)`,
    [VIEJO, NUEVO, VIEJO],
  );
  console.log(`[rename_zone] revertido en ${res.rowCount ?? 0} zona(s)`);
};
