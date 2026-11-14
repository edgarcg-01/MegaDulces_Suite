'use strict';
/**
 * `[PGP.124]` — **El anticipo de mercancía que pasó 90 días sin factura contra qué aplicarse llega a
 * la bandeja de Compras.** Catálogo + reparto de la responsabilidad `compras.anticipos`.
 *
 * ── Lo medido antes (pg-prod, sólo lectura, 2026-11-14) ─────────────────────────────────────
 *  · En 12 meses Kepler aplicó **cero** anticipos de mercancía (`X-D-60`, `C*`) que ya tuvieran más de
 *    90 días. Pasado ese plazo, el dinero se queda ahí si nadie lo mueve.
 *  · Hoy: 21 con más de 90 días ($3.39 M). 13 tienen factura abierta en su sucursal y se aplican al
 *    pagarla (`[PGP.120]`); **8 no tienen contra qué ($1.20 M)**: hay que pedirle al proveedor la
 *    factura o el reembolso. Entran ~3 al mes.
 *  · No existe un dato de «comprador por proveedor» (ni en la Suite ni en Kepler), así que la
 *    responsabilidad va por PUESTO, como el resto de las bandejas (`[SN.30]`).
 *
 * ── A quién (D9, decidida por encargo del PM) ───────────────────────────────────────────────
 * `comprador` (trata con el proveedor) y `gerente_compras` (Coordinación de Compras). Los dos roles
 * tienen `COMPRAS_OBLIGACIONES_VER`, que abre `/compras/anticipos` (`[PGP.123]`). Los auxiliares de
 * compras quedan fuera a propósito: su trabajo es la orden de entrada, no la negociación con el
 * proveedor. Sumarlos es una línea el día que se decida.
 *
 * ⛔ **Esto NO otorga permisos.** La responsabilidad decide de quién es; el permiso, si lo puede abrir.
 * El log cruza las dos cosas y dice quién la ve DE VERDAD.
 *
 * ⚠️ Sólo hace INSERT (no crea objetos de esquema): la compuerta del despliegue la clasifica
 *    NO_MEDIDO. **Aplicarla en prod ANTES de mergear** (`apply-one-migration-prod.js`).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const KEY = 'compras.anticipos';
const PUESTOS = ['comprador', 'gerente_compras'];
/** El permiso que abre la ruta de la bandeja (`/compras/anticipos`). */
const PERMISO = 'COMPRAS_OBLIGACIONES_VER';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `INSERT INTO identity.responsibilities (key, label, descripcion, dimension, orden, permission_keys)
     VALUES (?, ?, ?, NULL, (SELECT COALESCE(max(orden), 0) + 1 FROM identity.responsibilities), ARRAY[?]::text[])
     ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, descripcion = EXCLUDED.descripcion,
                                     permission_keys = EXCLUDED.permission_keys`,
    [
      KEY,
      'Anticipos a proveedor sin factura',
      'Anticipos de mercancía con más de 90 días cuyo proveedor no tiene factura abierta en esa sucursal: ' +
        'pedirle la factura o el reembolso. Los que sí tienen factura se aplican al pagarla. Sin dimensión: ' +
        'Compras lo pide para toda la red.',
      PERMISO,
    ],
  );
  console.log(`  [PGP.124] catálogo: ${KEY}`);

  for (const PUESTO of PUESTOS) {
    const puestos = await knex('identity.positions').where({ code: PUESTO }).whereNull('deleted_at').select('tenant_id');
    if (!puestos.length) {
      console.log(`  [PGP.124] ⚠️ el puesto "${PUESTO}" no existe: no recibe la clave`);
      continue;
    }
    for (const { tenant_id } of puestos) {
      const ya = await knex('identity.position_responsibilities')
        .where({ tenant_id, position_code: PUESTO, responsibility_key: KEY })
        .whereNull('deleted_at')
        .first('id');
      if (!ya) {
        await knex('identity.position_responsibilities').insert({
          tenant_id, position_code: PUESTO, responsibility_key: KEY, es_principal: false, created_by: 'PGP.124',
        });
      }
      // Quién la ve DE VERDAD: responsabilidad ∧ permiso de la ruta (rol principal o rol extra).
      const { rows } = await knex.raw(
        `SELECT u.username,
                EXISTS (SELECT 1 FROM identity.role_permissions rp
                         WHERE rp.tenant_id = u.tenant_id AND rp.deleted_at IS NULL
                           AND (rp.role_name = u.role_name OR rp.role_name IN (SELECT r.role_name FROM identity.user_roles r WHERE r.user_id = u.id))
                           AND ((rp.permissions ->> ?)::boolean OR coalesce(rp.is_platform_admin, false))) AS abre
           FROM identity.users u
          WHERE u.tenant_id = ? AND u.position_code = ? AND u.activo AND u.deleted_at IS NULL
          ORDER BY u.username`,
        [PERMISO, tenant_id, PUESTO],
      );
      const ven = rows.filter((r) => r.abre).map((r) => r.username);
      const no = rows.filter((r) => !r.abre).map((r) => r.username);
      console.log(`  [PGP.124] ${PUESTO} → ${KEY}${ya ? ' (ya estaba)' : ''} · la ven ${ven.length}: ${ven.join(', ') || '—'}`);
      if (no.length) console.log(`  [PGP.124] ⚠️ ${PUESTO}: responden pero su rol no abre /compras/anticipos: ${no.join(', ')}`);
    }
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex('identity.position_responsibilities').where({ responsibility_key: KEY, created_by: 'PGP.124' }).whereIn('position_code', PUESTOS).del();
  const quedan = await knex('identity.position_responsibilities').where({ responsibility_key: KEY }).count({ n: '*' }).first();
  const personas = await knex('identity.user_responsibilities').where({ responsibility_key: KEY }).count({ n: '*' }).first();
  if (Number(quedan?.n ?? 0) === 0 && Number(personas?.n ?? 0) === 0) await knex('identity.responsibilities').where({ key: KEY }).del();
};
