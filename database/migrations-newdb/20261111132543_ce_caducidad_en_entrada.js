'use strict';
/**
 * `[CE.1.1]` `[CE.2.1]` `[CE.3.2]` — Toda entrada con caducidad (Anexo CE de la Fase WMS,
 * `docs/IMPLEMENTACION/FASES/FASE_WMS_ANEXO_CADUCIDAD_EN_ENTRADA.md`).
 *
 * 1. `commercial.expiry_receiving_policy` + `tracks_expiry` (¿caduca?) y `shelf_life_days` (vida
 *    útil total). Con eso el Andén deja de pedir fecha a lo que no caduca y el semáforo puede
 *    sospechar de una fecha que no cabe en lo que dura el producto.
 * 2. Semilla: los departamentos de Kepler DESECHABLES y ARTICULOS DE FIESTAS no caducan.
 * 3. `commercial.receiving_sessions` + quién, cuándo y por qué cerró un vale con renglones sin fecha
 *    (el cierre ya no lo permite sin ese motivo).
 * 4. Reparte `ALMACEN_LLEGADAS_VER` a almacenista y supervisor (regla 20): el camión que Kepler
 *    recibió y nadie abrió en el Andén deja de verlo sólo el modo dios.
 *
 * ── Lo medido antes (sólo lectura, pg-prod 7688376744939610156, 2026-11-11) ────────────────
 *  · `expiry_receiving_policy`: 0 filas → sin política, 3 lotes YA VENCIDOS entraron en verde.
 *  · `catalog.products.department` vacía en los 14,945 productos: el departamento se deriva de
 *    Kepler (`kdii.c4` → `kdie.c1`, 99.4 % de los SKUs del CEDIS casan).
 *  · Renglones de entrada de compra, 60 días: 11,583; DESECHABLES 1,665 + ARTICULOS DE FIESTAS 385
 *    = 2,050 (≈ 18 %) que hoy se le piden fechar a alguien y no caducan.
 *  · `ALMACEN_LLEGADAS_VER`: en 0 roles.
 *
 * Aditiva: columnas NULLABLE (ningún camino de inserción existente se rompe), semilla y reparto
 * sólo donde falta. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const NO_CADUCAN = ['DESECHABLES', 'ARTICULOS DE FIESTAS'];
const LLEGADAS = ['almacenista', 'supervisor'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. Política: ¿caduca? y vida útil ──
  if (!(await knex.schema.withSchema('commercial').hasColumn('expiry_receiving_policy', 'tracks_expiry'))) {
    await knex.schema.withSchema('commercial').alterTable('expiry_receiving_policy', (t) => {
      t.boolean('tracks_expiry'); // false = no caduca · true = caduca · null = sin decir
    });
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn('expiry_receiving_policy', 'shelf_life_days'))) {
    await knex.schema.withSchema('commercial').alterTable('expiry_receiving_policy', (t) => {
      t.integer('shelf_life_days');
    });
    await knex.raw(`
      ALTER TABLE commercial.expiry_receiving_policy
        ADD CONSTRAINT expiry_receiving_policy_shelf_life_pos CHECK (shelf_life_days IS NULL OR shelf_life_days > 0)
    `);
  }
  await knex.raw(`COMMENT ON COLUMN commercial.expiry_receiving_policy.tracks_expiry IS
    '[CE.1.1] false = el producto/departamento/proveedor NO caduca (el Andén no pide fecha). true = caduca. NULL = sin decir (se pide).'`);
  await knex.raw(`COMMENT ON COLUMN commercial.expiry_receiving_policy.shelf_life_days IS
    '[CE.1.1] Vida útil total en días. Sólo para sospechar de una fecha (amarillo beyond_shelf_life), nunca para rechazar. Si falta, el servicio usa kdii.c101 de Kepler.'`);
  await knex.raw(`COMMENT ON COLUMN commercial.expiry_receiving_policy.category IS
    '[CE.1.1] Departamento de Kepler (kdie.c2: DULCES, BOTANAS, DESECHABLES…), derivado de kdii.c4. No es catalog.products.category_id (=proveedor).'`);

  // ── 2. Semilla: lo que no caduca ──
  // Sólo donde el tenant existe: en una base recién creada (CI) las migraciones corren antes de sembrarlo.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  const hayTenant = !!(await knex('identity.tenants').where({ id: TENANT }).first('id'));
  for (const depto of hayTenant ? NO_CADUCAN : []) {
    await knex.raw(
      `INSERT INTO commercial.expiry_receiving_policy
              (tenant_id, product_id, category, supplier_code, tracks_expiry, allow_older_than_existing, source, notes)
       SELECT ?, NULL, ?, NULL, false, true, 'semilla_ce',
              '[CE.1.1] Departamento que no caduca (Anexo CE, 2026-11-11). Un producto puntual que sí caduque se corrige con una política por producto.'
        WHERE NOT EXISTS (
          SELECT 1 FROM commercial.expiry_receiving_policy
           WHERE tenant_id = ? AND product_id IS NULL AND category = ? AND supplier_code IS NULL)`,
      [TENANT, depto, TENANT, depto],
    );
  }

  // ── 3. El vale cerrado con fecha pendiente deja su motivo ──
  const ses = async (c) => knex.schema.withSchema('commercial').hasColumn('receiving_sessions', c);
  if (!(await ses('expiry_waiver_reason'))) {
    await knex.schema.withSchema('commercial').alterTable('receiving_sessions', (t) => {
      t.text('expiry_waiver_reason');
      t.uuid('expiry_waiver_by');
      t.timestamp('expiry_waiver_at', { useTz: true });
    });
  }
  await knex.raw(`COMMENT ON COLUMN commercial.receiving_sessions.expiry_waiver_reason IS
    '[CE.2.1] Por qué un supervisor cerró el vale con renglones sin caducidad. NULL = se cerró con todo fechado (o antes de CE.2.1).'`);

  // ── 4. Llegadas al andén, repartida ──
  await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object('ALMACEN_LLEGADAS_VER', true)
      WHERE role_name = ANY(?) AND deleted_at IS NULL
        AND permissions -> 'ALMACEN_LLEGADAS_VER' IS NULL`,
    [LLEGADAS],
  );

  // ── Verificación: si algo no quedó, la migración falla en vez de mentir ──
  const { rows: semilla } = await knex.raw(
    `SELECT count(*)::int AS n FROM commercial.expiry_receiving_policy
      WHERE tenant_id = ? AND product_id IS NULL AND supplier_code IS NULL AND category = ANY(?) AND tracks_expiry IS FALSE`,
    [TENANT, NO_CADUCAN],
  );
  if (hayTenant && semilla[0].n !== NO_CADUCAN.length)
    throw new Error(`[CE.1.1] semilla incompleta: ${semilla[0].n} de ${NO_CADUCAN.length} departamentos con tracks_expiry=false`);
  const { rows: rep } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_permissions
      WHERE role_name = ANY(?) AND deleted_at IS NULL AND (permissions ->> 'ALMACEN_LLEGADAS_VER')::boolean IS TRUE`,
    [LLEGADAS],
  );
  // eslint-disable-next-line no-console
  console.log(`  [CE] semilla no-caduca: ${semilla[0].n} · ALMACEN_LLEGADAS_VER en ${rep[0].n} rol(es)`);
  const existen = await knex('identity.role_permissions').whereIn('role_name', LLEGADAS).whereNull('deleted_at').first('role_name');
  if (existen && rep[0].n === 0) throw new Error('[CE.3.2] ALMACEN_LLEGADAS_VER no quedó en ningún rol');
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT]);
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - 'ALMACEN_LLEGADAS_VER'
      WHERE role_name = ANY(?) AND (permissions ->> 'ALMACEN_LLEGADAS_VER')::boolean IS TRUE`,
    [LLEGADAS],
  );
  await knex.raw(`DELETE FROM commercial.expiry_receiving_policy WHERE source = 'semilla_ce'`);
  if (await knex.schema.withSchema('commercial').hasColumn('receiving_sessions', 'expiry_waiver_reason')) {
    await knex.schema.withSchema('commercial').alterTable('receiving_sessions', (t) => {
      t.dropColumn('expiry_waiver_reason');
      t.dropColumn('expiry_waiver_by');
      t.dropColumn('expiry_waiver_at');
    });
  }
  await knex.raw(`ALTER TABLE commercial.expiry_receiving_policy DROP CONSTRAINT IF EXISTS expiry_receiving_policy_shelf_life_pos`);
  for (const c of ['shelf_life_days', 'tracks_expiry']) {
    if (await knex.schema.withSchema('commercial').hasColumn('expiry_receiving_policy', c)) {
      await knex.schema.withSchema('commercial').alterTable('expiry_receiving_policy', (t) => t.dropColumn(c));
    }
  }
};
