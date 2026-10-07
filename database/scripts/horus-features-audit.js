/* eslint-disable no-console */
/**
 * Read-only — audita qué señales del JSONB / tablas relacionadas están pobladas,
 * para decidir QUÉ entra al Feature Store v2 (Horus H2.1) y qué se difiere.
 * No escribe nada. Correr: node database/scripts/horus-features-audit.js
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const out = [];
const log = (...a) => out.push(a.join(' '));

async function safe(title, fn) {
  try {
    await fn();
  } catch (e) {
    log(`  [${title}] ERROR: ${e.message}`);
  }
}

(async () => {
  log('=== exhibiciones JSONB — cobertura de campos (30d) ===');
  await safe('exhib', async () => {
    const r = await knex.raw(
      `WITH ex AS (
         SELECT e FROM daily_captures dc, LATERAL jsonb_array_elements(dc.exhibiciones) e
          WHERE dc.tenant_id=? AND dc.hora_inicio >= now() - interval '30 days'
       )
       SELECT count(*)::int total,
         count(*) FILTER (WHERE NULLIF(e->>'ubicacionId','') IS NOT NULL)::int with_ubic,
         count(*) FILTER (WHERE NULLIF(e->>'nivelEjecucion','') IS NOT NULL)::int with_nivel,
         count(*) FILTER (WHERE NULLIF(e->>'conceptoId','') IS NOT NULL)::int with_concepto,
         count(*) FILTER (WHERE jsonb_typeof(e->'productosMarcados')='array' AND jsonb_array_length(e->'productosMarcados')>0)::int with_products,
         round(avg(CASE WHEN jsonb_typeof(e->'productosMarcados')='array' THEN jsonb_array_length(e->'productosMarcados') ELSE 0 END),2) avg_products
       FROM ex`,
      [T],
    );
    const x = r.rows[0];
    const pct = (n) => (x.total ? Math.round((n / x.total) * 100) : 0);
    log(`  exhibiciones=${x.total} | ubicacionId=${pct(x.with_ubic)}% nivelEjecucion=${pct(x.with_nivel)}% conceptoId=${pct(x.with_concepto)}% productos=${pct(x.with_products)}% (avg ${x.avg_products}/exh)`);
  });

  log('\n=== nivelEjecucion — distribución (30d) ===');
  await safe('nivel', async () => {
    const r = await knex.raw(
      `SELECT COALESCE(NULLIF(e->>'nivelEjecucion',''),'(vacío)') nivel, count(*)::int n
         FROM daily_captures dc, LATERAL jsonb_array_elements(dc.exhibiciones) e
        WHERE dc.tenant_id=? AND dc.hora_inicio >= now() - interval '30 days'
        GROUP BY 1 ORDER BY 2 DESC`,
      [T],
    );
    r.rows.forEach((row) => log(`  ${String(row.nivel).padEnd(12)} ${row.n}`));
  });

  log('\n=== duración de visita: hora_fin poblada (30d) ===');
  await safe('dur', async () => {
    const r = await knex.raw(
      `SELECT count(*)::int total, count(hora_fin)::int with_fin,
              count(*) FILTER (WHERE hora_fin > hora_inicio)::int valid_dur,
              round(avg(EXTRACT(EPOCH FROM (hora_fin-hora_inicio))/60) FILTER (WHERE hora_fin>hora_inicio)::numeric,1) avg_min,
              round((percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (hora_fin-hora_inicio))/60) FILTER (WHERE hora_fin>hora_inicio))::numeric,1) median_min
         FROM daily_captures WHERE tenant_id=? AND hora_inicio >= now() - interval '30 days'`,
      [T],
    );
    const x = r.rows[0];
    log(`  capturas=${x.total} con_hora_fin=${x.with_fin} dur_válida=${x.valid_dur} | avg=${x.avg_min}min mediana=${x.median_min}min`);
  });

  log('\n=== daily_assignments — plan de visitas (30d) ===');
  await safe('assign', async () => {
    const r = await knex.raw(
      `SELECT count(*)::int n, count(DISTINCT user_id)::int users, count(DISTINCT route_id)::int routes,
              count(*) FILTER (WHERE status='completado')::int completados,
              min(date) mind, max(date) maxd
         FROM daily_assignments WHERE date >= current_date - 30`,
    );
    const x = r.rows[0];
    log(`  asignaciones=${x.n} users=${x.users} rutas=${x.routes} completados=${x.completados} [${x.mind}..${x.maxd}]`);
  });

  log('\n=== stores geo + route_id en capturas ===');
  await safe('geo', async () => {
    const s = await knex.raw(
      `SELECT count(*)::int n, count(*) FILTER (WHERE latitud IS NOT NULL AND latitud<>0)::int geo
         FROM stores WHERE tenant_id=? AND deleted_at IS NULL`,
      [T],
    );
    const c = await knex.raw(
      `SELECT count(*)::int total, count(route_id)::int with_route, count(store_id)::int with_store
         FROM daily_captures WHERE tenant_id=? AND hora_inicio >= now() - interval '30 days'`,
      [T],
    );
    log(`  stores=${s.rows[0].n} con_geo=${s.rows[0].geo} | capturas con route_id=${c.rows[0].with_route}/${c.rows[0].total} store_id=${c.rows[0].with_store}/${c.rows[0].total}`);
  });

  log('\n=== scoring_pesos posición (mapa de pesos para position quality) ===');
  await safe('pesos', async () => {
    const r = await knex.raw(
      `SELECT tipo, count(*)::int n FROM scoring_pesos GROUP BY tipo ORDER BY tipo`,
    );
    r.rows.forEach((row) => log(`  ${row.tipo.padEnd(12)} ${row.n} pesos`));
    const pos = await knex.raw(
      `SELECT nombre, valor FROM scoring_pesos WHERE tipo='posicion' ORDER BY valor DESC LIMIT 12`,
    );
    log('  posiciones: ' + pos.rows.map((p) => `${p.nombre}=${p.valor}`).join(', '));
  });

  log('\n=== users: zona_id / supervisor_id (roll-ups) ===');
  await safe('users', async () => {
    const r = await knex.raw(
      `SELECT count(*)::int n, count(zona_id)::int with_zona, count(supervisor_id)::int with_sup
         FROM users WHERE tenant_id=?`,
      [T],
    );
    const x = r.rows[0];
    log(`  users=${x.n} con_zona=${x.with_zona} con_supervisor=${x.with_sup}`);
  });

  console.log(out.join('\n'));
  console.log('\n(read-only; no se escribió nada)');
  await knex.destroy();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
