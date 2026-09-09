'use strict';
/**
 * `[ID.27]` — El padrón queda limpio, y lo que se declaró sigue declarado.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * Una limpieza sin candado se deshace sola: la próxima migración que itere
 * «tenants activos» vuelve a escribirle al fixture, el próximo smoke vuelve a
 * dejar una cuenta, y el próximo rol nuevo vuelve a nacer sin poder ver el
 * padrón que administra. Este archivo afirma el ESTADO, no el cambio.
 *
 * ── Read-only a propósito ────────────────────────────────────────────────────
 * No escribe nada. Las dos pruebas negativas se ejercen **forzando la condición
 * dentro de la consulta** —un CASE que finge el dato malo— y exigiendo que el
 * conteo reaccione. Un candado que no reacciona a la condición que vigila es
 * decoración, y ésa es la falla que este archivo existe para impedir
 * (ADR-056: un gate sin prueba negativa es una intención).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knex = require('knex');

const URL = process.env.FLEET_DB_URL || process.env.DATABASE_URL_NEW;
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const FIXTURE = '00000000-0000-0000-0000-00000000beef';

let ok = 0;
let fail = 0;
let nomedido = 0;
const check = (cond, msg) => {
  if (cond) {
    ok++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL ${msg}`);
  }
};
const declarar = (msg) => {
  nomedido++;
  console.log(`  ~ NO MEDIDO ${msg}`);
};

(async () => {
  if (!URL) {
    console.error('Falta FLEET_DB_URL / DATABASE_URL_NEW');
    process.exit(1);
  }
  const k = knex({
    client: 'pg',
    pool: { min: 0, max: 2 },
    connection: /rlwy|railway/i.test(URL)
      ? { connectionString: URL, ssl: { rejectUnauthorized: false } }
      : URL,
  });

  try {
    console.log('\n[1] Ningún nombre de cuenta contradice a su username de ruta');
    // La familia `rv*`/`rd*` son credenciales de puesto cuyo `nombre` ES el
    // código de la ruta. Que el nombre diga OTRO código es el error de captura
    // que `[ID.27]` corrigió en `rvph03`.
    const { rows: contra } = await k.raw(
      `SELECT username, nombre FROM identity.users
        WHERE tenant_id = ? AND deleted_at IS NULL
          AND username ~ '^(rv|rd)[a-z]+[0-9]+$'
          AND upper(nombre) <> upper(username)`,
      [TENANT],
    );
    check(
      contra.length === 0,
      `0 credenciales de ruta con nombre discordante (hay ${contra.length}${contra.length ? ': ' + contra.map((r) => `${r.username}→${r.nombre}`).join(', ') : ''})`,
    );

    console.log('\n[2] El cliente B2B declara `none`, no `own` sin resolver');
    const { rows: b2b } = await k.raw(
      `SELECT dimension, mode FROM identity.role_scopes
        WHERE tenant_id = ? AND role_name = 'customer_b2b'
          AND dimension IN ('warehouse','zone') ORDER BY dimension`,
      [TENANT],
    );
    if (b2b.length !== 2) {
      declarar(`customer_b2b no tiene las 2 dimensiones esperadas (hay ${b2b.length})`);
    } else {
      check(
        b2b.every((r) => r.mode === 'none'),
        `warehouse y zone en none (están en ${b2b.map((r) => r.mode).join('/')})`,
      );
    }

    console.log('\n[3] La ceguera de alcance del padrón, medida');
    // Misma precedencia que el resolver: override de persona > rol > none.
    const sqlCeguera = (forzar) => `
      WITH efectivo AS (
        SELECT u.username, d.code AS dim, COALESCE(us.mode, rs.mode) AS mode,
               CASE WHEN ${forzar ? 'u.username = ?' : 'false'} THEN NULL
                    ELSE CASE d.code
                           WHEN 'warehouse' THEN u.warehouse_code
                           WHEN 'zone'      THEN u.zona_id::text
                           WHEN 'route'     THEN u.route_id::text
                           WHEN 'customer'  THEN u.customer_id::text
                         END END AS val
          FROM identity.users u
          CROSS JOIN identity.scope_dimensions d
          LEFT JOIN identity.user_scopes us
            ON us.tenant_id = u.tenant_id AND us.user_id = u.id AND us.dimension = d.code
          LEFT JOIN identity.role_scopes rs
            ON rs.tenant_id = u.tenant_id AND rs.role_name = u.role_name AND rs.dimension = d.code
         WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL)
      SELECT count(*)::int AS n FROM efectivo WHERE mode = 'own' AND val IS NULL`;

    const base = (await k.raw(sqlCeguera(false), [TENANT])).rows[0].n;
    check(base === 0, `0 pares persona-dimensión con \`own\` irresoluble (hay ${base})`);

    console.log('\n[4] PRUEBA NEGATIVA — la medición reacciona a la ficha rota');
    const { rows: cand } = await k.raw(
      `SELECT u.username FROM identity.users u
         LEFT JOIN identity.user_scopes us
           ON us.tenant_id = u.tenant_id AND us.user_id = u.id AND us.dimension = 'warehouse'
         LEFT JOIN identity.role_scopes rs
           ON rs.tenant_id = u.tenant_id AND rs.role_name = u.role_name AND rs.dimension = 'warehouse'
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL
          AND COALESCE(us.mode, rs.mode) = 'own' AND u.warehouse_code IS NOT NULL
        LIMIT 1`,
      [TENANT],
    );
    if (!cand.length) {
      declarar('nadie resuelve `own` en warehouse hoy: la prueba negativa no tiene sujeto');
    } else {
      const forzado = (await k.raw(sqlCeguera(true), [cand[0].username, TENANT])).rows[0].n;
      check(
        forzado > base,
        `fingirle la ficha vacía a ${cand[0].username} sube el conteo (${base} → ${forzado})`,
      );
    }

    console.log('\n[5] La baja quedó registrada COMO baja');
    // El punto no es que `prueba` esté inactiva: es que `status` y
    // `terminated_at` —que tuvieron 0 escrituras en toda la historia del
    // padrón— por fin cuentan la historia. Un `activo=false` con
    // `status='active'` sería la misma pantalla y ningún registro.
    const { rows: bajas } = await k.raw(
      `SELECT count(*) FILTER (WHERE NOT activo)::int inactivas,
              count(*) FILTER (WHERE NOT activo AND status = 'active')::int mudas,
              count(*) FILTER (WHERE status = 'terminated' AND terminated_at IS NOT NULL)::int con_baja
         FROM identity.users WHERE tenant_id = ?`,
      [TENANT],
    );
    const b = bajas[0];
    check(b.mudas === 0, `ninguna cuenta inactiva con status='active' (hay ${b.mudas} de ${b.inactivas})`);
    check(b.con_baja >= 1, `al menos una baja con status+terminated_at escritos (hay ${b.con_baja})`);

    console.log('\n[6] La cuenta de plataforma no aparece como vendedor de ruta');
    const { rows: sup } = await k.raw(
      `SELECT count(*)::int n FROM trade.daily_assignments da
         JOIN identity.users u ON u.id = da.user_id
        WHERE u.username = 'superoot' AND da.deleted_at IS NULL`,
    );
    check(sup[0].n === 0, `superoot sin asignaciones de ruta vigentes (hay ${sup[0].n})`);

    console.log('\n[7] El fixture está declarado y sigue vacío');
    const { rows: fx } = await k.raw(
      `SELECT t.metadata->>'es_fixture' AS declarado,
              (SELECT count(*)::int FROM identity.users u WHERE u.tenant_id = t.id) AS usuarios
         FROM identity.tenants t WHERE t.id = ?`,
      [FIXTURE],
    );
    if (!fx.length) {
      declarar('el tenant fixture ya no existe: si alguien lo borró, revisar test-authz-tenant-failclosed');
    } else {
      check(fx[0].declarado === 'true', 'test_tenant_b está declarado como fixture en metadata');
      check(fx[0].usuarios === 0, `el fixture sigue en 0 usuarios (tiene ${fx[0].usuarios})`);
    }

    console.log('\n[8] PRUEBA NEGATIVA — borrar los roles del fixture apagaría un candado');
    // `test-authz-tenant-failclosed` busca un role_name duplicado entre tenants
    // y sin sujeto reporta NO MEDIDO. Este bloque afirma que el sujeto existe, y
    // la prueba negativa es contar cuántos quedarían si se limpiara el fixture:
    // si es 0, la "limpieza" habría cambiado un dato sucio por una compuerta muerta.
    const { rows: dup } = await k.raw(
      `WITH d AS (
         SELECT role_name, count(DISTINCT tenant_id)::int tenants
           FROM identity.role_permissions WHERE deleted_at IS NULL
          GROUP BY 1)
       SELECT count(*) FILTER (WHERE tenants > 1)::int duplicados,
              (SELECT count(DISTINCT rp.role_name)::int
                 FROM identity.role_permissions rp
                WHERE rp.deleted_at IS NULL AND rp.tenant_id = ?
                  AND rp.role_name IN (SELECT role_name FROM d WHERE tenants > 1)) aportados_por_fixture
         FROM d`,
      [FIXTURE],
    );
    check(dup[0].duplicados >= 1, `hay ${dup[0].duplicados} role_name duplicado(s) entre tenants: el failclosed tiene sujeto`);
    check(
      dup[0].aportados_por_fixture >= 1,
      `${dup[0].aportados_por_fixture} de ellos los aporta el fixture → vaciarlo dejaría el candado en NO MEDIDO`,
    );

    console.log('\n[9] Ningún rol administra personal sin poder verlo');
    // El bug de `[IDG.8]`: `USUARIOS_GESTIONAR` sin permiso de reporte caía en
    // `own` y el rol veía una sola fila. Desde `[ID.27]` `alcanceDelPadron()`
    // resuelve `all` por `USUARIOS_GESTIONAR`, así que esto afirma la premisa
    // del arreglo — que la clave existe y se concede — y publica los roles que
    // ven el padrón sólo por la puerta de reportes.
    const { rows: adm } = await k.raw(
      `SELECT rp.role_name,
              (rp.permissions->>'USUARIOS_GESTIONAR') = 'true' AS gestiona,
              (rp.permissions->>'REPORTES_VER_GLOBAL')  = 'true' AS rep_global,
              (rp.permissions->>'REPORTES_VER_EQUIPO')  = 'true' AS rep_equipo,
              (SELECT count(*)::int FROM identity.users u
                WHERE u.tenant_id = rp.tenant_id AND u.role_name = rp.role_name
                  AND u.activo AND u.deleted_at IS NULL) AS usuarios
         FROM identity.role_permissions rp
        WHERE rp.tenant_id = ? AND rp.deleted_at IS NULL
          AND ((rp.permissions->>'USUARIOS_VER') = 'true' OR (rp.permissions->>'USUARIOS_GESTIONAR') = 'true')
        ORDER BY rp.role_name`,
      [TENANT],
    );
    check(
      adm.some((r) => r.gestiona),
      `al menos un rol concede USUARIOS_GESTIONAR (hay ${adm.filter((r) => r.gestiona).length})`,
    );
    // Los que ven el padrón sólo con `USUARIOS_VER` y sin NINGÚN permiso de
    // reporte caen en `own` y ven 1 fila. Los que tienen `REPORTES_VER_EQUIPO`
    // NO entran acá: resuelven `team`, que es comportamiento correcto — meterlos
    // infla el hallazgo (con `supervisor_ventas` dentro decía 9 en vez de 6).
    // No es un fallo de este candado: es `[ID.43]`, y se DECLARA con nombres y
    // conteo para que la decisión se tome contra un dato.
    const soloVer = adm.filter(
      (r) => !r.gestiona && !r.rep_global && !r.rep_equipo && r.usuarios > 0,
    );
    if (soloVer.length) {
      declarar(
        `${soloVer.reduce((s, r) => s + r.usuarios, 0)} persona(s) con USUARIOS_VER y sin reportes ven 1 sola fila ` +
          `del padrón (${soloVer.map((r) => `${r.role_name}×${r.usuarios}`).join(', ')}) → [ID.43] acotar por warehouse`,
      );
    }

    console.log(
      `\n${fail === 0 ? '✅' : '❌'} [ID.27] padrón limpio: ${ok} ok, ${fail} fallos, ${nomedido} no medido(s)`,
    );
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error(`\n❌ ERROR: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await k.destroy();
  }
})();
