#!/usr/bin/env node
// [ERR.1] Errores de la API → GitHub issues: UN issue por (método, ruta), no uno por error.
//   node .claude/skills/pm/errores-a-issues.js          → abre / actualiza / reabre / cierra issues
//   node .claude/skills/pm/errores-a-issues.js --dry    → sólo imprime qué haría
// Lee analytics.ui_usage de pg-prod en SÓLO LECTURA (PROD_DB_URL). Escribe sólo en el repo privado
// edgarcg-01/MegaDulces_PM. La ruta es el PATRÓN de Nest (sin ids ni datos de clientes).
//
// Umbral (D2 de la tarjeta [ERR] #73 — propuesta, ajustable aquí):
//   · FALLA:   ≥ UMBRAL_5XX respuestas 5xx en un día.
//   · RECHAZO: ≥ UMBRAL_4XX_N respuestas 4xx en un día Y ≥ UMBRAL_4XX_PCT de las llamadas
//              (un rechazo masivo suele ser un defecto de pantalla, como el arqueo de rutas).
//   Antes de la migración 20261021111235 no hay 4xx/5xx: se usa el total con la regla de rechazo
//   y el issue lo DECLARA ("sin separar").
// Se cierra cuando pasan DIAS_PARA_CERRAR días seguidos bajo el umbral.
const path = require('path');
const { execFileSync } = require('child_process');
const raiz = path.resolve(__dirname, '..', '..', '..');
require(path.join(raiz, 'node_modules/dotenv')).config({ path: path.join(raiz, '.env'), quiet: true });
const { Client } = require(path.join(raiz, 'node_modules/pg'));

const DRY = process.argv.includes('--dry');
const REPO = 'edgarcg-01/MegaDulces_PM';
const UMBRAL_5XX = 5, UMBRAL_4XX_N = 100, UMBRAL_4XX_PCT = 0.20, DIAS_PARA_CERRAR = 3, VENTANA = 7;
const ETIQUETA = 'auto-error';

const gh = (a) => {
  for (let i = 1; ; i++) {
    try { return execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { if (i >= 4) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000 * i); }
  }
};

/**
 * El workflow "auto-add" del tablero mete cada issue nuevo como tarjeta. Los automáticos no son
 * tarjetas (el tablero queda a nivel fase; la madre es #73), así que se sacan. Nunca falla el run.
 */
function sacarDelTablero(url) {
  const n = Number(String(url).split('/').pop());
  for (let intento = 0; intento < 5; intento++) {
    try {
      const it = JSON.parse(gh(['project', 'item-list', '2', '--owner', 'edgarcg-01', '--limit', '400', '--format', 'json']))
        .items.find((i) => i.content?.number === n);
      if (it) { gh(['project', 'item-delete', '2', '--owner', 'edgarcg-01', '--id', it.id]); return; }
    } catch { /* se reintenta */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000);
  }
}

async function leerUso() {
  const c = new Client({ connectionString: process.env.PROD_DB_URL, statement_timeout: 30000, connectionTimeoutMillis: 8000 });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const id = (await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
    if (id !== '7688376744939610156') throw new Error(`no es pg-prod (${id})`);
    const conClases = (await c.query(`SELECT count(*)::int n FROM information_schema.columns
      WHERE table_schema='analytics' AND table_name='ui_usage' AND column_name IN ('errores_4xx','errores_5xx')`)).rows[0].n === 2;
    const cols = conClases ? 'sum(errores_4xx)::int e4, sum(errores_5xx)::int e5' : 'NULL::int e4, NULL::int e5';
    const r = await c.query(`SELECT metodo, ruta, fecha::text dia, sum(hits)::int hits, sum(errores)::int err, ${cols},
        string_agg(DISTINCT role_name, ', ') FILTER (WHERE errores > 0) roles
      FROM analytics.ui_usage WHERE fecha >= current_date - $1::int
      GROUP BY 1,2,3 ORDER BY 1,2,3`, [VENTANA]);
    await c.query('ROLLBACK');
    return { conClases, filas: r.rows };
  } finally { await c.end(); }
}

const evaluar = (d, conClases) => {
  if (conClases && d.e5 != null && d.e5 >= UMBRAL_5XX) return 'falla';
  const rech = conClases ? d.e4 : d.err;
  if (rech != null && rech >= UMBRAL_4XX_N && d.hits > 0 && rech / d.hits >= UMBRAL_4XX_PCT) return 'rechazo';
  return null;
};

