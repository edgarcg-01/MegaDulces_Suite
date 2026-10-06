'use strict';
/**
 * `[VEC.1]`–`[VEC.3]` — Candado del flujo vecinal: la ruta del pedido y el pool filtrable.
 *
 * ── Qué afirma ──────────────────────────────────────────────────────────────────────────
 * Que el pool de surtido puede decir **de qué tipo de ruta** es cada pedido, y que lo que no
 * puede decir lo **declara** en vez de dibujarlo.
 *
 * Mide contra **PROD** (`PROD_DB_URL`), en estricta lectura. Verde sobre una copia local vieja
 * sería exactamente la mentira que esto viene a matar: el catálogo de rutas y la cartera de
 * clientes cambian en prod, no acá. Si no se llega: **NO MEDIDO** (exit 2), nunca verde.
 *
 * ── Las tres ausencias que NO son la misma ──────────────────────────────────────────────
 * `route_kind` en NULL puede ser tres cosas distintas y cada una tiene un dueño distinto:
 *   · el cliente no tiene `sales_route`  → lo arregla quien captura el cliente
 *   · la ruta no está declarada          → lo arregla Dirección (`[VEC.1]`)
 *   · la columna no existe todavía       → lo arregla aplicar la migración
 * Si las tres se ven igual, nadie sabe a quién llamar (ADR-056).
 *
 * Cierra con PRUEBA NEGATIVA y CONTROL POSITIVO sobre funciones puras. Un gate sin prueba
 * negativa es una intención.
 */
const path = require('path');
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const REPO = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(REPO, '.env') });

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const sinMedir = (msg) => { nm++; console.log('  ◻ NO MEDIDO —', msg); };

/** Espejo del CHECK de la migración 20261006130000. Si divergen, el bloque [1] lo canta. */
const KINDS = ['vecinal', 'camion', 'telemarketing', 'mayoreo', 'piso'];

/**
 * Las reglas de clasificación, como FUNCIÓN PURA sobre (nombre de ruta, código ERP, nombre
 * Kepler). Que sea pura es lo que hace posible la prueba negativa: se la alimenta con entradas
 * adulteradas y tiene que cambiar de veredicto.
 *
 * ⚠️ Replica el `CLASIFICADOR` de la migración **a propósito**: el candado cruza DOS
 * implementaciones (SQL contra JS). Verificar el SQL contra sí mismo pasaría sus bugs en verde
 * — ver [[feedback_cross_check_two_implementations]].
 */
function clasificar({ value, erpVendorCode, keplerName }) {
  if (keplerName && /VECINAL/i.test(keplerName)) return 'vecinal';
  if (['2V001', '2V003', '2V005'].includes(erpVendorCode)) return 'vecinal';
  if (/mayoreo/i.test(value)) return 'mayoreo';
  if (/^1000[12] /.test(value.trim())) return 'mayoreo';
  if (/^(ruta)? *[0-9]+$/i.test(value.trim())) return 'camion';
  return null;
}

/** El motivo de la ausencia, puro. `salesRoute` = del cliente; `kind` = de la ruta. */
function motivoAusencia(salesRoute, kind) {
  if (salesRoute === null || salesRoute === undefined) return 'cliente_sin_ruta';
  if (kind === null || kind === undefined) return 'ruta_sin_declarar';
  return null;
}

