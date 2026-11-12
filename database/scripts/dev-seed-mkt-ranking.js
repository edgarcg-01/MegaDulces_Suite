'use strict';
/**
 * `[MKT.11]` Semilla de DESARROLLO para poder VER el ranking de promociones en local.
 *
 * La base local trae una muestra delgada de Kepler (venta hasta mediados de octubre, códigos de
 * promo en una sola sucursal), así que la pantalla saldría vacía. Esto inserta datos SINTÉTICOS
 * —ningún dato real: códigos `DM…`, vendedores ficticios— con la misma forma que Kepler:
 *
 *   · `kepler_ods.kdii`  10 códigos de promo (`= GRATIS`, $0.01) y 4 productos con escalera de caja,
 *                        en las 8 sucursales.
 *   · `catalog.products` esos 14 SKUs (la venta diaria materializada sólo cuenta lo que está en el
 *                        catálogo).
 *   · `kepler_ods.kduv`  vendedores de piso, vecinal, ruta y televenta por sucursal.
 *   · `kepler_ods.kdm1/kdm2` 6 semanas de tickets (mostrador/preventa/ruta) y facturas (mayoreo).
 *   · `commercial.mkt_ranking_*` 8 promos dadas de alta (2 SIN objetivo, para que se vea que eso
 *                        no es cero) y 4 incentivos. DM009 y DM010 quedan SIN alta para probarla.
 *
 * Determinística (mismos números en cada corrida) e idempotente. Al final refresca la venta diaria
 * materializada LOCAL.
 *
 * Uso:   node database/scripts/dev-seed-mkt-ranking.js            (sembrar)
 *        node database/scripts/dev-seed-mkt-ranking.js --limpiar  (borrar todo lo de la semilla)
 *
 * ⛔ Sólo local: se niega a correr contra cualquier otra base.
 */
require('dotenv').config();
const { assertSafeTarget } = require('../tests/_lib/assert-safe-target');
const { Client } = require('pg');

const URL = (process.env.DATABASE_URL_NEW || '').replace('localhost', '127.0.0.1');
const T = '00000000-0000-0000-0000-00000000d01c';
const SUC = ['01', '02', '03', '04', '05', '06', '07', '08'];
const MARCA = 'DEMO (dev-seed-mkt-ranking)';

/** Códigos de promo: [sku, descripción, venta diaria media por sucursal en mostrador]. */
const PROMOS = [
  ['DM001', '3 LECHES DEMO 1LT = GRATIS 1 MAS', 3.2],
  ['DM002', '2 EXH CHOC DEMO = GRATIS 1 BOLSA CARAMELO', 4.5],
  ['DM003', '5 EXH CHICLE DEMO = GRATIS 1 EXH', 1.6],
  ['DM004', '3 PROD GALLETA DEMO = GRATIS 1 STICK', 1.1],
  ['DM005', '4 BOLSAS DULCE DEMO = GRATIS 1 BOLSA', 0.8],
  ['DM006', '1 BOLSON BOTANA DEMO = GRATIS 1 MINI', 2.4],
  ['DM007', '$150 DEMO TAPATIA = GRATIS 1 MINI BARRA', 0.4],
  ['DM008', '2 EXH WAFER DEMO = GRATIS 1 EXH', 1.9],
  ['DM009', '10 BLS PAQUETE DEMO = GRATIS 1 BLS', 0.7],
  ['DM010', '3 REJAS REFRESCO DEMO = GRATIS 1 REJA', 0.5],
];
/** Productos para incentivos: [sku, nombre, u1, u2, factor caja, precio pieza, venta diaria]. */
const PRODUCTOS = [
  ['DM101', 'CHOC DEMO SPORT 1KG', 'PAQ', 'CJA', 14, 190, 2.2],
  ['DM102', 'PALANQUETA DEMO GRANDE /20', 'PAQ', 'CJA', 20, 56, 3.1],
  ['DM103', 'PALETA DEMO COLOMBA 40P', 'PZA', 'CJA', 24, 45, 6],
  ['DM104', 'CARAMELO DEMO COLOMBA BOLSA', 'PZA', 'CJA', 30, 38, 5],
];
/**
 * `[MKT.15]` El producto que activa cada promo (Kepler no guarda la liga: se deriva del ticket).
 * [sku, nombre, factor caja, precio pieza, promo, piezas por cada vez que se aplica]. El nombre
 * comparte una palabra con la promo (no «DEMO»). DM009 NO tiene producto: debe salir «sin identificar».
 */
