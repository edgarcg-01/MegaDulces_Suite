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

    console.log('\n[7] ⚠️ `test_tenant_b` es EFÍMERO, no un fixture persistente');
    // ⚠️ CORRECCIÓN a lo que afirmé en `[ID.27]`. Lo declaré «fixture que no se
    // borra» y escribí esa declaración en su `metadata`. Está mal: el tenant lo
    // **crea y lo BORRA** `test-newdb-rls-isolation.js` — línea 261
    // (`DELETE FROM tenants WHERE id = TENANT_B`) más el barrido de todas las
    // tablas con su `tenant_id` en la 252. Existe sólo mientras ese test corre,
    // así que mi `metadata.es_fixture` se fue con la fila.
    //
    // La conclusión de `[ID.27]` sigue en pie —no hay que borrarlo a mano— pero
    // por otro motivo: no es que sea permanente, es que **no es nuestro**.
    const { rows: fx } = await k.raw(
      `SELECT (SELECT count(*)::int FROM identity.users u WHERE u.tenant_id = t.id) AS usuarios
         FROM identity.tenants t WHERE t.id = ?`,
      [FIXTURE],
    );
    if (!fx.length) {
      declarar(
        'el tenant efímero no está, que es lo normal fuera de una corrida de ' +
          'test-newdb-rls-isolation: su ausencia NO es un defecto del padrón',
      );
    } else {
      check(fx[0].usuarios === 0, `mientras existe, sigue en 0 usuarios (tiene ${fx[0].usuarios})`);
    }

    console.log('\n[8] ⚠️ El candado del failclosed depende del ORDEN de corrida');
    // `test-authz-tenant-failclosed` busca un `role_name` duplicado entre
    // tenants para su prueba negativa, y sin sujeto reporta NO MEDIDO. Pero el
    // único sujeto que existía lo aportaba un tenant EFÍMERO: o sea que ese
    // candado queda verde sólo si `test-newdb-rls-isolation` corrió antes y dejó
    // el tenant a medio limpiar, y `NO MEDIDO` si corre solo. **Un gate cuyo
    // veredicto depende del orden de ejecución no es un gate.**
    //
    // No se arregla acá —es el diseño de otro test, que tendría que sembrar su
    // propio sujeto— y no se dibuja verde: se DECLARA con el número, que es lo
    // que permite decidirlo en vez de volver a descubrirlo.
    const { rows: dup } = await k.raw(
      `WITH d AS (
         SELECT role_name, count(DISTINCT tenant_id)::int tenants
           FROM identity.role_permissions WHERE deleted_at IS NULL
          GROUP BY 1)
       SELECT count(*) FILTER (WHERE tenants > 1)::int duplicados FROM d`,
    );
    if (dup[0].duplicados === 0) {
      declarar(
        '0 role_name duplicados entre tenants → test-authz-tenant-failclosed va a reportar NO MEDIDO. ' +
          'Su prueba negativa necesita sembrar su propio sujeto en vez de heredar el que deja otro test.',
      );
    } else {
      check(true, `hay ${dup[0].duplicados} role_name duplicado(s): el failclosed tiene sujeto en ESTA corrida`);
    }

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
    // `[ID.35]` Los que ven el padrón sólo con `USUARIOS_VER` y sin NINGÚN
    // permiso de reporte ya no caen en `own`: el service los resuelve como
    // `sucursal` y ven al personal de su tienda. Los que tienen
    // `REPORTES_VER_EQUIPO` no entran acá (resuelven `team`, que es correcto).
    const soloVer = adm.filter(
      (r) => !r.gestiona && !r.rep_global && !r.rep_equipo && r.usuarios > 0,
    );
    if (!soloVer.length) {
      declarar('ningún rol con USUARIOS_VER y sin reportes: el eje `sucursal` no tiene portadores hoy');
    } else {
      // La premisa que hace que `sucursal` sirva: el rol tiene que resolver la
      // dimensión `warehouse` a algo. Si resolviera `none`, `applyTo` emitiría
      // `WHERE false` y volveríamos a una pantalla vacía — por otro camino.
      const { rows: dims } = await k.raw(
        `SELECT rs.role_name, rs.mode FROM identity.role_scopes rs
          WHERE rs.tenant_id = ? AND rs.dimension = 'warehouse'
            AND rs.role_name = ANY(?)`,
        [TENANT, soloVer.map((r) => r.role_name)],
      );
      const ciegos = dims.filter((d) => d.mode === 'none').map((d) => d.role_name);
      check(ciegos.length === 0,
        `los roles que dependen del eje \`sucursal\` resuelven warehouse a algo (en none: ${ciegos.join(', ') || 'ninguno'})`);

      // Y el conteo real: cuánta gente ve cada uno. Un 0 sería el defecto que
      // esto vino a arreglar, al revés.
      const { rows: alcance } = await k.raw(
        `SELECT e.username, e.warehouse_code AS suc,
                (SELECT count(*)::int FROM identity.users o
                  WHERE o.tenant_id = e.tenant_id AND o.warehouse_code = e.warehouse_code
                    AND o.activo AND o.deleted_at IS NULL) AS ve
           FROM identity.users e
          WHERE e.tenant_id = ? AND e.role_name = ANY(?) AND e.activo AND e.deleted_at IS NULL
          ORDER BY 1`,
        [TENANT, soloVer.map((r) => r.role_name)],
      );
      const sinVer = alcance.filter((r) => r.ve === 0);
      console.log(`      ${alcance.length} persona(s) en el eje \`sucursal\`: ${alcance.map((r) => `${r.username}(${r.suc || 'sin suc'})→${r.ve}`).join(' · ')}`);
      check(sinVer.length === 0,
        `ninguna ve 0 personas — el eje `.concat(`\`sucursal\` no deja a nadie con la pantalla vacía (en 0: ${sinVer.map((r) => r.username).join(', ') || 'ninguna'})`));
    }

    console.log('\n[10] `[ID.36]` Una persona, una cuenta');
    // Eran 11 personas cargando 22 de las 128 cuentas: la encargada con su
    // nombre + una segunda cuenta cuyo username es su código de caja. Nada en el
    // schema decía que esas doce filas eran seis personas.
    const NORM = `regexp_replace(lower(translate(btrim(nombre), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun')), '\\s+', ' ', 'g')`;
    const { rows: dobles } = await k.raw(
      `SELECT ${NORM} AS clave, count(*)::int AS n,
              string_agg(username, ', ' ORDER BY username) AS quienes
         FROM identity.users
        WHERE tenant_id = ? AND activo AND deleted_at IS NULL AND nombre IS NOT NULL
          AND array_length(regexp_split_to_array(btrim(nombre), '\\s+'), 1) >= 2
          AND nombre !~ '^Etiquetas'
        GROUP BY 1 HAVING count(*) > 1`,
      [TENANT],
    );
    check(dobles.length === 0,
      `ninguna persona con dos cuentas activas (quedan: ${dobles.map((r) => r.quienes).join(' | ') || 'ninguna'})`);

    // ⚠️ La que carga god-mode sin usarse era el riesgo real, no la prolijidad.
    const { rows: gm } = await k.raw(
      `SELECT count(*) FILTER (WHERE u.username = '01jzico' AND u.activo)::int AS pos_godmode,
              count(*) FILTER (WHERE u.activo AND u.deleted_at IS NULL)::int AS activos_godmode
         FROM identity.users u
         JOIN identity.role_permissions rp
           ON rp.tenant_id = u.tenant_id AND rp.role_name = u.role_name
        WHERE u.tenant_id = ? AND rp.is_platform_admin`,
      [TENANT],
    );
    check(gm[0].pos_godmode === 0,
      `la cuenta de POS con god-mode (01jzico) está retirada — nunca se usó y cargaba superadmin`);
    console.log(`      cuentas activas con god-mode: ${gm[0].activos_godmode}`);

    // Y que la consolidación de Diana no haya perdido jornadas.
    const { rows: dd } = await k.raw(
      `SELECT count(DISTINCT da.day_of_week)::int AS dias
         FROM trade.daily_assignments da JOIN identity.users u ON u.id = da.user_id
        WHERE da.deleted_at IS NULL AND u.username = 'diana_molina'`,
    );
    check(dd[0].dias >= 4,
      `diana_molina conserva la semana consolidada (${dd[0].dias} días de ruta)`);

    // Una jornada vigente colgada de alguien inactivo es trabajo asignado a nadie.
    const { rows: hu } = await k.raw(
      `SELECT count(*)::int AS n FROM trade.daily_assignments da
         JOIN identity.users u ON u.id = da.user_id
        WHERE da.deleted_at IS NULL AND NOT u.activo`,
    );
    check(hu[0].n === 0, `0 jornadas vigentes colgando de cuentas inactivas (hay ${hu[0].n})`);

    // El par que NO se fusionó, declarado para que no se proponga sin confirmar.
    const { rows: bb } = await k.raw(
      `SELECT username, nombre, warehouse_code, department_code FROM identity.users
        WHERE tenant_id = ? AND username IN ('brian_zavala', '54bcz')
          AND activo AND deleted_at IS NULL ORDER BY 1`,
      [TENANT],
    );
    if (bb.length === 2) {
      declarar(
        'sin fusionar a propósito: ' +
          bb.map((r) => `${r.username} ("${r.nombre}", ${r.department_code}/${r.warehouse_code || 'sin suc'})`).join(' vs ') +
          ' — apellidos iguales pero nombres de pila distintos, como Ivette vs Ivonne. Necesita confirmación humana.',
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
