/* eslint-disable no-console */
/**
 * HTTP smoke — Composición del ticket en `/store/analytics/range` (pantalla
 * `/tienda/analisis-semanal`).
 *
 * Cubre las tres métricas que descomponen el ticket —**valor por partida**
 * ($/renglón), **unidades por ticket** y **valor unitario promedio** ($/unidad)— y,
 * sobre todo, **la compuerta de cobertura** que decide cuándo NO se publican.
 *
 * Por qué la compuerta existe: esas razones cruzan dos fuentes con historia
 * distinta —la venta sale del fact (`analytics.sales_daily`, 13 meses) y las
 * partidas/tickets del POS (`analytics.store_live_tickets`, en vivo)—. Si el POS
 * cubre 1 día y el fact 3, el cociente NO da cero: da un número absurdo (venta de
 * 3 días ÷ tickets de 1) que **parece medido**. Medido en `platform_test` el
 * 2026-09-10: el fact traía 15 días y el POS 2 → "valor por partida" salía
 * $6,180.66. Por eso se declara `null` («— sin medir») en vez de publicarlo.
 *
 * El test es en buena parte NEGATIVO a propósito: una compuerta que nunca se
 * probó en rojo es una intención, no una compuerta. La sucursal `92` reproduce el hueco de
 * cobertura (sucursal `92`) y exige `null`; y en el mismo payload exige que `avg_unit` SIGA
 * trayendo número — un guard que apaga todo sería tan inútil como no tenerlo.
 *
 * Self-contained: siembra 2 sucursales sintéticas (`91`/`92`), 1 producto, su
 * venta diaria y sus tickets, y limpia al final. Requiere API en localhost:3334
 * con ENABLE_MULTITENANT=true.
 */

const BASE = `http://localhost:${process.env.RECON_TEST_PORT || 3334}/api`;
const { Client } = require('pg');
try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }
// Borra sucursales/productos/ventas sintéticas: no puede correr contra prod.
require('./_lib/assert-safe-target').assertSafeTarget('http-store-analytics-range-test');
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@127.0.0.1:5432/postgres_platform';

const M = '00000000-0000-0000-0000-00000000d01c';
const ROLE = 'encargado_analytics_smoke';
const USER = 'encargado_analytics_smoke';
const PASS = 'encargado_analytics_smoke';
/**
 * `91` = POS cubre los 3 días. `92` = POS cubre 1 de 3 (el hueco a detectar).
 *
 * OJO, cuesta una tarde: la llave canónica de `warehouse` son **2 dígitos**
 * (`esCodigoSucursal` = `/^[0-9]{2}$/`, `branchKeySql`). Un código sintético tipo
 * `ZS1` no traduce, `ScopeService` lo descarta y `intersect()` cae al alcance
 * COMPLETO del usuario — o sea el filtro se ignora en silencio y el test compara
 * la suma de las dos sucursales contra sí misma, en verde. La red real usa 00–06.
 */
const WH_OK = '91';
const WH_HUECO = '92';
const SKU = 'ZSKU-ANALYTICS-SMOKE';

/** Fecha de negocio en hora de MÉXICO: el backend resuelve "hoy" con esa TZ. */
const hoyMx = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const HOY = hoyMx();
/** Ventana de 3 días CERRADOS (ayer hacia atrás): no depende de la venta de hoy. */
const DIAS = [addDays(HOY, -3), addDays(HOY, -2), addDays(HOY, -1)];
const FROM = DIAS[0], TO = DIAS[2];

