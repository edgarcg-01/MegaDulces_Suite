/* eslint-disable no-console */
/**
 * `[CP.8.20]` — **El mapa proveedor → cuenta `2120*`, derivado de la contabilidad real.**
 *
 * Llena dos tablas, las dos READ-ONLY sobre ContPAQi (ADR-040 intacto):
 *   · `analytics.contpaqi_accounts`  — el catálogo de cuentas (8,811). Hoy sólo existe como JOIN
 *     dentro de `import-contpaqi-polizas.js`, o sea que no se le puede preguntar nada.
 *   · `contpaqi.supplier_accounts`   — qué proveedor corresponde a cada cuenta `2120*`, **con su
 *     veredicto y sus votos**.
 *
 * ── Dos derivaciones independientes, y se CRUZAN ────────────────────────────────────────────
 *  **A — por nombre normalizado.** El nombre de la cuenta contra el nombre del proveedor.
 *  **B — ⭐ por UUID.** `AsocCFDIs` dice qué CFDI ató ContPAQi a qué renglón de póliza; nuestro
 *  `fiscal.cfdis` dice de qué RFC es ese CFDI. **Estructural: no se adivina ninguna grafía.**
 *
 * Medido el 2026-10-09 sobre las 147 cuentas usadas en 2026 ($304,207,944.28): A resuelve 125
 * (89.4 % del importe), **B resuelve 146 (100 %)**, y **no hay ni una que A resuelva y B no**.
 *
 * ⛔ **Aun así A no se tira.** Es el único testigo independiente que tiene B, y ya pagó: de 125
 * cuentas donde opinan las dos, **124 coinciden y 1 discrepa** — `2120000366 CANAP BOLSAS` con un
 * CFDI de **ABARROTES LA VIOLETA** por $44,272.35, que tiene su propia cuenta (`2120000336`).
 * Error de captura, encontrado sólo porque había dos vías.
 *
 * ⚠️ Esa cuenta tenía **pureza 100 % sobre UN voto**. *Pureza perfecta sobre n=1 no es certeza.*
 * El veredicto pesa votos: 36 de 183 cuentas (20 %) se apoyan en una sola asociación.
 *
 *   node database/importers/contpaqi/import-contpaqi-account-map.js            # dry-run
 *   node database/importers/contpaqi/import-contpaqi-account-map.js --apply
 *
 * Env: CONTPAQI_SQL_* · DATABASE_URL_NEW · CONTPAQI_TENANT_ID.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const sql = require('mssql');
const { Client } = require('pg');

const TENANT = process.env.CONTPAQI_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
const APPLY = process.argv.includes('--apply');
const DESDE = (() => {
  const i = process.argv.indexOf('--desde');
  return i === -1 ? '2025-01-01' : process.argv[i + 1];
})();
const BATCH = 1000;
/** n≥3 para `uuid_solido`. No es redondo por gusto: n=1 es donde vivió el único falso positivo. */
const VOTOS_SOLIDO = 3;
const PUREZA_SOLIDA = 90;

/**
 * ⛔⛔ **La cuenta de un proveedor vive en TRES rubros, no en uno.** `2120` es su cuenta por
 * pagar; `5010` y `5020` son sus compras. Medido: **973 de 1,025 sufijos compartidos entre esos
 * rubros tienen el MISMO nombre (94.9 %)** — `2120000108` y `5010000108` son el mismo tercero.
 *
 * ⭐ Esta lista nació sólo con `2120` y el recorte se destapó comparando dos universos: al
 * restringir la derivación a pólizas 1:1, `compra_mercancia` se caía a `no_aplica` porque esas
 * pólizas cargan a `5010`/`5020`. Con los tres rubros, la concentración pasa de **65.1 % a
 * 94.7 %** y el tipo queda **estable** bajo las dos ventanas.
 */
const RUBROS_PROVEEDOR = ['2120', '5010', '5020'];

const SRC = {
  server: process.env.CONTPAQI_SQL_HOST || '192.168.0.35',
  user: process.env.CONTPAQI_SQL_USER || 'platform_ro',
  password: process.env.CONTPAQI_SQL_PASSWORD || 'superoot',
  database: process.env.CONTPAQI_SQL_DB || 'ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ',
  options: { instanceName: process.env.CONTPAQI_SQL_INSTANCE || 'COMPAC', encrypt: false, trustServerCertificate: true },
  connectionTimeout: 20000,
  requestTimeout: 300000,
};

const clean = (s) => (s == null ? null : String(s).trim() || null);

/**
 * Normalización del nombre. ⚠️ La puntuación **interna a una palabra se BORRA**, no se convierte
 * en espacio: medido, `CANEL'S` contra `CANELS` fallaba porque el apóstrofo se volvía espacio y
 * daba `CANEL S`. Los separadores sí van a espacio.
 *
 * ⛔ **No se normaliza más agresivo** (quitar `SA DE CV`, singular/plural). Medido: sube la
 * cobertura y empieza a emparejar cosas distintas — la cuenta
 * `SOCIEDAD COOPERATIVA TRABAJADORES PASCUAL` terminaba emparejada con la persona física
 * `PASCUAL ALEJANDRO GONZALEZ LOPEZ`. Esta vía es el **testigo**, no el resolvedor.
 */
