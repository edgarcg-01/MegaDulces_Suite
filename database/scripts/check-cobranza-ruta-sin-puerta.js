'use strict';
/**
 * ⭐⭐ `[CG.120]` — **Qué rutas vendieron y su cobranza NO tiene por dónde entrar a caja general.**
 *
 *   node database/scripts/check-cobranza-ruta-sin-puerta.js
 *   node database/scripts/check-cobranza-ruta-sin-puerta.js --dias=30
 *
 * Sólo lee.
 *
 * ── De dónde sale, medido el 2026-10-13 ─────────────────────────────────────────────────────
 *
 * Edgar: *"aún existen capturas a mano, hay que buscar qué nos falló"*. Se midió la cadena entera
 * y la respuesta fue que **no falló nada de la app: falta el camino**.
 *
 * Cuatro ingresos se teclearon desde cero el 13-oct y cuadran al centavo con la venta de ruta del
 * 08-oct — rutas **501 ($29,339.79), 502 ($16,482.23) y 503 ($24,450.82)**. No estaban en ninguna
 * bandeja porque **no existen como cobro `U-A-5` en Kepler**: se buscó por importe del 05 al
 * 14-oct, en caja y en banco, y no hay ninguno.
 *
 * El hueco estructural, medido sobre 14 días:
 *
 *     con cobros en la bandeja ............  21, 22, 26, 27      $899,263
 *     SIN ALMACEN en el mapa ..............  501, 502, 503, 504  $768,377
 *     con almacen y CERO cobros ...........  23, 28              $426,998
 *
 * Las de Canindo (sucursal 06) traen `almacen_erp` **NULL** en `analytics.v_rd_route_identity`:
 * no hay con qué ligarlas aunque el cobro existiera. Las 21–28 que sí entraron lo hicieron **por
 * CAOS** (la bóveda de oficinas), no por esta bandeja — y Canindo no tiene bóveda, así que no
 * tiene ninguna de las dos puertas.
 *
 * ── Por qué ESTA forma y no otra ────────────────────────────────────────────────────────────
 *
 * ⛔ **No se mide "faltan cobros" por importe.** Un cruce por importe exige control de placebo y
 * acá la pregunta es estructural, no estadística: o la ruta tiene almacén y aparece en
 * `route_collections`, o no. Eso es verificable sin tolerancia.
 *
 * ⛔ **Tres estados, no dos.** `sin_almacen` lo arregla quien administra el catálogo de rutas;
 * `sin_cobros` lo arregla quien captura en Kepler. Fundirlos en "no tiene puerta" mandaría a las
 * dos mitades a tocar la puerta equivocada.
 *
 * ⚠️ **El join NO es por `LIKE`.** El primer intento cruzó `route_collections.almacen` contra el
 * código de ruta con `almacen LIKE '%' || route_code` y dio `false` en las 18 filas **por
 * construcción** — `01-001` nunca va a terminar en `21`. Una compuerta que siempre dice lo mismo
 * no mide: el puente es `v_rd_route_identity.almacen_erp`.
 *
 * ⚠️ **No declara una ruta sana por tener UN cobro.** Publica cuántos cobros y cuántos días
 * vendió, para que "1 cobro en 12 días de venta" se vea como lo que es.
 *
 * Salida: código 0 siempre. **Esto informa, no frena** — las rutas sin puerta son un hecho del
 * negocio que alguien tiene que resolver, no una regresión de código que haya que bloquear.
 */

require('dotenv').config();
const { Client } = require('pg');

const URL = process.env.DATABASE_URL_NEW || process.env.PROD_DB_URL;
const DIAS = Number((process.argv.find((a) => a.startsWith('--dias=')) || '').split('=')[1]) || 14;

