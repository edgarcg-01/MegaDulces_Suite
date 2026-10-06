'use strict';
/**
 * `[RD.31.1]` — **El permiso de registrar un conteo de camión, REPARTIDO.**
 *
 * ⭐ La lección de `[LC.6.2]`, que ya costó una vez: *un módulo nuevo no está entregado hasta que
 * su permiso está repartido en PROD, no sólo declarado en el enum.* Aquel par nació con la fase,
 * nunca lo repartió nadie, y el módulo quedó en producción sin que **una sola persona** pudiera
 * abrirlo — lo único que lo tocaba era `ALL_PERMS`.
 *
 * ── A quién, y por qué a ésos ───────────────────────────────────────────────────────────────
 *
 * No se calca el permiso vecino sin mirarlo. Medido contra el estado vivo de prod:
 *
 * | tiene hoy | roles |
 * |---|---|
 * | `COMMERCIAL_INVENTORY_CONTAR` | almacenista · compras · gerente_compras · marketing · superadmin · supervisor |
 * | `COMMERCIAL_INVENTORY_RECONCILIAR` | compras · gerente_compras · superadmin · supervisor |
 *
 * ⭐ **Se calca el de RECONCILIAR, no el de CONTAR**, y la diferencia es el acto: un conteo de
 * almacén es **ciego** —se captura sin ver el teórico, y por eso `[IC.2]` le quitó `SUPERVISAR`
 * a `almacenista`— mientras que un conteo de camión **fija el número publicado**: resetea el
 * saldo de la ruta y manda a cero lo que no lista. Eso está del lado de cerrar un descuadre, no
 * del de levantar la mano.
 *
 * ⚠️ Por eso **`almacenista` queda fuera a propósito**, con sus 7 personas: cuenta, pero no
 * reconcilia, y ésa fue una decisión explícita de `[IC.2]` que esta migración respeta en vez de
 * erosionar por comodidad.
 *
 * ⚠️ `marketing` también queda fuera aunque tenga `CONTAR`: es residuo (tiene el permiso de
 * contar sin el de reconciliar y sin tocar almacén). Repartir sobre un residuo lo vuelve regla.
 *
 * ⛔ **Se deriva del estado VIVO, no de una lista tecleada.** Una lista de roles en una migración
 * envejece el día que alguien renombra un rol, y nada avisa — es la misma familia de la medición
 * persistida en un `COMMENT` que `[CDRP.2.1]` tuvo que corregir aparte.
 *
 * ⚠️ Las claves que están en `false` NO se pisan: un `false` explícito es una decisión de alguien
 * (el residuo que `[LC.6.2]` encontró en `almacenista` venía justo de ahí), y esta migración sólo
 * **agrega** donde la clave no existe.
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'COMMERCIAL_ROUTE_COUNT_REGISTRAR';
const ANCLA = 'COMMERCIAL_INVENTORY_RECONCILIAR';

exports.up = async function up(knex) {
  const { rows: antes } = await knex.raw(
    `SELECT count(*) FILTER (WHERE permissions -> ? = 'true')::int  AS con_ancla,
            count(*) FILTER (WHERE permissions -> ? IS NOT NULL)::int AS ya_tienen
       FROM identity.role_permissions
      WHERE deleted_at IS NULL`, [ANCLA, CLAVE]);
  console.log(`  · [RD.31.1] ${antes[0].con_ancla} rol(es) con ${ANCLA} · ${antes[0].ya_tienen} ya traen la clave nueva`);

  // Freno de premisa: si nadie reconcilia, repartir por calca no reparte NADA y la migracion se
  // pondria verde sin dar acceso a una sola persona -- exactamente el caso de [LC.6.2].
  if (Number(antes[0].con_ancla) === 0) {
    throw new Error(`[RD.31.1] ningun rol tiene ${ANCLA}: la regla de reparto no aplica, revisar`);
  }

  const { rowCount } = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true),
            updated_at = now()
      WHERE deleted_at IS NULL
        AND permissions -> ? = 'true'
        AND permissions -> ? IS NULL`, [CLAVE, ANCLA, CLAVE]);
  console.log(`  · [RD.31.1] clave agregada a ${rowCount} rol(es)`);

  const { rows: despues } = await knex.raw(
    `SELECT role_name,
            (SELECT count(*) FROM identity.user_roles ur WHERE ur.role_name = rp.role_name)::int AS personas
       FROM identity.role_permissions rp
      WHERE deleted_at IS NULL AND permissions -> ? = 'true'
      ORDER BY role_name`, [CLAVE]);
  console.log(`  · [RD.31.1] queda en: ${despues.map((r) => `${r.role_name}(${r.personas})`).join(' · ') || '(nadie)'}`);

  // Un permiso repartido a CERO personas es un permiso que no existe para nadie.
  const personas = despues.reduce((a, r) => a + Number(r.personas), 0);
  if (personas === 0) {
    throw new Error(`[RD.31.1] la clave quedo en ${despues.length} rol(es) pero en 0 personas`);
  }
  console.log(`  · [RD.31.1] alcanza a ${personas} persona(s)`);
};

exports.down = async function down(knex) {
  const { rowCount } = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions - ?::text, updated_at = now()
      WHERE deleted_at IS NULL AND permissions -> ? IS NOT NULL`, [CLAVE, CLAVE]);
  console.log(`  · [RD.31.1] clave retirada de ${rowCount} rol(es)`);
};