function cuerpo(clave, dias, conClases, tipo) {
  const filas = dias.map((d) => `| ${d.dia} | ${d.hits} | ${conClases ? d.e4 : '—'} | ${conClases ? d.e5 : '—'} | ${d.err} | ${d.hits ? Math.round(100 * d.err / d.hits) : 0} % | ${d.roles || ''} |`);
  return [
    `**Error automático (ERR.1)** — \`${clave}\` · tipo: **${tipo === 'falla' ? 'FALLA (5xx)' : 'RECHAZO masivo (4xx)'}**`,
    '',
    conClases ? '' : '⚠️ **Sin separar 4xx/5xx:** la migración `20261021111235` aún no está en prod; se usa el total de errores.',
    `Últimos ${VENTANA} días (\`analytics.ui_usage\`, pg-prod):`,
    '',
    '| Día | Llamadas | 4xx | 5xx | Errores | % | Roles con error |',
    '|---|---:|---:|---:|---:|---:|---|',
    ...filas,
    '',
    `Umbral: falla ≥ ${UMBRAL_5XX} 5xx/día · rechazo ≥ ${UMBRAL_4XX_N} 4xx/día y ≥ ${UMBRAL_4XX_PCT * 100} % de las llamadas. Se cierra solo tras ${DIAS_PARA_CERRAR} días bajo el umbral.`,
    'Tarjeta madre: #73 [ERR]. Este issue lo mantiene `.claude/skills/pm/errores-a-issues.js`: no editar la tabla a mano.',
  ].filter((l) => l !== null).join('\n');
}

(async () => {
  const { conClases, filas } = await leerUso();
  const porRuta = new Map();
  for (const f of filas) { const k = `${f.metodo} ${f.ruta}`; (porRuta.get(k) || porRuta.set(k, []).get(k)).push(f); }

  const existentes = DRY ? [] : JSON.parse(gh(['issue', 'list', '-R', REPO, '--label', ETIQUETA, '--state', 'all', '--limit', '300', '--json', 'number,title,state']));
  if (!DRY) gh(['label', 'create', ETIQUETA, '-R', REPO, '--color', 'E4E669', '--description', 'Abierto por errores-a-issues.js (ERR.1)', '--force']);
  const acciones = [];

  for (const [clave, dias] of porRuta) {
    const marcas = dias.map((d) => evaluar(d, conClases));
    const tipo = marcas.slice().reverse().find(Boolean) || null;
    const ultimos = marcas.slice(-DIAS_PARA_CERRAR);
    const sigueMal = marcas.slice(-2).some(Boolean);           // ayer u hoy sobre el umbral
    const titulo = `[ERR-AUTO] ${clave}`.slice(0, 250);
    const issue = existentes.find((x) => x.title === titulo);

    if (sigueMal) {
      const body = cuerpo(clave, dias, conClases, tipo);
      if (!issue) {
        acciones.push(['abrir', titulo]);
        if (!DRY) { const url = gh(['issue', 'create', '-R', REPO, '--title', titulo, '--body', body, '--label', 'bug', '--label', ETIQUETA]).trim(); sacarDelTablero(url); }
      }
      else {
        if (issue.state === 'CLOSED') { acciones.push(['reabrir', titulo]); if (!DRY) { gh(['issue', 'reopen', String(issue.number), '-R', REPO]); gh(['issue', 'comment', String(issue.number), '-R', REPO, '--body', 'Volvió a pasar el umbral: reabierto.']); } }
        else acciones.push(['actualizar', titulo]);
        if (!DRY) gh(['issue', 'edit', String(issue.number), '-R', REPO, '--body', body]);
      }
    } else if (issue && issue.state === 'OPEN' && ultimos.length >= DIAS_PARA_CERRAR && ultimos.every((m) => !m)) {
      acciones.push(['cerrar', titulo]);
      if (!DRY) gh(['issue', 'close', String(issue.number), '-R', REPO, '--comment', `${DIAS_PARA_CERRAR} días seguidos bajo el umbral: se cierra. Si vuelve, se reabre solo.`]);
    }
  }
  console.log(`${conClases ? '4xx/5xx separados' : 'SIN separar 4xx/5xx (falta la migración)'} · ${porRuta.size} rutas con tráfico`);
  for (const [a, t] of acciones) console.log(`  ${a.padEnd(10)} ${t}`);
  if (!acciones.length) console.log('  nada que hacer');
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
