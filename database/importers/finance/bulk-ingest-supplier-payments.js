/* eslint-disable no-console */
/**
 * SP.5 — Carga masiva de comprobantes de pago a proveedor desde la carpeta de red.
 *
 * Recorre `2026/<mes>/.../*.pdf`, y por cada comprobante: lo lee con OCR (endpoint),
 * busca el pago de Kepler que le corresponde (monto + fecha + concepto/factura), y
 * SI hay match único lo sube a Cloudinary y lo adjunta. Reusa los endpoints ya
 * probados (`/finance/supplier-payments/ocr|match-pago|upload|attach`) — NO reimplementa
 * OCR ni Cloudinary. El nombre del archivo ("F 451", "F 906-907-908") es la mejor
 * pista de concepto/factura y se usa como hint del match.
 *
 * DRY-RUN por default: solo reporta qué adjuntaría (igual llama OCR + match). Con
 * `--apply` sube y adjunta. Idempotencia: el backend permite N comprobantes por pago,
 * así que re-correr duplica — usar `--apply` UNA vez por carpeta, o filtrar por mes.
 *
 *   node database/importers/finance/bulk-ingest-supplier-payments.js                 # dry-run, todos los meses
 *   node ... --month "08 AGOSTO"                                                      # un mes
 *   node ... --limit 20                                                               # primeros 20 (prueba)
 *   node ... --apply                                                                  # sube + adjunta
 *
 * Env: API_BASE (def http://localhost:3334/api), BULK_USER/BULK_PASS (def superoot),
 *      PAYMENTS_DIR (def la carpeta Z:).
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.API_BASE || 'http://localhost:3334/api';
const USER = process.env.BULK_USER || 'superoot';
const PASS = process.env.BULK_PASS || 'superoot';
const ROOT = process.env.PAYMENTS_DIR || 'Z:\\Datos Usuarios\\0Finanzas\\Pagos\\2026';
const APPLY = process.argv.includes('--apply');
const monthIx = process.argv.indexOf('--month');
const MONTH = monthIx > -1 ? process.argv[monthIx + 1] : null;
const limIx = process.argv.indexOf('--limit');
const LIMIT = limIx > -1 ? Number(process.argv[limIx + 1]) : Infinity;

async function req(method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

/** Lista recursiva de PDFs bajo dir, con el nombre de archivo (= hint de factura). */
function walkPdfs(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkPdfs(full, out);
    else if (e.isFile() && /\.pdf$/i.test(e.name)) out.push(full);
  }
  return out;
}

/** Nombre de archivo → concepto ("F 906-907-908.pdf" → "F 906 907 908"). */
const conceptoFromName = (file) => path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ').trim();

(async () => {
  console.log(`\n=== Carga masiva comprobantes de pago (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`API=${BASE}  dir=${ROOT}${MONTH ? `  mes=${MONTH}` : ''}\n`);

  const login = await req('POST', '/auth/login', null, { username: USER, password: PASS });
  const token = login.body?.access_token || login.body?.token;
  if (!token) { console.error('Login falló:', JSON.stringify(login.body).slice(0, 200)); process.exit(1); }

  const scanDir = MONTH ? path.join(ROOT, MONTH) : ROOT;
  const pdfs = walkPdfs(scanDir).slice(0, LIMIT);
  console.log(`${pdfs.length} PDFs encontrados.\n`);

  const st = { matched: 0, attached: 0, ambiguo: 0, sin_match: 0, ocr_fail: 0, error: 0 };
  for (const file of pdfs) {
    const rel = path.relative(ROOT, file);
    try {
      const b64 = fs.readFileSync(file).toString('base64');
      const dataUri = `data:application/pdf;base64,${b64}`;
      const ocr = await req('POST', '/finance/supplier-payments/ocr', token, { file_base64: dataUri });
      const o = ocr.body || {};
      if (o.monto == null) { st.ocr_fail++; console.log(`  ~ OCR ilegible: ${rel}`); continue; }
      // concepto: el del OCR, o el del nombre de archivo (más confiable en esta carpeta)
      const concepto = o.concepto || conceptoFromName(file);
      const match = await req('POST', '/finance/supplier-payments/match-pago', token, { monto: o.monto, fecha: o.fecha, concepto });
      const cands = match.body?.pagos || [];
      // preferir el que casa por factura; si no, el único candidato
      const byConcepto = cands.filter((c) => c.concepto_match);
      const pick = byConcepto.length === 1 ? byConcepto[0] : (cands.length === 1 ? cands[0] : null);
      if (!pick) {
        if (cands.length === 0) { st.sin_match++; console.log(`  ✗ sin pago  $${o.monto}  "${concepto}"  ${rel}`); }
        else { st.ambiguo++; console.log(`  ? ${cands.length} candidatos  $${o.monto}  "${concepto}"  ${rel}`); }
        continue;
      }
      st.matched++;
      console.log(`  ✓ match  ${pick.doc_prefix} ${pick.sucursal}/${pick.folio}  ${pick.proveedor_nombre || ''}  $${o.monto}  ${rel}`);
      if (!APPLY) continue;
      const up = await req('POST', '/finance/supplier-payments/upload', token, { file_base64: dataUri, role: 'comprobante' });
      if (!up.body?.url) { st.error++; console.log(`     ! upload falló`); continue; }
      const at = await req('POST', '/finance/supplier-payments/attach', token, {
        sucursal: pick.sucursal, folio: pick.folio, doc_prefix: pick.doc_prefix,
        files: [up.body], ocr: { ...o, concepto },
      });
      if (at.body?.id) { st.attached++; console.log(`     → adjuntado (match=${at.body.monto_match}${at.body.cuenta_propia === false ? ', CUENTA AJENA' : ''}${at.body.ref_duplicada ? ', CLAVE DUP' : ''})`); }
      else { st.error++; console.log(`     ! attach falló: ${JSON.stringify(at.body).slice(0, 120)}`); }
    } catch (e) { st.error++; console.log(`  ! error ${rel}: ${e.message}`); }
  }

  console.log(`\n── Resumen ──`);
  console.log(`  match único: ${st.matched}${APPLY ? ` · adjuntados: ${st.attached}` : ' (dry-run, no adjuntó)'}`);
  console.log(`  ambiguos (varios pagos): ${st.ambiguo} · sin pago: ${st.sin_match} · OCR ilegible: ${st.ocr_fail} · errores: ${st.error}`);
  if (!APPLY) console.log(`\n[DRY-RUN] nada se subió. Revisá los match y corré con --apply.`);
})();
