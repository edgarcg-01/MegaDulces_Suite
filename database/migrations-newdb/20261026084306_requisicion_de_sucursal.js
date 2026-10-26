'use strict';
/**
 * `[AB.29]` + `[AB.32]` — **La requisición que genera la sucursal le llega a la jefa de Compras.**
 *
 * Pedido del PM (2026-10-26): «en Autoabasto, para generar el pedido, que se mande la requisición a
 * la jefa de Compras (Arizbeth)». Firmado con él ese día: le llega SÓLO a ella (por persona, no por
 * puesto), y rechazar una requisición de sucursal exige motivo (el porqué lo ve la sucursal).
 *
 * ── Lo medido antes (sólo lectura, prod `7688376744939610156`, 2026-10-26) ────────────────────
 *  · `arizbeth_gonzalez` (puesto `gerente_compras`) aprobó en 30 días **738 de 739** traspasos y 215
 *    de 235 compras. El mismo puesto lo tiene `fernanda_hernandez`, que no aprobó ninguna: repartir
 *    por PUESTO se la mandaría también a ella. Por eso va por persona (`user_responsibilities`), con
 *    nota, editable desde `/admin/personas` — el mismo puente de `[MS.3.10]`.
 *  · Ya tiene `COMPRAS_REQUISICIONES_AUTORIZAR` (mig `20261008115334`) y `COMPRAS_REQUISICIONES_VER`
 *    por su rol: abre la bandeja y aprueba. ⛔ Esta migración NO otorga permisos.
 *  · Hoy crear, aprobar o rechazar una requisición no avisa a nadie (FASE_AB §16.13): sin la
 *    responsabilidad repartida, la bandeja nueva sería invisible para todos, en silencio (`[SN.30]`).
 *  · Rechazar sólo cambia el estado: no guarda quién, cuándo ni por qué (`setEstado`).
 *  · `target_basis` sólo admite min/reorder/max; la sucursal pide sobre la base `demanda` (AB.15).
 *
 * ── Qué hace (aditiva) ──────────────────────────────────────────────────────────────────────────
 *  1. `purchase_requisitions.requested_by_branch` (NOT NULL DEFAULT false): la marca «pedida por
 *     sucursal». El default cubre todos los caminos que ya insertan (`insertRequisition` y el lote):
 *     no hay que tocarlos para que sigan funcionando.
 *  2. `rejected_at`, `rejected_by`, `rejection_reason`, con CHECK: un rechazo registrado lleva motivo.
 *     Las canceladas de antes quedan con las tres en NULL (no se inventa un motivo que nadie dio).
 *  3. `target_basis` admite `demanda`.
 *  4. Índice parcial para la bandeja y para «lo que la sucursal ya pidió».
 *  5. La responsabilidad `compras.requisiciones_sucursal` en el catálogo y su reparto a Arizbeth.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const KEY = 'compras.requisiciones_sucursal';
const PERSONA = 'arizbeth_gonzalez';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const t = 'commercial.purchase_requisitions';

  await knex.raw(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS requested_by_branch boolean NOT NULL DEFAULT false`);
  await knex.raw(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS rejected_at timestamptz`);
  await knex.raw(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS rejected_by uuid`);
  await knex.raw(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS rejection_reason text`);
  await knex.raw(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS purchase_req_rechazo_con_motivo_chk`);
  await knex.raw(`ALTER TABLE ${t} ADD CONSTRAINT purchase_req_rechazo_con_motivo_chk
    CHECK (rejected_at IS NULL OR btrim(COALESCE(rejection_reason, '')) <> '')`);
  await knex.raw(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS purchase_requisitions_target_basis_check`);
  await knex.raw(`ALTER TABLE ${t} ADD CONSTRAINT purchase_requisitions_target_basis_check
    CHECK (target_basis IN ('min', 'reorder', 'max', 'demanda'))`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_purch_req_de_sucursal
    ON ${t} (tenant_id, warehouse_id, estado, created_at) WHERE requested_by_branch`);
  await knex.raw(`COMMENT ON COLUMN ${t}.requested_by_branch IS
    'AB.29 - la genero la sucursal desde Autoabasto («Enviar a Compras»), no Compras desde el pedido general. Le llega a quien tenga la responsabilidad compras.requisiciones_sucursal.'`);
  await knex.raw(`COMMENT ON COLUMN ${t}.rejection_reason IS
    'AB.32 - por que se rechazo. Obligatorio al rechazar una requisicion de sucursal: la sucursal lo ve. Las canceladas antes de 2026-10-26 no lo tienen.'`);

  await knex.raw(
    `INSERT INTO identity.responsibilities (key, label, descripcion, dimension, orden)
     VALUES (?, ?, ?, NULL, (SELECT COALESCE(max(orden), 0) + 1 FROM identity.responsibilities))
     ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, descripcion = EXCLUDED.descripcion`,
    [
      KEY,
      'Requisiciones de sucursal por aprobar',
      'Lo que una sucursal pidió desde Autoabasto («Enviar a Compras»): una requisición por origen ' +
        '(su matriz o cada proveedor), pendiente de aprobar o rechazar con motivo en /compras/requisiciones. ' +
        'Sin dimensión: la aprueba Compras para toda la red.',
    ],
  );

  const tenants = await knex('identity.tenants').pluck('id');
  for (const tenant of tenants) {
    const persona = await knex('identity.users')
      .where({ tenant_id: tenant })
      .whereRaw('lower(username) = ?', [PERSONA])
      .whereNull('deleted_at')
      .first('id');
    if (!persona) {
      console.log(`  [AB.32] ⚠️ "${PERSONA}" no existe en el tenant ${tenant}: nadie recibe la bandeja (se reparte desde /admin/personas)`);
      continue;
    }
    const ya = await knex('identity.user_responsibilities')
      .where({ tenant_id: tenant, user_id: persona.id, responsibility_key: KEY })
      .whereNull('deleted_at')
      .first('id');
    if (ya) {
      console.log(`  [AB.32] ${PERSONA} ya responde de ${KEY} — sin cambios`);
      continue;
    }
    await knex('identity.user_responsibilities').insert({
      tenant_id: tenant,
      user_id: persona.id,
      responsibility_key: KEY,
      accion: 'suma',
      nota: 'AB.32 — jefa de Compras: le llegan las requisiciones que generan las sucursales en Autoabasto (decisión del PM, 2026-10-26)',
    });
    console.log(`  [AB.32] ${PERSONA} → responsabilidad ${KEY}`);
  }
};

/**
 * Deshace lo de esta migración. Las columnas se conservan si ya hay requisiciones de sucursal o
 * rechazos registrados (borrarlas perdería quién pidió y por qué se rechazó); el reparto y el
 * catálogo se retiran.
 */
