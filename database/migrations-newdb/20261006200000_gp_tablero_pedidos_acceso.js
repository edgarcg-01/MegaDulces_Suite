'use strict';
/**
 * `[GP.1]` — Quién ve el tablero de pedidos del almacén (`/almacen/pedidos`).
 *
 * Autorizado por Francisco López (2026-10-06): roles encargado de sucursal, auxiliar de encargado,
 * facturación, telemarketing y coordinador de embarques; y las personas Juan Diego (PH), Juan
 * Manuel (Canindo), Araceli (Morelia), Alberto Moreno, Fany y Leo (CEDIS).
 *
 * ── Lo medido en prod antes de escribir esto (solo lectura, 2026-10-06) ─────────────────────────
 *  · Con el permiso de surtido (`COMMERCIAL_PICKING_VER`) sólo entraban `encargado_tienda` (7),
 *    `almacenista` (6) y otros 8 roles de oficina. Auxiliar de encargado, telemarketing,
 *    facturación y embarques NO entraban.
 *  · Facturación no tenía rol: las 3 facturadoras estaban en `auxiliar_compras` (38 permisos de
 *    Compras) y en `telemarketing` (41). Embarques tampoco: el puesto `embarques` existía con 0
 *    personas y sin rol propuesto.
 *  · `encargado_bodega` (Leo) no tenía NINGUNA regla de sucursal: con el permiso habría visto la
 *    lista vacía (ScopeService es fail-closed).
 *  · `maria_mendez` (alta del 2026-10-06) es la MISMA persona que `estefania_mendez`: María Estefanía
 *    Méndez Garibaldi, que hace dos funciones (facturación de PH y de CEDIS). Confirmado por
 *    Francisco. La duplicada quedó activa con rol `administrativo`, que ve TODAS las sucursales.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────────
 *   1. Dos perfiles nuevos, con el ALCANCE copiado de `telemarketing` (sucursal propia):
 *        · `facturacion`           — tablero + documentos de venta, pedidos, clientes, cartera,
 *                                    productos y verificador de precios. Base mínima: lo que hoy
 *                                    usan del rol de Compras/Telemarketing se revisa aparte.
 *        · `coordinador_embarques` — tablero + pool de surtido + embarques de Logística.
 *   2. Reparte `ALMACEN_PEDIDOS_VER`: a quien hoy tiene el de surtido (foto al aplicar, no regla
 *      viva) + auxiliar_tienda, telemarketing, encargado_bodega y los dos perfiles nuevos. Nunca
 *      pisa un `false` explícito puesto desde /admin/roles.
 *   3. `encargado_bodega` recibe regla de sucursal: sólo CEDIS (00), si no tenía ninguna.
 *   4. Los puestos proponen el perfil nuevo: `facturador` y `facturacion_cedis` → facturacion;
 *      `embarques` → coordinador_embarques. Sólo donde no proponían nada.
 *   5. Personas (sólo si la ficha sigue como se midió; si alguien ya la editó, no se pisa):
 *        · `maria_mendez` se retira como duplicada de `estefania_mendez` (patrón `[ID.36]`), con
 *          el motivo en `identity.user_events`.
 *        · `estefania_mendez`: nombre completo, puesto principal Facturación CEDIS, jefe Alberto
 *          Moreno, perfil `facturacion`, sigue en PH (01) y ve PH + CEDIS (01, 00).
 *        · `juan_arellano` (Juan Diego): puesto Embarques en PH, perfil `coordinador_embarques`.
 *      A los tres se les revocan las sesiones para que el menú nuevo entre al volver a entrar.
 *
 * ── Lo que NO hace (queda declarado) ────────────────────────────────────────────────────────────
 *  · Fany (CEDIS) no tiene usuario: hay que darla de alta desde Administración › Personas.
 *  · Juan Manuel y Araceli siguen como Coordinador de Telemarketing (rol `telemarketing`): con el
 *    paso 2 ya ven el tablero de SU sucursal (06 y 08). Si su puesto real es Embarques, se mueve
 *    desde la pantalla.
 *  · María del Carmen García y Monserrath Frausto (facturadoras en `telemarketing`) NO se mueven
 *    al perfil `facturacion`: perderían lo de telemarketing sin haber medido qué usan.
 *  · Estefanía CONSERVA Compras (órdenes de entrada, requisiciones…) porque las usa por su doble
 *    función: al cambiar `users.role_name`, el disparador `trg_sync_primary_role` degrada el perfil
 *    anterior a COMPLEMENTO en `identity.user_roles` (no lo borra) y el login une los dos. No se
 *    toca el perfil `facturacion`: así las demás facturadoras no heredan Compras. (Medido en local
 *    el 2026-10-06; antes de medirlo se había declarado, mal, que lo perdía.)
 *  · A Juan Diego, en cambio, el mismo disparador le dejaría `compras_operaciones` (35 permisos)
 *    como complemento, y su trabajo es Embarques: ese complemento se le QUITA explícitamente.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const PERMISO = 'ALMACEN_PEDIDOS_VER';
const PERMISO_ORIGEN = 'COMMERCIAL_PICKING_VER';
const ROLES_EXTRA = ['auxiliar_tienda', 'telemarketing', 'encargado_bodega'];
const ROL_ALCANCE = 'telemarketing';

const PERFILES = {
  facturacion: [
    PERMISO,
    'SERVICIO_REPORTAR',
    'COMMERCIAL_SALES_DOCS_VER',
    'COMMERCIAL_ORDERS_VER',
    'COMMERCIAL_CUSTOMERS_VER',
    'COMMERCIAL_CARTERA_VER',
    'COMMERCIAL_PRODUCTS_VER',
    'STORE_PRICE_CHECK_VER',
  ],
  coordinador_embarques: [PERMISO, 'SERVICIO_REPORTAR', 'COMMERCIAL_PICKING_VER', 'LOGISTICS_SHIPMENTS_VER'],
};
const PUESTOS = { facturador: 'facturacion', facturacion_cedis: 'facturacion', embarques: 'coordinador_embarques' };

const ITEM = 'GP.1';
const ACTOR = 'migracion [GP.1]';
const AUTORIZA = 'Autorizado por Francisco López (2026-10-06)';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const tenant = (await knex.raw(`SELECT id FROM identity.tenants WHERE slug = 'mega_dulces'`)).rows[0]?.id;
  if (!tenant) throw new Error('No se encontró el tenant mega_dulces.');

  const evento = (userId, event, detalle) =>
    knex.raw(
      `INSERT INTO identity.user_events (id, tenant_id, user_id, event, detalle, actor_username)
       VALUES (gen_random_uuid(), ?, ?, ?, ?::jsonb, ?)`,
      [tenant, userId, event, JSON.stringify({ ...detalle, item: ITEM }), ACTOR],
    );
  const usuario = async (username) =>
    (await knex.raw(`SELECT * FROM identity.users WHERE tenant_id = ? AND username = ?`, [tenant, username])).rows[0] || null;

  // ── 1. Perfiles nuevos, con el alcance de telemarketing ─────────────────────────────────────
  const alcance = await knex('identity.role_scopes')
    .where({ tenant_id: tenant, role_name: ROL_ALCANCE })
    .select('dimension', 'area', 'mode', 'values', 'mode_write');
  if (!alcance.length) throw new Error(`El rol ${ROL_ALCANCE} no tiene alcance que copiar.`);
  for (const [rol, permisos] of Object.entries(PERFILES)) {
    const existe = await knex('identity.role_permissions').where({ tenant_id: tenant, role_name: rol }).first('role_name');
    if (!existe) {
      await knex('identity.role_permissions').insert({
        tenant_id: tenant,
        role_name: rol,
        permissions: JSON.stringify(Object.fromEntries(permisos.map((p) => [p, true]))),
        kind: 'perfil',
      });
      console.log(`  [GP.1] perfil "${rol}" creado con ${permisos.length} permisos`);
    }
    for (const r of alcance) {
      await knex('identity.role_scopes')
        .insert({ tenant_id: tenant, role_name: rol, ...r, nota: `[GP.1] alcance copiado de ${ROL_ALCANCE}` })
        .onConflict(['tenant_id', 'role_name', 'dimension', 'area'])
        .ignore();
    }
  }

  // ── 2. Reparto del permiso del tablero ──────────────────────────────────────────────────────
  // Foto al aplicar: quien hoy tiene el de surtido + los roles pedidos. `permissions -> 'X' IS NULL`
  // (no el operador ?) para no pisar un false explícito (CLAUDE.md, diffs de role_permissions).
  const destino = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true), updated_at = now()
      WHERE tenant_id = ? AND deleted_at IS NULL AND permissions -> ? IS NULL
        AND ((permissions -> ?)::text = 'true' OR role_name = ANY(?::text[]))
      RETURNING role_name`,
    [PERMISO, tenant, PERMISO, PERMISO_ORIGEN, [...ROLES_EXTRA, ...Object.keys(PERFILES)]],
  );
  console.log(`  [GP.1] ${PERMISO} → ${destino.rows.map((r) => r.role_name).sort().join(', ') || '(nadie nuevo)'}`);

  // ── 3. encargado_bodega: sólo CEDIS ─────────────────────────────────────────────────────────
  await knex('identity.role_scopes')
    .insert({
      tenant_id: tenant, role_name: 'encargado_bodega', dimension: 'warehouse', area: '*', mode: 'listed',
      values: ['00'], nota: '[GP.1] no tenía regla de sucursal: con el permiso habría visto la lista vacía',
    })
    .onConflict(['tenant_id', 'role_name', 'dimension', 'area'])
    .ignore();

  // ── 4. Los puestos proponen el perfil nuevo ─────────────────────────────────────────────────
  for (const [puesto, rol] of Object.entries(PUESTOS)) {
    await knex('identity.positions').where({ tenant_id: tenant, code: puesto }).whereNull('default_role').update({ default_role: rol });
  }

  // ── 5. Personas ─────────────────────────────────────────────────────────────────────────────
  const estefania = await usuario('estefania_mendez');
  const duplicada = await usuario('maria_mendez');
  const juanDiego = await usuario('juan_arellano');
  const alberto = await usuario('alberto_moreno');
  const almacen = async (code) =>
    (await knex('commercial.warehouses').where({ tenant_id: tenant, code }).whereNull('deleted_at').first('id'))?.id ?? null;

  // 5a. La cuenta duplicada.
  if (estefania && duplicada && duplicada.status !== 'terminated' && duplicada.nombre === 'MARIA ESTEFANIA MENDEZ GARIBALDI') {
    await knex.raw(
      `UPDATE identity.users SET status = 'terminated', terminated_at = COALESCE(terminated_at, now()),
              deleted_at = COALESCE(deleted_at, now()), sessions_revoked_at = now(), updated_at = now()
        WHERE id = ?`,
      [duplicada.id],
    );
    const motivo = `Cuenta duplicada: es la misma persona que estefania_mendez (María Estefanía Méndez Garibaldi), que hace dos funciones, facturación de PH y de CEDIS. Se da de baja por estar duplicada. ${AUTORIZA}.`;
    await evento(estefania.id, 'cuenta_fusionada', { absorbe_a: 'maria_mendez', motivo });
    await evento(duplicada.id, 'cuenta_retirada_por_fusion', { fusionada_en: 'estefania_mendez', motivo });
    console.log('  [GP.1] maria_mendez retirada como duplicada de estefania_mendez');
  } else {
    console.log('  [GP.1] maria_mendez: no está como se midió (o ya se retiró); no se toca');
  }

  // 5b. Estefanía: una sola cuenta, dos funciones.
  if (estefania && estefania.role_name === 'auxiliar_compras' && estefania.position_code === 'facturador') {
    await knex('identity.users')
      .where({ id: estefania.id })
      .update({
        nombre: 'MARIA ESTEFANIA MENDEZ GARIBALDI',
        position_code: 'facturacion_cedis',
        department_code: 'almacen',
        supervisor_id: alberto ? alberto.id : estefania.supervisor_id,
        role_name: 'facturacion',
        warehouse_code: '01',
        warehouse_id: await almacen('01'),
        sessions_revoked_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    await knex('identity.user_scopes')
      .insert({
        tenant_id: tenant, user_id: estefania.id, dimension: 'warehouse', area: '*', mode: 'listed',
        values: ['00', '01'], nota: '[GP.1] factura en PH y en CEDIS',
      })
      .onConflict(['tenant_id', 'user_id', 'dimension', 'area'])
      .merge(['mode', 'values', 'nota']);
    await evento(estefania.id, 'roles_changed', {
      quitados: [], agregados: ['facturacion'], perfil_base: 'facturacion', complementos: ['auxiliar_compras'],
      motivo: `Puesto principal Facturación CEDIS, opera desde PH; ve PH (01) y CEDIS (00). Conserva Compras como complemento por su doble función. ${AUTORIZA}.`,
    });
    console.log('  [GP.1] estefania_mendez → facturacion, Facturación CEDIS, ve 01 y 00');
  } else {
    console.log('  [GP.1] estefania_mendez: la ficha ya no está como se midió; no se toca');
  }

  // 5c. Juan Diego: Embarques en PH.
  if (juanDiego && juanDiego.role_name === 'compras_operaciones' && juanDiego.position_code === 'encargado_operaciones') {
    await knex('identity.users')
      .where({ id: juanDiego.id })
      .update({
        position_code: 'embarques',
        department_code: 'logistica',
        role_name: 'coordinador_embarques',
        warehouse_code: '01',
        warehouse_id: await almacen('01'),
        sessions_revoked_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    // El disparador dejó compras_operaciones como complemento: se quita a propósito (su puesto es Embarques).
    await knex('identity.user_roles')
      .where({ tenant_id: tenant, user_id: juanDiego.id, role_name: 'compras_operaciones', is_primary: false })
      .del();
    await evento(juanDiego.id, 'roles_changed', {
      quitados: ['compras_operaciones'], agregados: ['coordinador_embarques'], perfil_base: 'coordinador_embarques', complementos: [],
      motivo: `Coordinador de embarques en PH (01). ${AUTORIZA}.`,
    });
    console.log('  [GP.1] juan_arellano → coordinador_embarques, Embarques, PH');
  } else {
    console.log('  [GP.1] juan_arellano: la ficha ya no está como se midió; no se toca');
  }

  // ── Compuertas ──────────────────────────────────────────────────────────────────────────────
  const sinPermiso = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE tenant_id = ? AND deleted_at IS NULL AND role_name = ANY(?::text[])
        AND COALESCE((permissions -> ?)::text, 'false') <> 'true'`,
    [tenant, ['encargado_tienda', 'almacenista', ...ROLES_EXTRA, ...Object.keys(PERFILES)], PERMISO],
  );
  if (sinPermiso.rows.length) {
    // Un false explícito puesto a mano se respeta, pero se dice en voz alta.
    console.log(`  ⚠️ [GP.1] siguen SIN ${PERMISO} (false explícito): ${sinPermiso.rows.map((r) => r.role_name).join(', ')}`);
  }
};

exports.down = async function down(knex) {
  const tenant = (await knex.raw(`SELECT id FROM identity.tenants WHERE slug = 'mega_dulces'`)).rows[0]?.id;
  if (!tenant) return;
  // Personas: se devuelven a como se midieron, sólo si siguen como las dejó el up. El disparador
  // re-promueve el perfil anterior a principal; el complemento que dejó el up se limpia a mano.
  const jd = await knex('identity.users')
    .where({ tenant_id: tenant, username: 'juan_arellano', role_name: 'coordinador_embarques', position_code: 'embarques' })
    .first('id');
  if (jd) {
    await knex('identity.users').where({ id: jd.id })
      .update({ role_name: 'compras_operaciones', position_code: 'encargado_operaciones', updated_at: knex.fn.now() });
    await knex('identity.user_roles').where({ tenant_id: tenant, user_id: jd.id, role_name: 'coordinador_embarques', is_primary: false }).del();
  }
  await knex('identity.users')
    .where({ tenant_id: tenant, username: 'estefania_mendez', role_name: 'facturacion' })
    .update({ role_name: 'auxiliar_compras', position_code: 'facturador', department_code: 'tienda', updated_at: knex.fn.now() });
  const est = await knex('identity.users').where({ tenant_id: tenant, username: 'estefania_mendez' }).first('id');
  if (est) {
    await knex('identity.user_scopes').where({ tenant_id: tenant, user_id: est.id, dimension: 'warehouse', area: '*' }).del();
    await knex('identity.user_roles').where({ tenant_id: tenant, user_id: est.id, role_name: 'facturacion', is_primary: false }).del();
  }
  // La cuenta duplicada NO se reactiva: era un error de alta, no un estado al que volver.

  for (const [puesto, rol] of Object.entries(PUESTOS)) {
    await knex('identity.positions').where({ tenant_id: tenant, code: puesto, default_role: rol }).update({ default_role: null });
  }
  await knex('identity.role_scopes').where({ tenant_id: tenant, role_name: 'encargado_bodega', dimension: 'warehouse' }).del();
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE tenant_id = ?`,
    [PERMISO, tenant],
  );
  for (const rol of Object.keys(PERFILES)) {
    const quedan = await knex('identity.users').where({ tenant_id: tenant, role_name: rol }).whereNull('deleted_at').count({ n: '*' }).first();
    if (Number(quedan.n) > 0) continue; // alguien lo usa: no se borra
    await knex('identity.role_scopes').where({ tenant_id: tenant, role_name: rol }).del();
    await knex('identity.role_permissions').where({ tenant_id: tenant, role_name: rol }).del();
  }
};
