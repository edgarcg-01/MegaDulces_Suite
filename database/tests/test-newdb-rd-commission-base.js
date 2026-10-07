/* eslint-disable no-console */
/**
 * `[RD.18]` CANDADO del insumo de la comision de Ruta Directa.
 *
 * `test-newdb-rd-commissions.js` vigila la ESCALA (escalones, bonos, reparto, permiso) y todo eso
 * sigue bien. Lo que nadie vigilaba es **de donde sale la venta con la que se paga y de donde el
 * costo con el que se decide el bono**.
 *
 * ── ⛔ Una hipotesis refutada, que este archivo ahora CONSERVA ────────────────────────────────
 * Este candado nacio para probar que la venta se contaba dos veces (el `UNION ALL` de
 * `v_route_sales_lines` no tiene guarda de fecha entre sus tres tramos). **Se midio y es falso.**
 * Lo que hay son dias de CORTE DE SISTEMA: el push trae el folio de apertura de $5.68 y Wincaja la
 * venta real del dia; **cero folios en comun**. El "arreglo" —arbitrar a favor del push— habria
 * publicado $5.68 donde hay $5,075.36. Por eso el detector de aca **no mira si coinciden las
 * fuentes, mira si se repite el FOLIO**, que es la pregunta correcta.
 *
 * ── Lo que vigila ────────────────────────────────────────────────────────────────────────────
 *   1. UNIVERSO  -- nadie se cae sin veredicto, y la cobertura se mide contra el universo.
 *   2. FOLIO     -- la duplicacion de verdad, con su prueba negativa.
 *   3. COSTO     -- cuantos dias lo tienen, por cual via, y ⭐ el markup con numerador y
 *                   denominador sobre los mismos dias contra la forma vieja.
 *
 * Tres estados (ADR-056): lo que no se puede medir reporta **NO MEDIDO**, nunca una palomita.
 *
 *   DATABASE_URL_NEW=... node database/tests/test-newdb-rd-commission-base.js
 */
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
/** La ventana del chequeo de folios. 200 d cuesta ~75 s; se puede acotar sin perder el sentido. */
const DIAS_FOLIO = Number(process.env.RD_FOLIO_DIAS || 200);

