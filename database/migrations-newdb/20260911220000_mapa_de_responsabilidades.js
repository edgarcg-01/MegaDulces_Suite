'use strict';
/**
 * `[OR.3a]` — El mapa puesto → responsabilidad. Cierra `DEUDA-OR-CARTA`.
 *
 * ── Por qué ahora ───────────────────────────────────────────────────────────────────────────
 * Decisión del lead (2026-09-11): *«podemos dejar los puestos y no asignarlos; lo importante es
 * trabajar en los puestos, no en los nombres.»* Eso desbloquea esto: **la responsabilidad cuelga
 * del PUESTO**, así que no hace falta saber quién ocupa qué para decidir de qué responde cada
 * puesto. Un puesto vacante que responde de algo es una vacante con nombre, no un hueco.
 *
 * ── Lo que faltaba para que el cruce fuera MEDIBLE ──────────────────────────────────────────
 * `[OR.1b]` dejó `position_responsibilities` vacía a propósito, y `[OR.7.1]` declaró que le faltaba
 * el sexto tipo de desacuerdo —`responsabilidad_sin_permiso`— porque no había nada que cruzar.
 * Pero había un impedimento más de fondo: **`identity.responsibilities` no declara qué permiso la
 * abre.** Ese conocimiento vivía **sólo en TypeScript** (`me-work.ts`, campo `anyOf`), así que la
 * base no podía contestar «¿este puesto puede abrir lo que responde?».
 *
 * Por eso el catálogo gana `permission_keys text[]`. Con eso, el cruce deja de ser una constante
 * copiada en una migración y pasa a ser una consulta.
 *
 * ── ⛔ Lo que sigue sin cambiar ─────────────────────────────────────────────────────────────
 * **La responsabilidad NO otorga el permiso.** El permiso decide si podés abrirlo; la
 * responsabilidad decide si es tuyo. `permission_keys` es lo que permite **detectar** el
 * desacuerdo, no repararlo por la vía rápida: si un puesto responde de algo que no puede abrir,
 * eso se ve y alguien decide — conceder la clave o cambiar el responsable.
 *
 * ── El resultado, medido ────────────────────────────────────────────────────────────────────
 * De las 15 asignaciones: **11 ejecutables** y **4 en las que el perfil del puesto no abre la
 * bandeja**. Se siembran **las 15**, porque la verdad organizacional es la verdad organizacional y
 * esconder las 4 dejaría dos bandejas sin responsable y sin que nadie se entere:
 *
 *   · `logistica.flota` -> `encargado_logistica`   el puesto NO TIENE ROL (default_role NULL):
 *     no puede abrir nada. Y medido antes: las alertas de flota sólo las abren `jefe_finanzas` y
 *     `sistemas` — **nadie que pueda mover un camión**.
 *   · `comercial.thot` -> `supervisor_rd`          le falta COMMERCIAL_THOT_GESTIONAR. ⚠️ Hoy la
 *     tienen los 30 `vendedor_ruta`, o sea que aprueban las sugerencias dirigidas a ellos mismos.
 *   · `almacen.conteo` -> `encargado_sucursal`     secundario; el principal (`supervisor_inventarios`) sí abre
 *   · `tienda.caducidades` -> `auxiliar_encargado` secundario; el principal (`encargado_sucursal`) sí abre
 *
 * **Es la responsabilidad haciendo su trabajo: revela permisos que faltan en vez de heredarlos.**
 *
 * ── Lo que NO entra, con nombre ─────────────────────────────────────────────────────────────
 * El candado de escritura (`[OR.7.3]`: rechazar una asignación sin el permiso, salvo override con
 * motivo) **no se construye todavía porque no hay camino de escritura**: no existe endpoint ni
 * pantalla para asignar responsabilidades. Un candado sin tráfico no se puede probar y se oxida.
 * Va junto con la pantalla. Mientras tanto el desacuerdo **se mide** en la vista.
 *
 * Aditiva e idempotente. No toca personas, permisos ni alcance.
 *
 * @param { import("knex").Knex } knex
 */

/** Las claves que abren cada bandeja. Espejo de `anyOf` en `libs/trade/src/lib/users/me-work.ts`. */
const ABRE = {
  'finanzas.hallazgos': ['FINANCE_AI_CHAT'],
  'finanzas.acciones': ['FINANCE_AI_CHAT'],
  'almacen.cuadre': ['RECONCILIATION_VER'],
  'compras.reabasto': ['COMPRAS_HALLAZGOS_VER'],
  'almacen.conteo': ['COMMERCIAL_INVENTORY_CONTAR'],
  'tienda.caducidades': ['COMMERCIAL_EXPIRY_VER', 'COMMERCIAL_EXPIRY_CAPTURAR'],
  'logistica.flota': ['LOGISTICS_FLEET_VER'],
  'comercial.thot': ['COMMERCIAL_THOT_GESTIONAR'],
};

