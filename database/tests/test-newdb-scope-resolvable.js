'use strict';
/**
 * `[ID.26]` — El alcance declara cuando NO se puede resolver.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * `ScopeService.applyTo()` emite `whereRaw('false')` cuando el modo es `none`
 * **o** cuando la lista de valores viene vacía. Y `valoresDe()` devuelve lista
 * vacía para `own` con la columna de la ficha en NULL.
 *
 * Consecuencia: **«no ve nada porque así se configuró» y «no sabemos qué ve
 * porque le falta el dato» producen el MISMO SQL y la MISMA pantalla vacía.**
 * Eso viola ADR-056 de frente — el veredicto tiene que ser ternario, y lo que
 * no se pudo medir se DECLARA, nunca se dibuja como cero.
 *
 * Este test NO afirma que el filtro esté cerrado (cerrarlo es `[ID.43]`, y va
 * después de poblar la ficha). Afirma que la condición **se detecta y se
 * publica**, que es el paso que hace que cerrarlo después no sea una apuesta.
 *
 * ── Read-only a propósito ────────────────────────────────────────────────────
 * No escribe nada, ni dentro de una transacción. La prueba negativa no necesita
 * mutar el padrón: se ejerce **forzando la condición dentro de la consulta**
 * (un CASE que finge la columna vacía para un usuario) y verificando que el
 * conteo suba. Si la consulta no reacciona a eso, es decorativa.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knex = require('knex');

const URL = process.env.FLEET_DB_URL || process.env.DATABASE_URL_NEW;
const TENANT = '00000000-0000-0000-0000-00000000d01c';

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

/**
 * La misma precedencia que el resolver: override de persona gana sobre el rol y,
 * sin fila, el default es `none`. `forzarVacio` finge la ficha vacía para UN
 * username — es lo que convierte esto en prueba negativa sin escribir.
 */
const sqlCeguera = (forzarVacio) => `
  WITH efectivo AS (
    SELECT u.username, d.code AS dimension,
           COALESCE(us.mode, rs.mode) AS mode,
           CASE
             WHEN ${forzarVacio ? 'u.username = ?' : 'false'} THEN NULL
             ELSE CASE d.code
                    WHEN 'warehouse' THEN u.warehouse_code
                    WHEN 'zone'      THEN u.zona_id::text
                    WHEN 'route'     THEN u.route_id::text
                    WHEN 'customer'  THEN u.customer_id::text
                  END
           END AS valor_ficha
      FROM identity.users u
      CROSS JOIN identity.scope_dimensions d
      LEFT JOIN identity.user_scopes us
        ON us.tenant_id = u.tenant_id AND us.user_id = u.id AND us.dimension = d.code
      LEFT JOIN identity.role_scopes rs
        ON rs.tenant_id = u.tenant_id AND rs.role_name = u.role_name AND rs.dimension = d.code
     WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL)
  SELECT count(*)::int AS n FROM efectivo WHERE mode = 'own' AND valor_ficha IS NULL`;

