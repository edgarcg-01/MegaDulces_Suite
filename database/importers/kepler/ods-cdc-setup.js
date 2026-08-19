/* eslint-disable no-console */
/**
 * CDC forwarder — SETUP (parte 1 de 2). Monta en CADA replica local (kepler_md_XX @ :5433)
 * la captura de cambios que la replicación lógica ya aplica, para empujar SOLO el delta a prod
 * (kepler_ods) sin re-leer tablas completas. Reemplaza el re-scan del carril hash.
 *
 * Cómo: la replicación lógica aplica I/U/D al replica → un trigger `ENABLE ALWAYS` (fuera de esto
 * los triggers NO disparan durante el apply) encola la fila cambiada en `ods.change_queue`. El
 * forwarder (ods-cdc-forward.js) drena la cola y la empuja por feeds-ingest (raw-upsert).
 *
 * Seguridad: el trigger SWALLOWEA cualquier error (EXCEPTION WHEN OTHERS) → jamás bloquea el apply
 * de la replicación (una fila perdida se reconcilia con el barrido hash ocasional). Solo se ponen
 * triggers en las tablas MUTABLES (todas menos la whitelist ctid append-only, que ya es CDC barato).
 *
 *   node database/importers/kepler/ods-cdc-setup.js            # dry-run (cuenta tablas)
 *   node database/importers/kepler/ods-cdc-setup.js --apply    # crea cola + triggers
 *   node database/importers/kepler/ods-cdc-setup.js --apply --branch=02
 */
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const ONLY_BRANCH = (process.argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1] || null;
const SUB_BASE = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const BRANCH_CODES = (process.env.ODS_LIVE_BRANCHES || '01,02,03,04,05,06').split(',').map((s) => s.trim()).filter(Boolean);
const localDbName = (code) => (code === '03' ? 'kepler_pilot' : `kepler_md_${code}`);
const localUrl = (code) => { const u = new URL(SUB_BASE); u.pathname = `/${localDbName(code)}`; return u.toString(); };
// Mismas append-only del carril ctid → NO se les pone trigger (alto volumen, ya son CDC barato).
const CTID_TABLES = new Set(
  (process.env.ODS_CTID_TABLES || 'kdm1,kdm2,kdij,kdue,kdpord,kdm3,kdm4,kdm5,kdm6,kdm7,kdm8,kdm9,kdmx,kdmx_25,kdmx_26,kdlogmov,orglogtbl_24,orglogtbl_25,orglogtbl_26,pos95historico')
    .split(',').map((s) => s.trim()).filter(Boolean));
const qid = (id) => '"' + String(id).replace(/"/g, '""') + '"';

const DDL_QUEUE = `
  CREATE SCHEMA IF NOT EXISTS ods;
  CREATE TABLE IF NOT EXISTS ods.change_queue (
    id         bigserial PRIMARY KEY,
    table_name text NOT NULL,
    op         char(1) NOT NULL,          -- I / U / D
    row_json   jsonb NOT NULL,            -- NEW (I/U) u OLD (D)
    enqueued_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_change_queue_id ON ods.change_queue (id);`;

// El trigger swallowea errores → nunca rompe el apply de la replicación.
const DDL_FN = `
  CREATE OR REPLACE FUNCTION ods.capture_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN
    BEGIN
      IF TG_OP = 'DELETE' THEN
        INSERT INTO ods.change_queue(table_name, op, row_json) VALUES (TG_TABLE_NAME, 'D', to_jsonb(OLD));
      ELSE
        INSERT INTO ods.change_queue(table_name, op, row_json) VALUES (TG_TABLE_NAME, left(TG_OP,1), to_jsonb(NEW));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL; -- jamás bloquear la replicación por un fallo de encolado
    END;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END; $fn$;`;

(async () => {
  for (const code of BRANCH_CODES) {
    if (ONLY_BRANCH && code !== ONLY_BRANCH) continue;
    const c = new Client({ connectionString: localUrl(code), connectionTimeoutMillis: 8000, statement_timeout: 120000 });
    try { await c.connect(); } catch (e) { console.log(`⚠ ${code} (${localDbName(code)}): no conecta — skip`); continue; }
    try {
      const tabs = (await c.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='md' AND table_type='BASE TABLE' ORDER BY 1`)).rows.map((r) => r.table_name);
      const mut = tabs.filter((t) => !CTID_TABLES.has(t));
      console.log(`\n### ${code} (${localDbName(code)}): ${tabs.length} tablas · ${mut.length} mutables (trigger) · ${tabs.length - mut.length} ctid (sin trigger)`);
      if (!APPLY) { console.log('  [DRY-RUN] no se aplicó'); continue; }

      await c.query(DDL_QUEUE);
      await c.query(DDL_FN);
      let n = 0;
      for (const t of mut) {
        await c.query(`DROP TRIGGER IF EXISTS ods_cdc ON md.${qid(t)}`);
        await c.query(`CREATE TRIGGER ods_cdc AFTER INSERT OR UPDATE OR DELETE ON md.${qid(t)} FOR EACH ROW EXECUTE FUNCTION ods.capture_change()`);
        await c.query(`ALTER TABLE md.${qid(t)} ENABLE ALWAYS TRIGGER ods_cdc`);
        n++;
      }
      const q = (await c.query('SELECT count(*) n FROM ods.change_queue')).rows[0].n;
      console.log(`  ✓ cola + fn creadas · ${n} triggers ALWAYS instalados · cola actual: ${q} filas`);
    } catch (e) { console.log(`  ✗ ${code}: ${e.message.slice(0, 120)}`); }
    finally { await c.end().catch(() => {}); }
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
