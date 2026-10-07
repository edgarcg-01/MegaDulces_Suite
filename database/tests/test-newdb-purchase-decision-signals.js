/**
 * `[RA-DYN.U1]` — **La vista que une el pedido con el motor de margen no contradice al ERP.**
 *
 * `analytics.v_purchase_decision_signals` trae a la mesa del comprador las 16 señales que ya
 * estaban medidas y publicadas en `/comercial/precios/motor` y que `/compras/pedido` no miraba.
 * Lo que este candado vigila NO es que las traiga —eso lo dice el `SELECT`— sino las tres
 * maneras en que traerlas puede empeorar las cosas:
 *
 *   1. **Que se cuele una existencia rezagada.** `mv_price_signals` publica `e3_existencia` y
 *      `e1_dias_cobertura`, y están viejas: medido el 2026-10-01, para el SKU 88022 en Morelia
 *      Madero dice 83 PAQ donde el ERP dice 36, y 133 días de cobertura donde el pedido dice 3.
 *      La vista debe negarse a traerlas, y el bloque [2] lo comprueba **contra el árbitro**
 *      (`analytics.v_erp_stock_on_hand`), no contra sí misma.
 *   2. **Que una ausencia se lea como un cero.** Una fila sin señales llega NULL a un LEFT JOIN
 *      y parece sana. `senales_sin_dato` es lo que impide esa lectura, y tiene que poblarse de
 *      verdad (ADR-056: lo que no se midió se declara).
 *   3. **Que se pierda el `security_invoker`** en un `CREATE OR REPLACE` posterior, con lo que
 *      la vista empezaría a leer saltándose el RLS de `replenishment_plan`.
 *
 * ⛔ Mientras esto no esté verde, la vista no se cablea a la pantalla.
 *
 * Uso: DATABASE_URL_NEW=<destino> node database/tests/test-newdb-purchase-decision-signals.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
let noMedido = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nm = (m) => { console.log(`  ⚠️  NO MEDIDO — ${m}`); noMedido++; };

(async () => {
  try {
    const vista = (await knex.raw(
      `SELECT to_regclass('analytics.v_purchase_decision_signals') AS t`)).rows[0]?.t;
    if (!vista) {
      nm('la vista no existe (¿migración 20261002150000 pendiente?)');
      console.log('\n⚠️  señales del pedido: NO MEDIDO');
      process.exit(2);
    }

    console.log('\n[1] Forma: la vista cubre el universo del pedido, celda por celda');
    const { rows: [f] } = await knex.raw(`
      SELECT (SELECT count(*) FROM analytics.replenishment_plan WHERE tenant_id = ?)::int AS plan,
             (SELECT count(*) FROM analytics.v_purchase_decision_signals WHERE tenant_id = ?)::int AS vista`,
    [T, T]);
    ok(f.vista === f.plan,
      `una fila por celda del plan: vista ${f.vista} = plan ${f.plan}`);
    ok(f.plan > 0, `el plan no está vacío (${f.plan} celdas)`);

    console.log('\n[2] El árbitro: la existencia la manda el ERP, no la matvista de precios');
    // ⭐ El cruce es contra una implementación DISTINTA (la vista del ODS), no contra la propia.
    const { rows: cols } = await knex.raw(`
      SELECT a.attname FROM pg_attribute a
        JOIN pg_class t ON t.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'analytics' AND t.relname = 'v_purchase_decision_signals' AND a.attnum > 0`);
    const nombres = cols.map((c) => c.attname);
    const colada = nombres.filter((c) => /existencia|cobertura_dias|estado_inventario/.test(c));
    ok(colada.length === 0,
      `la vista NO publica existencia ni cobertura propias${colada.length ? ` (coladas: ${colada.join(', ')})` : ''}`);

    // PRUEBA NEGATIVA: la razón por la que se excluyen tiene que SEGUIR siendo cierta. Si algún
    // día la matvista se pusiera al día, este bloque se cae y hay que revisar la decisión —
    // justamente lo que queremos que pase, en vez de arrastrar una exclusión por inercia.
    const { rows: [drift] } = await knex.raw(`
      SELECT count(*)::int celdas,
             count(*) FILTER (WHERE ps.e3_existencia IS DISTINCT FROM erp.qty_stock_units)::int difieren,
             max(abs(ps.e3_existencia - erp.qty_stock_units))::numeric peor
        FROM analytics.v_erp_stock_on_hand erp
        JOIN commercial.warehouses w ON w.id = erp.warehouse_id AND w.tenant_id = erp.tenant_id
        JOIN analytics.mv_price_signals ps ON ps.sucursal = w.code AND ps.sku = erp.sku
       WHERE erp.tenant_id = ? AND ps.e3_existencia IS NOT NULL`, [T]);
    if (!drift || drift.celdas === 0) {
      nm('no hay celdas comparables entre el ERP y la matvista de precios');
    } else {
      ok(drift.difieren > 0,
        `la exclusión sigue justificada: ${drift.difieren} de ${drift.celdas} celdas difieren ` +
        `del ERP (peor caso ${drift.peor})`);
    }

    console.log('\n[3] Declarar, nunca dibujar un cero');
    const { rows: [dec] } = await knex.raw(`
      SELECT count(*)::int total,
             count(*) FILTER (WHERE cardinality(senales_sin_dato) > 0)::int con_hueco,
             count(DISTINCT cardinality(senales_sin_dato))::int formas,
             count(*) FILTER (WHERE costo_fuente = 'sin_dato')::int sin_costo,
             count(*) FILTER (WHERE costo_dispersion_veredicto = 'una_sola_plaza')::int una_plaza,
             count(*) FILTER (WHERE costo_dispersion_pct IS NOT NULL)::int con_dispersion
        FROM analytics.v_purchase_decision_signals WHERE tenant_id = ?`, [T]);
    ok(dec.con_hueco > 0,
      `las ausencias se enumeran: ${dec.con_hueco} de ${dec.total} celdas declaran algún hueco`);
    // ⭐ Que TODAS declaren hueco no prueba nada: hoy `fill_rate` y `dias_de_credito` faltan en el
    // 100% (0 de 1,318 proveedores los tienen), así que un array constante pasaría este bloque sin
    // medir nada por fila. Lo que se exige es que VARÍE — o sea que sea una declaración por celda
    // y no una leyenda fija.
    ok(dec.formas > 1,
      `y la declaración es POR CELDA, no una leyenda fija: ${dec.formas} tamaños distintos de hueco`);
    // PRUEBA NEGATIVA: una plaza sola NO puede publicarse como dispersión 0%.
    const { rows: [falso] } = await knex.raw(`
      SELECT count(*)::int n FROM analytics.v_purchase_decision_signals
       WHERE tenant_id = ? AND costo_dispersion_veredicto <> 'medida'
         AND costo_dispersion_pct IS NOT NULL`, [T]);
    ok(falso.n === 0,
      `ninguna celda sin comparación publica un porcentaje de dispersión (${falso.n})`);
    ok(dec.con_dispersion > 0,
      `y donde SÍ se puede comparar, se publica: ${dec.con_dispersion} celdas con dispersión medida`);

    console.log('\n[4] Las señales que justifican la fase llegan con cifra');
    const { rows: [s] } = await knex.raw(`
      SELECT count(*) FILTER (WHERE costo_deriva_pct > 5)::int sube5,
             count(*) FILTER (WHERE costo_deriva_pct > 15)::int sube15,
             count(*) FILTER (WHERE min_order_boxes IS NOT NULL)::int con_minimo,
             count(*) FILTER (WHERE canasta_lift IS NOT NULL)::int con_canasta,
             count(*) FILTER (WHERE faltantes_reportados > 0)::int con_faltante
        FROM analytics.v_purchase_decision_signals WHERE tenant_id = ?`, [T]);
    ok(s.sube5 > 0, `deriva del costo: ${s.sube5} celdas suben más de 5% (${s.sube15} más de 15%)`);
    ok(s.con_minimo > 0, `mínimo de pedido presente en ${s.con_minimo} celdas`);
    ok(s.con_canasta > 0, `efecto canasta presente en ${s.con_canasta} celdas`);
    if (s.con_faltante === 0) nm('ninguna celda con faltante de mostrador reportado');
    else ok(true, `faltantes del mostrador: ${s.con_faltante} celdas`);

    console.log('\n[5] El permiso y el RLS no se perdieron');
    const { rows: opts } = await knex.raw(`
      SELECT unnest(c.reloptions) AS o FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'analytics' AND c.relname = 'v_purchase_decision_signals'`);
    ok(opts.some((x) => String(x.o).includes('security_invoker=true')),
      'la vista conserva security_invoker (si no, leería saltándose el RLS)');
    const { rows: [g] } = await knex.raw(
      `SELECT has_table_privilege('app_runtime','analytics.v_purchase_decision_signals','SELECT') AS ok`);
    ok(g.ok === true, 'app_runtime conserva el SELECT');

    console.log('\n[6] Presupuesto de tiempo: la pantalla ya corre contra un gate de 1 s');
    const t0 = Date.now();
    await knex.raw(`
      SELECT * FROM analytics.v_purchase_decision_signals
       WHERE tenant_id = ? AND warehouse_code = '07' LIMIT 50`, [T]);
    const msPagina = Date.now() - t0;
    const t1 = Date.now();
    await knex.raw(`
      SELECT * FROM analytics.v_purchase_decision_signals WHERE tenant_id = ? AND sku = '88022'`, [T]);
    const msFicha = Date.now() - t1;
    ok(msPagina < 1000, `una página de 50 renglones: ${msPagina} ms`);
    ok(msFicha < 1000, `la ficha de un SKU en sus plazas: ${msFicha} ms`);

    console.log(
      fail ? `\n❌ señales del pedido: ${fail} falla(s)` : `\n✅ señales del pedido: todo verde`
      + (noMedido ? ` · ${noMedido} NO MEDIDO` : ''));
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\n❌ ERROR:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