const money = (n) => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  if (!URL) { console.error('Falta DATABASE_URL_NEW (o PROD_DB_URL).'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query(`SET statement_timeout = '120s'`);

  const { rows } = await c.query(`
    WITH venta AS (
      SELECT route_code, sum(venta) AS venta, count(*)::int AS dias
        FROM analytics.mv_rd_route_daily_200d
       WHERE business_date BETWEEN current_date - $1::int AND current_date
         AND venta > 0 AND source = 'push'
       GROUP BY 1
    ), rc AS (
      SELECT almacen, count(*)::int AS cobros, max(fecha)::date AS ultimo
        FROM analytics.route_collections
       WHERE fecha >= current_date - $1::int
       GROUP BY 1
    )
    SELECT v.route_code, i.plaza, i.suc_emisor, i.almacen_erp,
           round(v.venta, 2) AS venta, v.dias,
           coalesce(rc.cobros, 0) AS cobros, rc.ultimo,
           CASE WHEN i.route_no IS NULL          THEN 'sin_identidad'
                WHEN i.almacen_erp IS NULL       THEN 'sin_almacen'
                WHEN coalesce(rc.cobros,0) = 0   THEN 'sin_cobros'
                ELSE 'con_puerta' END AS estado
      FROM venta v
      LEFT JOIN analytics.v_rd_route_identity i ON i.route_no = v.route_code
      LEFT JOIN rc ON rc.almacen = i.almacen_erp
     ORDER BY v.venta DESC`, [DIAS]);

  if (!rows.length) {
    // ⛔ Cero filas NO es "todo bien": es que no hubo venta de ruta o la matvista está vacía.
    console.log(`ⓘ NO MEDIDO — ninguna ruta registró venta en los últimos ${DIAS} días.`);
    console.log('  O no se vendió, o `analytics.mv_rd_route_daily_200d` no se está refrescando.');
    await c.end();
    return;
  }

  const QUE_HACER = {
    sin_identidad: 'la ruta no está en v_rd_route_identity: nadie puede ligar su cobranza',
    sin_almacen:   'falta asignarle almacén en el catálogo de rutas (lo arregla el administrador)',
    sin_cobros:    'tiene almacén y CERO cobros: o nadie captura el U-A-5 en Kepler, o su feed no corre',
    con_puerta:    '—',
  };

  console.log(`\nCobranza de ruta · últimos ${DIAS} días · ${rows.length} ruta(s) con venta\n`);
  console.log('  ruta   plaza            almacén    días  cobros   venta            estado');
  console.log('  ' + '─'.repeat(88));
  for (const r of rows) {
    const marca = r.estado === 'con_puerta' ? ' ' : '⚠';
    console.log(
      `${marca} ${String(r.route_code).padEnd(6)} ${String(r.plaza ?? '—').padEnd(16)} `
      + `${String(r.almacen_erp ?? '(ninguno)').padEnd(10)} ${String(r.dias).padStart(4)} `
      + `${String(r.cobros).padStart(6)}   ${money(r.venta).padStart(14)}   ${r.estado}`);
  }

  const por = {};
  for (const r of rows) {
    por[r.estado] = por[r.estado] || { n: 0, venta: 0, cuales: [] };
    por[r.estado].n++;
    por[r.estado].venta += Number(r.venta);
    por[r.estado].cuales.push(r.route_code);
  }

  console.log('\nResumen');
  for (const [estado, v] of Object.entries(por).sort((a, b) => b[1].venta - a[1].venta)) {
    console.log(`  ${estado.padEnd(14)} ${String(v.n).padStart(2)} ruta(s)  ${money(v.venta).padStart(14)}  ${v.cuales.join(', ')}`);
    if (estado !== 'con_puerta') console.log(`                 → ${QUE_HACER[estado]}`);
  }

  const sinPuerta = rows.filter((r) => r.estado !== 'con_puerta');
  const dinero = sinPuerta.reduce((s, r) => s + Number(r.venta), 0);
  console.log(
    `\n${sinPuerta.length} de ${rows.length} rutas (${money(dinero)} en ${DIAS} días) no tienen por dónde`
    + ' entrar su cobranza a caja general: lo que vendan se captura a mano.');

  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
