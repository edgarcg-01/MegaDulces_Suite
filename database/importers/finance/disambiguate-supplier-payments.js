/* eslint-disable no-console */
/**
 * SP.6 — Desempate de comprobantes AMBIGUOS (mismo monto casa con ≥2 pagos de Kepler).
 *
 * El matcher masivo (SP.5) casa solo por monto. Cuando dos pagos comparten monto, deja
 * el comprobante como "ambiguo". Este pase usa las señales que SP.5 no aprovecha para
 * elegir el correcto:
 *   1. CARPETA = PROVEEDOR — el nombre de la carpeta padre ("DE LA ROSA") contra el
 *      proveedor del pago. Señal dominante.
 *   2. FACTURA — folios del concepto/nombre de archivo contra el concepto del pago.
 *   3. XD2601 — la carpeta es TRANSFERENCIAS → preferir transferencia sobre cheque.
 *   4. FECHA — cercanía a la fecha del OCR.
 * Idempotente: SOLO considera pagos SIN comprobante (deposits=0), así re-correr no
 * duplica ni toca lo ya adjuntado. Elige un ganador si su score supera al 2º por un
 * margen; si no, lo deja como ambiguo (a mano).
 *
 *   node database/importers/finance/disambiguate-supplier-payments.js < lista.txt        # dry-run
 *   node ... --apply < lista.txt                                                          # sube + adjunta
 *   La lista = rutas relativas a PAYMENTS_DIR, una por línea (stdin) o --file <path>.
 *
 * Env: API_BASE, BULK_USER/BULK_PASS, PAYMENTS_DIR (igual que SP.5).
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.API_BASE || 'http://localhost:3334/api';
const USER = process.env.BULK_USER || 'superoot';
const PASS = process.env.BULK_PASS || 'superoot';
const ROOT = process.env.PAYMENTS_DIR || 'Z:\\Datos Usuarios\\0Finanzas\\Pagos\\2026';
const APPLY = process.argv.includes('--apply');
const fileIx = process.argv.indexOf('--file');
const MARGIN = 3; // el ganador debe superar al 2º por ≥ este score

async function req(method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}

const norm = (s) => String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/** overlap de tokens ≥3 del nombre del proveedor vs el hint de la carpeta (0..1). */
function provScore(candName, hint) {
  const a = new Set(norm(candName).split(' ').filter((w) => w.length >= 3));
  const b = norm(hint).split(' ').filter((w) => w.length >= 3);
  if (!b.length || !a.size) return 0;
  let hit = 0; for (const w of b) if (a.has(w)) hit++;
  return hit / b.length;
}
const conceptoFromName = (file) => path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ').trim();
const daysBetween = (a, b) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);

function scoreCand(c, { provHint, ocrFecha, tokens }) {
  let s = 0;
  s += provScore(c.proveedor_nombre || c.proveedor_code, provHint) * 10; // proveedor: dominante
  if (c.concepto_match) s += 4;                                          // factura coincide
  else if (tokens.length && tokens.some((t) => String(c.concepto || '').includes(t))) s += 4;
  if ((c.doc_prefix || '') === 'XD2601') s += 1;                         // transferencia
  if (ocrFecha && c.pago_date) { const d = daysBetween(ocrFecha, c.pago_date); if (d <= 3) s += 2; else if (d <= 10) s += 1; }
  return s;
}

