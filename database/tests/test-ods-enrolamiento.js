/* eslint-disable no-console */
/**
 * [OBS.7] CANDADO — una tabla PUBLICADA que la suscripción no enrola se pierde EN SILENCIO.
 *
 * ── LO QUE ESTE TEST EXISTE PARA QUE NO VUELVA ───────────────────────────────────────────
 * El 2026-09-12 se midió que la póliza contable de SEPTIEMBRE (`md.kdc22609`) no había
 * replicado en 6 de las 8 ramas — 12 días de contabilidad ausente del ODS — y **nada estaba
 * en rojo**: las 8 suscripciones `enabled`, el apply worker sano, el lag en segundos, el
 * latido de los carriles en verde. `sub_md_00` llevaba **9,568 `sync_error_count`** por la
 * misma causa sin que ningún tablero lo mostrara.
 *
 * La causa raíz es una línea de permisos cruzada, medida idéntica en los 6 POS alcanzables:
 *
 *     default_privileges en schema md:  sa(r):platform_ro=r/sa | postgres(r):ods_repl=r/postgres
 *                                       ▲ el rol que CREA        ▲ un rol que no crea nada
 *
 * Kepler crea sus tablas como **`sa`**. Bajo `sa` sólo se declaró `platform_ro`. A **`ods_repl`**
 * —el usuario del **tablesync**— se le declaró el default bajo `postgres`. Entonces **cada tabla
 * nueva nace ilegible para la replicación**: el worker intenta el `COPY`, no tiene `SELECT`,
 * falla y reintenta para siempre. La tabla queda en `pg_subscription_rel` con `srsubstate='d'`
 * y **esa es toda la señal que hay**.
 *
 * ⚠️ Y la mitigación lo empeoró: `ensure-monthly-tables.js` pre-crea la tabla del período nuevo
 * para evitar el crash-loop del apply worker. Al existir localmente, el worker ya no muere —
 * pero sin enrolar, las filas nunca llegan. **Convirtió una falla RUIDOSA en una MUDA.**
 *
 * ── LO QUE CANDADEA ──────────────────────────────────────────────────────────────────────
 *  1. Ninguna rama con tablas en `srsubstate <> 'r'`. Es el síntoma directo y basta con mirarlo.
 *  2. El default privilege de `ods_repl` está declarado **para el rol que crea** (`sa`), no para
 *     `postgres`. Ésta es la que impide que VUELVA; la 1 sólo dice que ya pasó.
 *  3. `ods_repl` puede leer la tabla del período EN CURSO y la del SIGUIENTE (`kdc2YYMM`), que es
 *     donde detona: el 1 de cada mes nace una tabla nueva.
 *  4. Un `sync_error_count` que crece es falla, no ruido.
 *
 * ⛔ NACE EN ROJO a propósito (ADR-056: un gate sin prueba negativa es una intención). Al
 *    escribirlo, 7 de 8 ramas tenían tablas en `d` y los 6 POS tenían el default cruzado.
 *    Si lo ves verde sin que nadie haya corrido el `GRANT`, el test está roto, no el sistema.
 *
 * ⚠️ Lee las RÉPLICAS (`KEPLER_REPLICA_BASE`), no la DB de la app. Y los POS para la parte de
 *    permisos: lo que no se alcanza se declara **NO MEDIDO**, nunca verde (R4 / ADR-056).
 *
 *   KEPLER_REPLICA_BASE=… node database/tests/test-ods-enrolamiento.js
 */
const { Client } = require('pg');
const { esFaltaDeAcceso, noMedido } = require('./_lib/no-medido');
const { BRANCHES, urlOf, replicaDbName, USER, PASS } = require('../importers/lib/kepler-branches');

const BASE = process.env.KEPLER_REPLICA_BASE
  || (() => { throw new Error('falta KEPLER_REPLICA_BASE (el contenedor de réplicas :5433 en el servidor md)'); })();

let ok = 0; let fail = 0; let nm = 0;
const ck = (l, c, d = '') => {
  if (c) { ok++; console.log(`  ✔ ${l}`); } else { fail++; console.log(`  ✖ ${l}${d ? ` — ${d}` : ''}`); }
};
const decl = (l, d) => { nm++; console.log(`  ◻ NO MEDIDO — ${l}${d ? ` (${d})` : ''}`); };

/** `kdc2YYMM` del mes en curso y del siguiente: donde detona el 1 de cada mes. */
const periodos = (hoy) => {
  const y = hoy.getUTCFullYear() % 100; const m = hoy.getUTCMonth() + 1;
  const p = (yy, mm) => `kdc2${String(yy).padStart(2, '0')}${String(mm).padStart(2, '0')}`;
  return [p(y, m), m === 12 ? p(y + 1, 1) : p(y, m + 1)];
};

const conn = async (cs, ms = 60000) => {
  const c = new Client({ connectionString: cs, statement_timeout: ms, connectionTimeoutMillis: 10000 });
  await c.connect();
  return c;
};

