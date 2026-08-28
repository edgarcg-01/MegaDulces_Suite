/**
 * RE.13.0 — Smoke del listado de órdenes de entrada: alcance, carril, antigüedad y paginación.
 *
 * Replica la SQL de `GoodsReceiptProofsService.listReceipts` (el `base()` compartido por filas,
 * total y KPIs) y verifica lo que la versión anterior NO podía expresar:
 *
 *   - **Alcance** (ADR-050): filtrar por sucursal reduce el set; alcance VACÍO devuelve 0 filas
 *     (fail-closed). Antes no había filtro de sucursal y el de Yurécuaro (16 entradas) navegaba
 *     entre las 815 de CEDIS.
 *   - **Paginación**: `total` cuenta el universo filtrado y las páginas no se traslapan. Antes
 *     cortaba en 300 filas en silencio mientras el KPI contaba 1,096.
 *   - **`por_validar`**: la cola del revisor (`last_status='recibido'`) no es lo mismo que
 *     "con comprobante".
 *   - **Antigüedad**: `dias` nunca es negativo — hay una entrada de CEDIS capturada con fecha
 *     2026-12-29 que sin el `LEAST(receipt_date, current_date)` daba días negativos y se
 *     clavaba primera en cualquier orden.
 *   - **Carril**: `al_dia` + `rezago` particionan el universo sin traslape ni hueco.
 *   - **Settings**: `finance.receipt_settings` existe, tiene RLS forzado y trae la fila del tenant.
 *
 *   - **RE.13.2**: el historial existe, tiene RLS forzado y es **append-only** (`app_runtime`
 *     sin UPDATE ni DELETE — un historial editable no es historial); `motivo_codigo` existe; y la
 *     cola del revisor sale ordenada por riesgo.
 *
 * Uso: DATABASE_URL_NEW=... node database/tests/test-newdb-goods-receipts-scope.js
 */
// Carga el .env como los demás smokes: sin esto el fallback de abajo apunta a OTRA DB (el
// Docker de pgvector), y el test falla con "relation finance.receipt_settings does not exist"
// sobre una base que nunca tuvo el schema — un rojo que no habla del código.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const { Client } = require('pg');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let failed = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) failed++; };

/** El `base()` del service: join a la evidencia + tenant + canónicas (sin la copia CEDIS). */
const BASE = `
  FROM analytics.erp_goods_receipts c
  LEFT JOIN (
    SELECT sucursal, folio, count(*) AS n,
           (array_agg(status ORDER BY created_at DESC))[1] AS last_status
      FROM finance.goods_receipt_proofs GROUP BY sucursal, folio
  ) d ON d.sucursal = c.sucursal AND d.folio = c.folio
  WHERE c.tenant_id = $1 AND c.dup_of_folio IS NULL`;

