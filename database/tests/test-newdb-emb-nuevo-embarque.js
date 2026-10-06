/* eslint-disable no-console */
/**
 * EMB.12 smoke — «Nuevo embarque» toma el viaje de Kepler: las vistas que lo alimentan y el
 * candado que impide tomar una guía dos veces.
 *
 *   0. CONTRATO. Las tres relaciones nuevas son VISTAS (derive-no-copy), y `logistics.shipments`
 *      tiene la llave de la guía + su índice único parcial.
 *   1. NO DUPLICACIÓN. `erp_shipment_stops` tiene una fila por documento, igual que la cabecera de
 *      EMB.0 — se compara contra la cabecera, no contra sí misma.
 *   2. LA RUTA POR DOMICILIO. El embarque no trae ruta; el domicilio de entrega sí. Medido el
 *      2026-10-05 en las sucursales 01 y 06: 100%. Se exige ≥ 95% y se imprime lo medido.
 *   3. LA CARGA, contra una suma INDEPENDIENTE de los renglones (otra consulta, otra forma), y
 *      anclada en la guía 0001419 de Canindo (13 paradas, 190 cajas, 85 sueltos, 39 kg) cuando
 *      está en el destino.
 *   4. EL CANDADO. Dentro de una transacción que se deshace: la misma guía no entra dos veces;
 *      cancelada sí se puede volver a tomar; y la llave va completa o no va. PRUEBA NEGATIVA:
 *      sin el índice, la segunda inserción pasaría — por eso se comprueba que FALLE.
 *
 * Uso:  node database/tests/test-newdb-emb-nuevo-embarque.js
 *       DATABASE_URL_NEW=<url>  (o --prod para leer FLEET_DB_URL; en prod no se escribe nada)
 */
require('dotenv').config();
const { Client } = require('pg');
const { correr, noMedido } = require('./_lib/no-medido');

const PROD = process.argv.includes('--prod');
const URL = PROD ? process.env.FLEET_DB_URL : process.env.DATABASE_URL_NEW;
const M = '00000000-0000-0000-0000-00000000d01c';

let assertions = 0;
function assert(cond, msg) {
  assertions++;
  if (!cond) throw new Error('ASSERT FAIL: ' + msg);
  console.log('  ✓ ' + msg);
}
const n = (v) => Number(v ?? 0);