const norm = (s) => (s || '').trim().toUpperCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’.]/g, '')
  .replace(/[,"()\-/]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

(async () => {
  console.log(`ContPAQi account-map → ${APPLY ? 'APPLY' : 'DRY-RUN'} · tenant ${TENANT} · desde ${DESDE}`);

  const mss = await sql.connect(SRC);
  const cuentas = (await mss.request().query(`
    SELECT c.Codigo, c.Nombre, c.Tipo, c.EsBaja, c.Afectable, a.Codigo AS SatCod
      FROM Cuentas c LEFT JOIN AgrupadoresSAT a ON a.Id = c.IdAgrupadorSAT`)).recordset;
  const prov = (await mss.request().query('SELECT Codigo, Nombre, RFC FROM Proveedores')).recordset;
  const pares = (await mss.request().input('d', sql.Date, DESDE).query(`
    SELECT c.Codigo AS cuenta, a.UUID
      FROM AsocCFDIs a
      JOIN MovimientosPoliza mp ON mp.Guid = a.GuidRef
      JOIN Polizas  p ON p.Id = mp.IdPoliza
      JOIN Cuentas  c ON c.Id = mp.IdCuenta
     WHERE p.Fecha >= @d AND (c.Codigo LIKE '2120%' OR c.Codigo LIKE '5010%' OR c.Codigo LIKE '5020%')`)).recordset;
  await mss.close();
  console.log(`  origen: ${cuentas.length} cuentas · ${prov.length} proveedores · ${pares.length} pares (cuenta, UUID)`);

  // ── B: UUID → RFC del emisor, desde NUESTROS CFDIs ──────────────────────────────────────
  const pg = new Client({ connectionString: DST });
  await pg.connect();
  const uuids = [...new Set(pares.map((x) => (x.UUID || '').trim().toUpperCase()).filter(Boolean))];
  const { rows: cfdis } = await pg.query(
    'SELECT upper(uuid) uuid, upper(emisor_rfc) rfc FROM fiscal.cfdis WHERE upper(uuid) = ANY($1::text[])',
    [uuids]);
  const rfcDe = new Map(cfdis.map((r) => [r.uuid, r.rfc]));
  console.log(`  UUID distintos ${uuids.length} · hallados en fiscal.cfdis ${cfdis.length}`
    + ` (${((100 * cfdis.length) / Math.max(uuids.length, 1)).toFixed(1)}%)`);

  const votos = new Map();
  for (const p of pares) {
    const rfc = rfcDe.get((p.UUID || '').trim().toUpperCase());
    if (!rfc) continue;
    if (!votos.has(p.cuenta)) votos.set(p.cuenta, new Map());
    const m = votos.get(p.cuenta);
    m.set(rfc, (m.get(rfc) || 0) + 1);
  }

  // ── A: nombre normalizado → RFC. Un nombre que apunte a 2 RFC NO resuelve: se deja fuera. ──
  const porNombre = new Map();
  for (const p of prov) {
    const k = norm(p.Nombre);
    if (!k) continue;
    if (!porNombre.has(k)) porNombre.set(k, new Map());
    porNombre.get(k).set((p.RFC || '').trim().toUpperCase() || 'SIN_RFC', p);
  }
  const porRfc = new Map();
  for (const p of prov) {
    const r = (p.RFC || '').trim().toUpperCase();
    if (r && !porRfc.has(r)) porRfc.set(r, p);
  }

  // ── El veredicto, cuenta por cuenta ─────────────────────────────────────────────────────
  const filas = [];
  for (const c of cuentas) {
    const cod = clean(c.Codigo);
    if (!cod || !RUBROS_PROVEEDOR.some((r) => cod.startsWith(r))) continue;

    const cands = porNombre.get(norm(c.Nombre));
    const rfcA = cands && cands.size === 1 ? [...cands.keys()][0] : null;

    const m = votos.get(cod);
    let rfcB = null; let n = 0; let pureza = null;
    if (m) {
      const orden = [...m.entries()].sort((a, b) => b[1] - a[1]);
      n = orden.reduce((s, x) => s + x[1], 0);
      rfcB = orden[0][0];
      pureza = +((100 * orden[0][1]) / n).toFixed(2);
    }

    let veredicto; let rfc = null; let motivo = null;
    if (rfcA && rfcB && rfcA === rfcB) {
      veredicto = 'confirmado'; rfc = rfcA;
      motivo = `nombre y UUID coinciden (${n} asociaciones, pureza ${pureza}%)`;
    } else if (rfcA && rfcB) {
      // ⛔ NUNCA se elige uno. Discrepar es el hallazgo, no un empate a desempatar.
      veredicto = 'en_disputa';
      motivo = `el nombre dice ${rfcA} y los CFDI dicen ${rfcB} (${n} asociaciones, pureza ${pureza}%)`;
    } else if (rfcB && n >= VOTOS_SOLIDO && pureza >= PUREZA_SOLIDA) {
      veredicto = 'uuid_solido'; rfc = rfcB;
      motivo = `${n} CFDI asociados, pureza ${pureza}%; el nombre no corrobora`;
    } else if (rfcB) {
      veredicto = 'uuid_debil'; rfc = rfcB;
      motivo = `solo ${n} asociacion(es)${pureza === null ? '' : `, pureza ${pureza}%`}`
        + ' — insuficiente para asentar';
    } else if (rfcA) {
      veredicto = 'solo_nombre'; rfc = rfcA;
      motivo = 'empata por nombre; ningun CFDI asociado lo corrobora';
    } else {
      veredicto = 'sin_proveedor';
      motivo = cands && cands.size > 1
        ? `el nombre apunta a ${cands.size} proveedores con RFC distinto`
        : 'ni el nombre ni los CFDI resuelven un proveedor';
    }

    const p = rfc ? porRfc.get(rfc) : null;
    filas.push([TENANT, cod, clean(c.Nombre), rfc, p ? clean(p.Codigo) : null,
      p ? clean(p.Nombre) : null, rfcA, rfcB, n, pureza, veredicto, motivo]);
  }

  const cuenta = (v) => filas.filter((f) => f[10] === v).length;
  console.log('\n  veredictos:');
  for (const v of ['confirmado', 'uuid_solido', 'uuid_debil', 'en_disputa', 'solo_nombre', 'sin_proveedor']) {
    console.log(`    ${v.padEnd(14)} ${String(cuenta(v)).padStart(5)}`);
  }
  const disputa = filas.filter((f) => f[10] === 'en_disputa');
  if (disputa.length) {
    console.log('\n  ⛔ EN DISPUTA (van a bandeja, no se resuelven solas):');
    for (const d of disputa.slice(0, 10)) console.log(`    ${d[1]} ${d[2]} — ${d[11]}`);
  }

  if (!APPLY) { console.log('\nDRY-RUN — nada escrito. Corre con --apply.'); await pg.end(); return; }

  // ── Catálogo de cuentas ─────────────────────────────────────────────────────────────────
  const ctas = cuentas.map((c) => [TENANT, clean(c.Codigo), clean(c.Nombre), clean(c.Tipo),
    c.EsBaja == null ? null : Boolean(Number(c.EsBaja)),
    c.Afectable == null ? null : Number(c.Afectable), clean(c.SatCod)]).filter((r) => r[1]);
  for (let i = 0; i < ctas.length; i += BATCH) {
    const ch = ctas.slice(i, i + BATCH);
    const ph = ch.map((_, j) => `(${Array.from({ length: 7 }, (_, k) => `$${j * 7 + k + 1}`).join(',')})`).join(',');
    await pg.query(
      `INSERT INTO analytics.contpaqi_accounts
         (tenant_id, codigo, nombre, tipo, es_baja, afectable, agrupador_sat)
       VALUES ${ph}
       ON CONFLICT (tenant_id, codigo) DO UPDATE SET
         nombre=EXCLUDED.nombre, tipo=EXCLUDED.tipo, es_baja=EXCLUDED.es_baja,
         afectable=EXCLUDED.afectable, agrupador_sat=EXCLUDED.agrupador_sat, computed_at=now()`,
      ch.flat());
  }

  // ── El mapa ─────────────────────────────────────────────────────────────────────────────
  const C = 12;
  for (let i = 0; i < filas.length; i += BATCH) {
    const ch = filas.slice(i, i + BATCH);
    const ph = ch.map((_, j) => `(${Array.from({ length: C }, (_, k) => `$${j * C + k + 1}`).join(',')},CURRENT_DATE)`).join(',');
    await pg.query(
      `INSERT INTO contpaqi.supplier_accounts
         (tenant_id, cuenta, cuenta_nombre, rfc, proveedor_codigo, proveedor_nombre,
          rfc_por_nombre, rfc_por_uuid, votos, pureza_pct, veredicto, motivo, medido_en)
       VALUES ${ph}
       ON CONFLICT (tenant_id, cuenta) DO UPDATE SET
         cuenta_nombre=EXCLUDED.cuenta_nombre, rfc=EXCLUDED.rfc,
         proveedor_codigo=EXCLUDED.proveedor_codigo, proveedor_nombre=EXCLUDED.proveedor_nombre,
         rfc_por_nombre=EXCLUDED.rfc_por_nombre, rfc_por_uuid=EXCLUDED.rfc_por_uuid,
         votos=EXCLUDED.votos, pureza_pct=EXCLUDED.pureza_pct, veredicto=EXCLUDED.veredicto,
         motivo=EXCLUDED.motivo, medido_en=EXCLUDED.medido_en, computed_at=now()`,
      ch.flat());
  }
  await pg.end();
  console.log(`\n✅ ${ctas.length} cuentas en analytics.contpaqi_accounts`
    + ` · ${filas.length} filas en contpaqi.supplier_accounts`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
