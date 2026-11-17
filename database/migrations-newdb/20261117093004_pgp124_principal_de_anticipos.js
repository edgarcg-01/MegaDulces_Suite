'use strict';
/**
 * `[PGP.124]` — **`compras.anticipos` sin responsable principal: Coordinación de Compras lo es.**
 *
 * `20261114101514` repartió la bandeja «Anticipos sin factura, con más de 90 días» a `comprador` y a
 * `gerente_compras`, los dos como SECUNDARIOS. Sin principal, el reparto de [OR.3] no sabe a quién
 * apuntar («¿quién responde?» no tiene respuesta), y `test-newdb-organigrama.js` lo cazó en el CI:
 * «toda responsabilidad tiene responsable… (sin nadie: … compras.anticipos)».
 *
 * Principal = `gerente_compras` (Coordinación de Compras); `comprador` queda secundario. Es el patrón de
 * `compras.reabasto` (gerente_compras principal, comprador secundario), y pedirle la factura o el
 * reembolso a un proveedor que trae anticipos viejos lo decide Coordinación. La regla de UN principal
 * por responsabilidad la exige `org.service.ts` al asignar desde el organigrama.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-17) ───────────────────────────────────────────
 *  · `compras.anticipos`: comprador y gerente_compras, ninguno principal. Sin principal en todo el
 *    catálogo: `finanzas.caja_deposito` (ajena) y ésta.
 *  · La ven de verdad (responsabilidad ∧ permiso de la ruta): gerente_compras 2 de 2, comprador 1 de 1.
 *
 * ⚠️ Sólo hace UPDATE (no crea objetos de esquema): la compuerta del despliegue la clasifica NO_MEDIDO.
 *    **Aplicarla en prod ANTES de mergear** (`apply-one-migration-prod.js`).
 *
 * Idempotente: no toca nada si la responsabilidad ya tiene un principal.
 *
 * @param { import("knex").Knex } knex
 */

const KEY = 'compras.anticipos';
const PRINCIPAL = 'gerente_compras';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows } = await knex.raw(
    `UPDATE identity.position_responsibilities pr
        SET es_principal = true, updated_at = now()
      WHERE pr.responsibility_key = ? AND pr.position_code = ? AND pr.deleted_at IS NULL AND NOT pr.es_principal
        AND NOT EXISTS (SELECT 1 FROM identity.position_responsibilities o
                         WHERE o.tenant_id = pr.tenant_id AND o.responsibility_key = pr.responsibility_key
                           AND o.es_principal AND o.deleted_at IS NULL)
      RETURNING pr.tenant_id`,
    [KEY, PRINCIPAL],
  );
  console.log(`  [PGP.124] ${KEY}: principal = ${PRINCIPAL} en ${rows.length} tenant(s)${rows.length ? '' : ' (ya tenía principal, o el puesto no la tiene)'}`);
};

/** Deshace lo que hizo el `up`: `gerente_compras` vuelve a secundario en esa responsabilidad. */
exports.down = async function down(knex) {
  await knex('identity.position_responsibilities')
    .where({ responsibility_key: KEY, position_code: PRINCIPAL, es_principal: true })
    .whereNull('deleted_at')
    .update({ es_principal: false, updated_at: knex.fn.now() });
};
