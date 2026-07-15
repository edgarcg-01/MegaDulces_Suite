/**
 * HIQ.2 (Fase Horus-IQ) — Backfill de snapshots retroactivos de execution_360.
 *
 * PROBLEMA: L1 (baselines/z-score) y L3 (diff-in-diff) están dormidos porque
 * exigen ≥7 snapshots diarios y los snapshots solo se generan hacia adelante
 * (cron nocturno). daily_captures tiene 60+ días de historia — este script la
 * convierte en snapshots "como si el cron hubiera corrido cada día".
 *
 * Para cada día D del rango: recomputa por sujeto (colaborador/tienda) y ventana
 * (7/30 terminando en D) las MISMAS métricas que Execution360Service:
 *   - visits_done, avg_score (score_final_pct)
 *   - own/competitor_share_pct (exhibiciones.perteneceMegaDulces, por exhibición)
 *   - photo_coverage_pct (exhibiciones con fotoUrl / total, por exhibición)
 *   - exec_level_score (rúbrica mixta alto/excelente=1 · medio/estandar=.6 ·
 *     bajo/basico=.3 · critico=.1, ×100)
 * exec_score/exec_score_breakdown NO se backfillean (los computa el scoring
 * engine con señales que no existen retroactivamente); el baseline learner
 * maneja nulls por métrica con su propio n.
 *
 * Idempotente: UPSERT por (tenant, snapshot_date, subject, window). NO pisa el
 * snapshot de HOY si ya existe uno del cron (mismo conflict target → merge de
 * las mismas columnas, valores equivalentes).
 *
 * Uso: node database/scripts/horus-backfill-snapshots.js [--days=45] [--dry]
 */
require('dotenv').config();

const knex = require('knex')({
  client: 'pg',
  connection: process.env.DATABASE_URL || {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5433,
    database: process.env.DB_NAME || 'postgres_platform',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  },
  pool: {
    min: 1,
    max: 2,
    afterCreate: (conn, done) => {
      conn.query(
        'SET search_path TO trade, field_ops, identity, catalog, scoring, commercial, public',
        (err) => done(err, conn),
      );
    },
  },
});

const args = process.argv.slice(2);
const DAYS = Number((args.find((a) => a.startsWith('--days=')) || '').split('=')[1]) || 45;
const DRY = args.includes('--dry');

// Misma rúbrica mixta que Execution360Service.levelWeight (audit H2.1).
const LEVEL_WEIGHT = {
  alto: 1, excelente: 1,
  medio: 0.6, estandar: 0.6, 'estándar': 0.6,
  bajo: 0.3, basico: 0.3, 'básico': 0.3,
  critico: 0.1, 'crítico': 0.1,
};

const round2 = (x) => Math.round(x * 100) / 100;

function emptyBucket() {
  return { visits: 0, scoreSum: 0, scoreCount: 0, own: 0, competitor: 0, photoWith: 0, photoTotal: 0, levelSum: 0, levelCount: 0, lastVisit: 0 };
}

function applyCapture(b, cap) {
  b.visits++;
  if (cap.score != null) { b.scoreSum += cap.score; b.scoreCount++; }
  b.own += cap.own;
  b.competitor += cap.competitor;
  b.photoWith += cap.photoWith;
  b.photoTotal += cap.photoTotal;
  b.levelSum += cap.levelSum;
  b.levelCount += cap.levelCount;
  if (cap.t > b.lastVisit) b.lastVisit = cap.t;
}

function bucketToRow(b, dayMs) {
  const shareBase = b.own + b.competitor;
  return {
    visits_done: b.visits,
    avg_score: b.scoreCount ? round2(b.scoreSum / b.scoreCount) : null,
    exec_score: null,
    exec_level_score: b.levelCount ? round2((b.levelSum / b.levelCount) * 100) : null,
    own_share_pct: shareBase ? round2((b.own / shareBase) * 100) : null,
    competitor_share_pct: shareBase ? round2((b.competitor / shareBase) * 100) : null,
    photo_coverage_pct: b.photoTotal ? round2((b.photoWith / b.photoTotal) * 100) : null,
    days_since_last_visit: b.lastVisit ? Math.floor((dayMs - b.lastVisit) / 86400000) : null,
  };
}

