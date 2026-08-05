/**
 * RE.10 — Clasifica el TAIL de los ajustes de compra (X-D-40/55) que el keyword no pudo.
 *
 * Dos pasadas sobre `analytics.erp_purchase_adjustments`:
 *   (1) LLM (Haiku): motivos con TEXTO que quedaron 'otro' → lee `c24` y clasifica en la
 *       taxonomía; escribe `categoria` + `categoria_source='llm'`. (~$1M, motivos tersos:
 *       "PAGO CAPITAN DE MARCA"=apoyo, "NC-F-4233"=descuento, "Complemento factura"=diferencia)
 *   (2) Default por doctype: X-D-55 con motivo EN BLANCO (sin texto que leer) → comercial;
 *       X-D-40 en blanco → devolución. `categoria_source='doctype_default'`. (~$4M X-D-55)
 *
 * El importer preserva `llm`/`doctype_default` (no los pisa al re-importar). analytics.*
 * no tiene RLS → UPDATE directo con filtro tenant. Idempotente: re-clasifica solo el tail.
 *
 * Uso:
 *   node database/importers/kepler/classify-adjustments-llm.js            # dry-run
 *   node database/importers/kepler/classify-adjustments-llm.js --apply    # commit
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const M = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ADJ_LLM_MODEL || 'claude-haiku-4-5-20251001';
const APPLY = process.argv.includes('--apply');
const BATCH = 40;
const money = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

const TAXO = ['faltante', 'no_solicitado', 'mal_estado', 'cambiada', 'factura_duplicada', 'diferencia_monto', 'pronto_pago', 'apoyo_marca', 'descuento_comercial', 'saldo_favor', 'devolucion_otra', 'otro'];

const SYSTEM = `Eres un clasificador de motivos de NOTAS DE CRÉDITO y DEVOLUCIONES DE COMPRA (proveedor→nosotros) de una distribuidora de dulces en México (ERP Kepler). Clasifica cada motivo en EXACTAMENTE UNA categoría, usando el string EXACTO:
- faltante: faltó mercancía / no llegó completo / cobraron de más por algo no recibido
- no_solicitado: llegó producto no pedido
- mal_estado: dañado, caduco, roto, mal estado, peso de menos
- cambiada: producto equivocado / cambiado / reposición / no traía lo pedido
- factura_duplicada: factura o compra duplicada / doble captura del mismo comprobante
- diferencia_monto: diferencia de precio o monto, "complemento de factura N", ajuste de importe
- pronto_pago: descuento por pronto pago
- apoyo_marca: apoyo de marca / marketing / mercadotecnia / "capitán de marca" / material publicitario
- descuento_comercial: descuento comercial, rappel, promoción, plan, bonificación, o nota de crédito genérica (incl. referencias como "NC-F-4233", "F-688" sin más contexto)
- saldo_favor: saldo a favor
- devolucion_otra: devolución de mercancía sin razón específica
- otro: realmente no clasificable
Responde SOLO con un JSON array [{"i":<número>,"c":"<categoria>"}], sin texto adicional.`;

async function haiku(motivos) {
  const user = 'Clasifica estos motivos:\n' + motivos.map((m, i) => `${i + 1}. "${m}"`).join('\n');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, system: SYSTEM, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error(`sin JSON: ${text.slice(0, 120)}`);
    const arr = JSON.parse(m[0]);
    const out = motivos.map(() => null);
    for (const o of arr) {
      const i = Number(o.i) - 1, c = String(o.c || '').trim();
      if (i >= 0 && i < out.length && TAXO.includes(c)) out[i] = c;
    }
    return out;
  } finally { clearTimeout(timer); }
}

(async () => {
  if (!KEY) { console.error('Falta ANTHROPIC_API_KEY.'); process.exit(1); }
  const db = new Client({ connectionString: DST });
  await db.connect();
  console.log(`=== Clasificador LLM del tail de ajustes (${MODEL}) → analytics.erp_purchase_adjustments (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
  try {
    // Pasada 1 — 'otro' CON texto → Haiku
    const otros = (await db.query(
      `SELECT motivo, count(*)::int n, sum(monto) m FROM analytics.erp_purchase_adjustments
        WHERE tenant_id=$1 AND categoria='otro' AND btrim(COALESCE(motivo,''))<>''
        GROUP BY motivo ORDER BY m DESC`, [M])).rows;
    console.log(`Pasada 1 (LLM): ${otros.length} motivos distintos 'otro' con texto (${money(otros.reduce((s, r) => s + Number(r.m), 0))})`);

    const mapping = []; // { motivo, cat, n, m }
    for (let i = 0; i < otros.length; i += BATCH) {
      const chunk = otros.slice(i, i + BATCH);
      const cats = await haiku(chunk.map((r) => r.motivo));
      chunk.forEach((r, k) => { if (cats[k] && cats[k] !== 'otro') mapping.push({ motivo: r.motivo, cat: cats[k], n: r.n, m: Number(r.m) }); });
      process.stdout.write(`  · lote ${Math.floor(i / BATCH) + 1}: ${cats.filter((c) => c && c !== 'otro').length}/${chunk.length} clasificados\n`);
    }
    const byCat = {};
    for (const x of mapping) { byCat[x.cat] = byCat[x.cat] || { n: 0, m: 0 }; byCat[x.cat].n += x.n; byCat[x.cat].m += x.m; }
    console.log(`  → ${mapping.length}/${otros.length} motivos reclasificados por LLM:`);
    Object.entries(byCat).sort((a, b) => b[1].m - a[1].m).forEach(([c, v]) => console.log(`      ${c.padEnd(20)} ${String(v.n).padStart(4)}  ${money(v.m)}`));

    // Pasada 2 — blanco por doctype (recuento)
    const blankQ = async (dt) => (await db.query(
      `SELECT count(*)::int n, COALESCE(sum(monto),0) m FROM analytics.erp_purchase_adjustments
        WHERE tenant_id=$1 AND categoria IS NULL AND doctype=$2 AND btrim(COALESCE(motivo,''))=''`, [M, dt])).rows[0];
    const b55 = await blankQ('XD55'), b40 = await blankQ('XD40');
    console.log(`\nPasada 2 (default por doctype): X-D-55 blanco → descuento_comercial (${b55.n}, ${money(b55.m)}) · X-D-40 blanco → devolucion_otra (${b40.n}, ${money(b40.m)})`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply para escribir.'); await db.end(); return; }

    await db.query('BEGIN');
    let n1 = 0;
    for (const x of mapping) {
      const r = await db.query(
        `UPDATE analytics.erp_purchase_adjustments SET categoria=$3, categoria_source='llm'
          WHERE tenant_id=$1 AND categoria='otro' AND motivo=$2`, [M, x.motivo, x.cat]);
      n1 += r.rowCount;
    }
    const u55 = await db.query(
      `UPDATE analytics.erp_purchase_adjustments SET categoria='descuento_comercial', categoria_source='doctype_default'
        WHERE tenant_id=$1 AND categoria IS NULL AND doctype='XD55' AND btrim(COALESCE(motivo,''))=''`, [M]);
    const u40 = await db.query(
      `UPDATE analytics.erp_purchase_adjustments SET categoria='devolucion_otra', categoria_source='doctype_default'
        WHERE tenant_id=$1 AND categoria IS NULL AND doctype='XD40' AND btrim(COALESCE(motivo,''))=''`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — LLM: ${n1} filas · doctype_default: ${u55.rowCount} (X-D-55) + ${u40.rowCount} (X-D-40).`);

    const rest = (await db.query(
      `SELECT count(*)::int n, COALESCE(sum(monto),0) m FROM analytics.erp_purchase_adjustments
        WHERE tenant_id=$1 AND (categoria IS NULL OR categoria='otro')`, [M])).rows[0];
    console.log(`   Tail restante (sin clasificar): ${rest.n} filas / ${money(rest.m)}.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
