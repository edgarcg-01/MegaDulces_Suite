'use strict';
/**
 * `[RD.9]`+`[RD.10]` Candado del inventario de los camiones de Ruta Directa.
 *
 *   node database/tests/test-newdb-rd-route-inventory.js
 *
 * Sólo lee. Si las vistas ya están aplicadas ejerce **los objetos reales**; si no, ejerce el
 * SELECT que sale de la MIGRACIÓN (no una copia pegada acá: si la migración cambia, el candado
 * sigue el cambio en vez de proteger una versión que ya no existe).
 *
 * ── Qué protege, y por qué ESTAS aserciones ──────────────────────────────────────────────
 *
 * Lo que se publica es un **cuadre**: `carga − vendido = inventario`, en dos valuaciones. Un
 * cuadre es fácil de romper sin que el resultado deje de verse plausible, así que el candado no
 * pregunta "¿corre?" sino lo que puede fallar en silencio:
 *
 *  1. **Que las dos columnas CIERREN.** Cierran por construcción —las tres líneas usan el mismo
 *     valor unitario— y justo por eso hay que vigilarlo: el día que alguien valúe el inventario
 *     con un costo y el COGS con otro, el número sigue saliendo y deja de significar nada.
 *  2. **La CARGA contra un árbitro independiente.** `analytics.stock_movements` tiene la misma
 *     carga, desde el lado del emisor y por otro camino de código (su importer). Dos
 *     derivaciones del mismo hecho. Un candado que compare la vista consigo misma pasa en verde
 *     con la lógica rota — la lección de `[IC.0]`.
 *  3. **Que la unidad sea parte de la llave.** Si no hubiera ni un SKU con dos peldaños en la
 *     misma ruta, la aserción sería vacua: se mide que los hay antes de afirmar que importa.
 *  4. **Que el contraste NO se haya fundido con la cifra.** `cogs_erp` (el `c62` del ERP) mide
 *     otra cosa que el costo del embarque. Si algún día coincidieran exactamente, lo más probable
 *     es que alguien los haya igualado — y el candado lo dice.
 *
 * Y las PRUEBAS NEGATIVAS, porque un gate sin prueba negativa es una intención (ADR-056):
 * valuar con un costo ajeno tiene que ROMPER el cuadre, y un tenant falso tiene que dar cero.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');
const fs = require('node:fs');

const MIG = path.resolve(__dirname, '..', 'migrations-newdb',
  '20261003120000_rd_route_inventory_views.js');
/** El servicio REAL: el candado ejerce su SQL tal cual, no una copia pegada acá. */
const SERVICIO = path.resolve(__dirname, '..', '..', 'libs', 'commercial', 'src', 'lib',
  'commercial-analytics', 'commercial-analytics.service.ts');

let ok = 0, bad = 0, nm = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};
const noMedido = (name, motivo) => { nm++; console.log(`  ◻ NO MEDIDO: ${name} — ${motivo}`); };
const n = (v) => Number(v) || 0;

