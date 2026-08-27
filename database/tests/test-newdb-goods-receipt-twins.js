/**
 * RE.14 — Smoke de los **pares sucursal ↔ oficinas**: la misma recepción capturada dos veces.
 *
 * Lo que este archivo protege es una afirmación sobre dinero: **ocultar la copia de oficinas
 * dice que esa compra no existe**. Si el apareo se equivoca, o si un par dudoso oculta por su
 * cuenta, desaparece una compra real de los reportes. Entonces se verifica que:
 *
 *   1. sólo los pares VIGENTES (`auto`/`confirmado`) ocultan; `propuesto` y `rechazado` NO;
 *   2. el par es 1:1 — nadie puede colgar dos copias vivas de la misma canónica;
 *   3. lo que se aplicó solo tiene con qué defenderse (score ≥ 0.75) y lo dudoso quedó esperando;
 *   4. los denormalizados (Δ importe/días) coinciden con los dos lados que dicen describir;
 *   5. **buscar por el folio de oficinas encuentra la orden de la sucursal** — el requisito
 *      operativo: el usuario llega con el folio que tiene en la mano, no con el nuestro.
 *
 * Las pruebas que escriben corren dentro de UNA TRANSACCIÓN CON ROLLBACK.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-goods-receipt-twins.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const one = async (sql, p = []) => (await knex.raw(sql, p)).rows[0];

(async () => {
  console.log('\nRE.14 — pares sucursal ↔ oficinas (la misma recepción capturada dos veces)\n');

  // ── 0. La tabla trae lo de RE.14 ─────────────────────────────────────────
  const cols = await one(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_schema='analytics' AND table_name='erp_goods_receipt_dedup'
        AND column_name IN ('status','match_rule','match_score','suc_monto','cedis_monto','suc_prov','cedis_prov','delta_monto','delta_dias','decided_by')`);
  ok(cols.n === 10, `la tabla de pares tiene las 10 columnas de RE.14 (${cols.n})`);
  const chk = await one(
    `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='chk_grd_status'`);
  ok(!!chk && ['propuesto', 'auto', 'confirmado', 'rechazado'].every((s) => chk.d.includes(s)),
    'el CHECK de status admite los 4 estados y sólo esos');

  const tot = await one(
    `SELECT count(*)::int n,
            count(*) FILTER (WHERE status IN ('auto','confirmado'))::int vigentes,
            count(*) FILTER (WHERE status='propuesto')::int propuestos
       FROM analytics.erp_goods_receipt_dedup WHERE tenant_id=?`, [T]);
  if (!tot.n) { console.log('  SKIP sin pares detectados — corré detect-goods-receipt-duplicates.js --apply'); process.exit(0); }
  console.log(`  (${tot.n} pares: ${tot.vigentes} vigentes · ${tot.propuestos} por dictaminar)\n`);

  // ── 1. Sólo lo vigente oculta ────────────────────────────────────────────
  const vis = await one(
    `SELECT count(*)::int ocultas_en_vista FROM analytics.erp_goods_receipts
      WHERE tenant_id=? AND sucursal='00' AND dup_of_folio IS NOT NULL`, [T]);
  ok(vis.ocultas_en_vista === tot.vigentes,
    `la vista marca exactamente los pares vigentes (${vis.ocultas_en_vista} = ${tot.vigentes})`);
  const props = await one(
    `SELECT count(*)::int n FROM analytics.erp_goods_receipts c
       JOIN analytics.erp_goods_receipt_dedup d ON d.tenant_id=c.tenant_id AND d.cedis_folio=c.folio
      WHERE c.tenant_id=? AND c.sucursal='00' AND d.status='propuesto' AND c.dup_of_folio IS NOT NULL`, [T]);
  ok(props.n === 0, 'una propuesta sin dictaminar NO oculta la fila de oficinas (sigue contable)');

  // ── 2. El par es 1:1 ─────────────────────────────────────────────────────
  const dupCan = await one(
    `SELECT count(*)::int n FROM (
       SELECT dup_of_sucursal, dup_of_folio FROM analytics.erp_goods_receipt_dedup
        WHERE tenant_id=? AND status IN ('auto','confirmado') AND dup_of_folio IS NOT NULL
        GROUP BY 1,2 HAVING count(*) > 1) x`, [T]);
  ok(dupCan.n === 0, 'ninguna canónica tiene dos copias de oficinas vigentes (índice único parcial)');

  // ── 3. Lo automático se puede defender; lo dudoso espera ─────────────────
  const flojo = await one(
    `SELECT count(*)::int n FROM analytics.erp_goods_receipt_dedup
      WHERE tenant_id=? AND status='auto' AND COALESCE(match_score, 0) < 0.75`, [T]);
  ok(flojo.n === 0, 'nada se aplicó solo con score < 0.75');
  const sugeridas = await one(
    `SELECT count(*)::int n FROM analytics.erp_goods_receipt_dedup
      WHERE tenant_id=? AND match_rule='sugerida' AND status='auto'`, [T]);
  ok(sugeridas.n === 0, `la regla más floja (mismo importe, otro proveedor) nunca se aplica sola`);

  // ── 4. Los denormalizados describen lo que dicen describir ───────────────
  const deltas = await one(
    `SELECT count(*)::int n FROM analytics.erp_goods_receipt_dedup
      WHERE tenant_id=? AND cedis_monto IS NOT NULL AND suc_monto IS NOT NULL
        AND round(cedis_monto - suc_monto, 2) <> round(COALESCE(delta_monto, 0), 2)`, [T]);
  ok(deltas.n === 0, 'delta_monto = importe de oficinas − importe de la sucursal, en todas las filas');
  const contraVista = await one(
    `SELECT count(*)::int n FROM analytics.erp_goods_receipt_dedup d
       JOIN analytics.erp_goods_receipts s
         ON s.tenant_id=d.tenant_id AND s.sucursal=d.dup_of_sucursal AND s.folio=d.dup_of_folio
      WHERE d.tenant_id=? AND d.suc_monto IS NOT NULL AND round(s.monto,2) <> round(d.suc_monto,2)`, [T]);
  ok(contraVista.n === 0, 'el importe denormalizado de la canónica coincide con la vista viva');

  // ── 5. Buscar por el folio de OFICINAS encuentra la orden de la sucursal ──
  const par = await one(
    `SELECT cedis_folio, dup_of_sucursal suc, dup_of_folio folio FROM analytics.erp_goods_receipt_dedup
      WHERE tenant_id=? AND status IN ('auto','confirmado') AND dup_of_folio IS NOT NULL LIMIT 1`, [T]);
  const suf = String(par.cedis_folio).replace(/\D/g, '').slice(-4);
  // Réplica del predicado del service (últimos 4 dígitos sobre el folio de oficinas).
  const hallada = await knex.raw(
    `SELECT c.sucursal, c.folio FROM analytics.erp_goods_receipts c
       LEFT JOIN analytics.erp_goods_receipt_dedup gem
         ON gem.tenant_id=c.tenant_id AND gem.dup_of_sucursal=c.sucursal AND gem.dup_of_folio=c.folio
        AND gem.status IN ('auto','confirmado')
      WHERE c.tenant_id=? AND c.dup_of_folio IS NULL
        AND right(regexp_replace(gem.cedis_folio, '\\D', '', 'g'), 4) = ?`, [T, suf]);
  ok(hallada.rows.some((r) => r.sucursal === par.suc && r.folio === par.folio),
    `buscando "${suf}" (folio de oficinas) aparece la canónica ${par.suc}/${par.folio}`);

  // ── 6. El dictamen humano cambia lo que se cuenta (transacción + ROLLBACK) ─
  await knex.transaction(async (trx) => {
    const antes = (await trx.raw(
      `SELECT count(*)::int n FROM analytics.erp_goods_receipts
        WHERE tenant_id=? AND sucursal='00' AND folio=? AND dup_of_folio IS NOT NULL`,
      [T, par.cedis_folio])).rows[0];
    ok(antes.n === 1, 'punto de partida: el par está vigente y la copia de oficinas está oculta');

    await trx('analytics.erp_goods_receipt_dedup')
      .where({ tenant_id: T, cedis_folio: par.cedis_folio })
      .update({ status: 'rechazado', decided_by: 'revisor_test', decided_at: trx.fn.now() });
    const rech = (await trx.raw(
      `SELECT dup_of_folio FROM analytics.erp_goods_receipts
        WHERE tenant_id=? AND sucursal='00' AND folio=?`, [T, par.cedis_folio])).rows[0];
    ok(rech && rech.dup_of_folio === null,
      'al rechazar el par, la fila de oficinas vuelve a ser visible y contable (no es espejo)');

    await trx('analytics.erp_goods_receipt_dedup')
      .where({ tenant_id: T, cedis_folio: par.cedis_folio })
      .update({ status: 'confirmado' });
    const conf = (await trx.raw(
      `SELECT dup_of_folio FROM analytics.erp_goods_receipts
        WHERE tenant_id=? AND sucursal='00' AND folio=?`, [T, par.cedis_folio])).rows[0];
    ok(conf && conf.dup_of_folio === par.folio, 'al confirmarlo vuelve a apuntar a su canónica');

    // El índice único parcial es la última línea contra el doble apareo: dos copias vivas sobre
    // la misma canónica harían que "el importe de oficinas" fuera ambiguo justo en el cuadre.
    let choco = false;
    try {
      await trx('analytics.erp_goods_receipt_dedup').insert({
        tenant_id: T, cedis_folio: `${par.cedis_folio}-X`,
        dup_of_sucursal: par.suc, dup_of_folio: par.folio, status: 'auto', match_rule: 'manual', match_score: 1,
      });
    } catch (e) { choco = /ux_grd_canonica_viva|duplicate key/i.test(e.message); }
    ok(choco, 'la DB rechaza una segunda copia vigente sobre la misma canónica');

    throw new Error('ROLLBACK_INTENCIONAL');
  }).catch((e) => { if (e.message !== 'ROLLBACK_INTENCIONAL') throw e; });

  const limpio = await one(
    `SELECT count(*)::int n FROM analytics.erp_goods_receipt_dedup
      WHERE tenant_id=? AND decided_by='revisor_test'`, [T]);
  ok(limpio.n === 0, 'el ROLLBACK no dejó dictámenes de prueba en la tabla');

  console.log(fail ? `\n❌ ${fail} aserción(es) fallaron\n` : '\n✅ Todo verde\n');
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('ERROR', e.message); await knex.destroy(); process.exit(1); });