/** [responsabilidad, puesto, es_principal] — derivado del organigrama de Dirección. */
const MAPA = [
  ['finanzas.hallazgos', 'jefe_finanzas', true],
  ['finanzas.hallazgos', 'auxiliar_finanzas', false],
  ['finanzas.hallazgos', 'auxiliar_contabilidad', false],
  ['finanzas.acciones', 'jefe_finanzas', true],
  ['compras.reabasto', 'gerente_compras', true],
  ['compras.reabasto', 'comprador', false],
  ['compras.reabasto', 'auxiliar_compras', false],
  ['almacen.cuadre', 'supervisor_inventarios', true],
  ['almacen.cuadre', 'encargado_sucursal', false],
  ['almacen.conteo', 'supervisor_inventarios', true],
  ['almacen.conteo', 'encargado_sucursal', false],
  ['tienda.caducidades', 'encargado_sucursal', true],
  ['tienda.caducidades', 'auxiliar_encargado', false],
  ['logistica.flota', 'encargado_logistica', true],
  ['comercial.thot', 'supervisor_rd', true],
];

exports.up = async function up(knex) {
  // ── 1. El catálogo declara qué permiso lo abre ────────────────────────────
  if (!(await knex.schema.withSchema('identity').hasColumn('responsibilities', 'permission_keys'))) {
    await knex.raw(
      `ALTER TABLE identity.responsibilities
         ADD COLUMN permission_keys text[] NOT NULL DEFAULT '{}'::text[]`);
    console.log('  [OR.3a] + identity.responsibilities.permission_keys');
  }
  await knex.raw(`COMMENT ON COLUMN identity.responsibilities.permission_keys IS
    '[OR.3a] Claves que ABREN esta bandeja (espejo de anyOf en me-work.ts). Existe para poder CRUZAR responsabilidad contra permiso desde la base: antes ese saber vivia solo en TypeScript y la base no podia contestar "este puesto puede abrir lo que responde?". NO otorga el permiso -- permite DETECTAR el desacuerdo.'`);

  for (const [key, claves] of Object.entries(ABRE)) {
    await knex.raw(
      `UPDATE identity.responsibilities SET permission_keys = ?::text[] WHERE key = ?`,
      [`{${claves.join(',')}}`, key]);
  }
  const sinClave = await knex('identity.responsibilities')
    .whereRaw(`array_length(permission_keys, 1) IS NULL`)
    .pluck('key');
  console.log(`  [OR.3a] catálogo: ${Object.keys(ABRE).length} con claves · ${sinClave.length} sin declarar${sinClave.length ? ` (${sinClave.join(', ')})` : ''}`);

  // ── 2. El mapa ────────────────────────────────────────────────────────────
  const tenants = await knex('identity.tenants').where({ activo: true }).pluck('id');
  for (const tenant of tenants) {
    let puestas = 0;
    let saltadas = 0;
    for (const [key, code, principal] of MAPA) {
      const p = await knex('identity.positions')
        .where({ tenant_id: tenant, code })
        .whereNull('deleted_at')
        .first('code');
      if (!p) { saltadas++; console.log(`     ~ ${code} no existe en este tenant — se salta`); continue; }
      const res = await knex.raw(
        `INSERT INTO identity.position_responsibilities
           (tenant_id, position_code, responsibility_key, es_principal)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, position_code, responsibility_key) WHERE deleted_at IS NULL
         DO NOTHING`,
        [tenant, code, key, principal]);
      if (res.rowCount) puestas++;
    }
    console.log(`  [OR.3a] ${puestas} asignación/es puesto × responsabilidad · ${saltadas} saltada/s`);

    // ── 3. Toda bandeja tiene un responsable PRINCIPAL ──────────────────────
    const huerfanas = await knex.raw(
      `SELECT r.key FROM identity.responsibilities r
        WHERE NOT EXISTS (
          SELECT 1 FROM identity.position_responsibilities pr
           WHERE pr.tenant_id = ? AND pr.responsibility_key = r.key
             AND pr.es_principal AND pr.deleted_at IS NULL)
        ORDER BY r.orden`, [tenant]);
    if (huerfanas.rows.length) {
      console.log(`  [OR.3a] ⚠️ ${huerfanas.rows.length} responsabilidad/es SIN principal: ${huerfanas.rows.map((r) => r.key).join(', ')}`);
    } else {
      console.log(`  [OR.3a] las ${Object.keys(ABRE).length} responsabilidades tienen un puesto PRINCIPAL`);
    }

    // ── 4. El cruce que ahora es una consulta ───────────────────────────────
    const cruce = await knex.raw(
      `SELECT pr.responsibility_key AS resp, pr.position_code AS puesto, pr.es_principal,
              (SELECT count(*)::int FROM identity.users u
                WHERE u.tenant_id = pr.tenant_id AND u.position_code = pr.position_code
                  AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno') AS gente
         FROM identity.position_responsibilities pr
         JOIN identity.responsibilities r ON r.key = pr.responsibility_key
         JOIN identity.positions p ON p.tenant_id = pr.tenant_id AND p.code = pr.position_code
        WHERE pr.tenant_id = ? AND pr.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM unnest(r.permission_keys) AS clave
             WHERE EXISTS (
               SELECT 1 FROM identity.role_permissions rp
                WHERE rp.tenant_id = pr.tenant_id AND rp.deleted_at IS NULL
                  AND (rp.role_name = p.default_role
                       OR rp.role_name = ANY(coalesce(p.default_complements, '{}'::text[])))
                  AND (rp.permissions -> clave)::text = 'true'))
        ORDER BY pr.es_principal DESC, pr.responsibility_key`, [tenant]);

    console.log(`\n  [OR.3a] ${cruce.rows.length} asignación/es donde el perfil del puesto NO abre la bandeja:`);
    cruce.rows.forEach((r) =>
      console.log(
        `     · ${String(r.resp).padEnd(22)} ${String(r.puesto).padEnd(24)}` +
        `${r.es_principal ? 'PRINCIPAL' : 'secundario'} · ${r.gente} persona/s`));
    console.log(`     Es la responsabilidad haciendo su trabajo: REVELA permisos que faltan en vez de heredarlos.`);
  }

  // ── 5. La vista gana el sexto tipo ──────────────────────────────────────
  // `[OR.7.1]` lo dejó declarado como ausente «porque una rama que siempre da
  // cero se lee igual que no hay problemas». Ya hay qué cruzar.
  await knex.raw(`
    CREATE OR REPLACE VIEW identity.v_authz_coherencia_resp AS
    SELECT
      pr.tenant_id,
      'responsabilidad_sin_permiso'::text AS tipo,
      pr.position_code                    AS sujeto,
      pr.responsibility_key               AS detalle,
      (SELECT count(*)::int FROM identity.users u
        WHERE u.tenant_id = pr.tenant_id AND u.position_code = pr.position_code
          AND u.activo AND u.deleted_at IS NULL AND u.kind = 'interno') AS cuantos,
      NULL::int AS de_cuantos,
      format('el puesto "%s" responde de "%s" y su perfil "%s" no concede ninguna de las claves que la abren',
             pr.position_code, pr.responsibility_key, coalesce(p.default_role, '(sin perfil)')) AS dice
      FROM identity.position_responsibilities pr
      JOIN identity.responsibilities r ON r.key = pr.responsibility_key
      JOIN identity.positions p ON p.tenant_id = pr.tenant_id AND p.code = pr.position_code
     WHERE pr.deleted_at IS NULL
       AND array_length(r.permission_keys, 1) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM unnest(r.permission_keys) AS clave
          WHERE EXISTS (
            SELECT 1 FROM identity.role_permissions rp
             WHERE rp.tenant_id = pr.tenant_id AND rp.deleted_at IS NULL
               AND (rp.role_name = p.default_role
                    OR rp.role_name = ANY(coalesce(p.default_complements, '{}'::text[])))
               AND (rp.permissions -> clave)::text = 'true'))`);

  await knex.raw(`ALTER VIEW identity.v_authz_coherencia_resp SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON identity.v_authz_coherencia_resp TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW identity.v_authz_coherencia_resp IS
    '[OR.3a] El sexto tipo de desacuerdo de v_authz_coherencia: un puesto que responde de algo que su perfil no le deja abrir. Vive en su propia vista para no re-crear la de [OR.7.1] (y perderle el security_invoker, que es el gotcha del proyecto). Se consulta junto con ella.'`);
  console.log('\n  [OR.3a] identity.v_authz_coherencia_resp creada (el 6º tipo)');
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS identity.v_authz_coherencia_resp`);
  for (const tenant of await knex('identity.tenants').pluck('id')) {
    for (const [key, code] of MAPA) {
      await knex('identity.position_responsibilities')
        .where({ tenant_id: tenant, position_code: code, responsibility_key: key })
        .del();
    }
  }
  await knex('identity.responsibilities').update({ permission_keys: knex.raw(`'{}'::text[]`) });
  console.log('  [OR.3a] down: mapa y vista retirados. La columna permission_keys se conserva.');
};