(async () => {
  if (!URL) {
    console.error('Falta FLEET_DB_URL / DATABASE_URL_NEW');
    process.exit(1);
  }
  const k = knex({ client: 'pg', connection: URL, pool: { min: 0, max: 2 }, ...(/rlwy|railway/i.test(URL) ? { connection: { connectionString: URL, ssl: { rejectUnauthorized: false } } } : {}) });

  try {
    console.log('\n[1] El catálogo de dimensiones declara quién puede resolver `own`');
    const { rows: dims } = await k.raw(
      `SELECT code, supports_own FROM identity.scope_dimensions ORDER BY orden`,
    );
    check(dims.length === 6, `las 6 dimensiones están en el catálogo (hay ${dims.length})`);
    // `own` sin columna en la ficha es irresoluble POR CONSTRUCCIÓN: el catálogo
    // tiene que decirlo, o la UI ofrece un modo que después rebota con 400.
    const conColumna = new Set(['warehouse', 'zone', 'route', 'customer']);
    const mienten = dims.filter((d) => d.supports_own && !conColumna.has(d.code));
    check(
      mienten.length === 0,
      `ninguna dimensión declara supports_own sin columna propia (mienten: ${mienten.map((d) => d.code).join(', ') || 'ninguna'})`,
    );

    console.log('\n[2] La ceguera de alcance se MIDE, no se supone');
    const base = (await k.raw(sqlCeguera(false), [TENANT])).rows[0].n;
    console.log(`      hoy: ${base} par(es) persona-dimensión con \`own\` y la ficha vacía`);
    check(Number.isInteger(base), 'el diagnóstico devuelve un número, no null');

    console.log('\n[3] PRUEBA NEGATIVA — la consulta reacciona a la condición');
    // Se elige un usuario que HOY resuelve `own` en `warehouse`. Fingirle la
    // ficha vacía tiene que subir el conteo. Si no sube, el diagnóstico no
    // detecta nada y su "0" no significa "todo bien".
    const { rows: cand } = await k.raw(
      `SELECT u.username
         FROM identity.users u
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
      // Sin nadie que hoy resuelva `own`, el bloque NO puede comprobarse. Se
      // declara — pasar en vacío es exactamente el modo de falla que este
      // archivo existe para impedir.
      declarar('nadie resuelve `own` en warehouse hoy: la prueba negativa no tiene sujeto');
    } else {
      const forzado = (await k.raw(sqlCeguera(true), [cand[0].username, TENANT])).rows[0].n;
      check(
        forzado > base,
        `fingir la ficha vacía de ${cand[0].username} sube el conteo (${base} → ${forzado})`,
      );
    }

    console.log('\n[4] PRUEBA NEGATIVA — sin universo se DECLARA, no se dibuja 0');
    const { rows: tenants } = await k.raw(
      `SELECT t.id, t.slug,
              (SELECT count(*)::int FROM identity.users u
                WHERE u.tenant_id = t.id AND u.activo AND u.deleted_at IS NULL) AS cuentas
         FROM identity.tenants t ORDER BY 3`,
    );
    const vacio = tenants.find((t) => t.cuentas === 0);
    if (!vacio) {
      declarar('no hay un tenant sin cuentas con el que ejercer el caso vacío');
    } else {
      const n = (await k.raw(sqlCeguera(false), [vacio.id])).rows[0].n;
      // El punto no es que dé 0 — es que el SERVICIO no puede reportar ese 0
      // como "0 problemas". Se afirma la premisa que obliga al `measured:false`.
      check(
        n === 0 && vacio.cuentas === 0,
        `el tenant ${vacio.slug} no tiene universo (${vacio.cuentas} cuentas) → el diagnóstico debe reportar measured:false, nunca "0 problemas"`,
      );
    }

    console.log('\n[5] El riesgo latente queda publicado (es el gate de `[ID.43]`)');
    const { rows: latente } = await k.raw(
      `SELECT d.code AS dimension,
              count(*) FILTER (WHERE CASE d.code
                WHEN 'warehouse' THEN u.warehouse_code
                WHEN 'zone'      THEN u.zona_id::text
                WHEN 'route'     THEN u.route_id::text
                WHEN 'customer'  THEN u.customer_id::text END IS NULL)::int AS ciegos_si_girara,
              count(*)::int AS activos
         FROM identity.users u CROSS JOIN identity.scope_dimensions d
        WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL AND d.supports_own
        GROUP BY 1 ORDER BY 2 DESC`,
      [TENANT],
    );
    for (const r of latente) {
      console.log(`      ${r.dimension.padEnd(10)} girar a \`own\` cegaría ${r.ciegos_si_girara} de ${r.activos}`);
    }
    check(latente.length > 0, 'el riesgo de girar a `own` está medido por dimensión');

    console.log(`\n${fail === 0 ? '✅' : '❌'} [ID.26] alcance resoluble: ${ok} ok, ${fail} fallos, ${nomedido} no medido(s)`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error(`\n❌ ERROR: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await k.destroy();
  }
})();
