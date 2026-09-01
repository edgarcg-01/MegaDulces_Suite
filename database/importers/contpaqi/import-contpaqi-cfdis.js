/* eslint-disable no-console */
/**
 * LC.1 (Fase LC, ADR-052) — CFDIs recibidos del ADD de ContPAQi → `fiscal.cfdis`.
 *
 * Por qué el ADD y no la Descarga Masiva del SAT: el ADD (Administrador de Documentos
 * Digitales) es el repositorio que ContPAQi ya mantiene sincronizado — 141,517 CFDIs de
 * ingreso recibidos desde nov-2022, al día — y **no depende de la FIEL** (la de Mega
 * Dulces vencía 2026-07-27). Verificado 2026-09-01: los 238 UUID del libro de compras de
 * jun-2026 están los 238 en el ADD y el total cuadra al centavo ($30,278,735.58).
 *
 * De dónde sale cada cosa (decodificado, no supuesto):
 *   - `Comprobante`              → cabecera del CFDI (UUID, emisor, folio, subtotal, total)
 *   - `ImpuestosTotalizados`     → IVA e IEPS trasladados **por comprobante**
 *   - `Conceptos ⋈ Impuesto_Traslado_Concepto` (join por `IdConcepto` = `GuidDocument-N`)
 *                                → la **base gravable por impuesto y tasa**, que es lo que
 *                                  el workbook derivaba por resta. Ojo: la base del IVA
 *                                  incluye al IEPS (verificado en factura De la Rosa:
 *                                  base IEPS 649,705.34 @8% → base IVA 701,681.77 @0%).
 *   - `Documento`                → `IsAsoContabilidad`, `CancelStatus`, `ValidationStatus`
 *
 * El ADD vivo se resuelve en tiempo de corrida desde `DB_Directory.DatabaseDirectory`
 * (el más recientemente sincronizado para el RFC) — NO se hardcodea el GUID de la base.
 *
 * DOS MODOS (LC.1.1):
 *   - **incremental** (default): lee `analytics.feed_watermarks` y trae solo lo que cambió
 *     desde la última pasada, filtrando por `Documento.TimeStamp`. Verificado 2026-09-01:
 *     de 168,295 comprobantes recibidos, **0 sin Documento y 0 sin TimeStamp**, y el sello
 *     refleja también los cambios posteriores (un CFDI de abril traía sello de septiembre,
 *     131 días después) — o sea que capta altas Y reprocesos, no nada más inserts.
 *   - **--full**: recorre año por año ignorando el watermark. Es el backfill y el
 *     reconciliador de respaldo, por si algún cambio no tocara el sello.
 *
 * Con `--watch N` se queda como carril continuo (cada N segundos) en vez de correr y salir,
 * que es lo que lo saca de ser "un batch que puede fallar de madrugada sin que nadie vea":
 * cada pasada reporta a `analytics.cron_runs` (Salud BD).
 *
 * Flags: --apply · --full · --watch <seg> · --from YYYY-MM-DD (default 2025-01-01)
 *        --tipos I,E,P,T (default I,E)
 * READ-ONLY sobre ContPAQi. UPSERT idempotente por (tenant_id, uuid).
 * Env: CONTPAQI_SQL_* · DATABASE_URL_NEW.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const sql = require('mssql');
const { Client } = require('pg');
const hb = require('../lib/cron-heartbeat');

const FEED_KEY = 'contpaqi_add_cfdis';

const TENANT = process.env.CONTPAQI_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const RFC = process.env.CONTPAQI_RFC || 'LOGL851014AQ5';
const APPLY = process.argv.includes('--apply');
const FULL = process.argv.includes('--full');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : def; };
const FROM = arg('--from', process.env.CONTPAQI_CFDI_FROM || '2025-01-01');
const TIPOS = arg('--tipos', 'I,E').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
const WATCH = Number(arg('--watch', 0)) || 0;
const BATCH = 400;

const SRC = (database) => ({
  server: process.env.CONTPAQI_SQL_HOST || '192.168.0.35',
  user: process.env.CONTPAQI_SQL_USER || 'platform_ro',
  password: process.env.CONTPAQI_SQL_PASSWORD || 'superoot',
  database,
  options: { instanceName: process.env.CONTPAQI_SQL_INSTANCE || 'COMPAC', encrypt: false, trustServerCertificate: true },
  connectionTimeout: 20000, requestTimeout: 900000,
});

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const iso = (d) => (d instanceof Date ? d.toISOString() : d ? String(d) : null);

/**
 * `Documento.CancelStatus` del ADD → `fiscal.cfdis.estatus_sat` (CHECK vigente|cancelado|desconocido).
 * Valores reales medidos en el ADD: '' (615k), 'Cancelable sin/con aceptación' (90),
 * 'Cancelado sin aceptación' (15), 'En proceso' (11).
 * Ojo: **vacío NO es "vigente"** — significa que nadie consultó el estatus al SAT. Se
 * mapea a 'desconocido' para no afirmar de más; el valor crudo se guarda en cancel_reason.
 */