(async () => {
  console.log(`\n=== Desempate de ambiguos (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  const raw = fileIx > -1 ? fs.readFileSync(process.argv[fileIx + 1], 'utf8') : fs.readFileSync(0, 'utf8');
  const rels = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  console.log(`API=${BASE}  ${rels.length} archivos a desempatar\n`);

  const login = await req('POST', '/auth/login', null, { username: USER, password: PASS });
  const token = login.body?.access_token || login.body?.token;
  if (!token) { console.error('Login falló'); process.exit(1); }

  const st = { resuelto: 0, adjuntado: 0, ambiguo: 0, ya: 0, sin: 0, ocr_fail: 0, error: 0 };
  for (const rel of rels) {
    const file = path.join(ROOT, rel);
    const provHint = path.basename(path.dirname(file)); // carpeta padre = proveedor
    try {
      if (!fs.existsSync(file)) { st.error++; console.log(`  ! no existe: ${rel}`); continue; }
      const b64 = fs.readFileSync(file).toString('base64');
      const dataUri = `data:application/pdf;base64,${b64}`;
      const ocr = await req('POST', '/finance/supplier-payments/ocr', token, { file_base64: dataUri });
      const o = ocr.body || {};
      if (o.monto == null) { st.ocr_fail++; console.log(`  ~ OCR ilegible: ${rel}`); continue; }
      const concepto = o.concepto || conceptoFromName(file);
      const tokens = String(concepto).match(/\d{2,}/g) || [];
      const match = await req('POST', '/finance/supplier-payments/match-pago', token, { monto: o.monto, fecha: o.fecha, concepto });
      const cands = match.body?.pagos || [];
      const open = cands.filter((c) => (c.deposits || 0) === 0); // idempotencia: solo sin comprobante
      if (!cands.length) { st.sin++; console.log(`  ✗ sin pago  $${o.monto}  ${rel}`); continue; }
      if (!open.length) { st.ya++; console.log(`  · ya adjuntado (todos los candidatos ya tienen comprobante)  ${rel}`); continue; }

      const scored = open.map((c) => ({ c, s: scoreCand(c, { provHint, ocrFecha: o.fecha, tokens }) }))
        .sort((a, b) => b.s - a.s);
      const top = scored[0];
      const second = scored[1];
      // Exigir EVIDENCIA real (proveedor coincide con la carpeta, o la factura casa) —
      // nunca ganar solo por fecha+doctype. Evita adjuntar al "último que queda" cuando el
      // pago correcto ya fue tomado por otro archivo del mismo monto.
      const provOk = provScore(top.c.proveedor_nombre || top.c.proveedor_code, provHint) > 0;
      const conceptoOk = top.c.concepto_match || (tokens.length > 0 && tokens.some((t) => String(top.c.concepto || '').includes(t)));
      const clear = top.s > 0 && (provOk || conceptoOk) && (open.length === 1 || !second || top.s - second.s >= MARGIN);
      if (!clear) {
        st.ambiguo++;
        const alt = scored.slice(0, 3).map((x) => `${x.c.doc_prefix} ${x.c.sucursal}/${x.c.folio} "${x.c.proveedor_nombre || ''}" (${x.s})`).join('  |  ');
        console.log(`  ? sigue ambiguo  $${o.monto}  [${provHint}]  ${rel}\n       ${alt}`);
        continue;
      }
      const pick = top.c;
      st.resuelto++;
      console.log(`  ✓ ${pick.doc_prefix} ${pick.sucursal}/${pick.folio}  ${pick.proveedor_nombre || ''}  score=${top.s}${second ? ` (2º=${second.s})` : ''}  [${provHint}]  ${rel}`);
      if (!APPLY) continue;
      const up = await req('POST', '/finance/supplier-payments/upload', token, { file_base64: dataUri, role: 'comprobante' });
      if (!up.body?.url) { st.error++; console.log(`     ! upload falló`); continue; }
      const at = await req('POST', '/finance/supplier-payments/attach', token, {
        sucursal: pick.sucursal, folio: pick.folio, doc_prefix: pick.doc_prefix, files: [up.body], ocr: { ...o, concepto },
      });
      if (at.body?.id) { st.adjuntado++; console.log(`     → adjuntado (match=${at.body.monto_match})`); }
      else { st.error++; console.log(`     ! attach falló: ${JSON.stringify(at.body).slice(0, 120)}`); }
    } catch (e) { st.error++; console.log(`  ! error ${rel}: ${e.message}`); }
  }

  console.log(`\n── Resumen ──`);
  console.log(`  resueltos: ${st.resuelto}${APPLY ? ` · adjuntados: ${st.adjuntado}` : ' (dry-run)'}`);
  console.log(`  siguen ambiguos: ${st.ambiguo} · ya adjuntados: ${st.ya} · sin pago: ${st.sin} · OCR ilegible: ${st.ocr_fail} · errores: ${st.error}`);
  if (!APPLY && st.resuelto) console.log(`\n[DRY-RUN] corré con --apply para adjuntar los resueltos.`);
})();
