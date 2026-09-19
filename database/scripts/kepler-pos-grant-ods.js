#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[RL.10]` Destraba la replicación en TODOS los POS Kepler de una corrida: otorga a `ods_repl` y
 * `platform_ro` lo que no pueden leer, y deja puesto el `ALTER DEFAULT PRIVILEGES` para que no
 * vuelva a pasar con las tablas que Kepler cree el mes que viene.
 *
 * ── El problema que resuelve ────────────────────────────────────────────────────────────────
 * `ERP_KEPLER.md` §4.2b: el `ALTER DEFAULT PRIVILEGES` quedó **cruzado** en los POS. Las tablas
 * de Kepler las crea `sa`, y bajo `sa` sólo se declaró `platform_ro`; a `ods_repl` —el rol con el
 * que corre el tablesync— se le declaró bajo `postgres`, que no crea nada. Resultado: **toda
 * tabla nueva de Kepler nace invisible para la replicación, en silencio.**
 *
 * Cómo se ve: la tabla queda en `pg_subscription_rel` con `srsubstate='d'` y el worker reintenta
 * para siempre. ⚠️ La suscripción sigue `enabled`, el apply worker sano y el lag en segundos —
 * sólo esa tabla no llega. `sub_md_00` acumuló 9,568 `sync_error_count` así, sin ponerse nada rojo.
 *
 * Medido el 2026-09-18: **12 tablas trabadas en 6 ramas** — la póliza de septiembre `kdc22609` en
 * cinco, y 7 de RH en el CEDIS. Padre Hidalgo tenía 4,369 filas esperando desde el 12-sep.
 *
 * ── Por qué DESCUBRE en vez de listar ───────────────────────────────────────────────────────
 * No lleva la lista de tablas rotas: la calcula con `has_table_privilege` en cada POS. Una lista
 * escrita a mano se desactualiza el día que Kepler crea la próxima `kdc2YYMM`, y este script
 * existe justamente para esa clase de tabla.
 *
 * Y el `ALTER DEFAULT PRIVILEGES` lo pone **para cada rol que de verdad es dueño de tablas en
 * `md`** (leído de `pg_class.relowner`), no para uno supuesto. Suponer el dueño es exactamente el
 * error que causó el bug.
 *
 * ── ⚠️ Por qué NO usa `GRANT ON ALL TABLES` ─────────────────────────────────────────────────
 * Ése toma lock sobre las ~330 tablas del schema y las retiene hasta el commit, **en una caja que
 * está cobrando**. Acá se otorga sólo lo que hace falta (1 a 7 tablas), una sentencia por tabla.
 *
 * ── Desde dónde se corre ────────────────────────────────────────────────────────────────────
 * ⭐ Desde `192.168.0.249`. Medido el 2026-09-18: los POS conservan en su `pg_hba` las líneas de
 * cuando el suscriptor vivía acá, así que `postgres`/`sa` llegan a **los 6**. Desde `md`
 * (`192.168.0.222`) sólo llega Padre Hidalgo — las otras cinco responden
 * "no hay una línea en pg_hba.conf". Si algún día se limpian esas líneas viejas, esto deja de
 * funcionar desde acá y hay que ir por consola/VNC.
 *
 *   node database/scripts/kepler-pos-grant-ods.js --dry          # sólo reporta, no toca nada
 *   node database/scripts/kepler-pos-grant-ods.js                # aplica
 *   node database/scripts/kepler-pos-grant-ods.js --user=postgres --branch=02
 *
 * La contraseña se pide por consola y no se imprime nunca. ⚠️ NO es la misma en todos los POS
 * (medido: `postgres` falla en Padre Hidalgo y `sa` funciona). El script sigue con las demás y
 * reporta cuáles quedaron; se re-corre con `--branch=NN` y el usuario que corresponda.
 */
const readline = require('node:readline');
const { Client } = require('pg');
const { BRANCHES } = require('../importers/lib/kepler-branches');

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `=${d}`).split('=')[1];
const DRY = process.argv.includes('--dry');
const USER = arg('user', 'sa');
const SOLO = arg('branch', '');

/** Pide la contraseña sin eco. No se guarda, no se imprime, no viaja a ningún archivo. */
function pedirPassword(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (ch) => { if (['\n', '\r', ''].includes(ch.toString())) process.stdin.removeListener('data', onData); };
    process.stdin.on('data', onData);
    rl._writeToOutput = function (s) { if (s.includes(prompt)) rl.output.write(prompt); };
    rl.question(prompt, (v) => { rl.output.write('\n'); rl.close(); resolve(v); });
  });
}

