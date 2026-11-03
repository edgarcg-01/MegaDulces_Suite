'use strict';
/**
 * `[NP.7.L.7]` — Reparte `CATALOGO_LEVANTAR` a TODO rol con personas (regla 20).
 *
 * «Todos los usuarios pueden acceder a este módulo, es universal: todos participan en la construcción
 * del catálogo digital» (Francisco, 2026-11-02). Reemplaza el reparto POR PERSONA del piloto que pedía
 * el plan (NP.7.L.7a) y la expansión por rol (NP.7.L.7b).
 *
 * Mismo molde y mismas exclusiones que `SERVICIO_REPORTAR` (`20261002170000_servicedesk_permisos.js`):
 *   · `retirado_*`   — roles dados de baja.
 *   · `customer_b2b` — el cliente del portal no es personal y no entra a la suite.
 *   · `servicio`     — la cuenta de los feeds, sin login interactivo.
 *   · cuentas COMPARTIDAS de dispositivo (`checador_kiosco`, `verificador_precios`, `etiquetas_tienda`):
 *     no hay una persona detrás, y la foto se atribuye a quien la tomó (ranking, recaptura).
 * Medido el 2026-11-02 en prod (sólo lectura): 33 roles con 184 personas activas.
 *
 * Sólo AGREGA donde la clave falta (`permissions -> 'KEY' IS NULL`, nunca el operador `?`): a quien
 * alguien ya se la puso en `false` a mano no se le pisa. Después VERIFICA: si ningún rol con personas
 * quedó con la clave, la migración falla en vez de reportar éxito sin haber repartido nada.
 *
 * ⚠️ Sólo hace UPDATE (no crea esquema): la compuerta del despliegue la clasifica NO_MEDIDO y se aplica a
 * mano con `apply-one-migration-prod.js`. Después la gente tiene que volver a entrar (el permiso viaja en
 * el JWT armado al login).
 *
 * @param { import("knex").Knex } knex
 */

const SIN_LEVANTAR = ['customer_b2b', 'servicio', 'checador_kiosco', 'verificador_precios', 'etiquetas_tienda'];
const CLAVE = 'CATALOGO_LEVANTAR';
/** `?,?,?` para una lista: knex EXPANDE un arreglo en varios `?`. */
const marcas = (xs) => xs.map(() => '?').join(',');

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const r = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || '{"${CLAVE}": true}'::jsonb
      WHERE role_name NOT LIKE 'retirado%'
        AND role_name NOT IN (${marcas(SIN_LEVANTAR)})
        AND deleted_at IS NULL
        AND permissions -> '${CLAVE}' IS NULL`,
    SIN_LEVANTAR,
  );

  const { rows } = await knex.raw(
    `SELECT count(DISTINCT rp.role_name)::int AS roles, count(DISTINCT u.id)::int AS personas
       FROM identity.role_permissions rp
       JOIN identity.users u ON u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name
      WHERE (rp.permissions ->> ?)::boolean IS TRUE
        AND rp.deleted_at IS NULL AND u.activo IS TRUE AND u.deleted_at IS NULL`,
    [CLAVE],
  );
  // eslint-disable-next-line no-console
  console.log(`  [NP.7.L.7] ${CLAVE}: ${r.rowCount} fila(s) de role_permissions tocadas · alcanza ${rows[0].roles} rol(es) · ${rows[0].personas} persona(s) activa(s)`);
  if (rows[0].personas === 0) {
    const hayGente = await knex('identity.users').where({ activo: true }).whereNull('deleted_at').first('id');
    if (hayGente) throw new Error(`[NP.7.L.7] ${CLAVE} no quedó repartido a ninguna persona activa: revisar role_permissions antes de seguir.`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`: quita la clave donde vale `true` en los roles que la recibieron. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions - '${CLAVE}'
      WHERE (permissions ->> '${CLAVE}')::boolean IS TRUE
        AND role_name NOT LIKE 'retirado%'
        AND role_name NOT IN (${marcas(SIN_LEVANTAR)})`,
    SIN_LEVANTAR,
  );
};
