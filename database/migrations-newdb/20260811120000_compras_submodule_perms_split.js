/**
 * RA — Split de permisos de Compras en permiso INDIVIDUAL por submódulo (ADR-030).
 *
 * Antes: COMPRAS_VER / COMPRAS_GESTIONAR / COMPRAS_VALIDAR (genéricos para todo /compras).
 * Ahora: un par VER/GESTIONAR por submódulo (pedido, red, requisiciones, ordenes, entradas
 * [+VALIDAR], descuentos, hallazgos, proveedores, categorias) + VER para 360 y costo-neto.
 *
 * Migrar y retirar:
 *   1) Backfill: cada nuevo permiso hereda el valor del viejo que lo cubría
 *      (todos los *_VER ← COMPRAS_VER · todos los *_GESTIONAR ← COMPRAS_GESTIONAR ·
 *       COMPRAS_ENTRADAS_VALIDAR ← COMPRAS_VALIDAR).
 *   2) Retiro: se eliminan las 3 claves viejas del JSONB.
 *
 * Idempotente: escribe cada clave nueva sólo si no existe (`-> 'KEY' IS NULL`, NO el
 * operador `?` que knex no escapa). Frontend gatea por JWT → RE-LOGIN requerido.
 *
 * @param { import("knex").Knex } knex
 */
const VER_NEW = [
  'COMPRAS_PEDIDO_VER', 'COMPRAS_RED_VER', 'COMPRAS_REQUISICIONES_VER', 'COMPRAS_ORDENES_VER',
  'COMPRAS_ENTRADAS_VER', 'COMPRAS_360_VER', 'COMPRAS_COSTO_NETO_VER', 'COMPRAS_DESCUENTOS_VER',
  'COMPRAS_HALLAZGOS_VER', 'COMPRAS_PROVEEDORES_VER', 'COMPRAS_CATEGORIAS_VER',
];
const GES_NEW = [
  'COMPRAS_PEDIDO_GESTIONAR', 'COMPRAS_RED_GESTIONAR', 'COMPRAS_REQUISICIONES_GESTIONAR',
  'COMPRAS_ORDENES_GESTIONAR', 'COMPRAS_ENTRADAS_GESTIONAR', 'COMPRAS_DESCUENTOS_GESTIONAR',
  'COMPRAS_HALLAZGOS_GESTIONAR', 'COMPRAS_PROVEEDORES_GESTIONAR', 'COMPRAS_CATEGORIAS_GESTIONAR',
];
// nuevo → clave vieja de la que hereda su valor.
const SOURCE = {};
for (const k of VER_NEW) SOURCE[k] = 'COMPRAS_VER';
for (const k of GES_NEW) SOURCE[k] = 'COMPRAS_GESTIONAR';
SOURCE['COMPRAS_ENTRADAS_VALIDAR'] = 'COMPRAS_VALIDAR';

const OLD = ['COMPRAS_VER', 'COMPRAS_GESTIONAR', 'COMPRAS_VALIDAR'];

exports.up = async function (knex) {
  // 1) Backfill: cada nueva clave hereda el valor de su clave vieja (o false si no estaba).
  for (const [key, src] of Object.entries(SOURCE)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                COALESCE((permissions->>'${src}')::boolean, false))
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[compras_split] up ${key} (← ${src}): filas = ${res.rowCount ?? 0}`);
  }
  // 2) Retiro de las claves viejas.
  for (const key of OLD) {
    const res = await knex.raw(
      `UPDATE role_permissions SET permissions = permissions - '${key}' WHERE permissions -> '${key}' IS NOT NULL`,
    );
    console.log(`[compras_split] up retiro ${key}: filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  // Reconstruye las viejas desde las nuevas (VER si algún *_VER, GESTIONAR si algún *_GESTIONAR,
  // VALIDAR desde ENTRADAS_VALIDAR) y remueve las nuevas.
  await knex.raw(
    `UPDATE role_permissions SET permissions = permissions
       || jsonb_build_object('COMPRAS_VER', COALESCE((permissions->>'COMPRAS_PEDIDO_VER')::boolean, false))
       || jsonb_build_object('COMPRAS_GESTIONAR', COALESCE((permissions->>'COMPRAS_PEDIDO_GESTIONAR')::boolean, false))
       || jsonb_build_object('COMPRAS_VALIDAR', COALESCE((permissions->>'COMPRAS_ENTRADAS_VALIDAR')::boolean, false))`,
  );
  for (const key of [...VER_NEW, ...GES_NEW, 'COMPRAS_ENTRADAS_VALIDAR']) {
    await knex.raw(`UPDATE role_permissions SET permissions = permissions - '${key}' WHERE permissions -> '${key}' IS NOT NULL`);
  }
  console.log('[compras_split] down: viejas restauradas, nuevas removidas');
};