const DISPARADORES = [
  ['DM201', 'LECHE ENTERA LT /12', 12, 26, 'DM001', 2],
  ['DM202', 'LECHE DESLACTOSADA LT /12', 12, 28, 'DM001', 1],
  ['DM203', 'CHOC LUNA EXH /24', 24, 9, 'DM002', 2],
  ['DM204', 'CHICLE MENTA EXH /40', 40, 4, 'DM003', 5],
  ['DM205', 'GALLETA MARIA PAQ /10', 10, 18, 'DM004', 3],
  ['DM206', 'DULCE TAMARINDO BOLSA 1KG', 10, 65, 'DM005', 4],
  ['DM207', 'BOTANA MIX BOLSON 500G', 12, 48, 'DM006', 1],
  ['DM208', 'TAPATIA BARQUILLO /20', 20, 7, 'DM007', 20],
  ['DM209', 'WAFER FRESA EXH /12', 12, 30, 'DM008', 2],
  ['DM210', 'REFRESCO COLA 600ML /24', 24, 17, 'DM010', 3],
];
/**
 * [MKT.18] Personas del reloj checador de cada sucursal (nombres INVENTADOS: el repo es público).
 * [clave del reloj, nombre, promotora]. La cuarta no vende: sirve para ver que la lista trae a todos.
 */
const PERSONAS = [['901', 'VENDEDORA DEMO A', false], ['902', 'VENDEDORA DEMO B', false], ['903', 'PROMOTORA DEMO C', true], ['904', 'ALMACEN DEMO D', false]];
const MARCA_HR = 'DEMO-MKT';
/** Los sitios del reloj van en minúsculas (CHECK de hr.attendance_sites). */
const SITIO = 'demo-mkt';
/** Apertura del turno de mostrador de una sucursal en un día (kdpv_folio_caja.c3 = kdm1.c80). */
const aperturaDe = (s, d) => 900000 + Number(s) * 1000 + (Math.floor(Date.parse(d) / 86400000) % 1000);
/** Clave de la cajera del turno: en 01 es el usuario local demo_flujo, para probar «sólo mis turnos». */
const cajeraDe = (s) => (s === '01' ? 'DEMO_FLUJO' : `CAJERA_DEMO_${s}`);
/** Qué tanto vende cada sucursal (para que el ranking tenga forma). */
const PESO = { '01': 1.6, '02': 0.7, '03': 1.1, '04': 0.5, '05': 0.6, '06': 1.3, '07': 0.9, '08': 1.5 };
const CANALES = [
  // [canal, doc Kepler, sufijo de caja, vendedor (código, nombre), proporción de la venta de mostrador]
  ['mostrador', 10, 91, (s) => [`DMP${s}`, `SUC DEMO ${s} PISO`], 1],
  ['preventa', 10, 92, (s) => [`${Number(s)}V0${s}`, `RUTA VECINAL DEMO ${s}`], 0.45],
  ['ruta', 10, 93, (s) => [`DMR${s}`, `RUTA DEMO ${s}1`], 0.35],
  ['mayoreo', 8, 94, (s) => [`DMT${s}`, `TLMKT DEMO ${s}`], 0.3],
];

// PRNG determinístico (mulberry32): la misma semilla da los mismos números.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Poisson barato: cuántas veces se aplicó la promo en el día. */
function poisson(r, media) {
  const L = Math.exp(-media);
  let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L && k < 60);
  return k - 1;
}
const hoyMx = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
const dia = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const lunes = (ymd) => { const d = new Date(ymd + 'T00:00:00Z'); return dia(ymd, -((d.getUTCDay() || 7) - 1)); };