// Cifras elegidas para que cada razón dé un número EXACTO y verificable a mano:
//   venta 3 × $1,000 = $3,000 · unidades 3 × 50 = 150 · tickets 3 × 5 = 15 · partidas 15 × 2 = 30
//   → ticket prom. 3000/15 = $200 · partidas/ticket 30/15 = 2.0
//   → precio x partida 3000/30 = $100 · unidades/ticket 150/15 = 10.0 · valor unidad 3000/150 = $20
const REV_DIA = 1000, UNI_DIA = 50, MAR_DIA = 300, TK_DIA = 5, PARTIDAS_TK = 2;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, det) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${det ? ' — ' + det : ''}`); fail++; failures.push(name); }
}

async function req(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch (e) { /* no json */ }
  return { status: r.status, body: json };
}

/** ¿La clave viene en el payload? (`in`, no `!= null`: acá importa el CONTRATO.) */
const tiene = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
/** Comparación de dinero/razón con tolerancia de centavo. */
const cerca = (a, b) => a != null && Math.abs(Number(a) - Number(b)) < 0.01;

async function cleanup(pg, userId) {
  const sucs = [WH_OK, WH_HUECO];
  await pg.query(
    `DELETE FROM analytics.sales_daily WHERE tenant_id=$1 AND warehouse_id IN
       (SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code = ANY($2))`, [M, sucs]).catch(() => {});
  await pg.query(`DELETE FROM analytics.store_live_tickets WHERE tenant_id=$1 AND warehouse_code = ANY($2)`, [M, sucs]).catch(() => {});
  await pg.query(`DELETE FROM commercial.warehouses WHERE tenant_id=$1 AND code = ANY($2)`, [M, sucs]).catch(() => {});
  await pg.query(`DELETE FROM catalog.products WHERE tenant_id=$1 AND sku=$2`, [M, SKU]).catch(() => {});
  if (userId) await pg.query(`DELETE FROM identity.user_scopes WHERE tenant_id=$1 AND user_id=$2::uuid`, [M, userId]).catch(() => {});
  await pg.query(`DELETE FROM identity.users WHERE tenant_id=$1 AND username=$2`, [M, USER]).catch(() => {});
  await pg.query(`DELETE FROM identity.role_permissions WHERE tenant_id=$1 AND role_name=$2`, [M, ROLE]).catch(() => {});
}

(async () => {
  const pg = new Client({ connectionString: DST, ssl: /rlwy|proxy|railway/.test(DST) ? { rejectUnauthorized: false } : false });
  await pg.connect();
  await cleanup(pg, null); // idempotente: limpia corridas previas

  console.log('\n── 1. Fixtures: 2 sucursales, 1 producto, venta de 3 días, POS desparejo ──');
  let userId = null;
  try {
    const bcrypt = require('bcryptjs');
    await pg.query(
      `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (tenant_id, role_name) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [M, ROLE, JSON.stringify({ STORE_ANALYTICS_VER: true })],
    );
    const hash = await bcrypt.hash(PASS, 10);
    userId = (await pg.query(
      `INSERT INTO identity.users (tenant_id, username, password_hash, nombre, role_name, activo)
       VALUES ($1,$2,$3,$2,$4,true)
       ON CONFLICT (tenant_id, username) DO UPDATE SET password_hash=EXCLUDED.password_hash, role_name=EXCLUDED.role_name, activo=true
       RETURNING id`, [M, USER, hash, ROLE])).rows[0].id;
    // Alcance `listed` con las 2 sintéticas: así el test no depende de la data real
    // ni la toca, y de paso ejercita el camino de `ScopeService` (ADR-050).
    await pg.query(
      `INSERT INTO identity.user_scopes (tenant_id, user_id, dimension, mode, values)
       VALUES ($1,$2,'warehouse','listed',$3::text[])
       ON CONFLICT (tenant_id, user_id, dimension) DO UPDATE SET mode='listed', values=EXCLUDED.values`,
      [M, userId, [WH_OK, WH_HUECO]],
    );

    const whIds = {};
    for (const code of [WH_OK, WH_HUECO]) {
      whIds[code] = (await pg.query(
        `INSERT INTO commercial.warehouses (tenant_id, code, name) VALUES ($1,$2,$3) RETURNING id`,
        [M, code, `Smoke sucursal ${code}`])).rows[0].id;
    }
    // Marca existente: el test no necesita sembrar el catálogo entero, sólo colgar
    // un producto de algo válido (FK). Es lectura, no lo modifica.
    const brand = (await pg.query(`SELECT id FROM catalog.brands WHERE tenant_id=$1 LIMIT 1`, [M])).rows[0];
    if (!brand) throw new Error('no hay ninguna marca en catalog.brands para colgar el producto sintético');
    const prodId = (await pg.query(
      `INSERT INTO catalog.products (tenant_id, brand_id, sku, nombre) VALUES ($1,$2,$3,$4) RETURNING id`,
      [M, brand.id, SKU, 'Producto smoke analytics'])).rows[0].id;

    for (const code of [WH_OK, WH_HUECO]) {
      for (const d of DIAS) {
        // `margin` es columna GENERADA (revenue − cost): se siembra el costo, no el margen.
        await pg.query(
          `INSERT INTO analytics.sales_daily (tenant_id, product_id, warehouse_id, channel, sale_date, units, revenue, cost)
           VALUES ($1,$2,$3,'tienda',$4,$5,$6,$7)`,
          [M, prodId, whIds[code], d, UNI_DIA, REV_DIA, REV_DIA - MAR_DIA],
        );
      }
      // La 91 recibe tickets los 3 días; la 92 SÓLO el último → el hueco de cobertura.
      const diasConPos = code === WH_OK ? DIAS : [DIAS[2]];
      for (const d of diasConPos) {
        for (let i = 0; i < TK_DIA; i++) {
          await pg.query(
            `INSERT INTO analytics.store_live_tickets (tenant_id, warehouse_code, serie, folio, ticket_ts, items)
             VALUES ($1,$2,'Z9',$3,$4::timestamptz,$5::jsonb)`,
            [M, code, `${code}-${d}-${i}`, `${d}T12:00:00-06:00`,
             JSON.stringify(Array.from({ length: PARTIDAS_TK }, (_, j) => ({ sku: SKU, n: j })))],
          );
        }
      }
    }
    check('fixtures sembrados', !!userId && !!prodId);
  } catch (e) {
    check('fixtures sembrados', false, e.message);
    await cleanup(pg, userId); await pg.end(); process.exit(1);
  }

  const login = await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username: USER, password: PASS });
  const token = login.body?.access_token;
  check('login encargado', !!token, `status=${login.status}`);
  if (!token) { await cleanup(pg, userId); await pg.end(); process.exit(1); }

  const pedir = async (wh) => (await req('GET', `/store/analytics/range?from=${FROM}&to=${TO}&warehouse_codes=${wh}`, token)).body;

  console.log('\n── 2. Cobertura COMPLETA (suc. 91): las tres razones publican el número exacto ──');
  const ok = await pedir(WH_OK);
  const k1 = ok?.kpis;
  check('el payload trae las 3 claves nuevas',
    tiene(k1, 'avg_line') && tiene(k1, 'units_per_ticket') && tiene(k1, 'avg_unit'),
    `claves=${k1 ? Object.keys(k1).join(',') : 'sin kpis'}`);
  check('venta = $3,000 (3 días × $1,000)', cerca(k1?.revenue?.cur, 3000), `cur=${k1?.revenue?.cur}`);
  check('tickets = 15 (3 días × 5)', k1?.tickets?.cur === 15, `cur=${k1?.tickets?.cur}`);
  check('partidas / ticket = 2.0 (el rename no cambió el cálculo)', cerca(k1?.basket?.cur, 2), `cur=${k1?.basket?.cur}`);
  // margen = 3 × (1000 − 700) = 900 sobre 3000 de venta.
  check('margen = $900', cerca(k1?.margin?.cur, 900), `cur=${k1?.margin?.cur}`);
  check('margen % = 30.0 de la venta', cerca(k1?.margin_pct?.cur, 30), `cur=${k1?.margin_pct?.cur}`);
  check('valor por partida = $100.00 (3000 ÷ 30)', cerca(k1?.avg_line?.cur, 100), `cur=${k1?.avg_line?.cur}`);
  check('unidades por ticket = 10.0 (150 ÷ 15)', cerca(k1?.units_per_ticket?.cur, 10), `cur=${k1?.units_per_ticket?.cur}`);
  check('valor unitario promedio = $20.00 (3000 ÷ 150)', cerca(k1?.avg_unit?.cur, 20), `cur=${k1?.avg_unit?.cur}`);
  // Clientes: la sucursal sintética no existe en la facturación del ERP (esa vista sale
  // de kepler_ods y no se siembra desde acá), así que se afirma el CONTRATO y el caso
  // "sin facturación a nombre" — que es el de verdad para las tiendas de puro mostrador.
  check('el payload trae clientes y venta por cliente',
    tiene(k1, 'customers') && tiene(k1, 'revenue_per_customer'), `claves=${k1 ? Object.keys(k1).join(',') : '—'}`);
  check('clientes con registro = 0 (no hay facturación a nombre)', k1?.customers?.cur === 0, `cur=${k1?.customers?.cur}`);
  check('venta por cliente = null, NO $0 (sin clientes no hay promedio)',
    k1?.revenue_per_customer?.cur === null, `cur=${k1?.revenue_per_customer?.cur}`);
  check('as_of declara las dos fuentes por separado',
    tiene(ok, 'as_of') && tiene(ok?.as_of, 'fact') && tiene(ok?.as_of, 'customers'), `as_of=${JSON.stringify(ok?.as_of)}`);
  check('as_of.fact = último día con venta del período', ok?.as_of?.fact === TO, `fact=${ok?.as_of?.fact} esperado=${TO}`);
  check('as_of.customers = null (esa fuente no trajo nada)', ok?.as_of?.customers === null, `customers=${ok?.as_of?.customers}`);

  console.log('\n── 3. PRUEBA NEGATIVA — POS cubre 1 de 3 días (suc. 92): se declara, no se dibuja ──');
  const hueco = await pedir(WH_HUECO);
  const k2 = hueco?.kpis;
  check('mismo fact que la 91: venta = $3,000', cerca(k2?.revenue?.cur, 3000), `cur=${k2?.revenue?.cur}`);
  check('el POS sí trajo tickets (5): el denominador EXISTE, no es cero', k2?.tickets?.cur === 5, `cur=${k2?.tickets?.cur}`);
  // Sin la compuerta esto habría publicado 3000/10 = $300 y 150/5 = 30 unidades.
  check('valor por partida = null (no $300)', k2?.avg_line?.cur === null, `cur=${k2?.avg_line?.cur}`);
  check('unidades por ticket = null (no 30)', k2?.units_per_ticket?.cur === null, `cur=${k2?.units_per_ticket?.cur}`);
  check('la compuerta NO apaga lo que sí está medido: valor unitario promedio sigue en $20.00',
    cerca(k2?.avg_unit?.cur, 20), `cur=${k2?.avg_unit?.cur}`);
  // Deuda CONOCIDA y declarada, no un descuido: `avg_ticket`/`basket` son anteriores a
  // la compuerta y siguen publicando el número inflado (3000/5 = $600 en vez de $200).
  // Si alguien les pone el guard, este check se pone rojo y hay que actualizarlo — que
  // es exactamente el aviso que se quiere.
  check('DEUDA: ticket promedio sigue SIN compuerta ($600 = 3000÷5)', cerca(k2?.avg_ticket?.cur, 600), `cur=${k2?.avg_ticket?.cur}`);

  console.log('\n── 4. Limpieza ──');
  await cleanup(pg, userId);
  const quedan = (await pg.query(`SELECT count(*)::int AS n FROM commercial.warehouses WHERE tenant_id=$1 AND code = ANY($2)`, [M, [WH_OK, WH_HUECO]])).rows[0].n;
  check('fixtures eliminados', quedan === 0, `quedan=${quedan}`);
  await pg.end();

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass}/${pass + fail} OK`);
  if (fail) console.log('   Fallaron: ' + failures.join(' · '));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR FATAL', e); process.exit(1); });