async function main() {
  console.log(`Horus HIQ.2 — backfill de snapshots (${DAYS} días${DRY ? ', DRY RUN' : ''})\n`);

  const tenants = await knex('identity.tenants').where('is_active', true).select('id', 'slug');

  // Trae UNA vez todas las capturas del rango extendido (DAYS + ventana 30).
  const caps = await knex('daily_captures as dc')
    .whereRaw('dc.hora_inicio >= now() - make_interval(days => ?)', [DAYS + 31])
    .whereNotNull('dc.hora_inicio')
    .select(
      'dc.tenant_id', 'dc.user_id', 'dc.captured_by_username', 'dc.store_id',
      'dc.score_final_pct', 'dc.hora_inicio', 'dc.exhibiciones',
    );
  console.log(`Capturas en rango: ${caps.length}`);

  const storeNames = new Map();
  for (const s of await knex('stores').whereNull('deleted_at').select('id', 'nombre')) {
    storeNames.set(s.id, s.nombre);
  }

  // Pre-procesa cada captura una sola vez (parse exhibiciones).
  const parsed = [];
  for (const r of caps) {
    let exs = r.exhibiciones;
    if (typeof exs === 'string') { try { exs = JSON.parse(exs); } catch { exs = []; } }
    if (!Array.isArray(exs)) exs = [];
    let own = 0, competitor = 0, photoWith = 0, photoTotal = 0, levelSum = 0, levelCount = 0;
    for (const e of exs) {
      photoTotal++;
      if (e && e.fotoUrl) photoWith++;
      if (e && e.perteneceMegaDulces === true) own++;
      else if (e && e.perteneceMegaDulces === false) competitor++;
      const lw = e && e.nivelEjecucion != null ? LEVEL_WEIGHT[String(e.nivelEjecucion).toLowerCase().trim()] : undefined;
      if (lw != null) { levelSum += lw; levelCount++; }
    }
    parsed.push({
      tenant_id: r.tenant_id,
      user_id: r.user_id,
      user_label: r.captured_by_username || 'Colaborador',
      store_id: r.store_id,
      t: new Date(r.hora_inicio).getTime(),
      score: r.score_final_pct != null ? Number(r.score_final_pct) : null,
      own, competitor, photoWith, photoTotal, levelSum, levelCount,
    });
  }

  // Días MX del rango, del más viejo al más nuevo (excluye HOY: ese lo pone el cron).
  const [{ today }] = await knex.raw(`SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text AS today`).then((r) => r.rows);
  const todayMs = new Date(`${today}T23:59:59.999-06:00`).getTime();

  let totalRows = 0;
  for (const tenant of tenants) {
    const tcaps = parsed.filter((c) => c.tenant_id === tenant.id);
    if (!tcaps.length) continue;
    const snapRows = [];

    for (let back = DAYS; back >= 1; back--) {
      const dayEndMs = todayMs - back * 86400000;
      const dayDate = new Date(dayEndMs).toISOString().slice(0, 10);

      // Agrega por sujeto para las ventanas que terminan en este día.
      const byCollab = new Map();
      const byStore = new Map();
      const ensure = (map, key, label) => {
        let a = map.get(key);
        if (!a) { a = { label, w7: emptyBucket(), w30: emptyBucket() }; map.set(key, a); }
        return a;
      };
      for (const c of tcaps) {
        if (c.t > dayEndMs) continue;
        const daysAgo = (dayEndMs - c.t) / 86400000;
        if (daysAgo > 30) continue;
        const fan = (a) => {
          if (daysAgo <= 7) applyCapture(a.w7, c);
          applyCapture(a.w30, c);
        };
        if (c.user_id) fan(ensure(byCollab, c.user_id, c.user_label));
        if (c.store_id) fan(ensure(byStore, c.store_id, storeNames.get(c.store_id) || 'Tienda'));
      }

      const push = (subjectType, map) => {
        for (const [subjectId, agg] of map) {
          for (const [windowDays, bucket] of [[7, agg.w7], [30, agg.w30]]) {
            if (!bucket.visits) continue;
            snapRows.push({
              tenant_id: tenant.id,
              snapshot_date: dayDate,
              subject_type: subjectType,
              subject_id: subjectId,
              window_days: windowDays,
              label: agg.label,
              ...bucketToRow(bucket, dayEndMs),
            });
          }
        }
      };
      push('collaborator', byCollab);
      push('store', byStore);
    }

    console.log(`Tenant ${tenant.slug}: ${snapRows.length} snapshots retroactivos`);
    totalRows += snapRows.length;

    if (!DRY && snapRows.length) {
      for (let i = 0; i < snapRows.length; i += 500) {
        await knex('commercial.execution_360_snapshots')
          .insert(snapRows.slice(i, i + 500))
          .onConflict(['tenant_id', 'snapshot_date', 'subject_type', 'subject_id', 'window_days'])
          .ignore(); // no pisa snapshots reales del cron (más completos: traen exec_score)
      }
    }
  }

  console.log(`\nTotal: ${totalRows} snapshots ${DRY ? '(dry run, no se escribió nada)' : 'upserteados'}.`);
  if (!DRY) {
    console.log('Siguiente paso: POST /supervisor-ai/compute (o esperar el cron) para que');
    console.log('BaselineLearnerService recompute los baselines con la historia nueva (L1 despierta).');
  }
  await knex.destroy();
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
