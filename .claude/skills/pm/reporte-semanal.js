#!/usr/bin/env node
// Reporte de estado semanal del tablero PM — mide y publica, sin LLM de por medio.
//   node .claude/skills/pm/reporte-semanal.js          → publica el status update del proyecto
//   node .claude/skills/pm/reporte-semanal.js --dry    → sólo imprime, no publica
// Lee: el GitHub Project (gh) y, en sólo lectura, analytics.cron_runs de pg-prod (PROD_DB_URL).
// Lo que no se pudo medir se DECLARA en el reporte ("NO MEDIDO"), nunca se omite en silencio.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const raiz = path.resolve(__dirname, '..', '..', '..');
const DRY = process.argv.includes('--dry');
const PROJECT = 'PVT_kwHOA7xW8s4BnyCF', OWNER = 'edgarcg-01', REPO = 'edgarcg-01/MegaDulces_PM', TOPE = 4;
// El registro vive fuera del repo (no ensucia el árbol compartido): %TEMP%\pm-reporte-semanal.log
const log = path.join(require('os').tmpdir(), 'pm-reporte-semanal.log');
const anota = (s) => { try { fs.appendFileSync(log, `${new Date().toISOString()} ${s}\n`); } catch { /* sin log no se frena */ } };

const gh = (a) => {
  for (let i = 1; ; i++) {
    try { return execFileSync('gh', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { if (i >= 4) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000 * i); }
  }
};
const hoyMx = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const masDias = (iso, d) => { const x = new Date(iso + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };

async function saludProcesos() {
  try {
    require(path.join(raiz, 'node_modules/dotenv')).config({ path: path.join(raiz, '.env'), quiet: true });
    const { Client } = require(path.join(raiz, 'node_modules/pg'));
    const c = new Client({ connectionString: process.env.PROD_DB_URL, statement_timeout: 20000, connectionTimeoutMillis: 8000 });
    await c.connect();
    try {
      await c.query('BEGIN READ ONLY');
      const id = (await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
      if (id !== '7688376744939610156') return 'NO MEDIDO (la conexión no es pg-prod)';
      const r = (await c.query(`SELECT count(*) total,
          count(*) FILTER (WHERE status IN ('ok','success') AND coalesce(last_finish,last_start) > now()-interval '2 days') sanos,
          count(*) FILTER (WHERE status = 'error') errores,
          count(*) FILTER (WHERE coalesce(last_finish,last_start) < now()-interval '2 days') sin_latido
        FROM analytics.cron_runs`)).rows[0];
      await c.query('ROLLBACK');
      return `${r.sanos} de ${r.total} sanos · ${r.errores} en error · ${r.sin_latido} sin latido >2 días`;
    } finally { await c.end(); }
  } catch (e) { return `NO MEDIDO (${e.message.slice(0, 60)})`; }
}

(async () => {
  const hoy = hoyMx();
  // Las sub-tareas no son tarjetas: el workflow "auto-add" las mete al tablero, así que se excluyen aquí.
  const items = JSON.parse(gh(['project', 'item-list', '2', '--owner', OWNER, '--limit', '300', '--format', 'json'])).items
    .filter((i) => !(i.labels || []).includes('sub-tarea'));
  const fases = items.filter((i) => (i.labels || []).includes('fase'));
  const enCurso = items.filter((i) => i.status === 'En curso');
  const fasesEnCurso = enCurso.filter((i) => (i.labels || []).includes('fase'));
  const urgentes = items.filter((i) => (i.labels || []).includes('urgente') && i.status !== 'Cerrado');
  const hace7 = masDias(hoy, -7);
  const revision = (i) => i['última revisión'] || i['última revisión'] || Object.entries(i).find(([k]) => /revisi/i.test(k))?.[1];
  const cerradasSemana = items.filter((i) => i.status === 'Cerrado' && (revision(i) || '') >= hace7);
  const viejas = enCurso.filter((i) => { const r = revision(i); return !r || r < masDias(hoy, -14); });
  const titulo = (i) => i.content.title.replace(/^(\[[^\]]+\]).*/, '$1') + ' ' + i.content.title.replace(/^\[[^\]]+\]\s*/, '').slice(0, 60);
  const dueno = (i) => i['dueño'] || i['dueño'] || Object.entries(i).find(([k]) => /due/i.test(k))?.[1] || 'SIN DUEÑO';

  const progreso = (n) => {
    try { const s = JSON.parse(gh(['api', `repos/${REPO}/issues/${n}`])).sub_issues_summary; return s && s.total ? ` — ${s.completed}/${s.total} sub-tareas` : ''; }
    catch { return ' — avance NO MEDIDO'; }
  };
  const carga = {};
  for (const i of enCurso) (carga[dueno(i)] ||= []).push(i.content.title.match(/^\[([^\]]+)\]/)?.[1] || '?');

  // Regla dinero × esfuerzo: lo de prioridad 0–1 que no está En curso es dinero barato sin cobrar.
  const prioridad = (i) => i.prioridad || Object.entries(i).find(([k]) => /^prioridad$/i.test(k))?.[1] || '';
  const baratasSinTrabajar = items.filter((i) => /^[01] /.test(prioridad(i)) && !['En curso', 'Cerrado'].includes(i.status));
  const altoYGrande = enCurso.filter((i) => /^2 /.test(prioridad(i)) && /^(L|XL)/.test(i.esfuerzo || ''));
  const salud = await saludProcesos();
  const lineas = [
    `**Semana del ${hoy} — reporte automático (medido, no redactado).**`,
    '',
    `**Fases en curso:** ${fasesEnCurso.length} (tope ${TOPE})${fasesEnCurso.length > TOPE ? ' ⛔ por encima del tope' : ''} · tarjetas en curso: ${enCurso.length} · fases en el tablero: ${fases.length}`,
    `**Cerradas en los últimos 7 días:** ${cerradasSemana.length ? cerradasSemana.map(titulo).join(' · ') : 'ninguna'}`,
    '',
    `**Urgentes abiertas (${urgentes.length}):**`,
    ...(urgentes.length ? urgentes.map((i) => `- #${i.content.number} ${titulo(i)} — ${dueno(i)}${progreso(i.content.number)}`) : ['- ninguna']),
    '',
    `**Prioridad 0–1 que nadie trabaja (${baratasSinTrabajar.length}):** ${baratasSinTrabajar.length ? baratasSinTrabajar.map((i) => `#${i.content.number} ${i.content.title.match(/^\[[^\]]+\]/)?.[0]} (${i.status})`).join(' · ') + ' → mucho dinero, poco esfuerzo: abrir antes que lo de prioridad 3–4' : 'ninguna'}`,
    ...(altoYGrande.length ? [`**Alto dinero y esfuerzo L/XL en curso (partir en un pedazo S/M):** ${altoYGrande.map((i) => '#' + i.content.number).join(', ')}`] : []),
    '',
    '**Carga en curso por persona:**',
    ...Object.entries(carga).sort((a, b) => b[1].length - a[1].length).map(([d, l]) => `- ${d}: ${l.length} (${l.join(', ')})`),
    '',
    `**En curso sin revisión hace más de 14 días (${viejas.length}):** ${viejas.length ? viejas.map((i) => '#' + i.content.number).join(', ') + ' → discutir en la junta' : 'ninguna'}`,
    `**Procesos de ingesta (prod):** ${salud}`,
    '',
    'Lo marcado NO MEDIDO no se pudo leer esta vez; no significa cero.',
  ];
  const cuerpo = lineas.join('\n');
  const estado = urgentes.length || fasesEnCurso.length > TOPE ? 'AT_RISK' : 'ON_TRACK';

  if (DRY) { console.log(`[${estado}]\n${cuerpo}`); return; }
  const q = 'mutation($p:ID!,$s:ProjectV2StatusUpdateStatus!,$a:Date!,$b:Date!,$t:String!){createProjectV2StatusUpdate(input:{projectId:$p,status:$s,startDate:$a,targetDate:$b,body:$t}){statusUpdate{id}}}';
  gh(['api', 'graphql', '-f', `query=${q}`, '-f', `p=${PROJECT}`, '-f', `s=${estado}`, '-f', `a=${hoy}`, '-f', `b=${masDias(hoy, 7)}`, '-f', `t=${cuerpo}`]);
  anota(`publicado ${estado} · en curso ${enCurso.length} · urgentes ${urgentes.length}`);
  console.log(`Publicado (${estado}).`);
})().catch((e) => { anota('ERROR ' + e.message); console.error('ERROR', e.message); process.exit(1); });
