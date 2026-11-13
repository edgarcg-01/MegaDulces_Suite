#!/usr/bin/env node
// ¿Qué pantalla se abre desde el CELULAR y cuál desde la computadora? (pg-prod, SÓLO LECTURA)
//   node .claude/skills/pm/uso-movil.js [regex-de-ruta] [días=30]
//   ej: node .claude/skills/pm/uso-movil.js '^/tienda/'
//   ⚠️ En Git Bash: MSYS_NO_PATHCONV=1 delante, o '^/tienda/' llega como '^C:/Program Files/Git/tienda/'
//      y el script contesta «nadie» (lo hizo, 2026-11-13). Sin argumento mide todas las rutas.
//
// Fuente: commercial.portal_telemetry_events, que escribe `UsoService` de apps/view. Cada muestra
// de `web_vital` y cada `abrio_puerta` trae ruta + user agent + usuario; `analytics.ui_usage`
// (uso.js) NO sabe de qué aparato vino la llamada.
// ⛔ Lo costó: la barra del celular se ordenó con ui_usage y puso primero el Arqueo, que en celular
//    se abre 9 persona-días contra 685 en computadora (2026-11-13, [MOV]).
// ⚠️ Cota inferior, no conteo: web_vital se manda al cargar y al ocultar la página (cuenta dónde se
//    entró o se dejó la app, no cada navegación interna) y abrio_puerta lleva la ruta de la landing.
const path = require('path');
const raiz = path.resolve(__dirname, '..', '..', '..');
require(path.join(raiz, 'node_modules/dotenv')).config({ path: path.join(raiz, '.env'), quiet: true });
const { Client } = require(path.join(raiz, 'node_modules/pg'));

const [filtro = '.', dias = '30'] = process.argv.slice(2);
(async () => {
  const c = new Client({ connectionString: process.env.PROD_DB_URL, statement_timeout: 30000 });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const id = (await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
    if (id !== '7688376744939610156') { console.error(`⛔ No es pg-prod (${id}).`); process.exit(3); }
    const r = await c.query(`
      WITH e AS (
        SELECT t.user_id, (t.created_at AT TIME ZONE 'America/Mexico_City')::date AS dia,
               regexp_replace(regexp_replace(split_part(t.url, '?', 1), '/[0-9a-f-]{8,}', '/:id', 'g'), '/[0-9]+', '/:n', 'g') AS ruta,
               (t.user_agent ~* '(android|iphone|ipad|mobile)') AS movil, u.role_name
          FROM commercial.portal_telemetry_events t
          JOIN public.users u ON u.id::text = t.user_id::text
         WHERE t.created_at >= now() - ($2::int * interval '1 day')
           AND t.name IN ('web_vital', 'abrio_puerta') AND t.env = 'prod')
      SELECT ruta,
             count(DISTINCT (user_id, dia)) FILTER (WHERE movil)     AS pd_celular,
             count(DISTINCT user_id)        FILTER (WHERE movil)     AS personas_celular,
             count(DISTINCT (user_id, dia)) FILTER (WHERE NOT movil) AS pd_computadora,
             string_agg(DISTINCT role_name, ', ') FILTER (WHERE movil) AS puestos_celular
        FROM e WHERE ruta ~ $1
       GROUP BY 1 HAVING count(*) FILTER (WHERE movil) > 0
       ORDER BY 2 DESC, 3 DESC`, [filtro, dias]);
    console.log(`persona-días (pd) en ${dias} días · ruta ~ /${filtro}/ · cota inferior (ver cabecera)`);
    if (!r.rows.length) console.log('Nadie la abrió desde celular en la ventana.');
    else console.table(r.rows);
    await c.query('ROLLBACK');
  } finally { await c.end(); }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
