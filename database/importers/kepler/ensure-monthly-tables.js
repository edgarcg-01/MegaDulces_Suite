/* eslint-disable no-console */
/**
 * CDC.8 — LA BOMBA DE CALENDARIO: pre-crea en cada réplica local las tablas que Kepler estrena
 * cuando cambia el mes o el año.
 *
 * POR QUÉ EXISTE
 * --------------
 * La replicación lógica de Postgres **no replica DDL**. Kepler particiona por calendario y crea la
 * tabla del período nuevo en el publisher; el subscriber no la tiene, y el apply worker muere con
 *
 *     ERROR: logical replication target relation "md.kdc22609" does not exist
 *
 * y **reinicia cada 5 segundos para siempre**. No aplica nada: la réplica se congela, y con ella el
 * ODS de esa sucursal. Silencioso hacia afuera — la subscription sigue `enabled`, el proceso del CDC
 * sigue `online`, su latido sigue en verde. Lo único visible es el log del contenedor.
 *
 * Vivido el 2026-09-01 a las 00:00: nació `kdc22609` y a media mañana ya había tres sucursales
 * (01, 03, 06) muertas y las otras tres a punto de caer en cuanto entrara su primera póliza de
 * septiembre. El rezago del slot de la 06 iba en 795 MB creciendo, camino al cap de 10 GB — o sea
 * camino a `wal_status='lost'`, que es pérdida PERMANENTE (ver GOTCHAS §32).
 *
 * Cuatro familias con fecha en el nombre, medidas en el schema real (no supuestas):
 *
 *     familia          cadencia   ejemplo        próxima
 *     ───────────────  ─────────  ─────────────  ──────────────
 *     kdc2<YY><MM>     MENSUAL    kdc22608       cada día 1
 *     kdcn<YY>         anual      kdcn26         kdcn27
 *     orglogtbl_<YY>   anual      orglogtbl_26   orglogtbl_27
 *     kdmx_<YY>        anual      kdmx_26        kdmx_27
 *
 * El 1 de enero de 2027 vencen las cuatro a la vez.
 *
 * Se corre seguido y es idempotente: sólo hace `CREATE TABLE IF NOT EXISTS ... (LIKE <hermana más
 * reciente> INCLUDING ALL)`. Nunca borra ni altera. Si la familia no existe en esa réplica, la salta
 * (no inventa un molde).
 *
 * Uso:  node ensure-monthly-tables.js            # dry-run
 *       node ensure-monthly-tables.js --apply
 */

const { Client } = require('pg');

const SUB_BASE = process.env.ODS_SOURCE_BASE
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const localDbName = (code) => (code === '03' ? 'kepler_pilot' : `kepler_md_${code}`);
const localUrl = (code) => { const u = new URL(SUB_BASE); u.pathname = `/${localDbName(code)}`; return u.toString(); };
const BRANCH_CODES = (process.env.ODS_LIVE_BRANCHES || '00,01,02,03,04,05,06').split(',').map((s) => s.trim()).filter(Boolean);

/** Cuántos períodos por delante se pre-crean. 2 meses de colchón cubre un fin de semana largo. */
const MESES_ADELANTE = Number(process.env.ODS_MONTHS_AHEAD || 2);
const ANIOS_ADELANTE = Number(process.env.ODS_YEARS_AHEAD || 1);

/** Los nombres que DEBERÍAN existir hoy y en los próximos períodos. */
function nombresEsperados(hoy = new Date()) {
  const out = [];
  const y = hoy.getFullYear(); const m = hoy.getMonth(); // 0-11
  for (let i = 0; i <= MESES_ADELANTE; i++) {
    const d = new Date(y, m + i, 1);
    out.push({ familia: 'kdc2', nombre: `kdc2${String(d.getFullYear() % 100).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}`, rx: '^kdc2[0-9]{4}$' });
  }
  for (let i = 0; i <= ANIOS_ADELANTE; i++) {
    const yy = String((y + i) % 100).padStart(2, '0');
    out.push({ familia: 'kdcn', nombre: `kdcn${yy}`, rx: '^kdcn[0-9]{2}$' });
    out.push({ familia: 'orglogtbl_', nombre: `orglogtbl_${yy}`, rx: '^orglogtbl_[0-9]{2}$' });
    out.push({ familia: 'kdmx_', nombre: `kdmx_${yy}`, rx: '^kdmx_[0-9]{2}$' });
  }
  return out;
}

/** Ejecuta una pasada. Devuelve [{suc, creadas:[], error?}]. */
async function asegurar({ apply = false } = {}) {
  const esperadas = nombresEsperados();
  const out = [];
  for (const code of BRANCH_CODES) {
    const c = new Client({ connectionString: localUrl(code), statement_timeout: 60000 });
    try { await c.connect(); } catch (e) { out.push({ suc: code, error: `replica no conecta: ${e.message.slice(0, 40)}` }); continue; }
    const creadas = [];
    try {
      for (const { nombre, rx } of esperadas) {
        const existe = (await c.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema='md' AND table_name=$1`, [nombre])).rowCount > 0;
        if (existe) continue;
        // Molde = la hermana MÁS RECIENTE de la misma familia. Si no hay ninguna, la familia no
        // aplica a esta réplica y no se inventa nada.
        const molde = (await c.query(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema='md' AND table_name ~ $1 ORDER BY table_name DESC LIMIT 1`, [rx])).rows[0]?.table_name;
        if (!molde) continue;
        if (apply) await c.query(`CREATE TABLE IF NOT EXISTS md."${nombre}" (LIKE md."${molde}" INCLUDING ALL)`);
        creadas.push(nombre);
      }
    } catch (e) { out.push({ suc: code, error: e.message.slice(0, 80) }); await c.end().catch(() => {}); continue; }
    await c.end().catch(() => {});
    out.push({ suc: code, creadas });
  }
  return out;
}

module.exports = { asegurar, nombresEsperados };

if (require.main === module) {
  const APPLY = process.argv.includes('--apply');
  (async () => {
    const out = await asegurar({ apply: APPLY });
    for (const r of out) {
      if (r.error) console.log(`  suc ${r.suc}: ERROR ${r.error}`);
      else if (r.creadas.length) console.log(`  suc ${r.suc}: ${APPLY ? 'creadas' : 'faltan'} ${r.creadas.join(', ')}`);
      else console.log(`  suc ${r.suc}: completo`);
    }
    const n = out.reduce((a, r) => a + (r.creadas?.length || 0), 0);
    console.log(`\ntablas ${APPLY ? 'creadas' : 'faltantes'}: ${n}${APPLY ? '' : ' (dry-run)'}`);
    process.exit(0);
  })().catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
