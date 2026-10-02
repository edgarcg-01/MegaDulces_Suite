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
      PRE = `WITH _ident AS (SELECT * FROM analytics.v_rd_route_identity),
                  LEDGER AS (SELECT * FROM analytics.v_rd_route_ledger) `;
    } else {
      console.log('  ⓘ las vistas NO están aplicadas → se ejerce el SELECT de la migración\n');
      const { ident, ledger } = await cuerposDeLaMigracion();
      PRE = `WITH _ident AS (${ident}), LEDGER AS (${ledger}) `;
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
    const CUADRE = `${PRE}, win AS (
        SELECT route_no, sku, unidad,
               sum(qty)       FILTER (WHERE clase='carga') cq,
               sum(costo_doc) FILTER (WHERE clase='carga') cv,
               sum(qty)       FILTER (WHERE clase='venta') vq,
               sum(venta_doc) FILTER (WHERE clase='venta') vi,
               sum(costo_erp) FILTER (WHERE clase='venta') ce
          FROM LEDGER WHERE tenant_id = ? GROUP BY 1,2,3
      ), val AS (
        SELECT w.*, w.cv/nullif(w.cq,0) costo_u, w.vi/nullif(w.vq,0) precio_u,
               coalesce(w.cq,0)-coalesce(w.vq,0) saldo FROM win w
      )
      SELECT route_no,
             round(sum(cq*costo_u),2) carga_costo,
             round(sum(coalesce(vq,0)*costo_u),2) cogs_costo,
             round(sum(saldo*costo_u),2) inv_costo,
             round(sum(cq*costo_u) - sum(coalesce(vq,0)*costo_u) - sum(saldo*costo_u),2) delta_costo,
             round(sum(coalesce(cq,0)*precio_u),2) carga_venta,
             round(sum(vi),2) venta_cliente,
             round(sum(saldo*precio_u),2) inv_venta,
             round(sum(coalesce(cq,0)*precio_u) - sum(vi) - sum(saldo*precio_u),2) delta_venta,
             round(sum(ce),2) cogs_erp,
             count(*) FILTER (WHERE saldo>0) pos, count(*) FILTER (WHERE saldo<0) neg
        FROM val GROUP BY 1 ORDER BY 1`;
    const cuadre = (await db.raw(CUADRE, [tenant])).rows;

    t('el cuadre devuelve las 11 rutas', cuadre.length === 11, `devolvió ${cuadre.length}`);
    const malCosto = cuadre.filter((r) => Math.abs(n(r.delta_costo)) >= 0.01);
    t('COLUMNA COSTO: carga − COGS − inventario = 0 en las 11 rutas', malCosto.length === 0,
      malCosto.map((r) => `${r.route_no}:${r.delta_costo}`).join(' '));
    const malVenta = cuadre.filter((r) => Math.abs(n(r.delta_venta)) >= 0.01);
    t('COLUMNA VENTA: carga − venta a cliente − inventario = 0 en las 11 rutas', malVenta.length === 0,
      malVenta.map((r) => `${r.route_no}:${r.delta_venta}`).join(' '));
    t('toda ruta mueve dinero (ninguna columna de carga en cero)',
      cuadre.every((r) => n(r.carga_costo) > 0 && n(r.venta_cliente) > 0));

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
        const r = await db.raw(pg, [tenant, ruta, '2000-01-01', '2999-12-31', tenant]);
        const filas = r.rows || r;
        t('la consulta del DETALLE del servicio corre contra prod', true);
        t('el detalle trae las columnas que la pantalla pinta',
          filas.length === 0 || ['sku', 'unidad', 'producto', 'saldo', 'saldo_costo', 'saldo_venta', 'veredicto']
            .every((c) => c in filas[0]),
          filas.length ? Object.keys(filas[0]).join(',') : 'sin filas');
        t('el detalle resuelve el NOMBRE del producto, no repite el SKU',
          filas.some((f) => f.producto && f.producto !== f.sku),
          'si ninguno resuelve, el join al catálogo está roto');
        const malV = filas.filter((f) => !['ok', 'negativo_sin_ancla', 'sin_costo', 'sin_precio'].includes(f.veredicto));
        t('todo renglón del detalle trae un veredicto conocido', malV.length === 0);
      } catch (e) {
        bad++;
        console.log('  ✘ la consulta del DETALLE del servicio FALLA — ' + e.message);
      }
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
  } catch (e) {
    bad++;
    console.error('  ✘ excepción:', e.message);
  } finally {
    await db.destroy();
  }

  console.log(`\n=== ${ok} ✓ · ${bad} ✗ · ${nm} no medidos ===\n`);
  process.exit(bad === 0 ? 0 : 1);
})();