(async () => {
  const url = process.env.PROD_DB_URL;
  if (!url) noMedido('no hay PROD_DB_URL en .env');
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 20000, statement_timeout: 60000 });
  try { await c.connect(); } catch (e) {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo llegar a prod -- ${e.message}`);
    throw e;
  }

  const { rows: quien } = await c.query(`SELECT current_database() AS db, current_user AS usr`);
  console.log(`\n  base: ${quien[0].db} · usuario: ${quien[0].usr} (lectura)\n`);

  // ── [0] PISO ─────────────────────────────────────────────────────────────────────────
  // Una comparación entre dos conjuntos vacíos se pone verde sola (lección [ID.28]).
  console.log('[0] Piso — ningún conjunto vacío se lee como coincidencia');
  const { rows: piso } = await c.query(`
    SELECT (SELECT count(*)::int FROM trade.catalogs WHERE catalog_id='rutas' AND deleted_at IS NULL) AS rutas,
           (SELECT count(*)::int FROM commercial.customers WHERE deleted_at IS NULL AND sales_route IS NOT NULL) AS clientes_con_ruta,
           (SELECT count(*)::int FROM commercial.orders WHERE deleted_at IS NULL) AS pedidos`);
  ok(piso[0].rutas >= 20, `catálogo de rutas: ${piso[0].rutas}`);
  ok(piso[0].clientes_con_ruta >= 500, `clientes con sales_route: ${piso[0].clientes_con_ruta}`);
  ok(piso[0].pedidos > 0, `pedidos: ${piso[0].pedidos}`);

  // ── [1] La columna y su taxonomía ────────────────────────────────────────────────────
  console.log('\n[1] route_kind — la columna existe y su CHECK es el que dice el código');
  const { rows: col } = await c.query(`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='trade' AND table_name='catalogs' AND column_name='route_kind'`);
  const hayColumna = col.length > 0;
  if (!hayColumna) {
    sinMedir('trade.catalogs.route_kind no existe todavía — falta aplicar 20261006130000');
  } else {
    ok(true, 'trade.catalogs.route_kind existe');
    const { rows: chk } = await c.query(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'catalogs_route_kind_ck'`);
    const def = chk[0]?.def || '';
    const faltan = KINDS.filter((k) => !def.includes(`'${k}'`));
    ok(chk.length > 0 && faltan.length === 0,
      faltan.length === 0
        ? `el CHECK cubre los ${KINDS.length} tipos del contrato`
        : `el CHECK no menciona: ${faltan.join(', ')} — contrato y base divergen`);
    // El CHECK de "sólo rutas": una zona con route_kind sería ruido que después alguien lee.
    const { rows: solo } = await c.query(`
      SELECT count(*)::int AS n FROM trade.catalogs
       WHERE route_kind IS NOT NULL AND catalog_id <> 'rutas'`);
    ok(solo[0].n === 0, `0 filas no-ruta con route_kind (hay ${solo[0].n})`);
  }

  // ── [2] CRUCE DE DOS IMPLEMENTACIONES ────────────────────────────────────────────────
  // El SQL de la migración contra las reglas en JS. Verificar el SQL contra sí mismo pasaría
  // sus bugs en verde; esto exige que dos caminos distintos digan lo mismo.
  console.log('\n[2] Cruce SQL ↔ JS — las dos implementaciones de la regla coinciden');
  const { rows: rutas } = await c.query(`
    SELECT tc.value, tc.erp_vendor_code,
           ${hayColumna ? 'tc.route_kind' : 'NULL::text AS route_kind'},
           (SELECT btrim(k.c3) FROM kepler_ods.kduv k
             WHERE k.sucursal='00' AND btrim(k.c2)=tc.erp_vendor_code LIMIT 1) AS kepler_name
      FROM trade.catalogs tc
     WHERE tc.catalog_id='rutas' AND tc.deleted_at IS NULL
     ORDER BY tc.value`);
  const esperado = rutas.map((r) => ({
    value: r.value,
    js: clasificar({ value: r.value, erpVendorCode: r.erp_vendor_code, keplerName: r.kepler_name }),
    sql: r.route_kind,
  }));
  const vecinalJs = esperado.filter((e) => e.js === 'vecinal').length;
  ok(vecinalJs >= 5, `las reglas en JS encuentran ${vecinalJs} rutas vecinales`);
  if (hayColumna) {
    const difieren = esperado.filter((e) => e.js !== e.sql);
    ok(difieren.length === 0,
      difieren.length === 0
        ? `las ${esperado.length} rutas coinciden entre el SQL de la migración y las reglas en JS`
        : `${difieren.length} difieren: ${difieren.map((d) => `${d.value} (sql=${d.sql}, js=${d.js})`).join(' · ')}`);
  } else {
    sinMedir('sin la columna no hay contra qué cruzar el SQL');
  }

  // ── [3] El pool resuelve la ruta del pedido ──────────────────────────────────────────
  console.log('\n[3] Pool — cada pedido dice de qué ruta viene, o por qué no');
  const RUTA = (col) => `(SELECT tc.${col} FROM trade.catalogs tc
                           WHERE tc.catalog_id='rutas' AND tc.deleted_at IS NULL
                             AND tc.value = c.sales_route LIMIT 1)`;
  const { rows: pool } = await c.query(`
    SELECT o.code, c.sales_route,
           ${RUTA('value')} AS ruta,
           ${hayColumna ? RUTA('route_kind') : 'NULL::text'} AS kind
      FROM commercial.orders o
      LEFT JOIN commercial.customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
     WHERE o.status='confirmed'
       AND NOT EXISTS (SELECT 1 FROM commercial.wave_orders wo
                        WHERE wo.order_id=o.id AND wo.stage <> 'listo_embarque')`);
  ok(pool.length > 0, `pedidos esperando surtido: ${pool.length}`);
  // ⭐ Ruta HUÉRFANA: el cliente dice una ruta que el catálogo no conoce. Es el caso peor,
  // porque no se ve como ausencia sino como un pedido normal que nunca entra a ninguna ola.
  const huerfanas = pool.filter((p) => p.sales_route && !p.ruta);
  ok(huerfanas.length === 0,
    huerfanas.length === 0
      ? '0 pedidos con una sales_route que el catálogo no conoce'
      : `${huerfanas.length} pedido(s) con ruta huérfana: ${[...new Set(huerfanas.map((h) => h.sales_route))].join(', ')}`);
  const sinRuta = pool.filter((p) => !p.sales_route).length;
  console.log(`      (declarado: ${sinRuta} pedido(s) de cliente sin ruta — se ven como 'cliente_sin_ruta', no como 0)`);

  // ── [4] Desempeño: >1 s se lee como "no funciona" ────────────────────────────────────
  console.log('\n[4] Desempeño del pool');
  const t0 = Date.now();
  await c.query(`
    SELECT o.id, ${hayColumna ? RUTA('route_kind') : 'NULL::text'} AS kind
      FROM commercial.orders o
      LEFT JOIN commercial.customers c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id
     WHERE o.status='confirmed' LIMIT 500`);
  const ms = Date.now() - t0;
  ok(ms < 1000, `el pool con la ruta resuelta tarda ${ms} ms (gate <1000)`);

  await c.end();

  // ── [5] PRUEBA NEGATIVA + CONTROL POSITIVO ───────────────────────────────────────────
  console.log('\n[5] Prueba negativa — las reglas rotas a propósito tienen que cambiar de veredicto');
  ok(clasificar({ value: '2V004 TELEMARKETING', erpVendorCode: '2V004', keplerName: 'TELEMARKETING MORELIA' }) !== 'vecinal',
    'la letra V NO basta: 2V004 (TELEMARKETING MORELIA) no sale vecinal');
  ok(clasificar({ value: '2V003 GUILLERMO HERNANDEZ ALMANZA', erpVendorCode: '2V003', keplerName: 'GUILLERMO HERNANDEZ' }) === 'vecinal',
    'y Morelia NO se pierde: 2V003 sale vecinal aunque su nombre no diga VECINAL');
  ok(clasificar({ value: 'RUTA 21', erpVendorCode: null, keplerName: null }) === 'camion',
    'RUTA 21 → camión (el regex usa espacio literal; con \\s esta base lo lee como una s)');
  ok(clasificar({ value: '20005 GLORIA ORTEGA CALDERON', erpVendorCode: '20005', keplerName: 'GLORIA  CALDERON' }) === null,
    'lo que no tiene testigo queda en NULL, no cae a un default');
  // CONTROL POSITIVO: sin él, un clasificador que devolviera `null` para todo se vería igual
  // de verde en las cuatro aserciones de arriba.
  ok(clasificar({ value: '1V001 CANDELARIA', erpVendorCode: '1V001', keplerName: 'RUTA VECINAL PH 01' }) === 'vecinal',
    'control positivo: el clasificador SÍ devuelve un veredicto cuando hay testigo');
  ok(motivoAusencia(null, null) === 'cliente_sin_ruta' && motivoAusencia('RUTA 99', null) === 'ruta_sin_declarar',
    'las dos ausencias se distinguen (cliente_sin_ruta ≠ ruta_sin_declarar)');

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} pass · ${fail} fail · ${nm} no medido`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  if (esFaltaDeAcceso(e)) noMedido(`no se pudo llegar a prod -- ${e.message}`);
  console.error('\nFALLA:', e.message);
  process.exit(1);
});