// Las tablas que alguno de los dos roles NO puede leer. Se calcula allá, no acá.
const SQL_ROTAS = `
  SELECT c.oid::regclass::text AS t
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'md' AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_roles g
                  WHERE g.rolname = ANY ($1::text[])
                    AND NOT has_table_privilege(g.rolname, c.oid, 'SELECT'))
   ORDER BY 1`;

const SQL_DUENOS = `
  SELECT DISTINCT pg_get_userbyid(c.relowner) AS d
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'md' AND c.relkind = 'r' ORDER BY 1`;

async function unaRama(b, password) {
  const c = new Client({
    host: b.host, port: b.port, database: b.db, user: USER, password,
    connectionTimeoutMillis: 15000, statement_timeout: 60000,
  });
  try { await c.connect(); } catch (e) {
    return { rama: b.code, nombre: b.name, error: (e.message || '').split('\n')[0].slice(0, 80) };
  }
  try {
    const roles = (await c.query(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('ods_repl','platform_ro') ORDER BY 1`)).rows.map((r) => r.rolname);
    if (!roles.length) return { rama: b.code, nombre: b.name, error: 'no existe ods_repl ni platform_ro' };

    const rotas = (await c.query(SQL_ROTAS, [roles])).rows.map((r) => r.t);
    const duenos = (await c.query(SQL_DUENOS)).rows.map((r) => r.d);
    const lista = roles.map((r) => `"${r}"`).join(', ');

    if (!DRY) {
      // Una sentencia por tabla, auto-commit: el lock dura lo que dura el GRANT.
      for (const t of rotas) await c.query(`GRANT SELECT ON ${t} TO ${lista}`);
      for (const d of duenos) {
        try { await c.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${d}" IN SCHEMA md GRANT SELECT ON TABLES TO ${lista}`); }
        catch (e) { return { rama: b.code, nombre: b.name, rotas, duenos, roles, avisoDueno: `${d}: ${(e.message || '').slice(0, 60)}` }; }
      }
    }
    // Se vuelve a medir: el veredicto es el estado, no que el comando no haya fallado.
    const quedan = DRY ? rotas.length : (await c.query(SQL_ROTAS, [roles])).rows.length;
    return { rama: b.code, nombre: b.name, rotas, duenos, roles, quedan };
  } catch (e) {
    return { rama: b.code, nombre: b.name, error: (e.message || '').split('\n')[0].slice(0, 80) };
  } finally { await c.end().catch(() => {}); }
}

(async () => {
  const ramas = BRANCHES.filter((b) => !SOLO || b.code === SOLO);
  console.log(`\n[RL.10] GRANT del ODS en los POS Kepler · usuario ${USER} · ${DRY ? 'ENSAYO' : 'APLICA'}`);
  console.log(`  ramas: ${ramas.map((b) => b.code).join(', ')}\n`);

  const password = await pedirPassword(`Contraseña de ${USER} en los POS: `);
  const res = [];
  for (const b of ramas) res.push(await unaRama(b, password));

  console.log('');
  let fallaron = 0;
  for (const r of res) {
    const cab = `  ${r.rama} ${String(r.nombre).padEnd(20)}`;
    if (r.error) { console.log(`${cab} ⛔ ${r.error}`); fallaron++; continue; }
    const det = r.rotas.length ? r.rotas.map((t) => t.replace(/^md\./, '')).join(', ') : '(ninguna)';
    console.log(`${cab} ${DRY ? 'otorgaría a' : 'otorgadas'}: ${r.rotas.length} — ${det}`);
    if (r.avisoDueno) { console.log(`       ⚠️ no se pudo poner el default de ${r.avisoDueno}`); fallaron++; }
    else if (!DRY && r.quedan > 0) { console.log(`       ⛔ QUEDAN ${r.quedan} ilegibles tras el GRANT`); fallaron++; }
  }

  console.log('');
  if (fallaron) {
    console.log(`⛔ ${fallaron} rama(s) sin cerrar. Si el motivo es la contraseña, re-correr esa sola:`);
    console.log('   node database/scripts/kepler-pos-grant-ods.js --branch=NN --user=postgres');
  } else {
    console.log(DRY ? '✅ ensayo completo — volver a correr sin --dry para aplicar'
      : '✅ todas las ramas cerradas. El tablesync reintenta solo: las tablas pasan a `r` en segundos.');
  }
  process.exit(fallaron ? 1 : 0);
})();
