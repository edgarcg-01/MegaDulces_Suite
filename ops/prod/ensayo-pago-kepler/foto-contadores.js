#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[PGP.71]` **Qué tablas toca Kepler cuando una persona captura un pago** — las 360, no sólo las
 * 242 que replica el ODS.
 *
 * Lee los contadores de Postgres (`pg_stat_user_tables`: inserciones, cambios y borrados por tabla),
 * que `kepler_push` puede ver sin permiso sobre cada tabla. Una foto antes y otra después de que
 * Tesorería capture UN pago; la diferencia son las tablas que el programa de Kepler escribió.
 * ⚠️ Lo que capture otra persona en esa ventana también sale: se hace con la ventana corta y se
 * cruza contra los documentos nuevos de `kdm1` en el mismo lapso.
 *
 *   node foto-contadores.js foto  <sucursal> > antes.json     # corre psql en md por ssh
 *   node foto-contadores.js foto  <sucursal> > despues.json
 *   node foto-contadores.js comparar antes.json despues.json
 *
 * La conexión sale del maestro `~/kepler-push-secretos/kepler-push.env` y viaja por stdin.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MD = process.env.MD_SSH || 'superoot@192.168.0.222';
const SQL = `SET default_transaction_read_only = on;
COPY (SELECT relname, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables WHERE schemaname='md' ORDER BY relname) TO STDOUT WITH CSV;`;

function urlDe(suc) {
  const maestro = path.join(os.homedir(), 'kepler-push-secretos', 'kepler-push.env');
  for (const l of fs.readFileSync(maestro, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^#?\s*KEPLER_PUSH_URL_(\d{2})=(\S+)\s*$/);
    if (m && m[1] === suc) return m[2];
  }
  throw new Error(`El maestro no tiene KEPLER_PUSH_URL_${suc}`);
}

function foto(suc) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', MD, 'IFS= read -r U; psql "$U" -X -q'], { input: `${urlDe(suc)}\n${SQL}\n`, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'psql falló');
  const tablas = {};
  for (const l of r.stdout.split(/\r?\n/)) {
    const [t, i, u, d] = l.split(',');
    if (t && /^\d+$/.test(i)) tablas[t] = { ins: +i, upd: +u, del: +d };
  }
  if (!Object.keys(tablas).length) throw new Error('La foto salió vacía');
  console.log(JSON.stringify({ sucursal: suc, cuando: new Date().toISOString(), tablas }));
}

function comparar(a, b) {
  const A = JSON.parse(fs.readFileSync(a, 'utf8')), B = JSON.parse(fs.readFileSync(b, 'utf8'));
  console.log(`De ${A.cuando} a ${B.cuando} (${Object.keys(B.tablas).length} tablas):`);
  let n = 0;
  for (const [t, v] of Object.entries(B.tablas)) {
    const o = A.tablas[t] ?? { ins: 0, upd: 0, del: 0 };
    const d = { ins: v.ins - o.ins, upd: v.upd - o.upd, del: v.del - o.del };
    if (d.ins || d.upd || d.del) { n++; console.log(`  ${t.padEnd(18)} +${d.ins} insertadas · ${d.upd} cambiadas · ${d.del} borradas${A.tablas[t] ? '' : '  (tabla NUEVA)'}`); }
  }
  console.log(n ? `${n} tablas cambiaron.` : 'Ninguna tabla cambió.');
}

const [, , cmd, x, y] = process.argv;
if (cmd === 'foto') foto(x || '00');
else if (cmd === 'comparar') comparar(x, y);
else { console.error('Uso: foto <sucursal> | comparar <antes.json> <despues.json>'); process.exit(1); }