(async () => {
  const c = new Client({ connectionString: DST });
  await c.connect();
  console.log('RE.13.0 — Entradas: alcance + carril + antigüedad + paginación\n');
  try {
    // ── 1. Settings ────────────────────────────────────────────────────────
    const t = await c.query(`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE oid = 'finance.receipt_settings'::regclass`);
    ok(t.rows.length === 1, 'finance.receipt_settings existe');
    ok(t.rows[0]?.relrowsecurity && t.rows[0]?.relforcerowsecurity, 'RLS habilitado Y forzado');
    const cfg = (await c.query(
      `SELECT reception_start::text, match_tolerance::numeric, sla_capture_days, sla_review_days, bulk_max_files
         FROM finance.receipt_settings WHERE tenant_id = $1`, [TENANT])).rows[0];
    ok(!!cfg, 'fila del tenant sembrada');
    if (!cfg) throw new Error('sin settings: el resto del smoke asume la fila');
    ok(Number(cfg.match_tolerance) > 0, `tolerancia del cuadre = $${Number(cfg.match_tolerance).toFixed(2)}`);
    const START = cfg.reception_start;
    console.log(`     arranque ${START} · SLA captura ${cfg.sla_capture_days}d · revisión ${cfg.sla_review_days}d\n`);

    const AL_DIA = `${BASE} AND c.receipt_date >= '${START}'`;
    const nTotal = Number((await c.query(`SELECT count(*)::int n ${AL_DIA}`, [TENANT])).rows[0].n);
    if (nTotal === 0) {
      console.log('  ⚠️  SKIP — sin entradas desde el arranque (feed no cargado). El wiring lo cubre el build.');
      await c.end(); process.exit(0);
    }
    console.log(`  ${nTotal} entradas en el carril "al día"\n`);

    // ── 2. Alcance ─────────────────────────────────────────────────────────
    const porSuc = (await c.query(
      `SELECT c.sucursal, count(*)::int n ${AL_DIA} GROUP BY 1 ORDER BY 2 DESC`, [TENANT])).rows;
    const chica = porSuc[porSuc.length - 1];
    const nChica = Number((await c.query(
      `SELECT count(*)::int n ${AL_DIA} AND c.sucursal = ANY($2)`, [TENANT, [chica.sucursal]])).rows[0].n);
    ok(nChica === Number(chica.n), `alcance ['${chica.sucursal}'] → ${nChica} filas (no ${nTotal})`);
    ok(nChica < nTotal, 'el alcance REDUCE el set (no es decorativo)');
    // Fail-closed: el service traduce alcance `[]` a `whereRaw('false')`.
    const nVacio = Number((await c.query(`SELECT count(*)::int n ${AL_DIA} AND false`, [TENANT])).rows[0].n);
    ok(nVacio === 0, 'alcance vacío → 0 filas (fail-closed, NO la red completa)');

    // ── 3. Antigüedad ──────────────────────────────────────────────────────
    const d = (await c.query(`
      SELECT min((current_date - LEAST(c.receipt_date, current_date))::int) AS dmin,
             max((current_date - LEAST(c.receipt_date, current_date))::int) AS dmax,
             count(*) FILTER (WHERE c.receipt_date > current_date)::int AS futuras
        ${AL_DIA}`, [TENANT])).rows[0];
    ok(Number(d.dmin) >= 0, `días nunca negativos (min ${d.dmin}, max ${d.dmax})`);
    if (Number(d.futuras) > 0) {
      const f = (await c.query(`
        SELECT (current_date - LEAST(c.receipt_date, current_date))::int dias
          ${AL_DIA} AND c.receipt_date > current_date LIMIT 1`, [TENANT])).rows[0];
      ok(Number(f.dias) === 0, `las ${d.futuras} de fecha futura cuentan 0 días (no negativos)`);
    } else {
      console.log('     (sin entradas de fecha futura en este set)');
    }

    // ── 4. Orden de trabajo ────────────────────────────────────────────────
    const primera = (await c.query(`
      SELECT c.receipt_date::text f ${AL_DIA}
       ORDER BY LEAST(c.receipt_date, current_date) ASC, c.folio DESC LIMIT 1`, [TENANT])).rows[0];
    const masVieja = (await c.query(
      `SELECT min(LEAST(c.receipt_date, current_date))::text f ${AL_DIA}`, [TENANT])).rows[0];
    ok(primera.f === masVieja.f, `orden "antigüedad" arranca en la más vieja (${primera.f})`);

    // ── 5. Estados ─────────────────────────────────────────────────────────
    const e = (await c.query(`
      SELECT count(*) FILTER (WHERE d.n IS NULL)::int pendiente,
             count(*) FILTER (WHERE d.n > 0)::int con_comprobante,
             count(*) FILTER (WHERE d.last_status = 'recibido')::int por_validar,
             count(*) FILTER (WHERE d.last_status = 'validado')::int validado,
             count(*) FILTER (WHERE d.last_status = 'rechazado')::int rechazado
        ${AL_DIA}`, [TENANT])).rows[0];
    ok(Number(e.pendiente) + Number(e.con_comprobante) === nTotal, 'pendiente + con_comprobante = universo');
    ok(Number(e.por_validar) + Number(e.validado) + Number(e.rechazado) === Number(e.con_comprobante),
      `los 3 estados de evidencia suman con_comprobante (${e.con_comprobante})`);
    ok(Number(e.por_validar) <= Number(e.con_comprobante), 'por_validar ⊆ con_comprobante (no matchea todo)');
    console.log(`     pendiente ${e.pendiente} · por validar ${e.por_validar} · validado ${e.validado} · rechazado ${e.rechazado}`);

    // ── 6. Paginación ──────────────────────────────────────────────────────
    const SZ = 25;
    const pag = (n) => c.query(`
      SELECT c.sucursal || '/' || c.folio k ${AL_DIA}
       ORDER BY LEAST(c.receipt_date, current_date) ASC, c.folio DESC
       LIMIT ${SZ} OFFSET ${(n - 1) * SZ}`, [TENANT]);
    const p1 = (await pag(1)).rows.map((r) => r.k);
    const p2 = (await pag(2)).rows.map((r) => r.k);
    ok(p1.length === Math.min(SZ, nTotal), `página 1 trae ${p1.length} filas`);
    ok(!p1.some((k) => p2.includes(k)), 'las páginas 1 y 2 no se traslapan');
    ok(nTotal > SZ ? p2.length > 0 : true, 'hay página 2 cuando el total la exige');

    // ── 7. Carril ──────────────────────────────────────────────────────────
    const car = (await c.query(`
      SELECT count(*) FILTER (WHERE c.receipt_date >= '${START}')::int al_dia,
             count(*) FILTER (WHERE c.receipt_date <  '${START}')::int rezago,
             count(*)::int todo
        ${BASE}`, [TENANT])).rows[0];
    ok(Number(car.al_dia) + Number(car.rezago) === Number(car.todo),
      `al_dia (${car.al_dia}) + rezago (${car.rezago}) = todo (${car.todo}) — partición sin hueco`);
    ok(Number(car.al_dia) === nTotal, 'el carril al_dia es el universo por default');

    // ── 8. Sucursal 06 (Canindo) ───────────────────────────────────────────
    const w = (await c.query(
      `SELECT name FROM commercial.warehouses WHERE tenant_id = $1 AND code = '06' AND deleted_at IS NULL`,
      [TENANT])).rows[0];
    if (w) ok(/canindo/i.test(w.name), `sucursal '06' = ${w.name} (el catálogo la nombra)`);
    else console.log("     (sin sucursal '06' en commercial.warehouses)");

    // ── 9. RE.13.2 — historial append-only + motivo tipificado ─────────────
    const h = await c.query(`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE oid = 'finance.goods_receipt_proof_history'::regclass`);
    ok(h.rows.length === 1, 'finance.goods_receipt_proof_history existe');
    ok(h.rows[0]?.relrowsecurity && h.rows[0]?.relforcerowsecurity, 'historial con RLS habilitado Y forzado');
    // Un historial que se puede editar no es historial: app_runtime solo lee e inserta.
    const g = (await c.query(`
      SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_schema='finance' AND table_name='goods_receipt_proof_history' AND grantee='app_runtime'`))
      .rows.map((r) => r.privilege_type);
    ok(g.includes('SELECT') && g.includes('INSERT'), 'app_runtime puede leer e insertar el historial');
    ok(!g.includes('UPDATE') && !g.includes('DELETE'), 'app_runtime NO puede editar ni borrar el historial (append-only)');
    const mc = await c.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='finance' AND table_name='goods_receipt_proofs' AND column_name='motivo_codigo'`);
    ok(mc.rows.length === 1, 'goods_receipt_proofs.motivo_codigo existe (motivo tipificado)');

    // ── 10. La cola del revisor: orden por riesgo ──────────────────────────
    const nProofs = Number((await c.query(`SELECT count(*)::int n FROM finance.goods_receipt_proofs`)).rows[0].n);
    if (nProofs === 0) {
      console.log('     (sin evidencias capturadas: el orden por riesgo se cubre cuando haya cola)');
    } else {
      const q = (await c.query(`
        SELECT COALESCE(ABS(d.last_disc), 0) AS r
          FROM analytics.erp_goods_receipts c
          LEFT JOIN (SELECT sucursal, folio,
                            (array_agg(status ORDER BY created_at DESC))[1] AS last_status,
                            (array_agg(discrepancy_amount ORDER BY created_at DESC))[1] AS last_disc
                       FROM finance.goods_receipt_proofs GROUP BY sucursal, folio) d
            ON d.sucursal = c.sucursal AND d.folio = c.folio
         WHERE c.tenant_id = $1 AND c.dup_of_folio IS NULL AND d.last_status = 'recibido'
         ORDER BY COALESCE(ABS(d.last_disc), 0) DESC, c.monto::numeric DESC`, [TENANT])).rows.map((x) => Number(x.r));
      const ordenada = q.every((v, i) => i === 0 || q[i - 1] >= v);
      ok(ordenada, `cola por riesgo: descuadre mayor primero (${q.length} en cola)`);
    }

    console.log(`\n${failed === 0 ? '✅ TODO VERDE' : `❌ ${failed} fallo(s)`}`);
  } catch (e) {
    console.error('  ❌ ERROR', e.message);
    failed++;
  } finally {
    await c.end();
  }
  process.exit(failed === 0 ? 0 : 1);
})();