exports.down = async function down(knex) {
  const t = 'commercial.purchase_requisitions';
  await knex('identity.user_responsibilities').where({ responsibility_key: KEY }).del();
  await knex('identity.responsibilities').where({ key: KEY }).del();
  await knex.raw(`DROP INDEX IF EXISTS commercial.ix_purch_req_de_sucursal`);
  await knex.raw(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS purchase_req_rechazo_con_motivo_chk`);
  const usadas = await knex(t).where('requested_by_branch', true).orWhereNotNull('rejected_at').count('* as n').first();
  if (Number(usadas && usadas.n) === 0) {
    await knex.raw(`ALTER TABLE ${t} DROP COLUMN IF EXISTS requested_by_branch`);
    await knex.raw(`ALTER TABLE ${t} DROP COLUMN IF EXISTS rejected_at`);
    await knex.raw(`ALTER TABLE ${t} DROP COLUMN IF EXISTS rejected_by`);
    await knex.raw(`ALTER TABLE ${t} DROP COLUMN IF EXISTS rejection_reason`);
  } else {
    console.log('  [AB.29] hay requisiciones de sucursal o rechazos registrados: las columnas se conservan');
  }
  // `target_basis` conserva `demanda` si alguna requisición ya la usa; si no, vuelve a las tres.
  const conDemanda = await knex(t).where('target_basis', 'demanda').count('* as n').first();
  if (Number(conDemanda && conDemanda.n) === 0) {
    await knex.raw(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS purchase_requisitions_target_basis_check`);
    await knex.raw(`ALTER TABLE ${t} ADD CONSTRAINT purchase_requisitions_target_basis_check
      CHECK (target_basis IN ('min', 'reorder', 'max'))`);
  }
};