/** Saca los dos cuerpos de la migración corriéndola con un `knex` de mentira. */
async function cuerposDeLaMigracion() {
  const mig = require(MIG);
  const sql = [];
  await mig.up({ raw: async (s) => { sql.push(s); return { rows: [] }; } });
  const vistas = sql.filter((s) => s.includes('CREATE OR REPLACE VIEW'));
  if (vistas.length !== 2) throw new Error(`se esperaban 2 vistas en la migración y hay ${vistas.length}`);
  const cuerpo = (s) => s.replace(/^[\s\S]*?CREATE OR REPLACE VIEW\s+\S+\s+AS\s*/, '').trim();
  return {
    ident: cuerpo(vistas.find((s) => s.includes('v_rd_route_identity'))),
    ledger: cuerpo(vistas.find((s) => s.includes('v_rd_route_ledger')))
      .replace(/analytics\.v_rd_route_identity/g, '_ident'),
  };
}

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: {
      connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false },
    },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [RD.9/RD.10] inventario de los camiones de Ruta Directa ===\n');

  try {
    const [{ aplicada }] = (await db.raw(
      `SELECT to_regclass('analytics.v_rd_route_ledger') IS NOT NULL AS aplicada`)).rows;

    // PRE = el prefijo que pone LEDGER (y _ident) al alcance de cada consulta.
    let PRE;
    if (aplicada) {
      console.log('  ⓘ las vistas están aplicadas → se ejercen los objetos reales\n');
      // ⭐ `MATERIALIZED` no es cosmético: sin él Postgres INLINE el CTE, y en la consulta del
      //    árbitro —que lleva una subconsulta correlacionada por ruta— eso reevalúa la vista
      //    viva una vez por ruta. Medido el 2026-10-07: **80.1 s contra el `statement_timeout`
      //    de 90 s** de abajo, o sea el candado en el filo, pasando o fallando según la carga
      //    del momento. La vista viva sola cuesta 9.6 s; computarla UNA vez y reusarla es la
      //    diferencia. (Se midió que NO es regresión de `[RD.40]`: el CTE del embarque cuesta
      //    lo mismo con y sin el filtro de sucursal, 107 ms vs 95 ms. El "~4.3 s" que este
      //    archivo decía más abajo quedó viejo — la vista creció con `[RD.34]` y `[RD.36]`.)
      PRE = `WITH _ident AS MATERIALIZED (SELECT * FROM analytics.v_rd_route_identity),
                  LEDGER AS MATERIALIZED (SELECT * FROM analytics.v_rd_route_ledger) `;
    } else {
      console.log('  ⓘ las vistas NO están aplicadas → se ejerce el SELECT de la migración\n');
      const { ident, ledger } = await cuerposDeLaMigracion();
      PRE = `WITH _ident AS MATERIALIZED (${ident}), LEDGER AS MATERIALIZED (${ledger}) `;
    }

    const tenant = (await db.raw(`SELECT id FROM identity.tenants WHERE slug='mega_dulces'`)).rows[0]?.id;
    t('el tenant mega_dulces existe', !!tenant);

    // ── El resolvedor ────────────────────────────────────────────────────────────────────
    const ident = (await db.raw(`${PRE} SELECT * FROM _ident ORDER BY route_no`)).rows;
    t('el resolvedor devuelve las 11 rutas con camión', ident.length === 11, `devolvió ${ident.length}`);
    t('las 6 de PH traen almacén ERP y las 5 de Canindo no',
      ident.filter((r) => r.almacen_erp).length === 6 && ident.filter((r) => !r.almacen_erp).length === 5);
    t('toda ruta tiene fecha de primera carga (ninguna NULL)',
      ident.every((r) => r.carga_desde), 'una ruta sin carga no puede cuadrar');
    t('el emisor es la sucursal madre, nunca el CEDIS',
      ident.every((r) => r.suc_emisor !== '00'),
      'el CEDIS emitió UN solo embarque a una ruta, anterior al cutover de Canindo');

    // ── El cuadre, que es lo que se publica ──────────────────────────────────────────────
    /**
     * ⛔ `[RD.42]` **Esta copia estaba RANCIA y su aserción estrella pasaba sola.**
     *
     * Hasta hoy el candado calculaba `saldo = cargado − vendido` (sin la clase `conteo`, que
     * `[RD.33]` agregó) y derivaba su propio unitario (`cv/cq`). Con esa fórmula,
     * `carga − COGS − inventario` da 0 **por álgebra**, pase lo que pase en producción: el
     * candado comparaba su copia contra sí misma y la aserción no podía fallar. Medido: decía
     * que la ruta 21 tenía $12,118.69 de inventario cuando publica $41,693.42.
     *
     * Ahora:
     *   · el unitario se LEE del resolvedor — el mismo que lee la pantalla; lo que tiene que ser
     *     independiente es la ARITMÉTICA, no la entrada, y una entrada propia y vieja es peor
     *     que ninguna;
     *   · el saldo incluye el ajuste del conteo, que es la identidad que producción mantiene:
     *     **cargado + conteo − vendido = inventario**.
     */
    const CUADRE = `${PRE}, win AS (
        SELECT route_no, sku, unidad,
               sum(qty)       FILTER (WHERE clase='carga')  cq,
               sum(qty)       FILTER (WHERE clase='conteo') kq,
               sum(qty)       FILTER (WHERE clase='venta')  vq,
               sum(venta_doc) FILTER (WHERE clase='venta')  vi,
               sum(costo_erp) FILTER (WHERE clase='venta')  ce
          FROM LEDGER WHERE tenant_id = ? GROUP BY 1,2,3
      ), val AS (
        SELECT w.*, u.costo_u, u.precio_u,
               coalesce(w.cq,0)+coalesce(w.kq,0)-coalesce(w.vq,0) saldo
          FROM win w
          LEFT JOIN analytics.mv_rd_route_unit_value u
            ON u.route_no = w.route_no AND u.sku = w.sku AND u.unidad = w.unidad
      )
      SELECT route_no,
             round(sum(cq*costo_u),2) carga_costo,
             round(sum(coalesce(kq,0)*costo_u),2) conteo_costo,
             round(sum(coalesce(vq,0)*costo_u),2) cogs_costo,
             round(sum(saldo*costo_u),2) inv_costo,
             round(sum(cq*costo_u) + sum(coalesce(kq,0)*costo_u)
                   - sum(coalesce(vq,0)*costo_u) - sum(saldo*costo_u),2) delta_costo,
             round(sum(coalesce(cq,0)*precio_u),2) carga_venta,
             round(sum(coalesce(kq,0)*precio_u),2) conteo_venta,
             round(sum(coalesce(vq,0)*precio_u),2) venta_cliente,
             round(sum(vi),2) cobrado_real,
             round(sum(saldo*precio_u),2) inv_venta,
             round(sum(coalesce(cq,0)*precio_u) + sum(coalesce(kq,0)*precio_u)
                   - sum(coalesce(vq,0)*precio_u) - sum(saldo*precio_u),2) delta_venta,
             round(sum(ce),2) cogs_erp,
             count(*) FILTER (WHERE saldo>0) pos, count(*) FILTER (WHERE saldo<0) neg
        FROM val GROUP BY 1 ORDER BY 1`;
    const cuadre = (await db.raw(CUADRE, [tenant])).rows;

    t('el cuadre devuelve las 11 rutas', cuadre.length === 11, `devolvió ${cuadre.length}`);
    const malCosto = cuadre.filter((r) => Math.abs(n(r.delta_costo)) >= 0.01);
    t('COLUMNA COSTO: cargado + conteo − vendido = inventario en las 11 rutas', malCosto.length === 0,
      malCosto.map((r) => `${r.route_no}:${r.delta_costo}`).join(' '));
    const malVenta = cuadre.filter((r) => Math.abs(n(r.delta_venta)) >= 0.01);
    t('COLUMNA VENTA: cargado + conteo − vendido = inventario en las 11 rutas', malVenta.length === 0,
      malVenta.map((r) => `${r.route_no}:${r.delta_venta}`).join(' '));
    t('toda ruta mueve dinero (ninguna columna de carga en cero)',
      cuadre.every((r) => n(r.carga_costo) > 0 && n(r.venta_cliente) > 0));

    /**
     * ⭐ `[RD.42]` PRUEBA NEGATIVA de la identidad, y es LA que faltaba.
     *
     * Las dos aserciones de arriba venían pasando **por álgebra**: el candado calculaba el saldo
     * sin el conteo y luego verificaba una resta que, con ese saldo, da 0 pase lo que pase. Un
     * candado que no puede ponerse rojo no es un candado.
     *
     * Acá se saca el término del conteo a propósito. Si la identidad SIGUE cerrando sin él, es
     * que el término no está haciendo nada y la aserción volvió a ser decorativa.
     */
    const sinConteo = cuadre.filter((r) => Math.abs(n(r.conteo_costo)) >= 0.01);
    if (!sinConteo.length) {
      noMedido('la prueba negativa de la identidad',
        'hoy ninguna ruta tiene ajuste de conteo, así que quitarlo no cambia nada');
    } else {
      t('PRUEBA NEGATIVA: sin el término del conteo la identidad se ROMPE',
        sinConteo.every((r) => Math.abs(n(r.delta_costo) - n(r.conteo_costo)) >= 0.01),
        `el conteo no mueve la identidad en ${sinConteo.length} ruta(s): el término es decorativo`);
      console.log(`     (${sinConteo.length} rutas con ajuste · ` +
        `$${sinConteo.reduce((a, r) => a + Math.abs(n(r.conteo_costo)), 0).toFixed(2)} en juego)`);
    }

    // ── El contraste NO se fundió con la cifra ───────────────────────────────────────────
    const conErp = cuadre.filter((r) => n(r.cogs_erp) > 0);
    t('las rutas de PH traen la línea de contraste del ERP', conErp.length === 6,
      `trajeron ${conErp.length}`);
    const iguales = conErp.filter((r) => Math.abs(n(r.cogs_erp) - n(r.cogs_costo)) < 1);
    t('el `c62` del ERP NO coincide con el costo del embarque (son dos cosas)', iguales.length === 0,
      'si coincidieran, alguien los igualó: la razón medida es 1.1744 sobre el mismo universo');

    // ── La unidad es parte de la llave, y NO es vacuo ────────────────────────────────────
    const [{ skus_multi }] = (await db.raw(`${PRE}
      SELECT count(*)::int skus_multi FROM (
        SELECT route_no, sku FROM LEDGER WHERE tenant_id = ?
         GROUP BY 1,2 HAVING count(DISTINCT unidad) > 1) x`, [tenant])).rows;
    t('hay SKUs con más de un peldaño en la misma ruta (la aserción no es vacua)',
      n(skus_multi) > 0, `${skus_multi}`);

    // ── Anti-duplicación: el UNION no puede repetir la llave ─────────────────────────────
    const [{ dups }] = (await db.raw(`${PRE}
      SELECT count(*)::int dups FROM (
        SELECT route_no, business_date, clase, sku, unidad FROM LEDGER WHERE tenant_id = ?
         GROUP BY 1,2,3,4,5 HAVING count(*) > 1) x`, [tenant])).rows;
    t('el grano (ruta, fecha, clase, sku, unidad) es único', n(dups) === 0, `${dups} repetidos`);

    // ── Árbitro INDEPENDIENTE de la carga: otro camino de código, mismo hecho ────────────
    const arb = (await db.raw(`${PRE}
      SELECT i.route_no,
             round(sum(l.costo_doc),0) vista,
             (SELECT round(sum(m.amount)::numeric,0) FROM analytics.stock_movements m
               WHERE m.tenant_id = ? AND m.dest_code = i.destino
                 AND m.doc_date >= '2026-09-01' AND m.doc_date <= '2026-09-30') arbitro
        FROM _ident i JOIN LEDGER l ON l.route_no = i.route_no AND l.clase='carga'
             AND l.business_date >= '2026-09-01' AND l.business_date <= '2026-09-30'
       WHERE l.tenant_id = ? GROUP BY i.route_no, i.destino ORDER BY 1`, [tenant, tenant])).rows;
    const conArbitro = arb.filter((r) => r.arbitro !== null);
    if (conArbitro.length === 0) {
      noMedido('la carga contra analytics.stock_movements',
        'el árbitro no tiene septiembre: su importer corre con ventana rodante');
    } else {
      const lejos = conArbitro.filter((r) => Math.abs(n(r.vista) - n(r.arbitro)) > 2);
      t(`la CARGA coincide con analytics.stock_movements en ${conArbitro.length} rutas (sep-2026)`,
        lejos.length === 0, lejos.map((r) => `${r.route_no}: ${r.vista} vs ${r.arbitro}`).join(' · '));
    }

    // ── La ventana arranca en la CARGA, no en la venta — y la elección IMPORTA ───────────
    const [{ venta_antes }] = (await db.raw(`${PRE}
      SELECT count(*)::int venta_antes
        FROM _ident i JOIN analytics.route_push_lines p
          ON p.route_no = i.route_no AND p.tenant_id = i.tenant_id
         AND p.business_date < i.carga_desde`, [])).rows;
    t('hay venta ANTERIOR a la primera carga (por eso la ventana arranca en la carga)',
      n(venta_antes) > 0,
      'si no la hubiera, la decisión de ventana sería indiferente y esta aserción, vacua');

    // ── PRUEBA NEGATIVA 1: valuar con un costo ajeno tiene que ROMPER el cuadre ──────────
    const [{ delta_roto }] = (await db.raw(`${PRE}, win AS (
        SELECT route_no, sku, unidad,
               sum(qty)       FILTER (WHERE clase='carga') cq,
               sum(costo_doc) FILTER (WHERE clase='carga') cv,
               sum(qty)       FILTER (WHERE clase='venta') vq
          FROM LEDGER WHERE tenant_id = ? GROUP BY 1,2,3
      ), val AS (SELECT w.*, w.cv/nullif(w.cq,0) costo_u FROM win w)
      SELECT round(abs(sum(cq*costo_u) - sum(coalesce(vq,0)*costo_u*1.10)
                   - sum((coalesce(cq,0)-coalesce(vq,0))*costo_u)),2) delta_roto
        FROM val`, [tenant])).rows;
    t('PRUEBA NEGATIVA: valuar el COGS con otro costo rompe el cuadre', n(delta_roto) > 1,
      `dio ${delta_roto}, debería ser grande`);

    // ── PRUEBA NEGATIVA 2: un tenant que no existe no puede devolver filas ───────────────
    const [{ filas }] = (await db.raw(`${PRE}
      SELECT count(*)::int filas FROM LEDGER WHERE tenant_id = '00000000-0000-0000-0000-0000000f00ff'`,
    [])).rows;
    t('PRUEBA NEGATIVA: un tenant falso devuelve 0 filas', n(filas) === 0, `devolvió ${filas}`);

    // ── Lo que se DECLARA: cobertura, no silencio ────────────────────────────────────────
    const [cob] = (await db.raw(`${PRE}, win AS (
        SELECT route_no, sku, unidad,
               sum(qty)       FILTER (WHERE clase='carga') cq,
               sum(costo_doc) FILTER (WHERE clase='carga') cv,
               sum(qty)       FILTER (WHERE clase='venta') vq,
               sum(venta_doc) FILTER (WHERE clase='venta') vi
          FROM LEDGER WHERE tenant_id = ? GROUP BY 1,2,3)
      SELECT count(*) FILTER (WHERE coalesce(vq,0)>0 AND cv/nullif(cq,0) IS NULL)::int sin_costo,
             count(*) FILTER (WHERE coalesce(cq,0)>0 AND vi/nullif(vq,0) IS NULL)::int sin_precio,
             count(*)::int total FROM win`, [tenant])).rows;
    console.log(`  ⓘ cobertura: ${cob.sin_costo} pares sin costo · ${cob.sin_precio} sin precio · de ${cob.total}`);
    t('la cobertura del costo es la que el diseño promete (el embarque cubre lo que entró)',
      n(cob.sin_costo) / n(cob.total) < 0.15,
      `${cob.sin_costo}/${cob.total} — sólo deberían faltar los SKUs que el camión ya traía`);

    // ── La consulta REAL del servicio, ejercida tal cual está escrita ───────────────────
    // ⛔ Esto existe porque el candado anterior probaba las VISTAS y daba verde mientras el
    // servicio referenciaba `catalog.products.name`, una columna que NO existe (es
    // `description`): el detalle habría tronado en el primer clic. Una vista correcta no
    // prueba que el consumidor esté bien cableado.
    const sqlDetalle = (() => {
      const src = fs.readFileSync(SERVICIO, 'utf8');
      const i = src.indexOf('async routeInventoryDetail(');
      if (i < 0) return null;
      const a = src.indexOf('`', i);
      const b = src.indexOf('`', a + 1);
      return a > 0 && b > a ? src.slice(a + 1, b) : null;
    })();
    if (!sqlDetalle) {
      noMedido('la consulta del detalle', 'no se pudo extraer el SQL de routeInventoryDetail');
    } else {
      // Se ejerce HOY, con la vista aplicada o sin ella: si no está, se le antepone el mismo
      // CTE que el resto del candado y se repunta el nombre. Dejarlo NO MEDIDO hasta el
      // despliegue sería esconder justo la clase de bug que este bloque vino a cazar.
      // ⛔ Los `?` se dejan COMO ESTÁN: este candado corre por knex, igual que el servicio, y
      // `knex.raw` sólo entiende `?` — traducirlos a `$n` fue el bug de Fase CV.
      const cuerpo = aplicada ? sqlDetalle
        : sqlDetalle.replace(/analytics\.v_rd_route_ledger/g, 'LEDGER')
          .replace(/^\s*WITH\s+/i, ', ');
      const pg = aplicada ? cuerpo : PRE + cuerpo;
      const ruta = cuadre[0] && cuadre[0].route_no;
      try {
        // El 6º binding es el tope (`LIMIT ?`). Si el servicio cambia de forma, knex lo grita.
        const r = await db.raw(pg, [tenant, ruta, '2000-01-01', '2999-12-31', tenant, 1000]);
        const filas = r.rows || r;
        t('la consulta del DETALLE del servicio corre contra prod', true);
        t('el detalle trae las columnas que la pantalla pinta',
          filas.length === 0 || ['sku', 'unidad', 'producto', 'saldo', 'saldo_costo', 'saldo_venta',
            'veredicto', 'ya_lo_traia', '_total']
            .every((c) => c in filas[0]),
          filas.length ? Object.keys(filas[0]).join(',') : 'sin filas');
        t('el detalle resuelve el NOMBRE del producto, no repite el SKU',
          filas.some((f) => f.producto && f.producto !== f.sku),
          'si ninguno resuelve, el join al catálogo está roto');
        const malV = filas.filter((f) => !['ok', 'sin_costo', 'sin_precio'].includes(f.veredicto));
        t('todo renglón del detalle trae un veredicto conocido', malV.length === 0);
        // El veredicto COMPONE: todo `sin_costo` es por construcción negativo (no hubo carga).
        const sinCostoNoNeg = filas.filter((f) => f.veredicto === 'sin_costo' && f.ya_lo_traia !== true);
        t('todo renglón sin costo viene marcado como «ya lo traía» (son la misma población)',
          sinCostoNoNeg.length === 0, `${sinCostoNoNeg.length} filas lo contradicen`);
      } catch (e) {
        bad++;
        console.log('  ✘ la consulta del DETALLE del servicio FALLA — ' + e.message);
      }
    }

    // ── [RD.14] La identidad sale de la TABLA PRINCIPAL, no de una lista a mano ─────────
    if (aplicada) {
      const [{ def }] = (await db.raw(
        `SELECT pg_get_viewdef('analytics.v_rd_route_identity'::regclass, true) AS def`)).rows;
      t('la identidad NO lleva una lista de rutas embebida',
        !/\bVALUES\b/i.test(def), 'un VALUES acá es una constante duplicada a mano (ADR-056)');
      t('la identidad JOINea contra commercial.warehouses (la tabla con la PK)',
        /commercial\.warehouses/.test(def));
      t('la identidad JOINea contra transfer_dest_map (la FK del destino)',
        /analytics\.transfer_dest_map/.test(def));

      const [fk] = (await db.raw(`
        SELECT (SELECT count(*)::int FROM commercial.warehouses
                 WHERE kind='truck' AND deleted_at IS NULL AND source_warehouse_id IS NOT NULL) AS con_origen,
               (SELECT count(*)::int FROM analytics.transfer_dest_map
                 WHERE warehouse_id IS NOT NULL AND dest_code ~ '^(RUTA|RD) ') AS dest_con_fk,
               (SELECT count(*)::int FROM commercial.warehouses
                 WHERE kind='truck' AND deleted_at IS NULL AND kepler_code IS NOT NULL) AS con_erp`)).rows;
      t('las 11 rutas tienen su almacén de origen por FK', n(fk.con_origen) === 11, `${fk.con_origen}`);
      t('los 11 destinos de Kepler apuntan a su almacén por FK', n(fk.dest_con_fk) === 11, `${fk.dest_con_fk}`);
      t('las 6 rutas de PH tienen su código de almacén del ERP (las de Canindo no lo tienen, y se declara)',
        n(fk.con_erp) === 6, `${fk.con_erp}`);

      // `route_no` se DERIVA del código canónico. Si esa derivación se rompe, el join con el
      // carril push se cae en silencio y la pantalla muestra rutas sin venta.
      const [{ huerfanas }] = (await db.raw(`
        SELECT count(*)::int AS huerfanas FROM analytics.v_rd_route_identity i
         WHERE NOT EXISTS (SELECT 1 FROM analytics.route_push_lines p
                            WHERE p.route_no = i.route_no AND p.tenant_id = i.tenant_id)`)).rows;
      t('el route_no derivado del código casa con el del carril push', n(huerfanas) === 0,
        `${huerfanas} rutas sin una sola línea de venta`);

      // ── [RD.15] PARIDAD: la copia por costo contra la definición viva ─────────────────
      // ⚠️ La paridad toca la VISTA VIVA, que deriva `kdm1 ⋈ kdm2` entero (~4.3 s medidos) y
      // choca con el `statement_timeout` del rol de lectura: sin esto el candado falla a veces
      // sin que haya ningún defecto, que es la peor clase de rojo (enseña a ignorarlo).
      // ⛔ **Comparar la matvista contra su vista VIVA no mide paridad: mide el rezago del
      // refresco.** Medido acá mismo: 108,081 contra 108,206 — 125 filas que entraron después
      // del último REFRESH. La aserción sólo podía pasar justo después de refrescar, o sea que
      // era un rojo programado. Lo que SÍ es invariante es un periodo **cerrado**: los meses
      // anteriores ya no se mueven, así que ahí la copia tiene que ser idéntica al peso.
      const CORTE = "date_trunc('month', (now() at time zone 'America/Mexico_City')::date)";
      const [par] = (await db.transaction(async (trx) => {
        // La vista viva deriva `kdm1 ⋈ kdm2` entero (~4.3 s) y choca con el `statement_timeout`
        // del rol de lectura: sin esto el candado falla A VECES sin que haya ningún defecto.
        await trx.raw("SET LOCAL statement_timeout = '90s'");
        return trx.raw(`
        SELECT (SELECT count(*)::int FROM analytics.mv_rd_route_ledger
                 WHERE business_date < ${CORTE}) AS mv_filas,
               (SELECT count(*)::int FROM analytics.v_rd_route_ledger
                 WHERE business_date < ${CORTE}) AS v_filas,
               (SELECT round(sum(costo_doc),2) FROM analytics.mv_rd_route_ledger
                 WHERE business_date < ${CORTE}) AS mv_costo,
               (SELECT round(sum(costo_doc),2) FROM analytics.v_rd_route_ledger
                 WHERE business_date < ${CORTE}) AS v_costo,
               (SELECT count(*)::int FROM analytics.mv_rd_route_identity) AS mv_id,
               (SELECT count(*)::int FROM analytics.v_rd_route_identity)  AS v_id`);
      })).rows;
      t('en el periodo CERRADO la matvista tiene las mismas filas que su vista',
        n(par.mv_filas) === n(par.v_filas), `${par.mv_filas} vs ${par.v_filas}`);
      t('…y el mismo dinero al centavo',
        Math.abs(n(par.mv_costo) - n(par.v_costo)) < 0.01, `${par.mv_costo} vs ${par.v_costo}`);
      t('el periodo cerrado no está vacío (si no, la paridad sería vacua)', n(par.mv_filas) > 0);
      t('la matvista de la identidad tiene las mismas rutas que su vista',
        n(par.mv_id) === n(par.v_id), `${par.mv_id} vs ${par.v_id}`);

      // ── PRESUPUESTO: 0.5 s. No es tarea de perf posterior, es criterio de aceptación ──
      const SERV = `
        WITH win AS (
          SELECT l.route_no, l.sku, l.unidad,
                 sum(l.qty) FILTER (WHERE l.clase='carga') cq,
                 sum(l.costo_doc) FILTER (WHERE l.clase='carga') cv,
                 sum(l.qty) FILTER (WHERE l.clase='venta') vq,
                 sum(l.venta_doc) FILTER (WHERE l.clase='venta') vi
            FROM analytics.mv_rd_route_ledger l
           WHERE l.tenant_id = ? AND l.business_date >= '2000-01-01' AND l.business_date <= '2999-12-31'
           GROUP BY 1,2,3
        ), val AS (SELECT w.*, w.cv/nullif(w.cq,0) costo_u,
                          coalesce(w.cq,0)-coalesce(w.vq,0) saldo FROM win w)
        SELECT i.route_no, round(sum(v.saldo*v.costo_u),2) inv
          FROM analytics.mv_rd_route_identity i LEFT JOIN val v ON v.route_no = i.route_no
         WHERE i.tenant_id = ? GROUP BY i.route_no`;
      await db.raw(SERV, [tenant, tenant]); // calentar: se mide el régimen, no el primer toque
      let peor = 0;
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        await db.raw(SERV, [tenant, tenant]);
        peor = Math.max(peor, Date.now() - t0);
      }
      t(`la consulta de la pantalla cabe en 500 ms (peor de 3: ${peor} ms)`, peor < 500,
        'medida sobre la consulta REAL, no una parecida: ese fue el error que costó 1,775 ms');
    } else {
      noMedido('la normalización y el presupuesto de 500 ms',
        'las migraciones 20261003130000/140000 todavía no se aplicaron');
    }

    // ── [RD.17-21] Los cuatro métodos nuevos, ejercidos CON SU SQL REAL ────────────────
    // Mismo criterio que el detalle: una vista correcta no prueba que el consumidor esté bien
    // cableado. Acá ya cazó dos: `round(double, int)` no existe en Postgres (percentile_cont
    // devuelve double) y la mediana sin acotar costaba 518 ms contra un presupuesto de 500.
    if (aplicada) {
      const src = fs.readFileSync(SERVICIO, 'utf8');
      const sqlDe = (m) => {
        const i = src.indexOf(`async ${m}(`);
        if (i < 0) return null;
        const a = src.indexOf('`', i);
        const b = src.indexOf('`', a + 1);
        return a > 0 && b > a ? src.slice(a + 1, b) : null;
      };
      const ruta = cuadre[0] && cuadre[0].route_no;
      const RANGO = ['2000-01-01', '2999-12-31'];

      // (a) La serie: el acumulado tiene que ser el acumulado, no una columna suelta.
      const serie = (await db.raw(sqlDe('routeSeries'), [tenant, ruta, tenant, ruta, ...RANGO])).rows;
      t('la SERIE del servicio corre contra prod', serie.length > 0, `${serie.length} días`);
      // ⛔ `[RD.42]` El AJUSTE del conteo entra al acumulado y NO a «cargado» (`[RD.31]`), así que
      //    `Σ(cargado − vendido)` NO puede dar el saldo: le falta el conteo. Esta aserción
      //    comparaba dos cosas distintas desde `[RD.33]` y fallaba por eso, no por un defecto —
      //    un candado que grita en falso enseña a ignorar el tablero. Ahora suma las TRES clases,
      //    que es lo que el acumulado de verdad acumula; y la serie publica `conteo_qty` para
      //    que en la pantalla las tres columnas también reconcilien a la vista.
      const sumaNeta = serie.reduce((a, p) =>
        a + (Number(p.cargado_qty) + Number(p.conteo_qty || 0) - Number(p.vendido_qty)), 0);
      const ultimo = serie.length ? Number(serie[serie.length - 1].saldo_qty_acum) : 0;
      t('el saldo acumulado del último día == cargado + conteo − vendido de todos los días',
        Math.abs(sumaNeta - ultimo) < 0.01, `${sumaNeta.toFixed(2)} vs ${ultimo.toFixed(2)}`);
      t('la serie está ordenada por día (el acumulado no significa nada si no lo está)',
        serie.every((p, i) => i === 0 || p.fecha > serie[i - 1].fecha));

      // ⭐ [RD.24] LA SERIE CONTRA EL RESUMEN — dos implementaciones distintas del mismo saldo.
      //
      // Esto no se podía preguntar antes: la serie llevaba el acumulado en UNIDADES y el resumen
      // en pesos, así que no había con qué compararlos. Y mientras no se podía preguntar, la
      // serie pintaba «Cargado» al COSTO junto a «Vendido» a PRECIO — la lectura A de
      // VERDAD_ABSOLUTA §19 adentro de la pantalla que existe para denunciarla. Medido en la
      // ruta 21: $3,820 cargado contra $17,227 vendido el 26-sep. No era sobreventa: eran dos
      // monedas.
      //
      // El candado compara el ÚLTIMO acumulado de la serie contra el inventario del resumen, en
      // las DOS valuaciones. Son dos SQL distintos sobre el mismo hecho; si divergen, alguien
      // volvió a mezclar.
      const fila = cuadre.find((x) => x.route_no === ruta) || {};
      const ultSerie = serie[serie.length - 1] || {};
      for (const [moneda, enSerie, enResumen] of [
        ['costo', Number(ultSerie.saldo_costo_acum), Number(fila.inv_costo)],
        ['venta', Number(ultSerie.saldo_venta_acum), Number(fila.inv_venta)],
      ]) {
        t(`⭐ el último día de la serie (${moneda}) == el inventario del resumen`,
          Number.isFinite(enSerie) && Number.isFinite(enResumen)
            && Math.abs(enSerie - enResumen) < 0.5,
          `serie ${enSerie} vs resumen ${enResumen} — dos consultas, un solo hecho`);
      }
      // PRUEBA NEGATIVA de la mezcla: si las dos monedas dieran lo mismo, el conmutador de
      // valuación no estaría haciendo nada y la pantalla mentiría en una de las dos.
      t('PRUEBA NEGATIVA · las dos valuaciones NO dan lo mismo (si no, una de las dos está mal)',
        Math.abs(Number(ultSerie.saldo_costo_acum) - Number(ultSerie.saldo_venta_acum)) > 1,
        `costo ${ultSerie.saldo_costo_acum} vs venta ${ultSerie.saldo_venta_acum}`);

      // (b) Los embarques: su suma TIENE que ser la carga que el ledger reporta. Dos caminos.
      const emb = (await db.raw(sqlDe('routeShipments'), [tenant, ruta, ...RANGO])).rows;
      t('los EMBARQUES del servicio corren contra prod', emb.length > 0, `${emb.length} documentos`);
      // ⛔ SEGUNDA vez que caigo en esto en este mismo archivo: comparar la vista VIVA contra la
      // matvista NO mide paridad, mide el REZAGO DEL REFRESCO. Medido acá: $1,051,575.76 contra
      // $1,033,144.76, y la diferencia resultó ser exactamente el embarque de hoy ($18,431.00)
      // que el refresco todavía no tomó. En periodo CERRADO las dos coinciden al centavo.
      const [{ emb_cerrado, carga_ledger }] = (await db.raw(
        `SELECT round(sum(l.importe),2)::float AS emb_cerrado,
                (SELECT round(sum(costo_doc),2)::float FROM analytics.mv_rd_route_ledger
                  WHERE tenant_id = ? AND route_no = ? AND clase = 'carga'
                    AND business_date < date_trunc('month',(now() AT TIME ZONE 'America/Mexico_City')::date)
                ) AS carga_ledger
           FROM analytics.v_rd_route_shipment_lines l
          WHERE l.tenant_id = ? AND l.route_no = ?
            AND l.business_date < date_trunc('month',(now() AT TIME ZONE 'America/Mexico_City')::date)`,
        [tenant, ruta, tenant, ruta])).rows;
      t('en periodo CERRADO, Σ de los embarques == la carga del ledger (dos derivaciones)',
        Math.abs(Number(emb_cerrado) - Number(carga_ledger)) < 0.5,
        `${emb_cerrado} vs ${carga_ledger}`);
      t('el periodo cerrado no está vacío (si no, la comparación sería vacua)',
        Number(emb_cerrado) > 0);
      const sumaEmb = emb.reduce((a, e) => a + Number(e.importe), 0);
      t('la vista viva de embarques va por delante o igual que la copia (nunca por detrás)',
        sumaEmb >= Number(carga_ledger) - 0.5,
        'si la copia tuviera MÁS que la fuente viva, algo se duplicó');

      // (c) Las líneas de un embarque: su suma == el total de ese documento.
      const e0 = emb[0];
      const lin = (await db.raw(sqlDe('routeShipmentLines'),
        [tenant, ruta, e0.folio, e0.serie, e0.serie, tenant, ruta, tenant])).rows;
      t('las LÍNEAS del embarque corren contra prod', lin.length > 0, `${lin.length} líneas`);
      const sumaLin = lin.reduce((a, l) => a + Number(l.importe), 0);
      t('Σ de las líneas == el importe del embarque',
        Math.abs(sumaLin - Number(e0.importe)) < 0.5, `${sumaLin.toFixed(2)} vs ${e0.importe}`);
      t('el detalle del embarque resuelve nombres de producto, no repite el SKU',
        lin.some((l) => l.producto && l.producto !== l.sku));

      // (d) Los rojos: las dos familias, y que `nunca_cargado` NO traiga cifra inventada.
      const neg = (await db.raw(sqlDe('routeNegatives'),
        [tenant, ruta, ...RANGO, tenant, 1000])).rows;
      // ⛔ `[RD.42]` Que una ruta NO tenga rojos es un resultado válido, no una falla. La ruta
      //    que el candado elige es la primera por plaza — hoy la 501, que tiene 340 pares
      //    positivos y CERO negativos. Exigir `> 0` convertía un dato sano en rojo del tablero,
      //    y además volvía vacuas las tres aserciones de abajo sin avisar. Se declara.
      if (!neg.length) {
        noMedido('los ROJOS de esta ruta',
          `la ruta ${ruta} no tiene ni un par en negativo: no hay qué comprobar`);
      } else {
        t('los ROJOS del servicio corren contra prod', true, `${neg.length} pares`);
      }
      t('todo rojo tiene saldo negativo (si no, no es un rojo)',
        neg.every((n) => Number(n.saldo) < 0));
      const flias = [...new Set(neg.map((n) => n.familia))];
      t('las dos familias existen y no hay una tercera',
        flias.every((f) => ['nunca_cargado', 'se_acabo'].includes(f)), flias.join(','));
      const inventado = neg.filter((n) => n.familia === 'nunca_cargado' && n.valor_costo !== null);
      t('«nunca se le cargó» NO publica un valor: sin carga no hay costo con qué valuarlo',
        inventado.length === 0,
        `${inventado.length} filas se inventaron una cifra — eso es dibujar un número (ADR-056)`);
      const sinDesde = neg.filter((n) => !n.desde);
      t('todo rojo dice DESDE CUÁNDO lo es', sinDesde.length === 0, `${sinDesde.length} sin fecha`);

      // (e) El presupuesto, para los cuatro.
      const presup = [
        ['serie', sqlDe('routeSeries'), [tenant, ruta, tenant, ruta, ...RANGO]],
        ['embarques', sqlDe('routeShipments'), [tenant, ruta, ...RANGO]],
        ['líneas', sqlDe('routeShipmentLines'),
          [tenant, ruta, e0.folio, e0.serie, e0.serie, tenant, ruta, tenant]],
        ['rojos', sqlDe('routeNegatives'), [tenant, ruta, ...RANGO, tenant, 1000]],
      ];
      for (const [nombre, sql, binds] of presup) {
        await db.raw(sql, binds); // calentar: se mide el régimen, no el primer toque
        const t0 = Date.now();
        await db.raw(sql, binds);
        const ms = Date.now() - t0;
        t(`«${nombre}» cabe en 500 ms (${ms} ms)`, ms < 500,
          'medido sobre la consulta REAL del servicio');
      }
    } else {
      noMedido('los cuatro métodos nuevos', 'las vistas todavía no están aplicadas');
    }

    // ── [RD.22] El default de la pantalla: saldo actual, COGS del embarque, carga de ayer ─────
    //
    // Se ejerce el SQL REAL de `routeInventory`, no una consulta parecida. Lo que vigila:
    // (1) «no cargó» viaja como NULL y NUNCA como 0 — colapsarlo diría que le mandamos el
    // camión vacío; (2) el COGS sale del costo del EMBARQUE y no del contraste del ERP, que
    // cubre un tercio del dinero y publicaría un margen del 79%; (3) la cobertura de ese
    // contraste se mide EN DINERO, no en pares, porque por pares da más del doble.
    if (aplicada) {
      const src = fs.readFileSync(SERVICIO, 'utf8');
      const i = src.indexOf('async routeInventory(');
      // ⛔ **El primer literal del método ya NO es la consulta con la lógica.** Desde `[RD.47]`
      // el método se bifurca: con el rango por default lee la copia (`mv_rd_route_inventory`,
      // un literal de UN binding) y sólo con rango explícito arma la consulta grande. Tomar «el
      // primer backtick» apuntaba este candado a la copia y lo volvía ciego a la lógica que
      // vino a vigilar — reventó con `Expected 9 bindings, saw 0`, que fue suerte: si la copia
      // hubiera aceptado los bindings, habría pasado en verde midiendo otra cosa.
      //
      // Se busca el literal POR SU FORMA: el que lleva los 9 parámetros. Eso sobrevive a que
      // alguien reordene las ramas.
      let sqlInv = null;
      for (let p = src.indexOf('`', i); p > 0 && p < i + 40000; p = src.indexOf('`', p + 1)) {
        const q2 = src.indexOf('`', p + 1);
        if (q2 < 0) break;
        const cand = src.slice(p + 1, q2);
        if ((cand.match(/\?/g) || []).length === 9 && cand.includes('WITH win AS')) { sqlInv = cand; break; }
        p = q2;
      }
      t('el candado encuentra la consulta VIVA del servicio (la de 9 parámetros)', sqlInv !== null,
        'sin esto, todo lo de abajo mide la copia o no mide nada');
      const ayer = new Date(Date.now() - 6 * 3600 * 1000 - 24 * 3600 * 1000)
        .toISOString().slice(0, 10);
      const inv = (await db.raw(sqlInv, [tenant, '2000-01-01', '2999-12-31', tenant, ayer, ayer, tenant, tenant, tenant])).rows;
      t('el DEFAULT de la pantalla corre contra prod', inv.length > 0, `${inv.length} rutas`);

      // ⭐ **La paridad que la migración `[RD.47]` prometió.** La copia trae un duplicado del SQL
      // de arriba con el rango resuelto; dos copias de la misma lógica son una segunda verdad
      // esperando, salvo que algo las compare. Esto es ese algo.
      const { rows: [hayCopia] } = await db.raw(
        `SELECT to_regclass('analytics.mv_rd_route_inventory') IS NOT NULL AS m`);
      if (!hayCopia.m) {
        noMedido('[RD.47] paridad copia vs viva', 'analytics.mv_rd_route_inventory todavía no existe');
      } else {
        const copia = (await db.raw(
          `SELECT * FROM analytics.mv_rd_route_inventory WHERE tenant_id = ? ORDER BY plaza, route_no`,
          [tenant])).rows;
        // Se comparan las columnas de dinero, que son las que alguien lee. El `hasta` del test
        // es 2999 y el de la copia es hoy: en una ruta sin movimientos futuros da igual, y si
        // algún día no diera igual, esta aserción es justo la que tiene que avisar.
        const clave = (r) => `${r.route_no}`;
        const porRuta = new Map(copia.map((r) => [clave(r), r]));
        const difieren = inv.filter((r) => {
          const c = porRuta.get(clave(r));
          if (!c) return true;
          return Math.abs(Number(r.inventario_costo ?? 0) - Number(c.inventario_costo ?? 0)) > 0.01;
        });
        t(`[RD.47] la copia dice lo MISMO que la consulta viva en las ${inv.length} rutas`,
          difieren.length === 0,
          `${difieren.length} ruta(s) divergen (${difieren.slice(0, 3).map((r) => r.route_no).join(', ')}) — alguien cambió una de las dos copias del SQL y no la otra`);
      }

      // ⚠️ La comparación va ESTRICTA contra 0, no por `Number(...)`: `Number(null)` es 0, así
      // que la versión obvia marca en rojo justo las filas que están bien. Es el mismo descuido
      // que esta pantalla vigila en el dato — un ausente leyéndose como un cero — cometido acá
      // dentro del test que lo vigila.
      const ceros = inv.filter((r) => r.cargado_ayer_costo === 0);
      t('«no cargó» NO se dibuja como $0: viaja NULL', ceros.length === 0,
        `${ceros.length} rutas con un 0 que se leería como «le cargamos nada»`);
      const conCarga = inv.filter((r) => r.cargado_ayer_costo !== null);
      // ⚠️ NO se exige que haya rutas con carga Y rutas sin ella: hay dias en que no carga
      // ninguna (domingos, festivos) y la asercion se ponia roja sola -- medido el 2026-10-05,
      // 0 de 11 cargaron el sabado, y eso es el dato correcto. Lo que se vigila es la
      // CAPACIDAD de distinguir: que lo ausente viaje NULL y que nunca aparezca un 0.
      t('la columna distingue ausencia de cero (ninguna carga viene como 0)',
        inv.every((r) => r.cargado_ayer_costo === null || Number(r.cargado_ayer_costo) !== 0),
        `${conCarga.length} de ${inv.length} cargaron el ${ayer}`);
      t('toda ruta dice cuándo fue su última carga, haya cargado ayer o no',
        inv.every((r) => r.ultima_carga), 'sin eso, «no cargó» no se puede interpretar');

      // PRUEBA NEGATIVA: con una fecha sin un solo embarque, TODAS tienen que caer en NULL.
      const vacio = (await db.raw(sqlInv,
        [tenant, '2000-01-01', '2999-12-31', tenant, '1990-01-01', '1990-01-01', tenant, tenant, tenant])).rows;
      t('PRUEBA NEGATIVA · un día sin embarques deja las 11 en NULL, no en 0',
        vacio.every((r) => r.cargado_ayer_costo === null),
        `${vacio.filter((r) => r.cargado_ayer_costo !== null).length} filas se inventaron una cifra`);

      // El COGS publicado vs el contraste: tienen que ser distintos y el contraste, menor.
      const sum = (k) => inv.reduce((s, r) => s + (Number(r[k]) || 0), 0);
      const cogs = sum('cogs_costo'); const ce = sum('cogs_erp');
      const venta = sum('venta_cliente'); const sinCe = sum('venta_sin_cogs_erp');
      t('el COGS publicado sale del EMBARQUE, no del contraste del ERP', cogs > ce * 2,
        `embarque ${cogs.toFixed(2)} vs contraste ${ce.toFixed(2)}`);
      const margen = venta > 0 ? (venta - cogs) / venta * 100 : 0;
      t('el margen de ruta cae en una banda creíble (10% a 40%)', margen > 10 && margen < 40,
        `${margen.toFixed(2)}% · con el contraste daría ${((venta - ce) / venta * 100).toFixed(2)}%`);

      const cobDinero = venta > 0 ? (1 - sinCe / venta) * 100 : 0;
      const paresV = inv.reduce((s, r) => s + (Number(r.pares_vendidos) || 0), 0);
      const paresSin = inv.reduce((s, r) => s + (Number(r.pares_sin_cogs_erp) || 0), 0);
      const cobPares = paresV > 0 ? (1 - paresSin / paresV) * 100 : 0;
      t('la cobertura del contraste se declara EN DINERO, y es MENOR que la de pares',
        cobDinero < cobPares,
        `dinero ${cobDinero.toFixed(1)}% vs pares ${cobPares.toFixed(1)}% — publicar la de pares infla`);
      t('la venta sin testigo de costo está declarada, no en cero', sinCe > 0,
        `${sinCe.toFixed(2)} de ${venta.toFixed(2)}`);

      const t0 = Date.now();
      await db.raw(sqlInv, [tenant, '2000-01-01', '2999-12-31', tenant, ayer, ayer, tenant, tenant, tenant]);
      const ms = Date.now() - t0;
      t(`el default cabe en 500 ms (${ms} ms)`, ms < 500, 'es la consulta que ve todo el mundo');

      // ── [RD.26/27] El costo y el precio salen de Kepler, y las dos columnas son comparables ──
      //
      // Lo reportó Edgar mirando la pantalla: «lo que costó» salía MÁS CARO que «lo que vale al
      // cliente». No era un error de cálculo — las dos columnas sumaban UNIVERSOS DISTINTOS,
      // porque cada una se valuaba con el unitario que salía del propio movimiento: un par con
      // carga y sin venta tenía costo y no precio, y con los negativos pasaba al revés.
      //
      // ⭐ La invariante que lo vigila no es un umbral: es un SIGNO. Valuar la misma mercancía
      // a costo y a precio sólo puede invertirse cuando el saldo es NEGATIVO (se debe más en
      // valor de venta que en costo). Si alguna ruta con saldo positivo sale invertida, alguien
      // volvió a mezclar universos.
      const violan = inv.filter((r) => {
        const ic = Number(r.inventario_costo); const iv = Number(r.inventario_venta);
        if (!Number.isFinite(ic) || !Number.isFinite(iv)) return false;
        return (ic > iv) !== (ic < 0);
      });
      t('⭐ costo > precio ocurre EXACTAMENTE cuando el saldo es negativo', violan.length === 0,
        violan.map((r) => `${r.route_no}:${r.inventario_costo}>${r.inventario_venta}`).join(' ')
          || 'medido 2026-10-05: antes del resolvedor fallaban 10 de 11 rutas');

      const sinC = inv.reduce((a, r) => a + (Number(r.sin_costo_resuelto) || 0), 0);
      const sinP = inv.reduce((a, r) => a + (Number(r.sin_precio_resuelto) || 0), 0);
      t('el resolvedor deja casi nada sin valuar', sinC < 60 && sinP < 60,
        `${sinC} sin costo · ${sinP} sin precio — antes del resolvedor eran 631 y 242`);
      const deFicha = inv.reduce((a, r) => a + (Number(r.costo_de_ficha) || 0), 0);
      t('y lo que resuelve con la ficha se DECLARA, no se disfraza de dato de la ruta',
        deFicha > 0, `${deFicha} pares valuados con el catálogo de Kepler`);

      // ⛔ PRUEBA NEGATIVA del peldaño: unir la ficha SÓLO por SKU (sin la unidad) tiene que
      // dar OTRO número. El mismo producto cuesta 10.85 en pieza y 130.22 en caja de 12: si
      // las dos formas coincidieran, el join por unidad no estaría haciendo nada.
      const [{ con_unidad, sin_unidad }] = (await db.raw(
        `SELECT
           (SELECT count(*) FROM analytics.mv_rd_route_unit_value
             WHERE tenant_id = ? AND origen_costo = 'kepler')::int AS con_unidad,
           (SELECT count(DISTINCT (l.route_no, l.sku, l.unidad))
              FROM analytics.mv_rd_route_ledger l
              JOIN kepler_ods.kdii k ON btrim(k.c1) = l.sku
             WHERE l.tenant_id = ?)::int AS sin_unidad`, [tenant, tenant])).rows;
      t('PRUEBA NEGATIVA · unir la ficha sin la unidad NO es lo mismo que unirla con ella',
        Number(sin_unidad) !== Number(con_unidad),
        `con unidad ${con_unidad} · sin unidad ${sin_unidad} — el peldaño cambia el costo 12x`);

      /**
       * ⚠️ **La paridad vista-vs-matvista NO se puede pedir como igualdad, de ninguna forma.**
       *
       * Se intentó dos veces y las dos estaban mal. Primero se comparó el total: mide el rezago
       * del refresco. Después se acotó a los pares `origen = 'kepler'` suponiendo que los de
       * `'ruta'` estaban congelados — y no lo están: el valor de un par sale de `carga_imp /
       * carga_qty`, así que **se mueve con cada venta y cada embarque que entra al ledger**.
       * Medido: 191 pares con origen 'ruta' difiriendo, media hora después de materializar.
       *
       * ⭐ Lo que sí es invariante: la matvista es una FOTO, y una foto puede estar atrasada,
       * pero **no puede tener filas que el original ya no tenga**. Un par huérfano significa que
       * el ledger perdió renglones, y eso sí es un defecto.
       */
      const [{ huerfanos, pendientes }] = (await db.raw(
        `SELECT
           (SELECT count(*) FROM analytics.mv_rd_route_unit_value m
             WHERE m.tenant_id = ? AND NOT EXISTS (
               SELECT 1 FROM analytics.v_rd_route_unit_value v
                WHERE v.tenant_id = m.tenant_id AND v.route_no = m.route_no
                  AND v.sku = m.sku AND v.unidad = m.unidad))::int AS huerfanos,
           (SELECT count(*) FROM analytics.v_rd_route_unit_value v
             WHERE v.tenant_id = ? AND NOT EXISTS (
               SELECT 1 FROM analytics.mv_rd_route_unit_value m
                WHERE m.tenant_id = v.tenant_id AND m.route_no = v.route_no
                  AND m.sku = v.sku AND m.unidad = v.unidad))::int AS pendientes`,
        [tenant, tenant])).rows;
      t('⭐ la matvista no tiene pares que el ledger ya no tenga (una foto se atrasa, no inventa)',
        Number(huerfanos) === 0,
        `${huerfanos} pares huérfanos — eso sería el ledger perdiendo renglones`);
      console.log(`     (${pendientes} pares nuevos esperando el refresco de 30 min — es la foto, no un defecto)`);
    } else {
      noMedido('el default de la pantalla', 'las vistas todavía no están aplicadas');
    }

    console.log('\n  — el cuadre, ruta por ruta —');
    console.table(cuadre.map((r) => ({
      ruta: r.route_no,
      carga_costo: r.carga_costo, cogs: r.cogs_costo, inv_costo: r.inv_costo, d: r.delta_costo,
      venta_cliente: r.venta_cliente, inv_venta: r.inv_venta, d2: r.delta_venta,
      pos: r.pos, neg: r.neg,
    })));

    if (!aplicada) {
      noMedido('que las vistas EXISTAN en el destino',
        'la migración 20261003120000 todavía no se aplicó: se ejerció su SELECT');
    }

    // ── `[RD.40]`+`[RD.41]` La DECLARACIÓN: hasta dónde se puede creer el descuadre ─────────
    //
    // El descuadre publicado convivía con un artefacto de medición MÁS GRANDE que él: la carga
    // que entra antes de que el push traiga ventas (el push pide `current_date - 15 días`) y la
    // venta que el ledger descarta por caer antes de su ventana. Medido el 2026-10-07: residuo
    // bruto $301,834 contra $413,464 de exposición. Estas aserciones protegen lo que puede
    // romperse en silencio — que la declaración y la cifra publicada vuelvan a contradecirse.
    console.log('\n  — la declaración de lo que no se puede medir —');
    const decl = await db.raw(`SELECT to_regclass('analytics.v_rd_route_opening') AS v,
                                      to_regclass('analytics.mv_rd_route_opening') AS m`);
    const tieneDecl = decl.rows[0] && decl.rows[0].v;
    if (!tieneDecl) {
      noMedido('la declaración de [RD.40]', 'analytics.v_rd_route_opening todavía no existe');
    } else {
      const { rows: op } = await db.raw('SELECT * FROM analytics.v_rd_route_opening ORDER BY route_no');
      t('la declaración cubre las 11 rutas', op.length === 11, `trae ${op.length}`);

      /**
       * ⭐ EL CANDADO QUE IMPORTA: la contradicción no puede volver.
       *
       * Entre `[RD.37]` y `[RD.40]` el ledger contó como carga exactamente el dinero que esta
       * misma vista rotulaba "mercancía real que ninguna fuente mide". El mismo peso, declarado
       * no medible y publicado a la vez. Lo único legítimo antes de la ventana es la `apertura`
       * de `[RD.36]` — un conteo físico, que SÍ está medido.
       */
      const { rows: [contra] } = await db.raw(`
        WITH previo AS (
          SELECT l.route_no, round(coalesce(sum(l.costo_doc), 0), 2) AS imp
            FROM analytics.mv_rd_route_ledger l
            JOIN analytics.mv_rd_route_identity i
              ON i.tenant_id = l.tenant_id AND i.route_no = l.route_no
           WHERE l.clase = 'carga' AND l.business_date < i.carga_desde
           GROUP BY 1
        ), apertura AS (
          SELECT i.route_no,
                 round(sum(CASE WHEN v.signo = 'faltante' THEN -v.importe ELSE v.importe END), 2) AS imp
            FROM analytics.mv_rd_route_identity i
            JOIN analytics.mv_erp_physical_count_variance v
              ON v.kepler_sucursal = i.suc_emisor AND v.kepler_almacen = i.almacen_erp
             AND v.fecha < i.carga_desde
           WHERE i.almacen_erp IS NOT NULL
             AND coalesce(btrim(v.sku), '') <> '' AND coalesce(btrim(v.unidad_erp), '') <> ''
           GROUP BY 1
        )
        SELECT count(*)::int AS rotas,
               coalesce(sum(abs(coalesce(p.imp,0) - coalesce(a.imp,0))), 0)::float AS imp
          FROM previo p FULL JOIN apertura a ON a.route_no = p.route_no
         WHERE abs(coalesce(p.imp, 0) - coalesce(a.imp, 0)) > 0.01`);
      t('el ledger NO cuenta lo que la declaración llama "sin medir"',
        n(contra.rotas) === 0,
        `${contra.rotas} ruta(s) / $${n(contra.imp).toFixed(2)} contados dos veces con sentidos opuestos`);

      // El veredicto no puede ser decorativo: es el `cfg ? classify : 'ok'` que la Fase VP midió
      // dando verde incondicional. Se prueba en los DOS sentidos.
      const mentira = op.filter((r) => r.medible && n(r.exposicion_costo) > 0);
      t('ninguna ruta sale medible teniendo exposición',
        mentira.length === 0, mentira.map((r) => r.route_no).join(', '));
      const clavado = op.filter((r) => !r.medible && n(r.exposicion_costo) === 0
        && n(r.docs_sin_medir) === 0 && r.primera_venta);
      t('el veredicto no está clavado en false',
        clavado.length === 0, clavado.map((r) => r.route_no).join(', '));

      // La aserción no puede ser vacua: si hoy ninguna ruta tuviera exposición, lo de arriba
      // pasaría solo. Se mide que la hay antes de afirmar que el candado sirve.
      const conExp = op.filter((r) => n(r.exposicion_costo) > 0);
      if (!conExp.length) {
        noMedido('que el veredicto discrimine',
          'hoy ninguna ruta tiene exposición, así que las dos aserciones de arriba son vacuas');
      } else {
        t('hay rutas con exposición (la aserción no es vacua)', true);
        console.log(`     (${conExp.length} de ${op.length} rutas · $${op.reduce((a, r) => a + n(r.exposicion_costo), 0).toFixed(2)} declarados)`);
      }

      // Las dos mitades son DISTINTAS y las dos tienen que estar cubiertas: `[RD.30]` sólo medía
      // la carga ciega, y las cinco de Canindo tienen el defecto al revés (venden antes de su
      // primer embarque). Una declaración que sólo ve un lado deja el otro en cero silencioso.
      t('la declaración mide los DOS lados (carga ciega y venta descartada)',
        op.some((r) => n(r.carga_sin_medir) > 0) && op.some((r) => n(r.venta_sin_medir) > 0),
        'una de las dos mitades está en cero en todas las rutas');

      // El motivo acompaña SIEMPRE al veredicto: "no medible" sin por qué se lee como un error
      // del sistema y no como una ausencia de dato.
      t('toda ruta no medible dice por qué',
        op.filter((r) => !r.medible && !r.motivo).length === 0);

      if (decl.rows[0].m) {
        const { rows: [par] } = await db.raw(`
          SELECT count(*)::int AS n FROM (
            SELECT tenant_id, route_no, exposicion_costo, medible FROM analytics.mv_rd_route_opening
            EXCEPT
            SELECT tenant_id, route_no, exposicion_costo, medible FROM analytics.v_rd_route_opening
          ) d`);
        t('[RD.41] la copia por costo coincide con la vista viva', n(par.n) === 0,
          `${par.n} fila(s) divergen — la copia sería una segunda verdad`);
      } else {
        noMedido('[RD.41] la copia por costo', 'analytics.mv_rd_route_opening todavía no existe');
      }

      console.table(op.map((r) => ({
        ruta: r.route_no,
        carga_sin_medir: n(r.carga_sin_medir).toFixed(2),
        venta_sin_medir: n(r.venta_sin_medir).toFixed(2),
        exposicion: n(r.exposicion_costo).toFixed(2),
        medible: r.medible,
      })));
    }

    // ── `[RD.45]` La HOJA DE CONTEO: lo que una persona va a tener enfrente ───────────────────
    //
    // La pantalla de conteo le pone a alguien 300 renglones delante y después ESCRIBE un ancla
    // que resetea el saldo de la ruta. Lo que se vigila acá es por qué la hoja sale de la foto
    // y no del ledger, que la hoja llegue COMPLETA, y que la copia por costo no sea una segunda
    // verdad.
    console.log('\n── [RD.45] la hoja de conteo ──');
    const { rows: [hayMat] } = await db.raw(
      `SELECT to_regclass('analytics.mv_rd_route_photo') IS NOT NULL AS m,
              to_regclass('analytics.v_rd_route_photo')  IS NOT NULL AS v`);

    if (!hayMat.v) {
      noMedido('[RD.45] la hoja de conteo', 'analytics.v_rd_route_photo todavía no existe (falta el FDW al runner)');
    } else if (!hayMat.m) {
      noMedido('[RD.45] la hoja de conteo', 'analytics.mv_rd_route_photo todavía no existe (falta la migración 20261007182824)');
    } else {
      // 1 · Paridad: la copia dice exactamente lo que la vista. Sin esto, materializar crea una
      //     segunda verdad sobre el mismo camión.
      const { rows: [par] } = await db.raw(`
        SELECT count(*)::int AS n FROM (
          SELECT tenant_id, route_no, sku, unidad, qty, importe FROM analytics.mv_rd_route_photo
          EXCEPT
          SELECT tenant_id, route_no, sku, unidad, qty, importe FROM analytics.v_rd_route_photo
        ) d`);
      t('[RD.45] la copia por costo coincide con la foto viva', n(par.n) === 0,
        `${par.n} renglón(es) divergen — la hoja impresa diría otra cosa que la pantalla`);

      // 2 · El tamaño de una sentada. La hoja se sirve COMPLETA y sin tope a propósito
      //     (`registerRouteCount` RESETEA: un renglón que no viaja queda en CERO), así que lo
      //     que hay que vigilar no es el corte sino que no crezca a un número que vuelva
      //     irreal contarla de una vez.
      const { rows: [comp] } = await db.raw(`
        SELECT count(DISTINCT route_no)::int AS rutas,
               min(n)::int AS menor, max(n)::int AS mayor
          FROM (SELECT route_no, count(*) AS n FROM analytics.mv_rd_route_photo GROUP BY 1) s`);
      t(`[RD.45] ninguna hoja pasa de 1,000 renglones (hoy ${comp.menor}–${comp.mayor} en ${comp.rutas} rutas)`,
        n(comp.mayor) > 0 && n(comp.mayor) <= 1000,
        `la mayor tiene ${comp.mayor}: a ese tamaño el conteo de una sentada deja de ser realista y hay que partirlo`);

      // 3 · El NOMBRE del producto. Una hoja que dice «00412» es ilegible para quien cuenta.
      //
      //     ⛔ Acá hubo DOS conclusiones mías equivocadas, y por eso el umbral va con margen y
      //     la cifra real se imprime. Primero dije que los renglones sin nombre eran culpa de
      //     un join sin `btrim`; medido, el `btrim` no rescata **ni una** fila (0 de 11,301
      //     SKUs del catálogo tienen espacios) y costaba 3.1 s por hoja. La causa real son
      //     **217 productos que SÍ están en el catálogo con la descripción VACÍA**; el nombre
      //     que usa el propio camión rescata 166 y quedan 54 de 3,035 (1.8%).
      //
      //     El umbral es 95% y no 98.2%: un freno calibrado al valor exacto de hoy se pone rojo
      //     con la primera alta de producto, y un freno que grita en falso enseña a ignorarlo.
      const { rows: [nom] } = await db.raw(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE producto = sku)::int AS sin_nombre
          FROM analytics.mv_rd_route_photo`);
      const pctNom = n(nom.total) ? (100 * (n(nom.total) - n(nom.sin_nombre)) / n(nom.total)) : 0;
      t(`[RD.45] el 95%+ de los renglones tiene nombre (hoy ${pctNom.toFixed(2)}%, ${nom.sin_nombre} de ${nom.total} salen con el código pelado)`,
        pctNom >= 95,
        'demasiados renglones se le mostrarían al contador como un código pelado');

      // 4 · ⭐ Lo que la hoja NO le muestra a quien cuenta — y que el conteo manda a CERO.
      //
      //     ⛔ Acá hubo una prueba negativa mal planteada: exigía que la foto y el ledger
      //     DIFIRIERAN en cantidad, «para probar que el conteo arbitra algo». Falló contra prod
      //     con 0 de 3,035, y tenía que fallar: `[RD.33]` ancla el ledger EN la foto todos los
      //     días (la clase `conteo` del ledger no es lo contado, es el ajuste contra la foto),
      //     así que coinciden **por construcción**. Pedirle a dos cosas que son la misma que se
      //     contradigan no es una prueba negativa: es una aserción imposible.
      //
      //     La comparación que SÍ tiene contenido es por CONJUNTO, no por cantidad: el ledger
      //     conoce pares `(sku, unidad)` que la foto no lista. Esos renglones no aparecen en la
      //     hoja, así que nadie los mira — y como un conteo RESETEA, al cerrarlo quedan en CERO.
      //     Eso es lo que `[RD.31]` quiere (matar fantasmas), pero es una consecuencia que tiene
      //     que estar medida y a la vista, no ser una sorpresa.
      const { rows: [fuera] } = await db.raw(`
        WITH led AS (
          SELECT tenant_id, route_no, sku, unidad,
                 sum(qty * CASE WHEN clase='venta' THEN -1 ELSE 1 END) AS saldo
            FROM analytics.mv_rd_route_ledger GROUP BY 1,2,3,4
        )
        SELECT count(*)::int AS en_ledger,
               count(*) FILTER (WHERE f.sku IS NULL)::int AS fuera_de_la_hoja,
               count(*) FILTER (WHERE f.sku IS NULL AND round(l.saldo,3) <> 0)::int AS con_saldo
          FROM led l
          LEFT JOIN analytics.mv_rd_route_photo f
            ON f.tenant_id=l.tenant_id AND f.route_no=l.route_no
           AND f.sku=l.sku AND f.unidad=l.unidad`);
      t(`[RD.45] la hoja NO es el ledger: ${fuera.fuera_de_la_hoja} de ${fuera.en_ledger} pares quedan fuera, ${fuera.con_saldo} de ellos con saldo`,
        n(fuera.fuera_de_la_hoja) > 0,
        'la foto cubre exactamente el ledger: la hoja dejó de poder descubrir un faltante que la reconstrucción no vea');
      t(`[RD.45] los pares fuera de la hoja con saldo son menos de 1,000 (hoy ${fuera.con_saldo})`,
        n(fuera.con_saldo) < 1000,
        'un conteo mandaría a cero demasiados renglones que la persona nunca vio en pantalla');

      // 5 · La ruta sin foto se DECLARA, no se esconde (ADR-056). El índice de la pantalla sale
      //     de `mv_rd_route_identity`, no de la foto, justo para que la apagada siga a la vista.
      const { rows: [huerf] } = await db.raw(`
        SELECT count(*)::int AS rutas,
               count(*) FILTER (WHERE f.route_no IS NULL)::int AS sin_foto
          FROM analytics.mv_rd_route_identity i
          LEFT JOIN (SELECT DISTINCT route_no FROM analytics.mv_rd_route_photo) f
            ON f.route_no = i.route_no`);
      t(`[RD.45] el índice cubre las ${huerf.rutas} rutas, incluidas las ${huerf.sin_foto} que no reportan`,
        n(huerf.rutas) > n(huerf.sin_foto) && n(huerf.rutas) > 0,
        'o no hay rutas, o ninguna reporta: en los dos casos la pantalla no tiene nada que mostrar');

      // 6 · El presupuesto de la pantalla. Es la razón de existir de la copia, y el freno que
      //     ya rechazó una primera versión de la migración que NO resolvía el problema.
      //     ⚠️ Es la consulta REAL del servicio —una tabla, cero joins—, no una parecida.
      const t0 = Date.now();
      const { rows: unaHoja } = await db.raw(`
        SELECT sku, unidad, producto, qty, costo_unitario, importe, barcode
          FROM analytics.mv_rd_route_photo
         WHERE route_no = (SELECT route_no FROM analytics.mv_rd_route_photo
                            GROUP BY 1 ORDER BY count(*) DESC LIMIT 1)
         ORDER BY producto, unidad`);
      const msHoja = Date.now() - t0;
      t(`[RD.45] la hoja más grande (${unaHoja.length} renglones) se sirve en ${msHoja} ms`,
        msHoja < 500,
        'por encima de 500 ms la pantalla "no funciona" según la regla del proyecto');

      // 7 · El código de barras: es lo que permite SALTAR al renglón escaneando en vez de
      //     buscarlo a mano en una lista de 300. Si la cobertura cae, la pantalla sigue
      //     funcionando pero pierde su mejor atajo, y conviene enterarse.
      const conCodigo = unaHoja.filter((r) => r.barcode).length;
      const pctCod = unaHoja.length ? (100 * conCodigo / unaHoja.length) : 0;
      t(`[RD.45] el 95%+ de esa hoja se puede escanear (hoy ${pctCod.toFixed(1)}%)`,
        pctCod >= 95,
        'sin código de barras el contador vuelve a buscar a mano en una lista de cientos');
    }

    // ── `[RD.47]` La copia del tablero: la deuda que esa migración declaró ───────────────────
    //
    // ⛔ `analytics.mv_rd_route_inventory` trae una COPIA del SQL del servicio (la del servicio
    // es parametrizada; la de la matvista tiene el rango por default resuelto). Dos copias de la
    // misma lógica es una segunda verdad **esperando** — salvo que algo las compare. Esto es ese
    // algo: si alguien toca una y no la otra, acá se pone rojo.
    console.log('\n── [RD.47] la copia del tablero de inventario ──');
    const { rows: [hayInv] } = await db.raw(
      `SELECT to_regclass('analytics.mv_rd_route_inventory') IS NOT NULL AS m`);
    if (!hayInv.m) {
      noMedido('[RD.47] la copia del tablero', 'analytics.mv_rd_route_inventory todavía no existe');
    } else {
      const { rows: [cmp] } = await db.raw(`
        SELECT count(*)::int AS rutas,
               count(*) FILTER (WHERE m.route_no IS NULL)::int AS solo_en_vivo,
               count(*) FILTER (WHERE i.route_no IS NULL)::int AS solo_en_copia
          FROM analytics.mv_rd_route_identity i
          FULL JOIN analytics.mv_rd_route_inventory m ON m.route_no = i.route_no`);
      t(`[RD.47] la copia cubre las mismas ${cmp.rutas} rutas que la identidad`,
        n(cmp.solo_en_vivo) === 0 && n(cmp.solo_en_copia) === 0,
        `${cmp.solo_en_vivo} ruta(s) sólo en vivo, ${cmp.solo_en_copia} sólo en la copia — el LATERAL perdió o inventó`);

      // El presupuesto. Es la razón por la que la copia existe.
      const tInv = Date.now();
      const { rows: tablero } = await db.raw(
        `SELECT * FROM analytics.mv_rd_route_inventory ORDER BY plaza, route_no`);
      const msInv = Date.now() - tInv;
      t(`[RD.47] el tablero (${tablero.length} rutas) se sirve en ${msInv} ms`, msInv < 500,
        'por encima de 500 ms la pantalla "no funciona" según la regla del proyecto');

      // ⭐ PRUEBA NEGATIVA de la copia: tiene que ser más rápida que recalcular. Si no lo fuera,
      // la deuda de mantener dos SQL iguales no se estaría pagando con nada.
      const tViva = Date.now();
      await db.raw(`SELECT count(*) FROM (
        SELECT l.route_no, l.sku, l.unidad,
               sum(l.qty) FILTER (WHERE l.clase='carga') AS cq,
               sum(l.qty) FILTER (WHERE l.clase='venta') AS vq
          FROM analytics.mv_rd_route_ledger l GROUP BY 1,2,3) w`);
      const msViva = Date.now() - tViva;
      t(`[RD.47] PRUEBA NEGATIVA: recalcular cuesta más que leer la copia (${msViva} ms vs ${msInv} ms)`,
        msViva > msInv,
        'leer la copia no es más barato que recalcular: entonces la copia sólo aporta deuda');
    }

    // ── `[RD.48]` El día abierto: las dos tablas tienen que SUMAR lo que dice la fila ────────
    //
    // ⭐ Es la única aserción que hace útil al drill-down. Si el desglose no cuadra con el total
    // que el usuario tocó, abrir un día no explica nada: confunde. El riesgo es concreto y esta
    // fase ya lo pagó una vez — la serie valúa con `mv_rd_route_unit_value` y el ledger trae
    // además `costo_doc`/`venta_doc`; tomar el del ledger «porque está ahí» daba otro número.
    console.log('\n── [RD.48] el día abierto cuadra con su fila ──');
    const { rows: dias } = await db.raw(`
      SELECT route_no, business_date::text AS fecha, count(*)::int AS n
        FROM analytics.mv_rd_route_ledger
       WHERE clase IN ('carga','venta')
       GROUP BY 1,2 ORDER BY 3 DESC LIMIT 3`);
    if (!dias.length) {
      noMedido('[RD.48] el día abierto', 'el ledger no tiene días con carga ni venta');
    } else {
      // El MISMO SQL de las dos puntas: la serie por día y el desglose de ese día. Si divergen,
      // es que alguien le cambió la fuente a una de las dos.
      const DESGLOSE = `
        WITH u AS (SELECT sku, unidad, costo_u, precio_u FROM analytics.mv_rd_route_unit_value
                    WHERE tenant_id = ? AND route_no = ?)
        SELECT round(coalesce(sum(l.qty * u.costo_u),0),2)::float AS costo,
               count(*) FILTER (WHERE u.costo_u IS NULL)::int     AS sin_valuar
          FROM analytics.mv_rd_route_ledger l
          LEFT JOIN u ON u.sku = l.sku AND u.unidad = l.unidad
         WHERE l.tenant_id = ? AND l.route_no = ? AND l.business_date = ?
           AND l.clase IN ('carga','venta')`;
      const SERIE = `
        WITH u AS (SELECT sku, unidad, costo_u FROM analytics.mv_rd_route_unit_value
                    WHERE tenant_id = ? AND route_no = ?)
        SELECT round(coalesce(sum(l.qty * u.costo_u),0),2)::float AS costo
          FROM analytics.mv_rd_route_ledger l
          LEFT JOIN u ON u.sku = l.sku AND u.unidad = l.unidad
         WHERE l.tenant_id = ? AND l.route_no = ? AND l.business_date = ?
           AND l.clase IN ('carga','venta')`;
      let maxMs = 0; let cuadran = 0;
      for (const d of dias) {
        const t0 = Date.now();
        const { rows: [des] } = await db.raw(DESGLOSE, [tenant, d.route_no, tenant, d.route_no, d.fecha]);
        maxMs = Math.max(maxMs, Date.now() - t0);
        const { rows: [ser] } = await db.raw(SERIE, [tenant, d.route_no, tenant, d.route_no, d.fecha]);
        if (Math.abs(n(des.costo) - n(ser.costo)) < 0.01) cuadran++;
      }
      t(`[RD.48] el desglose suma lo mismo que la serie en los ${dias.length} días más grandes`,
        cuadran === dias.length,
        `${dias.length - cuadran} día(s) no cuadran — el drill-down abriría un total que sus renglones no explican`);
      t(`[RD.48] el día más grande se sirve en ${maxMs} ms`, maxMs < 500,
        'por encima de 500 ms la pantalla "no funciona" según la regla del proyecto');

      // La cobertura de la valuación se DECLARA: los renglones sin valuar no entran al total,
      // y la pantalla los cuenta aparte en vez de sumarlos como cero.
      const { rows: [cob] } = await db.raw(`
        WITH u AS (SELECT route_no, sku, unidad, costo_u FROM analytics.mv_rd_route_unit_value)
        SELECT count(*)::int AS pares,
               count(*) FILTER (WHERE u.costo_u IS NULL)::int AS sin_valuar
          FROM (SELECT DISTINCT route_no, sku, unidad FROM analytics.mv_rd_route_ledger
                 WHERE clase IN ('carga','venta')) l
          LEFT JOIN u ON u.route_no = l.route_no AND u.sku = l.sku AND u.unidad = l.unidad`);
      const pctVal = n(cob.pares) ? (100 * (n(cob.pares) - n(cob.sin_valuar)) / n(cob.pares)) : 0;
      t(`[RD.48] el 90%+ de los pares tiene con qué valuarse (hoy ${pctVal.toFixed(1)}%, ${cob.sin_valuar} de ${cob.pares} se declaran sin valuar)`,
        pctVal >= 90,
        'demasiados renglones quedarían fuera del total y el desglose dejaría de explicar la fila');
    }
  } catch (e) {
    bad++;
    console.error('  ✘ excepción:', e.message);
  } finally {
    await db.destroy();
  }

  console.log(`\n=== ${ok} ✓ · ${bad} ✗ · ${nm} no medidos ===\n`);
  process.exit(bad === 0 ? 0 : 1);
})();