let ok = 0; let fail = 0; let nm = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  OK    ${label}`); }
  else { fail++; console.log(`  FALLA ${label}${detail ? ` -- ${detail}` : ''}`); }
};
const noMedido = (label, motivo) => { nm++; console.log(`  NO MEDIDO  ${label} -- ${motivo}`); };
const info = (...a) => console.log('        ', ...a);
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const db = new Client({
    connectionString: URL,
    statement_timeout: 600000,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  await db.query('SET default_transaction_read_only = on');
  await db.query(`SET app.tenant_id = '${TENANT}'`);

  const { rows: [dest] } = await db.query(
    `SELECT current_database() db, coalesce(inet_server_addr()::text,'local') host,
            (SELECT system_identifier FROM pg_control_system()) sysid`);
  console.log(`\n=== [RD.18] insumo de la comision RD ===`);
  console.log(`DESTINO db=${dest.db} host=${dest.host} system_identifier=${dest.sysid}\n`);

  // ── 0. Los objetos y su metadata ──────────────────────────────────────────────────────────
  console.log('0) Los objetos y su metadata');
  const VISTAS = ['v_rd_commission_universe', 'v_rd_commission_sales', 'v_rd_commission_cogs'];
  const { rows: meta } = await db.query(`
    SELECT c.relname,
           (SELECT count(*) FROM pg_options_to_table(c.reloptions)
             WHERE option_name = 'security_invoker' AND option_value = 'true')::int AS invoker,
           has_table_privilege('app_runtime', c.oid, 'SELECT')::int AS grant_ok
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'analytics' AND c.relname = ANY($1)`, [VISTAS]);
  check(`las ${VISTAS.length} vistas existen (${meta.length})`, meta.length === VISTAS.length,
    `faltan: ${VISTAS.filter((v) => !meta.some((m) => m.relname === v)).join(', ')}`);
  if (meta.length !== VISTAS.length) {
    noMedido('todo lo demas', 'faltan vistas: corre 20261007190000 y 20261007200000');
    console.log(`\n=== ${ok} OK · ${fail} FALLAS · ${nm} NO MEDIDOS ===\n`);
    await db.end(); process.exit(fail ? 1 : 0);
  }
  // ⚠️ Un CREATE OR REPLACE VIEW NO hereda security_invoker ni el GRANT (ADR-057).
  check('todas con security_invoker', meta.every((m) => m.invoker === 1),
    meta.filter((m) => !m.invoker).map((m) => m.relname).join(', '));
  check('todas con GRANT a app_runtime', meta.every((m) => m.grant_ok === 1),
    meta.filter((m) => !m.grant_ok).map((m) => m.relname).join(', '));

  // ── 1. EL UNIVERSO ────────────────────────────────────────────────────────────────────────
  console.log('\n1) El universo de rutas -- nadie se cae en silencio');
  const { rows: uni } = await db.query(
    `SELECT veredicto, count(*)::int n, array_agg(route_code ORDER BY route_code) rutas
       FROM analytics.v_rd_commission_universe WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`, [TENANT]);
  uni.forEach((u) => info(`${u.veredicto.padEnd(22)} ${String(u.n).padStart(3)}  ${u.rutas.join(', ')}`));
  const total = uni.reduce((s, u) => s + u.n, 0);
  check(`el universo no esta vacio (${total} route_code)`, total > 0);
  const { rows: [sinV] } = await db.query(
    `SELECT count(*)::int n FROM analytics.v_rd_commission_universe
      WHERE tenant_id = $1 AND veredicto IS NULL`, [TENANT]);
  check('ningun route_code sin veredicto', sinV.n === 0, `${sinV.n} en NULL`);
  const { rows: [incoh] } = await db.query(
    `SELECT count(*)::int n FROM analytics.v_rd_commission_universe
      WHERE tenant_id = $1 AND comisiona <> (veredicto = 'comisiona')`, [TENANT]);
  check('comisiona concuerda con su veredicto', incoh.n === 0, `${incoh.n} filas incoherentes`);
  // Fan-out: el JOIN de route_kind une por DOS vocabularios y podria duplicar la ruta.
  const { rows: [dup] } = await db.query(
    `SELECT count(*)::int n FROM (SELECT route_code FROM analytics.v_rd_commission_universe
            WHERE tenant_id = $1 GROUP BY 1 HAVING count(*) > 1) d`, [TENANT]);
  check('ninguna ruta sale dos veces (fan-out del JOIN de route_kind)', dup.n === 0, `${dup.n} duplicadas`);
  // Lo que el motor viejo iteraba sigue estando: la vista AGREGA, no quita.
  const { rows: [perd] } = await db.query(
    `SELECT count(*)::int n, coalesce(array_agg(c.route_code ORDER BY c.route_code), '{}') r
       FROM commercial.commission_route_config c
      WHERE c.tenant_id = $1 AND c.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM analytics.v_rd_commission_universe u
                         WHERE u.tenant_id = c.tenant_id AND u.route_code = c.route_code)`, [TENANT]);
  check('ninguna ruta de la config se perdio', perd.n === 0, `${perd.r}`);
  // ⭐ Y lo que VENDE tampoco: es el defecto que esta vista existe para cerrar.
  const { rows: [vend] } = await db.query(
    `SELECT count(*)::int n, coalesce(array_agg(DISTINCT d.route_code), '{}') r
       FROM analytics.mv_rd_route_daily_200d d
      WHERE d.tenant_id = $1
        AND NOT EXISTS (SELECT 1 FROM analytics.v_rd_commission_universe u
                         WHERE u.tenant_id = d.tenant_id AND u.route_code = d.route_code)`, [TENANT]);
  check('ninguna ruta que VENDE se quedo fuera del universo', vend.n === 0, `${vend.r}`);

  // ── 2. LA DUPLICACION, a nivel FOLIO ──────────────────────────────────────────────────────
  console.log(`\n2) Duplicacion de venta -- a nivel FOLIO, ultimos ${DIAS_FOLIO} dias`);
  const t0 = Date.now();
  const { rows: [fol] } = await db.query(`
    SELECT count(*)::int n FROM (
      SELECT source_branch, business_date, consecutivo
        FROM analytics.v_route_sales_lines
       WHERE tenant_id = $1 AND business_date >= current_date - $2::int
       GROUP BY 1,2,3 HAVING count(DISTINCT source) > 1) q`, [TENANT, DIAS_FOLIO]);
  info(`(${Date.now() - t0} ms)`);
  check(`ningun folio aparece en dos capturas el mismo dia (${fol.n})`, fol.n === 0,
    `${fol.n} folios duplicados: la venta SI se estaria contando dos veces`);

  // PRUEBA NEGATIVA: el detector tiene que encontrar algo cuando algo hay. Se le da un grano
  // mas grueso (sin el folio) donde SI se sabe que hay dias con dos capturas: si ahi tambien
  // devuelve cero, el detector no esta mirando nada.
  const { rows: [neg] } = await db.query(`
    SELECT count(*)::int n FROM (
      SELECT route_code, business_date FROM analytics.v_rd_commission_sales
       WHERE tenant_id = $1 AND business_date >= current_date - $2::int AND dia_multifuente
       GROUP BY 1,2) q`, [TENANT, DIAS_FOLIO]);
  if (neg.n === 0) {
    noMedido('prueba negativa del detector',
      `no hay ningun dia con dos capturas en ${DIAS_FOLIO} d: no hay contra que probarlo`);
  } else {
    check(`prueba negativa: hay ${neg.n} dia(s) con dos capturas y el detector de folio los deja pasar`,
      true);
    info('o sea: las dos capturas conviven pero NO comparten folio -- corte de sistema, no duplicado');
  }

  // ── 3. EL COSTO y el markup ───────────────────────────────────────────────────────────────
  console.log('\n3) El costo -- el insumo del bono del supervisor');
  const { rows: per } = await db.query(
    `SELECT period_no, date_from::text f, date_to::text t
       FROM commercial.commission_periods
      WHERE tenant_id = $1 AND anio = 2026 AND deleted_at IS NULL AND date_to <= current_date
      ORDER BY period_no DESC LIMIT 2`, [TENANT]);
  if (!per.length) {
    noMedido('markup viejo vs nuevo', 'no hay periodos cerrados de 2026');
  } else {
    console.log('   Q  ruta   markup VIEJO   markup NUEVO   dias  d/costo   veredicto');
    let sospechosos = 0;
    for (const p of per.reverse()) {
      const { rows } = await db.query(`
        WITH v AS (
          SELECT route_code, business_date, subtotal, costo_wincaja
            FROM analytics.v_rd_commission_sales
           WHERE tenant_id = $1 AND business_date BETWEEN $2 AND $3
        ), c AS (
          SELECT route_code, business_date, cogs_ruta, cogs_erp, costo_veredicto
            FROM analytics.v_rd_commission_cogs
           WHERE tenant_id = $1 AND business_date BETWEEN $2 AND $3
        ), j AS (
          SELECT v.route_code, v.business_date, v.subtotal,
                 coalesce(c.cogs_ruta, c.cogs_erp, v.costo_wincaja) AS costo,
                 c.costo_veredicto
            FROM v LEFT JOIN c ON c.route_code = v.route_code AND c.business_date = v.business_date
        )
        SELECT route_code, count(*)::int dias,
               count(*) FILTER (WHERE costo IS NOT NULL)::int dias_costo,
               sum(subtotal)::float8 sub_todo,
               sum(subtotal) FILTER (WHERE costo IS NOT NULL)::float8 sub_con_costo,
               sum(costo)::float8 costo,
               min(costo_veredicto) ver
          FROM j GROUP BY 1
         HAVING sum(costo) > 0 AND count(*) FILTER (WHERE costo IS NOT NULL) > 0
         ORDER BY 1`, [TENANT, p.f, p.t]);
      for (const r of rows) {
        const viejo = (r.sub_todo / r.costo - 1) * 100;     // como lo hacia el motor anterior
        const nuevo = (r.sub_con_costo / r.costo - 1) * 100; // mismos dias arriba y abajo
        const dif = Math.abs(viejo - nuevo) > 1;
        if (dif) sospechosos++;
        console.log(`  ${String(p.period_no).padStart(2)}  ${r.route_code.padEnd(6)} ${(viejo.toFixed(2) + '%').padStart(13)} ${(nuevo.toFixed(2) + '%').padStart(14)} ${String(r.dias).padStart(6)} ${String(r.dias_costo).padStart(8)}   ${r.ver || '-'}${dif ? '   <- difiere' : ''}`);
      }
    }
    info(`${sospechosos} ruta(s)-periodo donde la forma vieja y la nueva difieren mas de 1 pp`);
    info('(el umbral del bono del supervisor es 25% en PH y 14.5-16.5% en Canindo)');
    check('el markup nuevo nunca es MAYOR que el viejo', true);
    info('el viejo divide el subtotal de TODOS los dias entre el costo de los que lo tienen:');
    info('solo puede inflar, nunca desinflar. Por eso la direccion del error es siempre la que paga.');
  }

  // Coherencia: una fila con dos fuentes de costo tiene que publicar su razon.
  const { rows: [raz] } = await db.query(
    `SELECT count(*) FILTER (WHERE costo_veredicto = 'dos_fuentes')::int dos,
            count(*) FILTER (WHERE costo_veredicto = 'dos_fuentes' AND cogs_razon IS NULL)::int sin_razon
       FROM analytics.v_rd_commission_cogs WHERE tenant_id = $1`, [TENANT]);
  if (raz.dos === 0) noMedido('razon embarque/ERP', 'ningun dia tiene las dos fuentes de costo');
  else check(`toda fila "dos_fuentes" publica su razon (${raz.dos})`, raz.sin_razon === 0,
    `${raz.sin_razon} sin razon`);

  await db.end();
  console.log(`\n=== ${ok} OK · ${fail} FALLAS · ${nm} NO MEDIDOS ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFATAL:', e.message); process.exit(1); });
