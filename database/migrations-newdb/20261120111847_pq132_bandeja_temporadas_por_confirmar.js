'use strict';
/**
 * `[PQ.132]` — **La temporada que ya está en venta (o a 45 días de estarlo) con sus fechas sin confirmar
 * llega a «Mi trabajo» de quien la confirma.** Catálogo + reparto de la responsabilidad
 * `compras.temporadas` (plan PQ §19.14, D47 y D48 paso 1).
 *
 * ── Lo medido antes (pg-prod, sólo lectura, 2026-11-20) ─────────────────────────────────────
 *  · `catalog.season_dates`: 14 temporada-año (2025 y 2026), **las 14 en `propuesta`, 0 confirmadas**,
 *    diez días después de que Temporadas entró a prod (PQ.94). Las lecturas de la pantalla existen; las
 *    escrituras, no.
 *  · Navidad 2026 está **en venta** desde el 20-oct y sigue en `propuesta`: es la que la bandeja cuenta hoy.
 *  · ⛔ No sirve `compras.reabasto`: la tienen `gerente_compras`, `auxiliar_compras`, `comprador` y
 *    `analista_abastecimiento_comercial`, **no `direccion`**. La dirección comercial, que confirma (D47),
 *    no la vería (`[SN.30]`, cola ajena) y los auxiliares, que sólo tienen VER, la verían sin enlace
 *    (`[SN.24]`). Por eso la clave es nueva.
 *
 * ── A quién (D47, decidida por Dirección el 2026-11-20) ─────────────────────────────────────
 * Confirman la jefatura de compras y la dirección comercial. Por PUESTO, como el resto de las bandejas:
 *  · `gerente_compras` (Coordinación de Compras) — principal: es quien arma la temporada.
 *  · `direccion` (Dirección General) — firma junto con Compras.
 * Los cuatro ocupantes de hoy tienen `COMPRAS_TEMPORADAS_GESTIONAR`, que es lo que pide la bandeja (la
 * ruta acepta VER o GESTIONAR, pero una bandeja que no se puede vaciar se deja de mirar).
 *
 * ⛔ **Esto NO otorga permisos.** La responsabilidad decide de quién es; el permiso, si lo puede confirmar.
 * El log cruza las dos cosas y dice quién la ve DE VERDAD.
 *
 * ⚠️ Sólo hace INSERT (no crea objetos de esquema): la compuerta del despliegue la clasifica NO_MEDIDO.
 *    **Aplicarla en prod ANTES de soltar** (`aplicar-migracion.sh`). Sin ella la bandeja no le aparece a
 *    nadie (`[SN.30]`: nadie responde de la clave), pero tampoco rompe nada.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const KEY = 'compras.temporadas';
/** `[puesto, es_principal]` */
const PUESTOS = [
  ['gerente_compras', true],
  ['direccion', false],
];
/** El permiso que pide la bandeja (`anyOf` en `me-work.ts`): confirmar, no sólo ver. */
const PERMISO = 'COMPRAS_TEMPORADAS_GESTIONAR';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(
    `INSERT INTO identity.responsibilities (key, label, descripcion, dimension, orden, permission_keys)
     VALUES (?, ?, ?, NULL, (SELECT COALESCE(max(orden), 0) + 1 FROM identity.responsibilities), ARRAY[?]::text[])
     ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, descripcion = EXCLUDED.descripcion,
                                     permission_keys = EXCLUDED.permission_keys`,
    [
      KEY,
      'Temporadas por confirmar',
      'Temporadas cuya venta ya empezó o empieza en 45 días o menos y cuyas fechas siguen propuestas: ' +
        'confirmarlas (o corregirlas) en Compras › Temporadas. Lo propuesto no frena nada; sólo lo confirmado ' +
        'llega al pedido. Sin dimensión: la temporada es de toda la red.',
      PERMISO,
    ],
  );
  console.log(`  [PQ.132] catálogo: ${KEY}`);

  for (const [PUESTO, principal] of PUESTOS) {
    const puestos = await knex('identity.positions').where({ code: PUESTO }).whereNull('deleted_at').select('tenant_id');
    if (!puestos.length) {
      console.log(`  [PQ.132] ⚠️ el puesto "${PUESTO}" no existe: no recibe la clave`);
      continue;
    }
    for (const { tenant_id } of puestos) {
      const ya = await knex('identity.position_responsibilities')
        .where({ tenant_id, position_code: PUESTO, responsibility_key: KEY })
        .whereNull('deleted_at')
        .first('id');
      if (!ya) {
        await knex('identity.position_responsibilities').insert({
          // `created_by` es uuid y acepta NULL: escribirle el código del item revienta con «invalid input
          // syntax for type uuid» (lo vivió PGP.124). Las demás siembras de esta tabla tampoco lo llenan.
          tenant_id, position_code: PUESTO, responsibility_key: KEY, es_principal: principal,
        });
      }
      // Quién la ve DE VERDAD: responsabilidad ∧ permiso de la bandeja (rol principal o rol extra).
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
      console.log(`  [PQ.132] ${PUESTO} → ${KEY}${ya ? ' (ya estaba)' : ''} · la ven ${ven.length}: ${ven.join(', ') || '—'}`);
      if (no.length) console.log(`  [PQ.132] ⚠️ ${PUESTO}: responden pero su rol no confirma temporadas (la ven sin enlace): ${no.join(', ')}`);
    }
  }
};

/**
 * Deshace lo que hizo el `up`. La clave `compras.temporadas` nace en esta migración: sus filas de los dos
 * puestos son suyas. Si alguien la repartió después a una persona (`user_responsibilities`), el catálogo se
 * queda: borrarlo dejaría esas filas apuntando a nada.
 */
exports.down = async function down(knex) {
  await knex('identity.position_responsibilities')
    .where({ responsibility_key: KEY })
    .whereIn('position_code', PUESTOS.map(([p]) => p))
    .del();
  const quedan = await knex('identity.position_responsibilities').where({ responsibility_key: KEY }).count({ n: '*' }).first();
  const personas = await knex('identity.user_responsibilities').where({ responsibility_key: KEY }).count({ n: '*' }).first();
  if (Number(quedan?.n ?? 0) === 0 && Number(personas?.n ?? 0) === 0) await knex('identity.responsibilities').where({ key: KEY }).del();
};
