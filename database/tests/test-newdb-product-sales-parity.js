/* eslint-disable no-console */
/**
 * `[AUD-DAT.10]` — **La venta mensual por producto no puede contradecir a la diaria.**
 *
 * ── DE DÓNDE SALE ESTE CANDADO ──────────────────────────────────────────────────────────────
 * De la auditoría de la capa de datos (2026-09-28). `analytics.product_sales_daily` y
 * `analytics.product_sales_monthly` son hermanas, corren en el mismo carril nocturno, y el
 * encabezado de la diaria afirmaba textualmente *"MISMO join + filtro que el mensual (para que el
 * diario sume EXACTO al mensual)"*. Medido, era falso:
 *
 *      mes cerrado    diaria      mensual     falta
 *      2026-06        720,533     398,622     44.7 %
 *      2026-07        978,698     623,677     36.3 %
 *      2026-08        955,432     760,468     20.4 %
 *
 * ⭐ Lo que lo resolvió fue mirar 2025: **cuadra al peso, los doce meses**. La divergencia vivía
 * sólo en 2026 y no era de unidades sino de **filas** — enero-2026 tenía 89,358 en la diaria y
 * **5,033** en la mensual. Causa: el `DELETE` del importer mensual estaba acotado al año en curso
 * y barría cada noche todo 2026 que la consulta Kepler-sola no devolviera. Toda fila de la era
 * Wincaja moría ahí. 2025 sobrevivió **porque ya nadie lo borra**.
 *
 * El daño concreto: `06` (Canindo) migró de ERP el 2026-08-15, así que agosto está partido y la
 * mensual publicaba sólo del 15 en adelante; `MD-32` salía en **cero** con 94,400 u en la diaria.
 *
 * Desde `[AUD-DAT.10]` la mensual es el **rollup** de la diaria, con un solo dueño. La
 * contradicción es imposible **por construcción**; este archivo existe para que siga siéndolo.
 *
 * ── QUÉ GUARDA ──────────────────────────────────────────────────────────────────────────────
 * El invariante, no el número: para cada mes cerrado, `product_sales_monthly` debe ser EXACTAMENTE
 * el rollup de `product_sales_daily`, por almacén. No fija montos (se mueven todas las noches) ni
 * fechas (caducan).
 *
 * ⚠️ SÓLO LECTURA y contra PRODUCCIÓN a propósito: el invariante es sobre los datos reales.
 * Contra una base de prueba se pondría verde midiendo semillas.
 *
 * ⚠️ Tercer estado (ADR-056): un mes sin filas en la diaria reporta **NO MEDIDO**, no ✔. Dos
 * tablas vacías cuadran perfecto y eso no significa nada.
 *
 * ⚠️ El bloque 4 es la **prueba negativa**: rompe el comparador a propósito y exige el rojo. Sin
 * eso este archivo sería una intención, no una compuerta.
 *
 *   node database/tests/test-newdb-product-sales-parity.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { assertTarget } = require('../../libs/platform-core/src/lib/provenance/target-guard.js');

const URL = process.env.DATABASE_URL_NEW;
assertTarget('test-newdb-product-sales-parity', { url: URL, intent: 'read', expect: 'prod' });

const knex = require('knex')({ client: 'pg', connection: { connectionString: URL }, pool: { min: 0, max: 2 } });
const MEGA = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·', 'NO MEDIDO —', m); };

/**
 * ⭐ El comparador es UNA función y la usan los dos bloques: el veredicto real y la prueba
 * negativa. Si fueran dos implementaciones, la prueba negativa no probaría la que corre de verdad
 * — que es exactamente cómo un candado se pone verde mintiendo.
 *
 * Distingue TRES formas de fallar, porque no son la misma: una fila que la mensual no tiene
 * (el caso `MD-32`), una que tiene con otro monto, y una que tiene de más (huérfana).
 */
function diferencias(filasDaily, filasMonthly) {
  const pend = new Map(filasMonthly.map((r) => [`${r.alm}|${r.mes}`, Number(r.u)]));
  const out = [];
  for (const d of filasDaily) {
    const k = `${d.alm}|${d.mes}`;
    const v = pend.get(k);
    if (v === undefined) out.push({ k, motivo: 'ausente en mensual', daily: Number(d.u), monthly: null });
    else if (Number(d.u) !== v) out.push({ k, motivo: 'monto distinto', daily: Number(d.u), monthly: v });
    pend.delete(k);
  }
  for (const [k, v] of pend) out.push({ k, motivo: 'huérfana en mensual', daily: null, monthly: v });
  return out;
}