(async () => {
  console.log('\n=== OBS.7 · enrolamiento de la replicación lógica (la falla muda) ===\n');
  const [actual, siguiente] = periodos(new Date());
  console.log(`  período en curso=${actual}  siguiente=${siguiente}\n`);

  // ── 1) ¿alguna tabla sin terminar su sync, en alguna rama? ────────────────────────────
  let trabadas = 0; let ramasMedidas = 0;
  for (const b of BRANCHES) {
    const u = new URL(BASE); u.pathname = `/${replicaDbName(b.code)}`;
    let c;
    try { c = await conn(u.toString()); } catch (e) {
      if (esFaltaDeAcceso(e)) { decl(`réplica ${replicaDbName(b.code)} inalcanzable`, e.message.slice(0, 60)); continue; }
      throw e;
    }
    ramasMedidas++;
    const d = (await c.query(
      `SELECT srrelid::regclass::text t, srsubstate FROM pg_subscription_rel WHERE srsubstate <> 'r' ORDER BY 1`)).rows;
    if (d.length) trabadas += d.length;
    ck(`md_${b.code}: sin tablas a medio sincronizar`, d.length === 0,
      `${d.length} en estado no-ready → ${d.slice(0, 8).map((x) => `${x.t}(${x.srsubstate})`).join(', ')}`);
    await c.end();
  }
  if (!ramasMedidas) noMedido('ninguna réplica alcanzable: el candado no puede opinar');
  console.log(`    (${ramasMedidas} ramas medidas · ${trabadas} tablas trabadas en total)\n`);

  // ── 2+3) permisos en el PUBLICADOR: la parte que impide que VUELVA ────────────────────
  let posMedidos = 0;
  for (const b of BRANCHES) {
    if (b.replica) { decl(`POS md_${b.code} no expone ${USER} (rama replica-only)`, 'permisos sin verificar'); continue; }
    let c;
    try { c = await conn(urlOf(b)); } catch (e) {
      decl(`POS md_${b.code} inalcanzable`, e.message.slice(0, 60)); continue;
    }
    posMedidos++;
    // 2) el default privilege tiene que colgar del rol que CREA las tablas
    const dp = (await c.query(`
      SELECT pg_get_userbyid(defaclrole) AS rol, array_to_string(defaclacl, ' ') AS acl
        FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
       WHERE n.nspname = 'md' AND d.defaclobjtype = 'r'`)).rows;
    const creador = (await c.query(`
      SELECT pg_get_userbyid(relowner) AS r, count(*)::int n
        FROM pg_class c2 JOIN pg_namespace n ON n.oid = c2.relnamespace
       WHERE n.nspname = 'md' AND c2.relkind = 'r' GROUP BY 1 ORDER BY 2 DESC LIMIT 1`)).rows[0];
    const cubre = dp.some((x) => x.rol === creador.r && /ods_repl=/.test(x.acl || ''));
    ck(`md_${b.code}: default privilege de ods_repl cuelga de '${creador.r}' (el rol que crea)`, cubre,
      `declarado para: ${dp.map((x) => `${x.rol}→${(x.acl || '').replace(/\/\w+/g, '')}`).join(' | ') || 'NADA'}`);

    // 3) las tablas de período donde detona el 1 de cada mes
    for (const t of [actual, siguiente]) {
      // ⚠️ en DOS consultas: Postgres evalúa todo el target list, así que un
      // `has_table_privilege` junto al `to_regclass` revienta igual si la tabla no existe.
      const existe = (await c.query(`SELECT to_regclass('md.' || $1) IS NOT NULL AS e`, [t])).rows[0].e;
      if (!existe) { console.log(`  · md_${b.code}: ${t} todavía no existe en el POS (normal si el período no llegó)`); continue; }
      const puede = (await c.query(
        `SELECT has_table_privilege('ods_repl', 'md.' || $1, 'SELECT') AS p`, [t])).rows[0].p;
      ck(`md_${b.code}: ods_repl puede leer ${t}`, puede, 'sin SELECT → su tablesync va a fallar en silencio');
    }
    await c.end();
  }
  if (!posMedidos) decl('ningún POS alcanzable', 'la causa raíz (permisos) queda SIN VERIFICAR');

  // ── 4) errores de sync acumulados ────────────────────────────────────────────────────
  const u0 = new URL(BASE); u0.pathname = `/${replicaDbName(BRANCHES[0].code)}`;
  try {
    const c = await conn(u0.toString());
    const st = (await c.query(
      `SELECT subname, sync_error_count::int s FROM pg_stat_subscription_stats WHERE sync_error_count > 0 ORDER BY 2 DESC`)).rows;
    ck('ninguna suscripción acumula errores de tablesync', st.length === 0,
      st.map((x) => `${x.subname}=${x.s}`).join(' '));
    await c.end();
  } catch (e) { decl('pg_stat_subscription_stats', e.message.slice(0, 60)); }

  console.log(`\n  ${ok} ok · ${fail} fallas · ${nm} no medidos\n`);
  if (fail) {
    console.log('  ⛔ ARREGLO (requiere sa/superusuario en CADA POS — platform_ro no alcanza):');
    console.log('     ALTER DEFAULT PRIVILEGES FOR ROLE sa IN SCHEMA md GRANT SELECT ON TABLES TO ods_repl;');
    console.log('     GRANT SELECT ON md.<tabla> TO ods_repl;   -- UNA por sentencia, NUNCA ON ALL TABLES en horario hábil');
    console.log('     (no hace falta re-ejecutar REFRESH: el tablesync reintenta solo)\n');
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
