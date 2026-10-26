/* eslint-disable no-console */
/**
 * `[OBS.15]` Instala (o retira) la COLA DE CAMBIOS en las réplicas `kepler_md_XX`.
 * El porqué y lo que no cubre viven en `database/importers/lib/ods-cola.js`.
 *
 * EN SECO POR DEFECTO: muestra el estado de cada rama y el SQL que correría. Escribe sólo con
 * `--apply`. Cada tabla se instala en su propia transacción con `lock_timeout = 3s`: el trigger
 * necesita un candado breve sobre la tabla, y no debe quedarse esperando detrás de una transacción
 * larga del apply worker (eso sí frenaría la replicación).
 *
 * ⛔ GUARDA DE IDENTIDAD: se niega si la base a la que conecta NO es un suscriptor de replicación
 * lógica. La cola sólo tiene sentido en una réplica; en cualquier otra base sería un trigger
 * escribiendo en una tabla que nadie vacía.
 *
 * Uso:
 *   node database/scripts/ods-cola-instalar.js                      # en seco, las 9 ramas
 *   node database/scripts/ods-cola-instalar.js --branch=06          # en seco, una rama
 *   node database/scripts/ods-cola-instalar.js --apply              # instala kdm1,kdm2
 *   node database/scripts/ods-cola-instalar.js --quitar --apply     # retira (triggers primero)
 *   --tables=kdm1,kdm2 (default)
 *
 * Origen: `ODS_SOURCE_BASE` (la del carril) o `KEPLER_REPLICA_BASE`. Nunca `DATABASE_URL_NEW`:
 * en este repo esa variable significa tres cosas distintas (GOTCHAS §17).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });
const { Client } = require('pg');
const { BRANCHES, replicaUrl } = require('../importers/lib/kepler-branches');
const { instalarSql, quitarSql, estadoCola, profundidadCola } = require('../importers/lib/ods-cola');

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
const APPLY = process.argv.includes('--apply');
const QUITAR = process.argv.includes('--quitar');
const SOLO = arg('branch') || null;
const TABLAS = (arg('tables') || 'kdm1,kdm2').split(',').map((s) => s.trim()).filter(Boolean);
const BASE = process.env.ODS_SOURCE_BASE || process.env.KEPLER_REPLICA_BASE;

async function pkDe(p, tabla) {
  const { rows } = await p.query(`
    SELECT a.attname FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = ('md.' || quote_ident($1))::regclass AND i.indisprimary
    ORDER BY array_position(i.indkey, a.attnum)`, [tabla]);
  return rows.map((r) => r.attname);
}

(async () => {
  if (!BASE) { console.error('✖ falta ODS_SOURCE_BASE o KEPLER_REPLICA_BASE (la base del contenedor de réplicas).'); process.exit(1); }
  console.log(`\n=== ods-cola ${QUITAR ? 'RETIRAR' : 'INSTALAR'} — ${APPLY ? 'APPLY' : 'EN SECO'} · tablas ${TABLAS.join(',')} ===`);
  const resumen = [];
  let mostrado = false;
  for (const b of BRANCHES) {
    if (SOLO && b.code !== SOLO) continue;
    const p = new Client({ connectionString: replicaUrl(b.code, BASE), connectionTimeoutMillis: 10000, statement_timeout: 30000 });
    try { await p.connect(); } catch (e) { resumen.push({ rama: b.code, error: `no conecta: ${e.message.slice(0, 60)}` }); continue; }
    try {
      const sub = (await p.query(
        `SELECT count(*)::int AS n FROM pg_subscription WHERE subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].n;
      if (!sub) { resumen.push({ rama: b.code, error: 'NO es un suscriptor de replicación — no se toca' }); continue; }
      const tablas = [];
      for (const t of TABLAS) {
        const existe = (await p.query(`SELECT to_regclass('md.' || quote_ident($1)) IS NOT NULL AS hay`, [t])).rows[0].hay;
        if (!existe) continue;
        tablas.push({ tabla: t, pk: await pkDe(p, t) });
      }
      const antes = await estadoCola(p, TABLAS);
      const lotes = QUITAR ? quitarSql(tablas) : instalarSql(tablas);
      if (!APPLY && !mostrado) {
        mostrado = true;
        console.log(`\n-- SQL (rama ${b.code}; igual en las demás salvo la PK de cada tabla):`);
        for (const l of lotes) console.log(`BEGIN;\n${l.map((s) => `  ${s.replace(/\s+/g, ' ')};`).join('\n')}\nCOMMIT;`);
      }
      if (APPLY) {
        for (const l of lotes) {
          await p.query('BEGIN');
          try { for (const s of l) await p.query(s); await p.query('COMMIT'); }
          catch (e) { await p.query('ROLLBACK').catch(() => {}); throw e; }
        }
      }
      const despues = APPLY ? await estadoCola(p, TABLAS) : antes;
      const prof = despues.cola ? await profundidadCola(p, TABLAS) : [];
      resumen.push({
        rama: b.code,
        antes: TABLAS.map((t) => `${t}:${antes.tablas[t]}`).join(' '),
        despues: APPLY ? TABLAS.map((t) => `${t}:${despues.tablas[t]}`).join(' ') : '(en seco)',
        en_cola: prof.reduce((a, r) => a + r.n, 0),
      });
    } catch (e) {
      resumen.push({ rama: b.code, error: e.message.slice(0, 90) });
    } finally { await p.end().catch(() => {}); }
  }
  console.table(resumen);
  const errores = resumen.filter((r) => r.error).length;
  if (!APPLY) console.log('EN SECO — nada cambió. Corré con --apply.');
  process.exit(errores ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