async function limpiar(c) {
  await c.query(`DELETE FROM commercial.mkt_ranking_promos WHERE notas = $1`, [MARCA]);
  await c.query(`DELETE FROM commercial.mkt_incentives WHERE notas = $1`, [MARCA]);
  // [MKT.18] turnos, reloj checador y quién vendió
  await c.query(`DELETE FROM commercial.mkt_promo_ticket_sellers WHERE folio LIKE 'DM%'`);
  await c.query(`DELETE FROM kepler_ods.kdpv_folio_caja WHERE c13 = $1`, [MARCA_HR]);
  await c.query(`DELETE FROM hr.attendance_logs WHERE device_id IN (SELECT id FROM hr.attendance_devices WHERE serial_number LIKE $1)`, [`${MARCA_HR}-%`]);
  await c.query(`DELETE FROM hr.device_enrollments WHERE device_id IN (SELECT id FROM hr.attendance_devices WHERE serial_number LIKE $1)`, [`${MARCA_HR}-%`]);
  await c.query(`DELETE FROM hr.person_site_profiles WHERE site_code LIKE $1`, [`${SITIO}-%`]);
  await c.query(`DELETE FROM hr.attendance_devices WHERE serial_number LIKE $1`, [`${MARCA_HR}-%`]);
  await c.query(`DELETE FROM hr.attendance_sites WHERE code LIKE $1`, [`${SITIO}-%`]);
  await c.query(`DELETE FROM kepler_ods.kdm2 WHERE c6 LIKE 'DM%'`);
  await c.query(`DELETE FROM kepler_ods.kdm1 WHERE c6 LIKE 'DM%'`);
  await c.query(`DELETE FROM kepler_ods.kduv WHERE c2 LIKE 'DM%' OR c3 LIKE '%DEMO%'`);
  await c.query(`DELETE FROM kepler_ods.kdii WHERE c1 LIKE 'DM%'`);
  await c.query(`DELETE FROM catalog.products WHERE tenant_id = $1 AND sku LIKE 'DM%'`, [T]);
}

