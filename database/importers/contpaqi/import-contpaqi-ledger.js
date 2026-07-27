/* eslint-disable no-console */
/**
 * CP.1 (Fase CP, ADR-035) — Balanza de ContPAQi Contabilidad → analytics.contpaqi_ledger_monthly.
 *
 * Origen (READ-ONLY): SQL Server ContPAQi instancia COMPAC, empresa
 * `ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ`. Lee la balanza pre-agregada:
 *   SaldosCuentas (Tipo 2=cargos / 3=abonos, Importes1..14 = movimiento por periodo;
 *                  Tipo 1 = saldo, de ahí SaldoIni del ejercicio)
 *   ⋈ Cuentas (Codigo/Nombre/Afectable/IdAgrupadorSAT)
 *   ⋈ AgrupadoresSAT (código SAT de contabilidad electrónica)
 *   ⋈ Ejercicios (Id → año fiscal).
 * Pivotea a grano (cuenta × año × periodo) y hace UPSERT idempotente en la nueva DB.
 *
 * Verdad fiscal CONSOLIDADA de la entidad (no por sucursal — la contabilidad casi no usa
 * segmento). Espejo para el diff "libros vs operación" (CP.4) y para que Maat lea los libros.
 *
 *   node database/importers/contpaqi/import-contpaqi-ledger.js            # dry-run
 *   node database/importers/contpaqi/import-contpaqi-ledger.js --apply    # commit
 *
 * Conexión origen por env (default = valores decodificados):
 *   CONTPAQI_SQL_HOST=192.168.0.35  CONTPAQI_SQL_INSTANCE=COMPAC
 *   CONTPAQI_SQL_USER=platform_ro   CONTPAQI_SQL_PASSWORD=superoot
 *   CONTPAQI_SQL_DB=ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ
 * Destino: DATABASE_URL_NEW (postgres_platform). Tenant: CONTPAQI_TENANT_ID (default mega_dulces).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const sql = require('mssql');
const { Client } = require('pg');

const TENANT = process.env.CONTPAQI_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;

const SRC = {
  server: process.env.CONTPAQI_SQL_HOST || '192.168.0.35',
  user: process.env.CONTPAQI_SQL_USER || 'platform_ro',
  password: process.env.CONTPAQI_SQL_PASSWORD || 'superoot',
  database: process.env.CONTPAQI_SQL_DB || 'ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ',
  options: { instanceName: process.env.CONTPAQI_SQL_INSTANCE || 'COMPAC', encrypt: false, trustServerCertificate: true },
  connectionTimeout: 20000, requestTimeout: 180000,
};

const anioMes = (y, p) => (p <= 12 ? `${y}-${String(p).padStart(2, '0')}` : `${y}-${p}`);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

(async () => {
  console.log(`ContPAQi ledger → ${APPLY ? 'APPLY' : 'DRY-RUN'} · tenant ${TENANT}`);
  const mss = await sql.connect(SRC);
  console.log(`  origen: ${SRC.server}\\${SRC.options.instanceName}/${SRC.database}`);

  const ejr = (await mss.request().query(`SELECT Id, Ejercicio FROM Ejercicios`)).recordset;
  const yearOf = new Map(ejr.map((e) => [e.Id, e.Ejercicio]));
  console.log(`  ejercicios: ${[...yearOf.values()].sort().join(', ')}`);

  const rows = (await mss.request().query(`
    SELECT sc.IdCuenta, sc.Ejercicio AS EjeId, sc.Tipo, sc.SaldoIni,
           sc.Importes1,sc.Importes2,sc.Importes3,sc.Importes4,sc.Importes5,sc.Importes6,sc.Importes7,
           sc.Importes8,sc.Importes9,sc.Importes10,sc.Importes11,sc.Importes12,sc.Importes13,sc.Importes14,
           c.Codigo, c.Nombre, c.Afectable, a.Codigo AS SatCod, a.Nombre AS SatNom
      FROM SaldosCuentas sc
      JOIN Cuentas c ON c.Id = sc.IdCuenta
      LEFT JOIN AgrupadoresSAT a ON a.Id = c.IdAgrupadorSAT
     WHERE c.Afectable = 1`)).recordset; // solo cuentas de detalle (hoja); los padres = rollup por prefijo → evita doble conteo
  await mss.close();
  console.log(`  SaldosCuentas origen: ${rows.length} filas`);

  // Pivot → cuenta × año × periodo
  const meta = new Map();      // cod → {nombre, afectable, familia, sat, satNom}
  const saldoIni = new Map();  // cod|year → number
  const cargos = new Map();    // cod|year|p → number
  const abonos = new Map();
  const kCE = (c, y) => `${c}|${y}`;
  const kP = (c, y, p) => `${c}|${y}|${p}`;
  let noYear = 0;
  for (const r of rows) {
    const year = yearOf.get(r.EjeId);
    if (!year) { noYear++; continue; }
    const cod = String(r.Codigo).trim();
    if (!meta.has(cod)) meta.set(cod, {
      nombre: (r.Nombre || '').trim(),
      afectable: r.Afectable === 1 || r.Afectable === true,
      familia: cod.slice(0, 1),
      sat: r.SatCod ? String(r.SatCod).trim() : null,
      satNom: r.SatNom ? String(r.SatNom).trim() : null,
    });
    if (r.Tipo === 1) { saldoIni.set(kCE(cod, year), round2(r.SaldoIni)); continue; }
    if (r.Tipo !== 2 && r.Tipo !== 3) continue;
    const dest = r.Tipo === 2 ? cargos : abonos;
    for (let p = 1; p <= 14; p++) { const v = round2(r[`Importes${p}`]); if (v !== 0) dest.set(kP(cod, year, p), v); }
  }

  const keys = new Set([...cargos.keys(), ...abonos.keys()]);
  const out = [];
  for (const k of keys) {
    const [cod, yStr, pStr] = k.split('|');
    const year = Number(yStr), per = Number(pStr);
    const c = cargos.get(k) || 0, a = abonos.get(k) || 0;
    const m = meta.get(cod);
    out.push([TENANT, cod, m.nombre, m.afectable, m.familia, m.sat, m.satNom,
      year, per, anioMes(year, per), saldoIni.get(kCE(cod, year)) || 0, c, a, round2(c - a)]);
  }

  const totC = out.reduce((s, r) => s + r[11], 0), totA = out.reduce((s, r) => s + r[12], 0);
  console.log(`  filas destino: ${out.length}  (${noYear} sin año)`);
  console.log(`  Σcargos $${round2(totC).toLocaleString()}  Σabonos $${round2(totA).toLocaleString()}  Δ $${round2(totC - totA)}`);
  console.log(`  muestra:`, out.slice(0, 3).map((r) => `${r[1]} ${r[9]} C:${r[11]} A:${r[12]}`).join(' | '));

  if (!APPLY) { console.log('DRY-RUN — nada escrito. Corre con --apply.'); return; }

  const pg = new Client({ connectionString: DST });
  await pg.connect();
  const COLS = 14;
  let done = 0;
  for (let i = 0; i < out.length; i += BATCH) {
    const chunk = out.slice(i, i + BATCH);
    const ph = chunk.map((_, j) => `(${Array.from({ length: COLS }, (_, k) => `$${j * COLS + k + 1}`).join(',')})`).join(',');
    const vals = chunk.flat();
    await pg.query(
      `INSERT INTO analytics.contpaqi_ledger_monthly
         (tenant_id, cuenta, cuenta_nombre, cuenta_afectable, familia, agrupador_sat, agrupador_sat_nombre,
          ejercicio, periodo, anio_mes, saldo_ini, cargos, abonos, neto)
       VALUES ${ph}
       ON CONFLICT (tenant_id, cuenta, ejercicio, periodo) DO UPDATE SET
         cuenta_nombre=EXCLUDED.cuenta_nombre, cuenta_afectable=EXCLUDED.cuenta_afectable,
         familia=EXCLUDED.familia, agrupador_sat=EXCLUDED.agrupador_sat, agrupador_sat_nombre=EXCLUDED.agrupador_sat_nombre,
         anio_mes=EXCLUDED.anio_mes, saldo_ini=EXCLUDED.saldo_ini,
         cargos=EXCLUDED.cargos, abonos=EXCLUDED.abonos, neto=EXCLUDED.neto, computed_at=now()`,
      vals);
    done += chunk.length;
  }
  await pg.end();
  console.log(`✅ UPSERT ${done} filas en analytics.contpaqi_ledger_monthly`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