correr(async () => {
  if (!URL) noMedido(`falta ${PROD ? 'FLEET_DB_URL' : 'DATABASE_URL_NEW'} en el entorno`);
  const db = new Client({ connectionString: URL, ssl: PROD ? { rejectUnauthorized: false } : undefined });
  await db.connect();
  const q = async (sql, args) => (await db.query(sql, args)).rows;

  try {
    const [{ db: dbname }] = await q('SELECT current_database() AS db');
    console.log(`\n=== EMB.12 — Nuevo embarque desde Kepler · destino ${dbname} ===\n`);

    // ── 0. Contrato ────────────────────────────────────────────────────────────────────────
    console.log('── 0. Contrato: vistas en vivo + llave de la guía en logistics.shipments');
    const rels = await q(`
      SELECT c.relname, c.relkind::text AS kind FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
       WHERE ns.nspname = 'analytics' AND c.relname IN ('erp_shipment_stops','erp_shipment_stop_load','v_kepler_responsables')`);
    if (rels.length === 0) noMedido('las vistas de EMB.12 no están en este destino (migración 20261006150000 sin aplicar)');
    assert(rels.length === 3 && rels.every((r) => r.kind === 'v'), 'las 3 relaciones existen y son VISTAS, no copias');
    const cols = (await q(`SELECT column_name FROM information_schema.columns
       WHERE table_schema='logistics' AND table_name='shipments' AND column_name IN ('kepler_sucursal','kepler_guia','delivery_type')`))
      .map((r) => r.column_name).sort();
    assert(cols.join(',') === 'delivery_type,kepler_guia,kepler_sucursal', 'logistics.shipments tiene kepler_sucursal, kepler_guia y delivery_type');
    const [idx] = await q(`SELECT indexdef FROM pg_indexes WHERE schemaname='logistics' AND indexname='ux_logistics_shipments_kepler_guia'`);
    assert(idx && /UNIQUE/.test(idx.indexdef) && /status.*<>.*'cancelado'/.test(idx.indexdef),
      'índice único parcial: una guía activa por tenant (las canceladas no cuentan)');

    // ── 1. No duplicación ──────────────────────────────────────────────────────────────────
    console.log('\n── 1. Una fila por documento, igual que la cabecera de EMB.0');
    const [par] = await q(`
      SELECT (SELECT count(*) FROM analytics.erp_shipment_stops) AS paradas,
             (SELECT count(DISTINCT (sucursal, serie, folio)) FROM analytics.erp_shipment_stops) AS llaves,
             (SELECT count(*) FROM analytics.erp_shipment_headers) AS cabecera`);
    if (n(par.cabecera) === 0) noMedido('no hay embarques U-D-41 en kepler_ods.kdm1 de este destino');
    assert(n(par.paradas) === n(par.llaves), `sin duplicados — ${par.paradas} filas, ${par.llaves} llaves`);
    assert(n(par.paradas) === n(par.cabecera), `mismas paradas que la cabecera de EMB.0 (${par.paradas} = ${par.cabecera})`);

    // ── 2. Ruta por domicilio ──────────────────────────────────────────────────────────────
    console.log('\n── 2. La ruta sale del domicilio de entrega');
    const metodos = await q(`SELECT ruta_metodo, count(*)::int AS n FROM analytics.erp_shipment_stops GROUP BY 1 ORDER BY 2 DESC`);
    const total = metodos.reduce((a, r) => a + r.n, 0);
    const conRuta = metodos.find((r) => r.ruta_metodo === 'domicilio')?.n ?? 0;
    console.log(`     medido: ${metodos.map((r) => `${r.ruta_metodo}=${r.n}`).join(' · ')}`);
    assert(conRuta / total >= 0.95, `≥ 95% de las paradas resuelve su ruta por domicilio (${(100 * conRuta / total).toFixed(1)}%)`);
    const [sup] = await q(`
      SELECT count(*) FILTER (WHERE s.domicilio_supuesto AND NULLIF(btrim(h.c85),'') IS NOT NULL)::int AS mal_marcado,
             count(*) FILTER (WHERE NOT s.domicilio_supuesto AND NULLIF(btrim(h.c85),'') IS NULL)::int AS sin_marcar
        FROM analytics.erp_shipment_stops s
        JOIN kepler_ods.kdm1 h ON btrim(h.sucursal) = s.sucursal AND (h.c5)::int = s.serie AND btrim(h.c6) = s.folio
                              AND h.c2='U' AND h.c3='D' AND (h.c4)::int = 41`);
    assert(n(sup.mal_marcado) === 0 && n(sup.sin_marcar) === 0,
      'domicilio_supuesto se enciende EXACTAMENTE cuando kdm1.c85 viene vacío (lo supuesto se declara)');

    // ── 3. La carga ────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. Cajas y sueltos, contra una suma independiente de los renglones');
    const [cuadre] = await q(`
      WITH muestra AS (SELECT sucursal, serie, folio FROM analytics.erp_shipment_stops ORDER BY sucursal, serie, folio LIMIT 200),
      directo AS (
        SELECT m.sucursal, m.serie, m.folio,
               coalesce(sum(CASE WHEN upper(btrim(l.c55)) IN ('CJA','BTO') THEN nullif(btrim(l.c54),'')::numeric END), 0) AS cajas,
               coalesce(sum(CASE WHEN nullif(btrim(l.c55),'') IS NOT NULL AND upper(btrim(l.c55)) NOT IN ('CJA','BTO')
                                 THEN nullif(btrim(l.c54),'')::numeric END), 0) AS sueltos
          FROM muestra m
          JOIN kepler_ods.kdm2 l ON btrim(l.sucursal) = m.sucursal AND (l.c5)::int = m.serie AND btrim(l.c6) = m.folio
                                AND l.c2='U' AND l.c3='D' AND (l.c4)::int = 41
         GROUP BY 1, 2, 3)
      SELECT count(*)::int AS comparadas,
             count(*) FILTER (WHERE v.cajas IS DISTINCT FROM d.cajas OR v.sueltos IS DISTINCT FROM d.sueltos)::int AS difieren
        FROM directo d JOIN analytics.erp_shipment_stop_load v USING (sucursal, serie, folio)`);
    if (n(cuadre.comparadas) === 0) noMedido('no hay renglones de embarque (kdm2) en este destino');
    assert(n(cuadre.difieren) === 0, `la vista de carga cuadra con la suma directa en ${cuadre.comparadas} paradas`);

    const [ancla] = await q(`
      SELECT count(*)::int AS paradas, sum(l.cajas)::numeric AS cajas, sum(l.sueltos)::numeric AS sueltos,
             sum(l.kg)::numeric AS kg, count(DISTINCT s.ruta_clave)::int AS rutas, count(DISTINCT s.cliente_code)::int AS clientes
        FROM analytics.erp_shipment_stops s
        LEFT JOIN analytics.erp_shipment_stop_load l USING (sucursal, serie, folio)
       WHERE s.sucursal = '06' AND s.guia_embarque = '0001419'`);
    if (n(ancla.paradas) === 0) {
      console.log('  ⓘ ancla 06-G0001419 NO MEDIDA en este destino (la guía no está cargada)');
    } else {
      assert(n(ancla.paradas) === 13 && n(ancla.cajas) === 190 && n(ancla.sueltos) === 85 && n(ancla.kg) === 39,
        `ancla 06-G0001419: 13 paradas · 190 cajas · 85 sueltos · 39 kg (${ancla.paradas} · ${ancla.cajas} · ${ancla.sueltos} · ${ancla.kg})`);
      assert(n(ancla.rutas) === 4 && n(ancla.clientes) === 7, `ancla 06-G0001419: 4 rutas y 7 clientes (${ancla.rutas} y ${ancla.clientes})`);
    }

    // ── 4. El candado (sólo fuera de prod, y dentro de una transacción que se deshace) ──────
    if (PROD) {
      console.log('\n── 4. Candado: NO MEDIDO en --prod (no se escribe en producción)');
    } else {
      console.log('\n── 4. La misma guía no se toma dos veces (transacción que se deshace)');
      await db.query('BEGIN');
      try {
        const alta = (folio, status = 'programado', suc = '99', guia = '9999999') => db.query(
          `INSERT INTO logistics.shipments (tenant_id, folio, shipment_date, type, status, kepler_sucursal, kepler_guia)
           VALUES ($1, $2, current_date, 'entrega', $3, $4, $5)`, [M, folio, status, suc, guia]);
        await alta('EMB-PRUEBA-00001');
        let error = null;
        await db.query('SAVEPOINT s1');
        try { await alta('EMB-PRUEBA-00002'); } catch (e) { error = e; await db.query('ROLLBACK TO SAVEPOINT s1'); }
        assert(error && error.code === '23505', 'PRUEBA NEGATIVA: la segunda toma de la misma guía FALLA (23505)');

        await db.query(`UPDATE logistics.shipments SET status='cancelado' WHERE folio='EMB-PRUEBA-00001'`);
        await alta('EMB-PRUEBA-00003');
        assert(true, 'con la primera cancelada, la guía se puede volver a tomar');

        let par = null;
        await db.query('SAVEPOINT s2');
        try { await alta('EMB-PRUEBA-00004', 'programado', '99', null); } catch (e) { par = e; await db.query('ROLLBACK TO SAVEPOINT s2'); }
        assert(par && par.code === '23514', 'la llave va completa o no va: sucursal sin guía se rechaza (23514)');
      } finally {
        await db.query('ROLLBACK');
      }
      const [{ quedaron }] = await q(`SELECT count(*)::int AS quedaron FROM logistics.shipments WHERE folio LIKE 'EMB-PRUEBA-%'`);
      assert(quedaron === 0, 'la prueba no dejó residuos');
    }

    console.log(`\n✅ EMB.12 — ${assertions} aserciones en verde\n`);
  } finally {
    await db.end();
  }
});