(async () => {
  assertSafeTarget('dev-seed-mkt-ranking', { url: URL });
  const u = new globalThis.URL(URL);
  if (u.hostname !== '127.0.0.1') throw new Error('Sólo corre contra la base local (127.0.0.1)');
  const c = new Client({ connectionString: URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    await limpiar(c);
    if (process.argv.includes('--limpiar')) {
      await c.query('COMMIT');
      await c.query('REFRESH MATERIALIZED VIEW analytics.mv_kepler_sales_daily');
      console.log('✓ semilla borrada');
      return;
    }

    // ── catálogo ──
    const marca = (await c.query(`SELECT id FROM catalog.brands WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [T])).rows[0];
    if (!marca) throw new Error('No hay ninguna marca en catalog.brands local');
    for (const [sku, nombre] of [...PROMOS.map((p) => [p[0], p[1]]), ...PRODUCTOS.map((p) => [p[0], p[1]]), ...DISPARADORES.map((p) => [p[0], p[1]])]) {
      await c.query(
        `INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre, is_promo, activo) VALUES ($1, $2, $3, $4, $5, true)`,
        [T, marca.id, sku, nombre, sku < 'DM100']);
    }
    for (const s of SUC) {
      for (const [sku, nombre] of PROMOS) {
        await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c11, c90) VALUES ($1, $2, $3, 'PZA', 0.01)`, [s, sku, nombre]);
      }
      for (const [sku, nombre, u1, u2, f, pv] of PRODUCTOS) {
        // Costos y precios coherentes con el factor: la escalera de Kepler los compara.
        const costo = Math.round(pv * 0.78 * 100) / 100;
        await c.query(
          `INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c11, c80, c81, c77, c78, c90, c91)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [s, sku, nombre, u1, u2, String(f), String(costo), String(costo * f), String(pv), String(pv * f)]);
      }
      for (const [sku, nombre, f, pv] of DISPARADORES) {
        const costo = Math.round(pv * 0.8 * 100) / 100;
        await c.query(
          `INSERT INTO kepler_ods.kdii (sucursal, c1, c2, c11, c80, c81, c77, c78, c90, c91)
           VALUES ($1, $2, $3, 'PZA', 'CJA', $4, $5, $6, $7, $8)`,
          [s, sku, nombre, String(f), String(costo), String(costo * f), String(pv), String(pv * f)]);
      }
      for (const [, , , vend] of CANALES) {
        const [code, name] = vend(s);
        await c.query(`INSERT INTO kepler_ods.kduv (sucursal, c2, c3) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [s, code, name]);
      }
    }

    // ── venta: 6 semanas hasta hoy ──
    const hoy = hoyMx();
    const desde = dia(lunes(hoy), -35);
    const r = rng(20261111);
    let docs = 0, lineas = 0;
    const vendidos = [];

    // ── [MKT.18] turnos de mostrador (kdpv_folio_caja) y reloj checador por sucursal ──
    for (const s of SUC) {
      for (let d = desde; d <= hoy; d = dia(d, 1)) {
        await c.query(
          `INSERT INTO kepler_ods.kdpv_folio_caja (sucursal, c1, c2, c3, c5, c6, c8, c10, c11, c13)
           VALUES ($1, $1, '91', $2, $3, '08:00:00', $4, $5, '20:00:00', $6)`,
          [s, aperturaDe(s, d), d, cajeraDe(s), d < hoy ? d : '1800-01-01', MARCA_HR]);
      }
      const site = `${SITIO}-${s}`;
      await c.query(`INSERT INTO hr.attendance_sites (tenant_id, code, name, warehouse_code) VALUES ($1, $2, $3, $4)`, [T, site, `Reloj demo ${s}`, s]);
      const { rows: [dev] } = await c.query(
        `INSERT INTO hr.attendance_devices (tenant_id, serial_number, site_code) VALUES ($1, $2, $3) RETURNING id`, [T, `${MARCA_HR}-SN-${s}`, site]);
      for (const [code, nombre, promotora] of PERSONAS) {
        await c.query(`INSERT INTO hr.device_enrollments (tenant_id, device_id, device_user_id, device_name, person_code) VALUES ($1, $2, $3, $4, $3)`, [T, dev.id, code, nombre]);
        await c.query(`INSERT INTO hr.person_site_profiles (tenant_id, site_code, person_code, is_promoter, is_active) VALUES ($1, $2, $3, $4, true)`, [T, site, code, promotora]);
        for (let k = 1; k <= 5; k++) {
          await c.query(`INSERT INTO hr.attendance_logs (tenant_id, device_id, device_user_id, punched_at, punched_local, source) VALUES ($1, $2, $3, $4::date + time '08:00', $4::date + time '08:00', 'manual')`, [T, dev.id, code, dia(hoy, -k)]);
        }
      }
    }
    for (let d = desde; d <= hoy; d = dia(d, 1)) {
      const semanaIdx = Math.floor((Date.parse(d) - Date.parse(desde)) / (7 * 86400000));
      for (const s of SUC) {
        for (const [canal, doc, caja, vend, prop] of CANALES) {
          const [vcode] = vend(s);
          // 3 documentos por día y canal, con clientes distintos (para «por cliente distinto»).
          for (let k = 1; k <= 3; k++) {
            // Dos tickets: el de las promos (cada promo junto con SU producto, como cobra el cajero)
            // y el de los productos de incentivo, aparte — si compartieran ticket, el barrido de
            // `[MKT.15]` los tomaría por producto de una promo («CHOC DEMO SPORT» ↔ «CHOC DEMO»).
            const promosT = [];
            for (const [sku, desc, media] of PROMOS) {
              // DM009/DM010 sólo venden las últimas 2 semanas: son promos nuevas.
              if ((sku === 'DM009' || sku === 'DM010') && semanaIdx < 4) continue;
              const q = poisson(r, (media * PESO[s] * prop * (0.85 + semanaIdx * 0.05)) / 3);
              if (q <= 0) continue;
              promosT.push([sku, desc, q, 'PZA', 0.01]);
              for (const [psku, pnom, , pv, promo, pzas] of DISPARADORES) {
                if (promo === sku) promosT.push([psku, pnom, q * pzas, 'PZA', pv]);
              }
            }
            const prodT = [];
            for (const [sku, nombre, , , , pv, media] of PRODUCTOS) {
              const q = poisson(r, (media * PESO[s] * prop) / 3);
              if (q > 0) prodT.push([sku, nombre, q, 'PZA', pv]);
            }
            const cliente = `DMC${s}${String(Math.floor(r() * 40)).padStart(3, '0')}`;
            // [MKT.18] El ticket de mostrador lleva la apertura de su turno (kdm1.c80), como en Kepler.
            const apertura = canal === 'mostrador' ? aperturaDe(s, d) : null;
            for (const [folio, renglones] of [[`DM${d.replace(/-/g, '')}${k}`, promosT], [`DM${d.replace(/-/g, '')}P${k}`, prodT]]) {
              if (!renglones.length) continue;
              const total = renglones.reduce((a, x) => a + x[2] * x[4], 0);
              await c.query(
                `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c10, c12, c13, c16, c43, c67, c80)
                 VALUES ($1, $1, 'U', 'D', $2, $3, $4, $5, $6, $7, 0, $8, '', '', $9)`,
                [s, doc, caja, folio, d, cliente, vcode, Math.round(total * 100) / 100, apertura === null ? null : String(apertura)]);
              // [MKT.18] En 01 y 03 la cajera ya dijo quién vendió ~70 % de los tickets con promo.
              if (apertura !== null && renglones === promosT && (s === '01' || s === '03') && r() < 0.7) {
                vendidos.push([s, doc, String(caja), folio, d, String(apertura), PERSONAS[Math.floor(r() * 3)]]);
              }
              docs++;
              let n = 0;
              for (const [sku, desc, q, un, precio] of renglones) {
                n++;
                await c.query(
                  `INSERT INTO kepler_ods.kdm2 (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c32)
                   VALUES ($1, $1, 'U', 'D', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                  [s, doc, caja, folio, n, sku, q, desc, un, precio, Math.round(q * precio * 100) / 100, d]);
                lineas++;
              }
            }
          }
        }
      }
    }

    // ── [MKT.18] quién vendió (lo que ya escribieron las cajeras de 01 y 03) ──
    for (const [s, doc, caja, folio, d, apertura, [code, nombre]] of vendidos) {
      await c.query(
        `INSERT INTO commercial.mkt_promo_ticket_sellers (tenant_id, warehouse_code, doc_tipo, caja, folio, business_date, turno_apertura, person_code, person_name, created_by_username, updated_by_username)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'semilla', 'semilla')`,
        [T, s, doc, caja, folio, d, apertura, code, nombre]);
    }

    // ── alta de promos (8 de 10) y objetivos ──
    const ini = desde;
    for (const [sku, desc] of PROMOS.slice(0, 8)) {
      const canales = sku <= 'DM004' ? ['mostrador', 'preventa', 'ruta', 'mayoreo'] : ['mostrador'];
      const { rows: [p] } = await c.query(
        `INSERT INTO commercial.mkt_ranking_promos (tenant_id, code, descripcion_kepler, mecanica, vigencia_desde, canales, notas, created_by_username, updated_by_username)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'semilla', 'semilla') RETURNING id`,
        [T, sku, desc, desc.replace(' DEMO', '').toLowerCase().replace(/^./, (x) => x.toUpperCase()), ini, canales, MARCA]);
      if (sku === 'DM007' || sku === 'DM008') continue; // [MKT.17] sin objetivo fijado: van con el DINÁMICO
      for (const s of SUC) {
        const media = PROMOS.find((x) => x[0] === sku)[2];
        await c.query(
          `INSERT INTO commercial.mkt_ranking_objectives (tenant_id, promo_id, warehouse_code, canal, objetivo_semanal, fuente, created_by_username, updated_by_username)
           VALUES ($1, $2, $3, 'mostrador', $4, 'manual', 'semilla', 'semilla')`,
          [T, p.id, s, Math.max(1, Math.round(media * 7 * 1.05))]);
      }
    }

    // ── incentivos ──
    const inc = [
      ['Chocolate Demo Sport 1 kg', 'por_caja', 50, null, ['DM101'], ['mostrador', 'preventa', 'ruta', 'mayoreo']],
      ['Palanqueta Demo grande', 'por_caja', 25, null, ['DM102'], ['preventa', 'ruta', 'mayoreo']],
      ['Marca Demo Colomba (por monto)', 'por_monto', 5, 120, ['DM103', 'DM104'], ['preventa', 'ruta', 'mayoreo']],
      ['Marca Demo Colomba (clientes)', 'por_cliente', 5, null, ['DM103', 'DM104'], ['ruta', 'preventa']],
    ];
    for (const [nombre, tipo, pago, base, skus, canales] of inc) {
      await c.query(
        `INSERT INTO commercial.mkt_incentives (tenant_id, nombre, tipo, pago, base_monto, skus, vigencia_desde, canales, notas, created_by_username, updated_by_username)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'semilla', 'semilla')`,
        [T, nombre, tipo, pago, base, skus, ini, canales, MARCA]);
    }
    await c.query('COMMIT');
    await c.query('REFRESH MATERIALIZED VIEW analytics.mv_kepler_sales_daily');
    console.log(`✓ semilla: ${docs} documentos, ${lineas} renglones (${desde} → ${hoy}), 8 promos dadas de alta, 4 incentivos`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
