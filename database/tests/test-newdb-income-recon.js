/* eslint-disable no-console */
/**
 * `[IG.6]` Candado de la conciliación de ingresos: **lo vendido contra lo cobrado**.
 *
 * Lo que vigila, y por qué cada bloque existe:
 *
 *  1. El traspaso interno **tiene que seguir separándose**. Si un día `kind` deja de distinguir al
 *     CEDIS facturándole a sus propias tiendas, la pantalla vuelve a publicar $41 M/mes de dinero
 *     moviéndose dentro de la casa como si fuera ingreso — que es exactamente el defecto que esta
 *     fase vino a corregir. Lleva **prueba negativa**: si el bloque no encuentra NADA interno, no
 *     se pone verde, se pone rojo, porque un clasificador que no clasifica se lee igual que uno
 *     que no tiene nada que clasificar.
 *  2. `sin_catalogo` **no puede volver a colapsar en `externo`**. Ya pasó una vez durante la
 *     construcción: el `COALESCE` estaba en el SELECT y la columna cruda en el `GROUP BY`, así que
 *     las filas sin catálogo y las externas caían en grupos distintos que imprimían la MISMA
 *     etiqueta (medido: la Caja 1 de PH salía partida en 120 + 154 documentos).
 *  3. El envoltorio fiscal `U-D-6` **no puede entrar al vendido externo**: duplicaría el mostrador.
 *  4. ⭐ El cruce que de verdad vale: las aplicaciones de `kdm5` contra el dinero cobrado. En PH el
 *     30-sep fueron 10 cobros / 18 aplicaciones / $163,150.01 y **cuadra al centavo**. Son dos
 *     caminos distintos al mismo hecho (el libro de aplicaciones y la cartera), así que verificarlo
 *     NO es verificar una vista contra sí misma.
 *  5. Metadata: `security_invoker` y los GRANT, que un `CREATE OR REPLACE VIEW` no hereda (ADR-057).
 *
 * ⛔ Lo que este candado NO puede comprobar, y se declara: el **medio de pago del mostrador**.
 * No existe en Kepler (`kdm1.c45` vacía en el 100 % de los documentos de venta), así que acá se
 * reporta NO MEDIDO en vez de inventar una aserción que siempre pasaría.
 */
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL;
const SUC = process.env.IG_SUC || '01';
const DIA = process.env.IG_DIA || '2026-09-30';
const MES_DESDE = process.env.IG_MES_DESDE || '2026-08-01';
const MES_HASTA = process.env.IG_MES_HASTA || '2026-08-31';

