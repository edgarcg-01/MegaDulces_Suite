/**
 * `analytics.bank_postings`: TABLA copiada por importer → **MATERIALIZED VIEW derive-no-copy**
 * sobre `kepler_ods.kdc2YYMM` (postings del 102). Regla ⭐: cero importers, todo del ODS.
 * Reemplaza `import-bank-postings.js`, que se retira.
 *
 * ¿Por qué matview y no vista viva (como kepler_bank_movements)? El 102 vive en tablas MENSUALES
 * (kdc2YYMM, ~24 en el ODS). Una vista viva = 12 seqscans por consulta y el filtro `anio_mes` del
 * consumidor NO prunea → 2.8 s/consulta (medido). El matview con índice = 15 ms (§19 materializar por
 * COSTO, dato FIEL). El costo del fan-out (~1.1 s) corre sólo en el REFRESH (cron 15 min), no en lectura.
 *
 * Auto-mantenible: la fuente es la FUNCIÓN `analytics.bank_postings_src()` que arma la UNION dinámica
 * sobre las kdc2 que EXISTEN en una ventana rodante de 12 meses (to_regclass) → al llegar el mes nuevo,
 * el próximo REFRESH lo incluye solo (sin tocar SQL, sin re-correr importer). El REFRESH lo dispara
 * `AnalyticsRefreshService` (agregar 'analytics.bank_postings' a MVS[]).
 *
 * Lógica idéntica al importer (verificada 2026-09-03, dev): doc_tipo=c15‖c16‖lpad(c17,2)‖lpad(c18,2),
 * folio=c19, importe=c5, sólo 102 con c5<>0, excluye cancelados (kdm1 c43='C' del CEDIS por
 * (left(doc_tipo,4),folio)). CONCENTRADOR: todas las sucursales viven en este ledger (c14=origen, no
 * réplica); sucursal='00' (consolidado). Counts/sumas EXACTOS vs importer (44,770 / A $570,951,487.14 /
 * C $568,502,824.40). client_uuid = md5 determinista → UNIQUE index → REFRESH CONCURRENTLY.
 *
 * 0 writers salvo el importer (retirado). Consumidores (finance-bank) sólo LEEN → drop-in.
 * Backup: `bank_postings_snapshot_bak`.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

const FN_SQL = `
CREATE OR REPLACE FUNCTION analytics.bank_postings_src()
RETURNS TABLE(tenant_id uuid, client_uuid text, sucursal text, doc_tipo text, folio text,
              linea int, fecha date, anio_mes text, cargo_abono text, importe numeric,
              contraparte text, forma text)
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  m date := date_trunc('month', now())::date;
  parts text := '';
  tbl text; ym text; i int;
BEGIN
  -- Ventana rodante de 12 meses: sólo las kdc2 que existen (el mes nuevo entra solo al próximo REFRESH).
  FOR i IN 0..11 LOOP
    tbl := 'kdc2' || to_char(m - (i||' months')::interval, 'YYMM');
    ym  := to_char(m - (i||' months')::interval, 'YYYY-MM');
    IF to_regclass('kepler_ods.'||tbl) IS NOT NULL THEN
      parts := parts || (CASE WHEN parts='' THEN '' ELSE ' UNION ALL ' END) ||
        format('SELECT (c15||c16||lpad(c17::text,2,''0'')||lpad(c18::text,2,''0'')) dt, '
             ||'coalesce(nullif(btrim(c19),''''),''0'') fo, coalesce(c10,0)::int li, c2::date fe, '
             ||'%L::text ym, c4 ca, c5::numeric im, nullif(btrim(c6),'''') cp, nullif(btrim(c7),'''') fm '
             ||'FROM kepler_ods.%I WHERE split_part(c3,''-'',1)=''102'' AND coalesce(c5,0)<>0', ym, tbl);
    END IF;
  END LOOP;
  IF parts = '' THEN RETURN; END IF;
  RETURN QUERY EXECUTE format($q$
    WITH raw AS (%s),
    canc AS (SELECT DISTINCT btrim(c2::text)||btrim(c3::text)||lpad(btrim(c4::text),2,'0') pfx, btrim(c6::text) folio
               FROM kepler_ods.kdm1 WHERE btrim(c1::text)='00' AND sucursal='00' AND btrim(coalesce(c43::text,''))='C'),
    filt AS (SELECT r.* FROM raw r WHERE NOT EXISTS (SELECT 1 FROM canc c WHERE c.pfx=left(r.dt,4) AND c.folio=r.fo)),
    num AS (SELECT filt.*, row_number() OVER (PARTITION BY ym,dt,fo,li,ca,im,coalesce(cp,'')) occ FROM filt)
    SELECT '${M}'::uuid,
           md5(ym||'|'||dt||'|'||fo||'|'||li::text||'|'||ca||'|'||im::text||'|'||coalesce(cp,'')||'|'||occ::text),
           '00'::text, dt, fo, li, fe, ym, ca, im, cp, fm
      FROM num
  $q$, parts);
END $fn$;`;

exports.up = async function (knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`);
  if (!ods.rows[0]?.t) return; // entorno sin ODS: nada que derivar

  await knex.raw(FN_SQL);
  await knex.raw(`GRANT EXECUTE ON FUNCTION analytics.bank_postings_src() TO app_runtime`);

  const rel = await knex.raw(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.bank_postings')`);
  if (rel.rows[0]?.relkind === 'm') return; // ya es matview: idempotente (la función quedó refrescada arriba)

  if (rel.rows[0]?.relkind === 'r') {
    await knex.raw(`ALTER TABLE analytics.bank_postings RENAME TO bank_postings_snapshot_bak`);
  }
  await knex.raw(`CREATE MATERIALIZED VIEW analytics.bank_postings AS SELECT * FROM analytics.bank_postings_src() WITH DATA`);
  // UNIQUE index (client_uuid determinista) → habilita REFRESH ... CONCURRENTLY.
  await knex.raw(`CREATE UNIQUE INDEX idx_bank_postings_uk ON analytics.bank_postings (tenant_id, client_uuid)`);
  // Índice del filtro del consumidor (anio_mes=period, cargo_abono).
  await knex.raw(`CREATE INDEX idx_bank_postings_period ON analytics.bank_postings (tenant_id, anio_mes, cargo_abono)`);
  await knex.raw(`GRANT SELECT ON analytics.bank_postings TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.bank_postings IS
    'Matview derive-no-copy: postings del 102 desde kepler_ods.kdc2YYMM vía analytics.bank_postings_src() '
    '(UNION dinámica ventana rodante 12m). Reemplaza import-bank-postings.js. Refresca AnalyticsRefreshService '
    '(cron 15m). Concentrador todas las sucursales, excluye cancelados c43=C. Backup: bank_postings_snapshot_bak.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.bank_postings`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.bank_postings_src()`);
  await knex.raw(`ALTER TABLE IF EXISTS analytics.bank_postings_snapshot_bak RENAME TO bank_postings`);
};
