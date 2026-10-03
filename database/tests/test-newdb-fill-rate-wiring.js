/**
 * `[RA-DYN.U7]` — **El cumplimiento del proveedor, ya cableado al pedido.**
 *
 * `[RA-DYN.U5/U6]` dejó la medición en prod y servía para negociar. Esto la mete al motor: el
 * pedido de `/compras/pedido` se divide por el fill rate del proveedor, topado en
 * `fill_max_inflate`. Es un cambio de número publicado, así que el candado no mira el número —
 * mira **las cinco premisas que lo hacen defendible**.
 *
 * ── 1. El grano es PROVEEDOR porque se midió, no porque se supuso ────────────────────────────
 * La intuición decía SKU: el faltante está concentrado (en MONDELEZ el peor 10% de los SKUs carga
 * el 49.5% del dinero no surtido, y 80 de sus 174 SKUs nunca fallaron). Partiendo la historia de
 * cada sujeto en dos mitades cronológicas y preguntando si la primera predice la segunda, el orden
 * se invierte: **proveedor 0.495 · (proveedor, SKU) 0.240**. El faltante se amontona DENTRO de un
 * periodo, pero **cuáles** SKUs fallan cambia entre periodos. Si esta premisa se da vuelta, el
 * diseño está cableado al grano equivocado.
 *
 * ── 2. El umbral de 25 renglones es el borde medido de la señal ──────────────────────────────
 * Debajo de 25 la correlación pasado-futuro es CERO (-0.026 entre 6 y 14 renglones, -0.052 entre
 * 15 y 24); arriba salta a 0.607 / 0.341. ⚠️ Y el dinero NO decide: entre umbral 3 y umbral 50 el
 * sugerido se mueve 1.5%. Bajar el umbral casi no agrega pedido, sólo agrega ruido.
 *
 * ── 3. La guarda del GREATEST ────────────────────────────────────────────────────────────────
 * `GREATEST` **ignora los NULL** en Postgres. Sin el `COALESCE(..., 1.0)` por dentro, todo
 * proveedor SIN medición se llevaría el inflado máximo (+30%) — el que menos lo merece. El bloque
 * [3] reproduce la trampa en vivo y verifica que la expresión del motor no cae en ella.
 *
 * ── 4. El tope acota el daño ─────────────────────────────────────────────────────────────────
 * Kepler no distingue un renglón que NOSOTROS cancelamos de uno que el proveedor no surtió. Esa
 * ignorancia no se puede cerrar con esta fuente, así que se acota: el factor nunca pasa de
 * `fill_max_inflate`, y el fill rate nunca sale de [0,1] (si saliera, podría ENCOGER un pedido,
 * que es otra operación y nadie la pidió).
 *
 * ── 5. El homónimo no llega al motor ─────────────────────────────────────────────────────────
 * 202 nombres repetidos en `catalog.suppliers`. Su calificación mezcla negocios distintos; cuesta
 * $2,393 del delta dejarlos fuera y evita inflarle el pedido a uno por culpa de otro.
 *
 * Uso: DATABASE_URL_NEW=<destino> node database/tests/test-newdb-fill-rate-wiring.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
let fail = 0;
let noMedido = 0;
const ok = (c, m) => { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) fail++; };
const nm = (m) => { console.log(`  ⚠️  NO MEDIDO — ${m}`); noMedido++; };

// La celda del pedido, tal como la publica workbook(): grano (producto, almacén), cobertura 30,
// con el mismo gate de peldaño (U.2). Se reconstruye acá para poder medir el ANTES y el DESPUÉS
// sobre el MISMO dato, que es lo único que vuelve comparable un cambio de número publicado.
const CELDA = `
  cel AS (
    SELECT rp.product_id, rp.warehouse_id, pr.supplier_id, COALESCE(rp.caja_cost,0) AS cc,
           CASE WHEN COALESCE(rp.rung_veredicto,'ok') IN ('ok','sin_dato','z_no_arbitrable') THEN
             GREATEST(0, COALESCE(rp.daily_pieces,0) * COALESCE(rp.season_ratio,1) * 30
                         / (COALESCE(rp.suf,1) * COALESCE(rp.bf,1))
                       - COALESCE(rp.stock_pz,0) / GREATEST(COALESCE(rp.display_bf,rp.bf,1),1)
                       - COALESCE(rp.transit_eff_cajas, rp.transit_cajas, 0))
           END AS ped
      FROM analytics.replenishment_plan rp
      JOIN catalog.products pr ON pr.id = rp.product_id AND pr.tenant_id = rp.tenant_id
     WHERE rp.tenant_id = '${T}' AND pr.activo = true AND pr.deleted_at IS NULL
       AND (rp.stock_pz > 0 OR rp.daily_pieces > 0 OR rp.transit_cajas > 0))`;

// El fill rate del motor, con los tres parámetros vigentes.
const FILL = `
  fre AS (
    SELECT supplier_id,
           1 - sum(importe_no_surtido) / NULLIF(sum(importe_pedido), 0) AS fr,
           count(*)::int AS n
      FROM analytics.mv_supplier_fill_rate
     WHERE supplier_id IS NOT NULL
       AND primera_entrega >= current_date - make_interval(days => (SELECT fwin FROM par))
     GROUP BY supplier_id
    HAVING count(*) >= (SELECT fmin FROM par)
       AND sum(importe_pedido) > 0
       AND NOT bool_or(supplier_ambiguo))`;

(async () => {
  try {
    const existe = (await knex.raw(
      `SELECT to_regclass('analytics.mv_supplier_fill_rate') AS t`)).rows[0]?.t;
    if (!existe) {
      nm('la matvista del cumplimiento no existe (¿migración 20261002190000 pendiente?)');
      console.log('\n⚠️  cableado del fill rate: NO MEDIDO');
      process.exit(2);
    }

    // Los parámetros SALEN DE LA DB, no de este archivo: si alguien mueve el knob, el candado mide
    // el motor que de verdad corre, no el que yo supuse al escribirlo.
    const tieneCol = (await knex.raw(`
      SELECT EXISTS(SELECT 1 FROM information_schema.columns
                     WHERE table_schema='commercial' AND table_name='replenishment_settings'
                       AND column_name='fill_min_lines_erp') AS c`)).rows[0].c;
    const PAR = `par AS (SELECT ${tieneCol
      ? `COALESCE(max(fill_window_days),180) AS fwin, GREATEST(COALESCE(max(fill_min_lines_erp),25),25) AS fmin, COALESCE(max(fill_max_inflate),1.30) AS maxinf FROM commercial.replenishment_settings WHERE tenant_id='${T}'`
      : `180 AS fwin, 25 AS fmin, 1.30 AS maxinf`})`;
    if (!tieneCol) nm('falta commercial.replenishment_settings.fill_min_lines_erp (mig 20261003120000): el candado mide con los defaults del servicio');

    console.log('\n[1] PREMISA — el grano PROVEEDOR predice mejor que el grano SKU');
    // Si esto se invierte, el motor está corrigiendo con el sujeto equivocado.
    const { rows: [g] } = await knex.raw(`
      WITH ls AS (SELECT supplier_id, importe_pedido p, importe_no_surtido f,
                         ntile(2) OVER (PARTITION BY supplier_id ORDER BY primera_entrega) m
                    FROM analytics.mv_supplier_fill_rate WHERE supplier_id IS NOT NULL),
      gs AS (SELECT supplier_id, sum(p) FILTER (WHERE m=1) p1, sum(f) FILTER (WHERE m=1) f1,
                    sum(p) FILTER (WHERE m=2) p2, sum(f) FILTER (WHERE m=2) f2
               FROM ls GROUP BY 1 HAVING count(*) >= 25),
      lk AS (SELECT supplier_id, sku, importe_pedido p, importe_no_surtido f,
                    ntile(2) OVER (PARTITION BY supplier_id, sku ORDER BY primera_entrega) m
               FROM analytics.mv_supplier_fill_rate WHERE supplier_id IS NOT NULL),
      gk AS (SELECT supplier_id, sku, sum(p) FILTER (WHERE m=1) p1, sum(f) FILTER (WHERE m=1) f1,
                    sum(p) FILTER (WHERE m=2) p2, sum(f) FILTER (WHERE m=2) f2
               FROM lk GROUP BY 1,2 HAVING count(*) >= 6)
      SELECT (SELECT round(corr(1-f1/p1, 1-f2/p2)::numeric,3) FROM gs WHERE p1>0 AND p2>0) AS corr_prov,
             (SELECT count(*)::int                            FROM gs WHERE p1>0 AND p2>0) AS n_prov,
             (SELECT round(corr(1-f1/p1, 1-f2/p2)::numeric,3) FROM gk WHERE p1>0 AND p2>0) AS corr_sku,
             (SELECT count(*)::int                            FROM gk WHERE p1>0 AND p2>0) AS n_sku`);
    if (g.corr_prov == null || g.corr_sku == null) {
      nm('no hay historia partible en dos mitades: la premisa del grano no se pudo comprobar');
    } else {
      ok(Number(g.corr_prov) > Number(g.corr_sku),
        `proveedor ${g.corr_prov} (n=${g.n_prov}) vs (proveedor,SKU) ${g.corr_sku} (n=${g.n_sku}) — ` +
        'el grano que usa el motor es el que más predice');
      ok(Number(g.corr_prov) > 0.2,
        `y predice de verdad: correlación ${g.corr_prov} entre la primera y la segunda mitad`);
    }

    console.log('\n[2] PREMISA — debajo del umbral no hay señal (por eso el umbral, no por el dinero)');
    const { rows: bk } = await knex.raw(`
      WITH l AS (SELECT supplier_id, importe_pedido p, importe_no_surtido f,
                        ntile(2) OVER (PARTITION BY supplier_id ORDER BY primera_entrega) m,
                        count(*) OVER (PARTITION BY supplier_id) n
                   FROM analytics.mv_supplier_fill_rate WHERE supplier_id IS NOT NULL),
      gg AS (SELECT supplier_id, max(n) n, sum(p) FILTER (WHERE m=1) p1, sum(f) FILTER (WHERE m=1) f1,
                    sum(p) FILTER (WHERE m=2) p2, sum(f) FILTER (WHERE m=2) f2
               FROM l GROUP BY 1)
      SELECT CASE WHEN n < 25 THEN 'bajo_umbral' ELSE 'sobre_umbral' END AS lado,
             count(*)::int prov, round(corr(1-f1/p1, 1-f2/p2)::numeric,3) AS correlacion
        FROM gg WHERE p1 > 0 AND p2 > 0 GROUP BY 1`);
    const bajo = bk.find(r => r.lado === 'bajo_umbral');
    const sobre = bk.find(r => r.lado === 'sobre_umbral');
    if (!bajo || !sobre || bajo.correlacion == null || sobre.correlacion == null) {
      nm('un lado del umbral quedó sin proveedores comparables: no se puede contrastar');
    } else {
      ok(Number(sobre.correlacion) > Number(bajo.correlacion) + 0.15,
        `bajo 25 renglones: ${bajo.correlacion} (n=${bajo.prov}) · sobre 25: ${sobre.correlacion} ` +
        `(n=${sobre.prov}) — el corte separa señal de ruido`);
    }

    console.log('\n[3] PRUEBA NEGATIVA — GREATEST ignora los NULL, y la guarda lo compensa');
    // La trampa primero: se demuestra que es REAL en este Postgres, no que yo me acuerde de ella.
    const { rows: [t] } = await knex.raw(`
      SELECT GREATEST(NULL::numeric, 1.0/1.30) AS sin_guarda,
             GREATEST(COALESCE(NULL::numeric, 1.0), 1.0/1.30) AS con_guarda`);
    ok(Math.abs(Number(t.sin_guarda) - 0.769) < 0.01,
      `la trampa existe: GREATEST(NULL, 1/1.30) devuelve ${Number(t.sin_guarda).toFixed(3)}, ` +
      'o sea el inflado MÁXIMO para un proveedor sin medición');
    ok(Number(t.con_guarda) === 1,
      `con el COALESCE adentro devuelve ${t.con_guarda}: sin medición, el pedido no se mueve`);
    // Y que la expresión del motor tenga la guarda puesta.
    const fuente = require('fs').readFileSync(
      path.resolve(__dirname, '..', '..', 'libs/commercial/src/lib/commercial-replenishment/commercial-replenishment.service.ts'),
      'utf8');
    ok(/GREATEST\(COALESCE\(\$\{col\},\s*1\.0\),\s*1\.0\s*\/\s*:maxinf\)/.test(fuente),
      'el motor construye el factor con el COALESCE por dentro del GREATEST');

    console.log('\n[4] PREMISA — el fill vive en [0,1] y el factor nunca pasa del tope');
    const { rows: [c4] } = await knex.raw(`
      WITH ${PAR}, ${FILL}
      SELECT count(*)::int proveedores,
             count(*) FILTER (WHERE fr < 0 OR fr > 1)::int fuera_de_rango,
             round(min(fr),3)::float8 peor, min(n)::int muestra_minima,
             round(max(1.0/GREATEST(COALESCE(fr,1.0), 1.0/(SELECT maxinf FROM par))),4)::float8 factor_max,
             (SELECT maxinf FROM par)::float8 tope
        FROM fre`);
    ok(c4.fuera_de_rango === 0,
      `${c4.proveedores} proveedores medidos, ${c4.fuera_de_rango} con fill fuera de [0,1] ` +
      `(peor ${c4.peor})`);
    ok(Number(c4.factor_max) <= Number(c4.tope) + 1e-9,
      `el factor más alto es ×${c4.factor_max} y el tope es ×${c4.tope}: nadie se infla por encima`);
    ok(c4.muestra_minima >= 25,
      `la muestra más chica que entra al motor son ${c4.muestra_minima} renglones`);

    console.log('\n[5] PREMISA — el nombre con homónimos no llega al motor');
    const { rows: [h] } = await knex.raw(`
      WITH ${PAR}, ${FILL}
      SELECT (SELECT count(*)::int FROM analytics.mv_supplier_fill_rate
               WHERE supplier_ambiguo AND supplier_id IS NOT NULL)        AS renglones_ambiguos,
             (SELECT count(*)::int FROM fre f
               WHERE EXISTS (SELECT 1 FROM analytics.mv_supplier_fill_rate m
                              WHERE m.supplier_id = f.supplier_id AND m.supplier_ambiguo)) AS se_colaron`);
    if (!h.renglones_ambiguos) {
      nm('ya no hay renglones ambiguos: la exclusión quedó sin universo que vigilar');
    } else {
      ok(h.se_colaron === 0,
        `${h.renglones_ambiguos} renglones de nombre repetido en la matvista y ${h.se_colaron} ` +
        'llegaron al motor');
    }

    console.log('\n[6] EL CAMBIO DE NÚMERO — antes, después, y quién NO se movió');
    const { rows: [d] } = await knex.raw(`
      WITH ${PAR}, ${CELDA}, ${FILL}
      SELECT count(*) FILTER (WHERE ped > 0)::int celdas,
             round(sum(ped*cc))::float8 antes,
             round(sum(ped*cc / GREATEST(COALESCE(fre.fr,1.0), 1.0/(SELECT maxinf FROM par))))::float8 despues,
             round(100.0*sum(ped*cc*(1/GREATEST(COALESCE(fre.fr,1.0),1.0/(SELECT maxinf FROM par))-1))
                   / NULLIF(sum(ped*cc),0), 2)::float8 delta_pct,
             count(*) FILTER (WHERE ped > 0 AND fre.fr IS NOT NULL)::int celdas_corregidas,
             -- EL INVARIANTE: una celda sin medición tiene que publicar EXACTAMENTE lo de antes.
             count(*) FILTER (WHERE ped > 0 AND fre.fr IS NULL
                              AND ped*cc <> ped*cc / GREATEST(COALESCE(fre.fr,1.0), 1.0/(SELECT maxinf FROM par)))::int se_movieron_sin_medicion
        FROM cel LEFT JOIN fre ON fre.supplier_id = cel.supplier_id`);
    ok(d.se_movieron_sin_medicion === 0,
      `${d.celdas - d.celdas_corregidas} celdas sin fill medido, y ${d.se_movieron_sin_medicion} ` +
      'cambiaron de número: sin medición el pedido queda intacto');
    ok(Number(d.delta_pct) >= 0 && Number(d.delta_pct) <= 30,
      `pedido ${d.antes ? '$' + Number(d.antes).toLocaleString('es-MX') : 's/d'} → ` +
      `$${Number(d.despues).toLocaleString('es-MX')} (${d.delta_pct}%), sobre ${d.celdas_corregidas} ` +
      `de ${d.celdas} celdas con pedido`);

    console.log('\n[7] Presupuesto de tiempo');
    const t0 = Date.now();
    await knex.raw(`WITH ${PAR}, ${FILL} SELECT count(*) FROM fre`);
    const ms = Date.now() - t0;
    ok(ms < 1000, `el fill rate de todos los proveedores: ${ms} ms (va como CTE MATERIALIZED, una vez)`);

    console.log('\n[8] Lo que esta fuente NO puede decidir');
    nm('Kepler no marca la cancelación en el renglón: un renglón que cancelamos NOSOTROS se ve ' +
       'igual que uno que el proveedor no surtió. El inflado va topado y declarado en pantalla ' +
       'justamente porque esa atribución no se puede medir con esta fuente.');

    console.log(
      (fail ? `\n❌ cableado del fill rate: ${fail} falla(s)` : '\n✅ cableado del fill rate: verde')
      + (noMedido ? ` · ${noMedido} NO MEDIDO` : ''));
    process.exit(fail ? 1 : (noMedido ? 2 : 0));
  } catch (e) {
    console.error('\n❌ ERROR:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