const estatusSat = (cancelStatus) => {
  const s = String(cancelStatus || '').trim();
  if (!s) return 'desconocido';
  if (/^Cancelado/i.test(s)) return 'cancelado';
  if (/^Cancelable/i.test(s)) return 'vigente';
  return 'desconocido';                       // 'En proceso' y cualquier valor nuevo
};

/** Lee el watermark guardado del feed (null la primera vez). */
async function leerWatermark(pg) {
  const r = await pg.query(
    `SELECT watermark_ts FROM analytics.feed_watermarks WHERE tenant_id=$1 AND feed_key=$2`, [TENANT, FEED_KEY]);
  return r.rows[0]?.watermark_ts || null;
}

/** Guarda el watermark alcanzado. Nunca retrocede: si la pasada no trajo nada, se queda igual. */
async function guardarWatermark(pg, ts, rows) {
  await pg.query(
    `INSERT INTO analytics.feed_watermarks (tenant_id, feed_key, label, watermark_ts, rows_last, rows_total, last_run, updated_at)
     VALUES ($1,$2,$3,$4,$5,$5, now(), now())
     ON CONFLICT (tenant_id, feed_key) DO UPDATE
       SET watermark_ts = GREATEST(analytics.feed_watermarks.watermark_ts, EXCLUDED.watermark_ts),
           rows_last = EXCLUDED.rows_last,
           rows_total = analytics.feed_watermarks.rows_total + EXCLUDED.rows_last,
           last_run = now(), updated_at = now()`,
    [TENANT, FEED_KEY, 'CFDIs recibidos del ADD de ContPAQi', ts, rows]);
}

/** Una pasada completa. Devuelve cuántos CFDIs se escribieron. */
async function pasada(mss, pg, tipoList) {
  if (FULL || !APPLY) {
    // Backfill / reconciliación: año por año. El ADD tiene ~168k recibidos y traerlos de
    // un jalón (cabeceras + bases por concepto) no cabe cómodo en memoria.
    const yearFrom = Number(FROM.slice(0, 4));
    const yearTo = new Date().getFullYear();
    let total = 0;
    for (let year = yearFrom; year <= yearTo; year++) {
      const desde = year === yearFrom ? FROM : `${year}-01-01`;
      total += await procesarRango(mss, pg, desde, `${year + 1}-01-01`, tipoList);
    }
    return total;
  }

  // Incremental: solo lo que el ADD tocó desde la última pasada.
  const wm = await leerWatermark(pg);
  if (!wm) {
    console.log('  sin watermark previo → primera pasada completa (equivale a --full)');
    const yearFrom = Number(FROM.slice(0, 4));
    let total = 0;
    for (let year = yearFrom; year <= new Date().getFullYear(); year++) {
      total += await procesarRango(mss, pg, year === yearFrom ? FROM : `${year}-01-01`, `${year + 1}-01-01`, tipoList);
    }
    const max = await maxTimeStamp(mss, tipoList);
    if (max) await guardarWatermark(pg, max, total);
    return total;
  }
  return procesarRango(mss, pg, null, null, tipoList, wm);
}