let ok = 0, fail = 0, skip = 0;
const chk = (c, m) => { if (c) { ok++; console.log(`  ✔ ${m}`); } else { fail++; console.log(`  ✖ ${m}`); } };
const nm = (m) => { skip++; console.log(`  ◻ NO MEDIDO — ${m}`); };
const n = (x) => Number(x ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  if (!URL) return noMedido('falta DATABASE_URL_NEW');
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy\.net|railway|amazonaws/i.test(URL) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000, statement_timeout: 180000,
  });
  try { await c.connect(); } catch (e) {
    if (esFaltaDeAcceso(e)) return noMedido(`no se pudo conectar (${e.code || e.message})`);
    throw e;
  }
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;

  try {
    // ── 1. El traspaso interno se separa, y el clasificador NO es un no-op ──────────────────
    console.log('\n[1] El traspaso interno se separa del ingreso real');
    const kinds = await q(
      `SELECT kind, sum(importe)::numeric imp, sum(docs)::int docs
         FROM analytics.v_erp_income_daily
        WHERE fecha BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY 2 DESC`, [MES_DESDE, MES_HASTA]);
    if (!kinds.length) {
      nm(`no hay venta entre ${MES_DESDE} y ${MES_HASTA} — nada que clasificar`);
    } else {
      const interno = kinds.filter((r) => String(r.kind).startsWith('interno'));
      const extern = kinds.find((r) => r.kind === 'externo');
      // Prueba negativa: el clasificador TIENE que encontrar interno. Si no, no clasifica.
      chk(interno.length > 0 && Number(interno[0].imp) > 0,
        interno.length
          ? `prueba negativa: el clasificador SÍ encuentra traspaso interno — ${interno
              .map((r) => `${r.kind} $${n(r.imp)}`).join(' · ')}`
          : '⛔ ningún documento quedó marcado como interno: el clasificador es un no-op y el '
            + 'ingreso vuelve a incluir al CEDIS facturándole a sus propias tiendas');
      chk(extern && Number(extern.imp) > 0, `y sigue habiendo venta externa — $${n(extern?.imp)}`);
    }

    // ── 2. `sin_catalogo` no se disfraza de `externo` ───────────────────────────────────────
    console.log('\n[2] El cliente fuera del catálogo se DECLARA, no se cuenta como externo');
    const sc = kinds.find((r) => r.kind === 'sin_catalogo');
    if (!sc) {
      nm('no hubo documentos con cliente fuera del catálogo en la ventana — nada que declarar');
    } else {
      chk(Number(sc.imp) > 0,
        `${sc.docs} documentos / $${n(sc.imp)} salen rotulados sin_catalogo en vez de engordar `
        + 'el ingreso externo en silencio');
    }

    // ── 3. El envoltorio fiscal no entra al vendido externo ─────────────────────────────────
    console.log('\n[3] La factura global U-D-6 no se suma al mostrador');
    const [env] = await q(
      `SELECT count(*)::int filas,
              count(*) FILTER (WHERE doctype = 'U-D-6' AND NOT es_envoltorio_fiscal)::int mal
         FROM analytics.v_erp_income_daily
        WHERE fecha BETWEEN $1::date AND $2::date AND doctype = 'U-D-6'`, [MES_DESDE, MES_HASTA]);
    if (!env || env.filas === 0) {
      nm('no hay facturas globales U-D-6 en la ventana');
    } else {
      chk(env.mal === 0,
        `las ${env.filas} filas de U-D-6 vienen marcadas es_envoltorio_fiscal — el consumidor las `
        + 'puede excluir sin tener que saber que envuelven a los tickets');
    }

    // ── 4. ⭐ El cruce de verdad: aplicaciones de kdm5 contra el dinero cobrado ──────────────
    console.log('\n[4] Lo casado cuadra con lo cobrado — dos caminos, el mismo hecho');
    const [cob] = await q(
      `SELECT COALESCE(sum(importe),0)::numeric imp, COALESCE(sum(cobros),0)::int cobros
         FROM analytics.v_erp_collection_daily
        WHERE sucursal = $1 AND fecha = $2::date`, [SUC, DIA]);
    const [apl] = await q(
      `SELECT count(*)::int pagos, count(DISTINCT a.c11)::int facturas,
              COALESCE(sum(a.c12::numeric),0)::numeric imp
         FROM kepler_ods.kdm5 a
         JOIN kepler_ods.kdm1 m
           ON m.sucursal=a.sucursal AND m.c1=a.c1 AND m.c2=a.c2 AND m.c3=a.c3
          AND m.c4=a.c4 AND m.c5=a.c5 AND m.c6=a.c6
        WHERE a.sucursal = $1 AND a.c2='U' AND a.c3='A' AND a.c4 IN ('5','7')
          AND btrim(coalesce(m.c43::text,'')) <> 'C' AND m.c9::date = $2::date`, [SUC, DIA]);
    if (!cob || Number(cob.cobros) === 0) {
      nm(`la sucursal ${SUC} no registró cobros el ${DIA} — sin dinero que cruzar`);
    } else {
      const d = Math.abs(Number(cob.imp) - Number(apl.imp));
      chk(d < 0.01,
        `sucursal ${SUC} el ${DIA}: cobrado $${n(cob.imp)} (${cob.cobros} cobros) == aplicado `
        + `$${n(apl.imp)} (${apl.pagos} pagos contra ${apl.facturas} facturas) — Δ ${n(d)}`);
    }

    // ── 5. Metadata que un CREATE OR REPLACE no hereda ──────────────────────────────────────
    console.log('\n[5] security_invoker y grants sobrevivieron');
    for (const v of ['v_kepler_customer_kind', 'v_erp_income_daily', 'v_erp_collection_daily']) {
      const [m] = await q(
        `SELECT coalesce(array_to_string(c.reloptions,','),'') opts,
                has_table_privilege('app_runtime', 'analytics.'||$1, 'SELECT') app
           FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
          WHERE ns.nspname='analytics' AND c.relname=$1`, [v]);
      chk(!!m && /security_invoker=true/.test(m.opts) && m.app === true,
        `${v}: security_invoker y SELECT para app_runtime`);
    }

    // ── 6. El hueco que NO se puede medir, declarado ─────────────────────────────────────────
    console.log('\n[6] El medio de pago del mostrador');
    const [c45] = await q(
      `SELECT count(*)::int docs, count(*) FILTER (WHERE btrim(coalesce(c45::text,'')) <> '')::int con
         FROM kepler_ods.kdm1
        WHERE c2='U' AND c3='D' AND c4='10' AND c9::date BETWEEN $1::date AND $2::date`,
      [MES_DESDE, MES_HASTA]);
    if (c45 && c45.con > 0) {
      // Si Kepler EMPIEZA a llenarlo, esto deja de ser un hueco y hay que cablearlo.
      chk(false,
        `⛔ ${c45.con} de ${c45.docs} tickets YA traen cuenta de tesorería (c45): el medio de pago `
        + 'del mostrador dejó de ser un hueco — cablearlo a la conciliación');
    } else {
      nm(`el medio de pago del mostrador no existe en Kepler: c45 vacía en los ${c45?.docs ?? 0} `
        + 'tickets de la ventana. No se dibuja: se declara en el puente');
    }
  } finally {
    await c.end().catch(() => undefined);
  }

  console.log(`\n=== ${ok} OK · ${fail} FALLA · ${skip} NO MEDIDO ===`);
  if (fail > 0) process.exitCode = 1;
})();
