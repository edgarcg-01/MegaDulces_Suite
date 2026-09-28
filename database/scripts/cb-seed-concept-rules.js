/* eslint-disable no-console */
/**
 * [CB.6.1] Set inicial de reglas `match_concept` para `finance.bank_classify_rules` — clasifica por
 * CONCEPTO los movimientos que hoy caen sin categoría (el motor de reglas YA EXISTE; esto sólo agrega
 * reglas, no código). Nace del reporte: ~5,855 movimientos rule-classified sin categoría en 9 meses,
 * todos EGRESOS, con conceptos recurrentes (UBER, comisión POS, basura, vigilancia…).
 *
 * CONSERVADOR a propósito: sólo conceptos OPERATIVOS inequívocos. NO incluye nombres de proveedor
 * (compra vs gasto = decisión del contador) ni ambiguos (bonos, capitán de marca). `priority` 100+
 * para que las reglas por `raw_type` (TI/TE, PF…) sigan ganando primero. Idempotente por match_concept.
 *
 *   node database/scripts/cb-seed-concept-rules.js          # dry-run: cobertura + avisos, NO escribe
 *   node database/scripts/cb-seed-concept-rules.js --apply  # inserta reglas + recategoriza los sin_categoria
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { classify } = require('../../libs/platform-core/src/lib/provenance/target-guard.js');

const APPLY = process.argv.includes('--apply');
const TENANT = '00000000-0000-0000-0000-00000000d01c';

// patrón (regex, case-insensitive) → category_code. Alto priority = menor precedencia que las de raw_type.
// Cada regla se probó contra los conceptos reales de prod; el dry-run mide cuántos toca y avisa colisiones.
const RULES = [
  { priority: 100, concept: 'APLI TASA DE DES.*TERMINALES', cat: 'comision_bancaria', note: 'comisión TPV/POS (tasa de descuento)' },
  { priority: 101, concept: '^IVA TASA DE DES.*TERMINALES', cat: 'iva_acreditable', note: 'IVA de la comisión TPV' },
  { priority: 110, concept: '^UBER', cat: 'gasto_admin', note: 'transporte (Uber)' },
  { priority: 120, concept: 'BASURA|RECOLECCION', cat: 'servicios', note: 'recolección de basura' },
  { priority: 121, concept: 'VELADOR|VIGILANCIA', cat: 'servicios', note: 'seguridad/vigilancia' },
  { priority: 122, concept: '^EPURA|AGUA PURIF', cat: 'servicios', note: 'agua purificada' },
  { priority: 123, concept: '\\bSAPAS\\b', cat: 'servicios', note: 'agua (SAPAS)' },
  { priority: 130, concept: 'ARTICULOS DE LIMPIEZA|PROD(UCTOS)? LIMPIEZA|PAPEL HIGIENICO', cat: 'gasto_admin', note: 'limpieza/insumos' },
  { priority: 140, concept: 'VALORES LUCIA|TRASLADO DE VALORES', cat: 'traslado_valores', note: 'traslado de valores' },
  { priority: 150, concept: '^PERMISO CEDIS', cat: 'gasto_admin', note: 'permisos/derechos' },
  { priority: 151, concept: '^ESTACIONAMIENTO', cat: 'gasto_admin', note: 'estacionamiento' },
  { priority: 152, concept: 'MANTENIMIENTO', cat: 'gasto_admin', note: 'mantenimiento' },
];
// Guarda: un concepto que huele a PROVEEDOR (razón social) NO debe caer en estas reglas — es compra/gasto
// que decide el contador. Se usa para AVISAR si alguna regla lo tocara.
const SUPPLIER_RE = /S\.?\s*A\.?\s*DE\s*C\.?\s*V|S\.?\s*DE\s*R\.?\s*L|SAPI/i;

function url() {
  const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
  const m = env.match(/^FLEET_DB_URL=(.*)$/m);
  if (!m) throw new Error('falta FLEET_DB_URL');
  return m[1].trim();
}
const normKey = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

(async () => {
  const u = url();
  if (classify(u).kind !== 'prod') { console.error('ABORT: destino no es prod'); process.exit(2); }
  const c = new Client({ connectionString: u, ssl: { rejectUnauthorized: false }, statement_timeout: 300000 });
  await c.connect();
  const q = (s, p) => c.query(s, p).then((r) => r.rows);
  if ((await q('select current_database() d'))[0].d !== 'railway') { console.error('ABORT !railway'); process.exit(2); }

  console.log(`\n=== [CB.6.1] Reglas por concepto · ${APPLY ? 'APLICAR' : 'DRY-RUN'} ===\n`);

  // Categorías válidas (para no insertar una regla a una categoría inexistente).
  const cats = new Map((await q('SELECT code, id FROM finance.movement_categories')).map((r) => [r.code, r.id]));
  for (const r of RULES) if (!cats.has(r.cat)) { console.error(`ABORT: categoría inexistente "${r.cat}" (regla ${r.concept})`); process.exit(2); }

  // Reglas existentes (para idempotencia + para NO pisar una clasificación por raw_type de mayor prioridad).
  const existing = await q('SELECT priority, match_type, match_code, match_concept, category_code FROM finance.bank_classify_rules WHERE active IS NOT FALSE');
  const already = new Set(existing.filter((r) => r.match_concept).map((r) => r.match_concept));
  const nuevas = RULES.filter((r) => !already.has(r.concept));
  if (nuevas.length < RULES.length) console.log(`  (${RULES.length - nuevas.length} regla(s) ya existen — idempotente)`);

  // Universo: los sin categoría rule-classified (los que reclassify tocaría). Traigo raw_type/code/concept.
  const uncat = await q(
    `SELECT bm.id, bm.raw_type, bm.raw_code, bm.concept, bm.amount_in, bm.amount_out
       FROM finance.bank_movements bm LEFT JOIN finance.movement_categories mc ON mc.id = bm.category_id
      WHERE bm.deleted_at IS NULL AND mc.group_key IS NULL AND bm.classified_by = $1`, ['rule']);
  console.log(`  sin categoría (rule-classified): ${uncat.length} movimientos\n`);

  // Compilo TODAS las reglas activas (existentes + nuevas) por prioridad — la primera que aplica gana,
  // igual que classifyWith del servicio. Así respeto que una regla por raw_type de menor priority gane.
  const compiled = [...existing.map((r) => ({ priority: r.priority, reType: safe(r.match_type), reCode: safe(r.match_code), reConcept: safe(r.match_concept), cat: r.category_code })),
    ...nuevas.map((r) => ({ priority: r.priority, reType: null, reCode: null, reConcept: safe(r.concept), cat: r.cat }))]
    .sort((a, b) => a.priority - b.priority);
  function safe(p) { if (!p) return null; try { return new RegExp(p, 'i'); } catch { return null; } }
  const classifyOne = (m) => {
    const M = normKey(m.raw_type), C = normKey(m.raw_code), T = normKey(m.concept);
    for (const r of compiled) {
      if (r.reType && !r.reType.test(M)) continue;
      if (r.reCode && !r.reCode.test(C)) continue;
      if (r.reConcept && !r.reConcept.test(T)) continue;
      return r.cat;
    }
    return 'sin_clasificar';
  };

  // Cobertura por regla nueva + avisos de proveedor.
  const perRule = new Map(nuevas.map((r) => [r.concept, { n: 0, monto: 0, cat: r.cat, supplier: 0 }]));
  const toUpdate = []; // {id, cat}
  let clasificados = 0, supplierHits = 0;
  const supplierEx = [];
  for (const m of uncat) {
    const cat = classifyOne(m);
    if (cat === 'sin_clasificar') continue;
    clasificados++;
    const monto = Number(m.amount_in || 0) + Number(m.amount_out || 0);
    toUpdate.push({ id: m.id, cat });
    // ¿por cuál NUEVA regla entró? (recompilo solo nuevas para atribuir)
    const hit = nuevas.find((r) => { const re = safe(r.concept); return re && re.test(normKey(m.concept)); });
    if (hit) { const b = perRule.get(hit.concept); b.n++; b.monto += monto; if (SUPPLIER_RE.test(m.concept || '')) { b.supplier++; supplierHits++; if (supplierEx.length < 8) supplierEx.push(`${hit.concept} ← ${m.concept}`); } }
  }

  console.log('  Regla (match_concept)                         → categoría          movs · monto');
  for (const r of nuevas) { const b = perRule.get(r.concept); console.log(`   ${r.concept.padEnd(42).slice(0, 42)} → ${r.cat.padEnd(18)} ${String(b.n).padStart(4)} · $${Math.round(b.monto).toLocaleString()}${b.supplier ? `   ⚠️ ${b.supplier} parecen proveedor` : ''}`); }
  console.log(`\n  Clasificaría ${clasificados} de ${uncat.length} sin categoría (${((clasificados / (uncat.length || 1)) * 100).toFixed(1)}%). Quedarían ${uncat.length - clasificados} sin categoría.`);
  if (supplierHits) { console.log(`  ⚠️ ${supplierHits} movimiento(s) que parecen PROVEEDOR entrarían a una regla — revisar (compra vs gasto):`); supplierEx.forEach((s) => console.log('     ' + s)); }

  if (!APPLY) { console.log('\n⛔ NO aplicado — corré con --apply para insertar reglas + recategorizar.'); await c.end(); process.exit(0); }

  // APLICAR: insertar reglas nuevas + actualizar category_id de los recién clasificados.
  console.log('\n[apply] insertando reglas nuevas…');
  for (const r of nuevas) {
    await q(`INSERT INTO finance.bank_classify_rules (tenant_id, priority, match_type, match_code, match_concept, category_code, note, active)
             VALUES ($1,$2,NULL,NULL,$3,$4,$5,true)`, [TENANT, r.priority, r.concept, r.cat, r.note]);
  }
  console.log(`[apply] ${nuevas.length} reglas insertadas. Recategorizando ${toUpdate.length} movimientos…`);
  const byCat = new Map();
  for (const u2 of toUpdate) { const id = cats.get(u2.cat); if (!byCat.has(id)) byCat.set(id, []); byCat.get(id).push(u2.id); }
  for (const [catId, ids] of byCat) {
    for (let i = 0; i < ids.length; i += 500)
      await q(`UPDATE finance.bank_movements SET category_id=$1, updated_at=now() WHERE id = ANY($2)`, [catId, ids.slice(i, i + 500)]);
  }
  const rem = (await q(`SELECT count(*) n FROM finance.bank_movements bm LEFT JOIN finance.movement_categories mc ON mc.id=bm.category_id WHERE bm.deleted_at IS NULL AND mc.group_key IS NULL AND bm.classified_by=$1`, ['rule']))[0].n;
  console.log(`\n✅ aplicado. Sin categoría restantes (rule): ${rem}. Correr el candado: node database/tests/test-newdb-bank-threeway-recon.js`);
  await c.end();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
