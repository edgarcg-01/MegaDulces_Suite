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
 * Flags: --apply · --from YYYY-MM-DD (default 2025-01-01) · --tipos I,E,P,T (default I,E)
 * READ-ONLY sobre ContPAQi. UPSERT idempotente por (tenant_id, uuid).
 * Env: CONTPAQI_SQL_* · DATABASE_URL_NEW.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const sql = require('mssql');
const { Client } = require('pg');

const TENANT = process.env.CONTPAQI_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const RFC = process.env.CONTPAQI_RFC || 'LOGL851014AQ5';
const APPLY = process.argv.includes('--apply');
const arg = (name, def) => { const i = process.argv.indexOf(name); return i !== -1 ? process.argv[i + 1] : def; };
const FROM = arg('--from', process.env.CONTPAQI_CFDI_FROM || '2025-01-01');
const TIPOS = arg('--tipos', 'I,E').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
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

(async () => {
  console.log(`ContPAQi ADD → fiscal.cfdis · ${APPLY ? 'APPLY' : 'DRY-RUN'} · desde ${FROM} · tipos ${TIPOS.join('/')}`);

  // ── 1) Resolver el ADD vivo (el más recientemente sincronizado para el RFC) ──────────
  let mss = await sql.connect(SRC('DB_Directory'));
  const dirs = (await mss.request().query(`
    SELECT DB_DocumentsMetadata AS db, RFC, Syncronized
      FROM DatabaseDirectory WHERE RFC = '${RFC}' ORDER BY Syncronized DESC`)).recordset;
  await mss.close();
  if (!dirs.length) throw new Error(`DB_Directory no tiene ADD para el RFC ${RFC}`);
  const ADD = dirs[0].db;
  console.log(`  ADD vivo: ${ADD} (sync ${iso(dirs[0].Syncronized)?.slice(0, 10)})`);

  // ── 2) Se procesa AÑO POR AÑO: el ADD tiene ~168k CFDIs recibidos y traerlos de un
  //       jalón (cabeceras + bases por concepto) no cabe cómodo en memoria. ────────────
  mss = await sql.connect(SRC(ADD));
  const tipoList = TIPOS.map((t) => `'${t}'`).join(',');
  const yearFrom = Number(FROM.slice(0, 4));
  const yearTo = new Date().getFullYear();
  const pg = new Client({ connectionString: DST, ssl: DST.includes('rlwy.net') ? { rejectUnauthorized: false } : false });
  if (APPLY) await pg.connect();
  let grandTotal = 0;

  for (let year = yearFrom; year <= yearTo; year++) {
    const desde = year === yearFrom ? FROM : `${year}-01-01`;
    const hasta = `${year + 1}-01-01`;
    const n = await procesarRango(mss, pg, desde, hasta, tipoList);
    grandTotal += n;
  }

  await mss.close();
  if (APPLY) { await pg.end(); console.log(`\n✅ TOTAL: ${grandTotal} CFDIs sincronizados a fiscal.cfdis (source=contpaqi_add).`); }
  else console.log(`\nDRY-RUN — ${grandTotal} CFDIs listos. Corre con --apply para escribir.`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });

async function procesarRango(mss, pg, FROM, HASTA, tipoList) {
  const heads = (await mss.request().query(`
    SELECT c.GuidDocument, c.UUID, c.Version, c.TipoComprobante, c.Serie, c.Folio, c.Fecha, c.FechaTimbrado,
           c.RFCEmisor, c.NombreEmisor, c.RegimenEmisor, c.RFCReceptor, c.NombreReceptor, c.RegimenReceptor,
           c.UsoCFDI, c.Subtotal, c.Descuento, c.Total, c.Moneda, c.TipoCambio, c.MetodoPago, c.FormaPago,
           c.LugarExp, c.NumeroCertificado, c.TotImpTraslado, c.TotImpRetenidos,
           it.ImporteTotalIVATraslado, it.ImporteTotalIEPSTraslado, it.TotalImpuestosRetenidos,
           d.IsAsoContabilidad, d.CancelStatus, d.ValidationStatus
      FROM Comprobante c
      LEFT JOIN ImpuestosTotalizados it ON it.GuidDocument = c.GuidDocument
      LEFT JOIN Documento d ON d.GuidDocument = c.GuidDocument
     WHERE c.RFCReceptor = '${RFC}' AND c.TipoComprobante IN (${tipoList})
       AND c.Fecha >= '${FROM}' AND c.Fecha < '${HASTA}'`)).recordset;
  if (!heads.length) { console.log(`  ${FROM.slice(0, 4)}: sin CFDIs`); return 0; }

  // ── 3) Bases gravables por impuesto y tasa (agregadas por documento) ─────────────────
  // El join va por IdConcepto porque Impuesto_Traslado_Concepto NO trae GuidDocument.
  const bases = (await mss.request().query(`
    SELECT c.GuidDocument, itc.Impuesto, itc.ImpuestoDesc, itc.TipoFactor, itc.TasaOCuota,
           SUM(itc.Base) AS Base, SUM(itc.Importe) AS Importe
      FROM Comprobante cm
      JOIN Conceptos c ON c.GuidDocument = cm.GuidDocument
      JOIN Impuesto_Traslado_Concepto itc ON itc.IdConcepto = c.IdConcepto
     WHERE cm.RFCReceptor = '${RFC}' AND cm.TipoComprobante IN (${tipoList})
       AND cm.Fecha >= '${FROM}' AND cm.Fecha < '${HASTA}'
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
  const etiqueta = `  ${FROM.slice(0, 4)}: ${rows.length} CFDIs · ${bases.length} bases · ${sinAso} sin IsAsoContabilidad`;
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
  console.log(`✅ ${n} escritos${dupes ? ` (${dupes} UUID duplicados en el ADD, colapsados)` : ''}`);
  return n;
}