/** Sello más reciente del ADD, para dejar el watermark en su tope tras un full. */
async function maxTimeStamp(mss, tipoList) {
  const r = (await mss.request().query(`
    SELECT MAX(d.TimeStamp) AS mx FROM Comprobante c JOIN Documento d ON d.GuidDocument = c.GuidDocument
     WHERE c.RFCReceptor = '${RFC}' AND c.TipoComprobante IN (${tipoList})`)).recordset[0];
  return r?.mx || null;
}

(async () => {
  const modo = FULL ? 'FULL' : 'INCREMENTAL';
  console.log(`ContPAQi ADD → fiscal.cfdis · ${APPLY ? 'APPLY' : 'DRY-RUN'} · ${modo}${WATCH ? ` · watch ${WATCH}s` : ''} · tipos ${TIPOS.join('/')}`);

  // ── 1) Resolver el ADD vivo (el más recientemente sincronizado para el RFC) ──────────
  let mss = await sql.connect(SRC('DB_Directory'));
  const dirs = (await mss.request().query(`
    SELECT DB_DocumentsMetadata AS db, RFC, Syncronized
      FROM DatabaseDirectory WHERE RFC = '${RFC}' ORDER BY Syncronized DESC`)).recordset;
  await mss.close();
  if (!dirs.length) throw new Error(`DB_Directory no tiene ADD para el RFC ${RFC}`);
  const ADD = dirs[0].db;
  console.log(`  ADD vivo: ${ADD} (sync ${iso(dirs[0].Syncronized)?.slice(0, 10)})`);

  mss = await sql.connect(SRC(ADD));
  const tipoList = TIPOS.map((t) => `'${t}'`).join(',');
  const pg = new Client({ connectionString: DST, ssl: DST.includes('rlwy.net') ? { rejectUnauthorized: false } : false });
  if (APPLY) await pg.connect();

  const correr = async () => {
    if (APPLY) await hb.begin(FEED_KEY, 'CFDIs recibidos del ADD de ContPAQi');
    try {
      const n = await pasada(mss, pg, tipoList);
      if (APPLY) await hb.end(FEED_KEY, { status: 'ok', rows: n, note: modo.toLowerCase() });
      return n;
    } catch (e) {
      if (APPLY) await hb.end(FEED_KEY, { status: 'error', error: e.message });
      throw e;
    }
  };

  if (!WATCH) {
    const n = await correr();
    await mss.close();
    if (APPLY) { await pg.end(); console.log(`\n✅ TOTAL: ${n} CFDIs sincronizados a fiscal.cfdis (source=contpaqi_add).`); }
    else console.log(`\nDRY-RUN — ${n} CFDIs listos. Corre con --apply para escribir.`);
    return;
  }

  // Carril continuo. Un fallo de una pasada NO tumba el carril: se reporta y se reintenta
  // en la siguiente vuelta (si truena de verdad, queda en cron_runs como 'error').
  console.log(`  carril continuo cada ${WATCH}s — Ctrl+C para salir`);
  for (;;) {
    try { const n = await correr(); if (n) console.log(`  ${new Date().toISOString().slice(11, 19)} · ${n} CFDIs`); }
    catch (e) { console.error(`  ${new Date().toISOString().slice(11, 19)} · fallo: ${e.message}`); }
    await new Promise((r) => setTimeout(r, WATCH * 1000));
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });

/**
 * Procesa un tajo del ADD. Dos formas de acotar, excluyentes:
 *   - por fecha del CFDI (`FROM`/`HASTA`) → backfill y reconciliación
 *   - por sello del ADD (`desdeTs`)       → carril incremental
 */
async function procesarRango(mss, pg, FROM, HASTA, tipoList, desdeTs = null) {
  const corte = desdeTs
    ? `AND d.TimeStamp > '${new Date(desdeTs).toISOString().slice(0, 23).replace('T', ' ')}'`
    : `AND c.Fecha >= '${FROM}' AND c.Fecha < '${HASTA}'`;
  const etiquetaCorte = desdeTs ? `sello > ${iso(desdeTs)?.slice(0, 19)}` : String(FROM).slice(0, 4);

  const heads = (await mss.request().query(`
    SELECT c.GuidDocument, c.UUID, c.Version, c.TipoComprobante, c.Serie, c.Folio, c.Fecha, c.FechaTimbrado,
           c.RFCEmisor, c.NombreEmisor, c.RegimenEmisor, c.RFCReceptor, c.NombreReceptor, c.RegimenReceptor,
           c.UsoCFDI, c.Subtotal, c.Descuento, c.Total, c.Moneda, c.TipoCambio, c.MetodoPago, c.FormaPago,
           c.LugarExp, c.NumeroCertificado, c.TotImpTraslado, c.TotImpRetenidos,
           it.ImporteTotalIVATraslado, it.ImporteTotalIEPSTraslado, it.TotalImpuestosRetenidos,
           d.IsAsoContabilidad, d.CancelStatus, d.ValidationStatus, d.TimeStamp AS AddTimeStamp
      FROM Comprobante c
      LEFT JOIN ImpuestosTotalizados it ON it.GuidDocument = c.GuidDocument
      LEFT JOIN Documento d ON d.GuidDocument = c.GuidDocument
     WHERE c.RFCReceptor = '${RFC}' AND c.TipoComprobante IN (${tipoList}) ${corte}`)).recordset;
  if (!heads.length) { if (!desdeTs) console.log(`  ${etiquetaCorte}: sin CFDIs`); return 0; }

  // ── 3) Bases gravables por impuesto y tasa (agregadas por documento) ─────────────────
  // El join va por IdConcepto porque Impuesto_Traslado_Concepto NO trae GuidDocument.
  // En incremental se acota a los documentos que ya trajimos (son pocos); en full se
  // acota por fecha, porque un IN de 20 mil GUIDs no es viable.
  const corteBases = desdeTs
    ? `AND cm.GuidDocument IN (${heads.map((h) => `'${h.GuidDocument}'`).join(',')})`
    : `AND cm.Fecha >= '${FROM}' AND cm.Fecha < '${HASTA}'`;
  const bases = (await mss.request().query(`
    SELECT c.GuidDocument, itc.Impuesto, itc.ImpuestoDesc, itc.TipoFactor, itc.TasaOCuota,
           SUM(itc.Base) AS Base, SUM(itc.Importe) AS Importe
      FROM Comprobante cm
      JOIN Conceptos c ON c.GuidDocument = cm.GuidDocument
      JOIN Impuesto_Traslado_Concepto itc ON itc.IdConcepto = c.IdConcepto
     WHERE cm.RFCReceptor = '${RFC}' AND cm.TipoComprobante IN (${tipoList}) ${corteBases}
     GROUP BY c.GuidDocument, itc.Impuesto, itc.ImpuestoDesc, itc.TipoFactor, itc.TasaOCuota`)).recordset;

  const byDoc = new Map();
  for (const b of bases) {
    const arr = byDoc.get(b.GuidDocument) || [];
    arr.push({
      impuesto: b.Impuesto, nombre: b.ImpuestoDesc, tipo_factor: b.TipoFactor,
      tasa: Number(b.TasaOCuota), base: round2(b.Base), importe: round2(b.Importe),
    });
    byDoc.set(b.GuidDocument, arr);
  }

  // ── 4) Armar filas para fiscal.cfdis ─────────────────────────────────────────────────
  const rows = heads.map((h) => {
    const traslados = byDoc.get(h.GuidDocument) || [];
    const impuestos = {
      fuente: 'contpaqi_add',
      traslados,                                        // base + tasa + importe por impuesto
      iva_trasladado: round2(h.ImporteTotalIVATraslado),
      ieps_trasladado: round2(h.ImporteTotalIEPSTraslado),
      // Lo que el libro de compras necesita, ya resuelto desde el CFDI (no por resta):
      base_iva_16: round2(traslados.filter((t) => t.impuesto === '002' && t.tasa === 0.16).reduce((a, t) => a + t.base, 0)),
      base_ieps: round2(traslados.filter((t) => t.impuesto === '003').reduce((a, t) => a + t.base, 0)),
    };
    return [
      TENANT, String(h.UUID || '').toUpperCase(), h.Version || null, h.TipoComprobante || null,
      h.Serie || null, h.Folio || null, iso(h.Fecha), iso(h.FechaTimbrado),
      h.RFCEmisor || null, h.NombreEmisor || null, h.RegimenEmisor || null,
      h.RFCReceptor || null, h.NombreReceptor || null, h.RegimenReceptor || null, h.UsoCFDI || null,
      round2(h.Subtotal), round2(h.Descuento), round2(h.Total), h.Moneda || 'MXN', Number(h.TipoCambio) || 1,
      h.MetodoPago || null, h.FormaPago || null, h.LugarExp || null, h.NumeroCertificado || null,
      round2(h.TotImpTraslado), round2(h.TotImpRetenidos),
      JSON.stringify(impuestos), 'recibidas', 'contpaqi_add',
      estatusSat(h.CancelStatus),
      String(h.CancelStatus || '').trim() || null,   // cancel_reason = el crudo del ADD
      h.GuidDocument || null,
    ];
  });

  const sinAso = heads.filter((h) => !h.IsAsoContabilidad).length;
  const etiqueta = `  ${etiquetaCorte}: ${rows.length} CFDIs · ${bases.length} bases · ${sinAso} sin IsAsoContabilidad`;
  if (!APPLY) { console.log(`${etiqueta} (dry-run)`); return rows.length; }
  process.stdout.write(`${etiqueta} … `);

  // ── 5) UPSERT idempotente por (tenant_id, uuid) ──────────────────────────────────────
  const COLS = ['tenant_id', 'uuid', 'version', 'tipo_comprobante', 'serie', 'folio', 'fecha', 'fecha_timbrado',
    'emisor_rfc', 'emisor_nombre', 'emisor_regimen', 'receptor_rfc', 'receptor_nombre', 'receptor_regimen',
    'receptor_uso_cfdi', 'subtotal', 'descuento', 'total', 'moneda', 'tipo_cambio', 'metodo_pago', 'forma_pago',
    'lugar_expedicion', 'no_certificado', 'total_trasladados', 'total_retenidos', 'impuestos', 'rol', 'source',
    'estatus_sat', 'cancel_reason', 'stored_ref'];
  const upd = COLS.filter((c) => !['tenant_id', 'uuid'].includes(c)).map((c) => `${c}=EXCLUDED.${c}`).join(',');

  // El ADD puede traer el mismo UUID más de una vez (tiene su tabla MetadataDuplicados);
  // dos filas con la misma llave en un solo INSERT truenan con "cannot affect row a second
  // time", así que se deduplica antes — se queda la última.
  const porUuid = new Map();
  for (const r of rows) { if (r[1]) porUuid.set(r[1], r); }
  const unicos = [...porUuid.values()];
  const dupes = rows.length - unicos.length;

  let n = 0;
  try {
    await pg.query('BEGIN');
    for (let i = 0; i < unicos.length; i += BATCH) {
      const chunk = unicos.slice(i, i + BATCH);
      const ph = chunk.map((_, j) => `(${COLS.map((_, k) => `$${j * COLS.length + k + 1}`).join(',')})`).join(',');
      await pg.query(`INSERT INTO fiscal.cfdis (${COLS.join(',')}) VALUES ${ph}
         ON CONFLICT (tenant_id, uuid) DO UPDATE SET ${upd}, updated_at=now()`, chunk.flat());
      n += chunk.length;
    }
    await pg.query('COMMIT');
  } catch (e) { await pg.query('ROLLBACK').catch(() => {}); throw e; }

  // El watermark avanza SOLO después de que el lote quedó comiteado. Si truena a medias,
  // se queda donde estaba y la siguiente pasada vuelve a traer lo mismo (el UPSERT es
  // idempotente, así que repetir no duele; perder un cambio sí).
  if (desdeTs) {
    const maxTs = heads.reduce((mx, h) => (h.AddTimeStamp > mx ? h.AddTimeStamp : mx), heads[0].AddTimeStamp);
    await guardarWatermark(pg, maxTs, n);
  }
  console.log(`✅ ${n} escritos${dupes ? ` (${dupes} UUID duplicados en el ADD, colapsados)` : ''}`);
  return n;
}