(async () => {
  try {
    const [{ hasta, etiqueta }] = await knex.raw(`
      SELECT date_trunc('month', current_date)::date AS hasta,
             to_char(date_trunc('month', current_date) - interval '1 month', 'YYYY-MM') AS etiqueta`)
      .then((r) => r.rows);
    console.log(`\nÚltimo mes cerrado: ${etiqueta}  ·  se prueban los 12 meses cerrados previos\n`);

    // ── 1) CUADRE POR ALMACÉN × MES, sobre meses CERRADOS ────────────────────────────────────
    console.log('1) La mensual es el rollup exacto de la diaria (12 meses cerrados)');
    // ⚠️ El `EXISTS` replica la exclusión que hace el importer, y tiene que estar: la FK a
    // `catalog.products` está **NOT VALID** en la diaria y **validada** en la mensual, así que la
    // diaria conserva filas de productos borrados del catálogo que la mensual no puede aceptar.
    // Sin esta línea el candado daría rojo por una diferencia que NO es el defecto que vigila.
    // El tamaño de esa exclusión se mide aparte (bloque 4) — se declara, no se esconde.
    const { rows: d } = await knex.raw(
      `SELECT w.code AS alm, to_char(date_trunc('month', s.sale_date),'YYYY-MM') AS mes,
              sum(s.units)::numeric AS u
         FROM analytics.product_sales_daily s JOIN commercial.warehouses w ON w.id = s.warehouse_id
        WHERE s.tenant_id = ? AND s.sale_date < ?
          AND s.sale_date >= (?::date - interval '12 months')
          AND EXISTS (SELECT 1 FROM catalog.products p WHERE p.id = s.product_id)
        GROUP BY 1,2`, [MEGA, hasta, hasta]);
    const { rows: mo } = await knex.raw(
      `SELECT w.code AS alm, to_char(m.month,'YYYY-MM') AS mes, sum(m.units)::numeric AS u
         FROM analytics.product_sales_monthly m JOIN commercial.warehouses w ON w.id = m.warehouse_id
        WHERE m.tenant_id = ? AND m.month < ? AND m.month >= (?::date - interval '12 months')
        GROUP BY 1,2`, [MEGA, hasta, hasta]);

    if (!d.length) {
      noMedido('`product_sales_daily` no tiene filas en los 12 meses cerrados — no hay con qué comparar');
    } else {
      const difs = diferencias(d, mo);
      ok(difs.length === 0,
        `${d.length} pares almacén×mes cuadran exacto (${difs.length} diferencias)`);
      for (const x of difs.slice(0, 10)) {
        console.log(`      ${x.k}: ${x.motivo} — diaria ${x.daily} / mensual ${x.monthly}`);
      }
      if (difs.length > 10) console.log(`      … y ${difs.length - 10} más`);
    }

    // ── 2) COBERTURA: ningún almacén se queda afuera ─────────────────────────────────────────
    // El modo de falla que originó todo esto no fue un monto torcido: fue `MD-32` publicando CERO
    // con 94,400 u vendidas. Un total que cuadra puede esconderlo si otro almacén compensa.
    console.log('\n2) Ningún almacén con venta en la diaria falta en la mensual');
    const almD = new Set(d.map((r) => r.alm));
    const almM = new Set(mo.map((r) => r.alm));
    const faltan = [...almD].filter((a) => !almM.has(a));
    if (!almD.size) noMedido('sin almacenes en la diaria');
    else ok(faltan.length === 0, `${almD.size} almacenes en la diaria, ${almM.size} en la mensual`
      + (faltan.length ? ` — FALTAN: ${faltan.join(', ')}` : ''));

    // ── 3) LA HISTORIA NO SE ENCOGE ──────────────────────────────────────────────────────────
    // El defecto original destruía historia cada noche. Si la mensual arranca después que la
    // diaria, alguien volvió a acotar un DELETE por año.
    console.log('\n3) La mensual cubre la misma historia que la diaria');
    // ⚠️ `to_char` en SQL y NO `String(fecha).slice(0,10)` en JS: `pg` devuelve un `date` como
    // objeto `Date` en UTC-medianoche, así que `String()` lo renderiza en hora MX (−06:00) y da
    // `"Wed Dec 01"` — el día anterior, en inglés. Ya cobró en el Libro de Compras (`[LC.16]`).
    const [{ d_desde, m_desde }] = await knex.raw(
      `SELECT (SELECT to_char(min(date_trunc('month',sale_date)),'YYYY-MM-DD') FROM analytics.product_sales_daily WHERE tenant_id=?) AS d_desde,
              (SELECT to_char(min(month),'YYYY-MM-DD') FROM analytics.product_sales_monthly WHERE tenant_id=?) AS m_desde`,
      [MEGA, MEGA]).then((r) => r.rows);
    if (!d_desde || !m_desde) noMedido('una de las dos tablas está vacía');
    else ok(m_desde <= d_desde, `la mensual arranca ${m_desde} y la diaria ${d_desde}`);

    // ── 4) LO QUE SE EXCLUYE, DECLARADO ──────────────────────────────────────────────────────
    // La diaria guarda filas de productos que ya no están en `catalog.products` (su FK nació
    // NOT VALID). La mensual no puede aceptarlas. Hoy son 6 filas / 8 u — ruido. Pero un ruido
    // que crece sin que nadie lo vea deja de ser ruido, así que se MIDE y se imprime siempre.
    console.log('\n4) La exclusión por producto fuera de catálogo está declarada y es chica');
    const [{ filas, productos, u }] = await knex.raw(
      `SELECT count(*)::int filas, count(DISTINCT s.product_id)::int productos,
              COALESCE(round(sum(s.units)),0)::float u
         FROM analytics.product_sales_daily s
        WHERE s.tenant_id = ?
          AND NOT EXISTS (SELECT 1 FROM catalog.products p WHERE p.id = s.product_id)`, [MEGA])
      .then((r) => r.rows);
    const [{ total }] = await knex.raw(
      `SELECT count(*)::int total FROM analytics.product_sales_daily WHERE tenant_id = ?`, [MEGA])
      .then((r) => r.rows);
    const pctExcl = total ? (100 * filas) / total : 0;
    ok(pctExcl < 1,
      `${filas} filas excluidas (${productos} producto(s), ${u} u) = ${pctExcl.toFixed(3)} % de la diaria`);

    // ── 5) PRUEBA NEGATIVA — el comparador tiene que ponerse ROJO ────────────────────────────
    console.log('\n5) Prueba negativa: el comparador detecta las tres formas de divergir');
    const base = [{ alm: 'X1', mes: '2026-01', u: 100 }, { alm: 'X2', mes: '2026-01', u: 50 }];
    const sano = diferencias(base, [{ alm: 'X1', mes: '2026-01', u: 100 }, { alm: 'X2', mes: '2026-01', u: 50 }]);
    ok(sano.length === 0, 'con datos idénticos no inventa diferencias');

    const roto = diferencias(base, [
      { alm: 'X1', mes: '2026-01', u: 99 },   // monto distinto
      { alm: 'X9', mes: '2026-01', u: 7 },    // huérfana (X2 falta)
    ]);
    const motivos = roto.map((x) => x.motivo).sort();
    ok(roto.length === 3
      && motivos[0] === 'ausente en mensual'
      && motivos[1] === 'huérfana en mensual'
      && motivos[2] === 'monto distinto',
      `detecta las 3: ${motivos.join(' · ')}`);

    // El caso exacto que se nos escapó: la mensual en CERO. Un almacén ausente no puede leerse
    // como "vendió cero".
    const md32 = diferencias([{ alm: 'MD-32', mes: '2026-08', u: 94400 }], []);
    ok(md32.length === 1 && md32[0].motivo === 'ausente en mensual',
      'un almacén ausente NO se lee como cero (el caso MD-32)');

  } catch (e) {
    fail++;
    console.log('  ✗ ERROR:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ / ${fail} ✗ / ${nm} NO MEDIDO\n`);
    process.exit(fail ? 1 : 0);
  }
})();
