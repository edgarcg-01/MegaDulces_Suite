'use strict';
/**
 * [EXP.1] Candado de las señales del descuadre — `analytics.mv_erp_count_line_signals`.
 *
 *   node database/tests/test-newdb-variance-senales.js
 *
 * Sólo lee.
 *
 * ── Qué protege, y por qué cada cosa ────────────────────────────────────────────────────
 *
 * 1. **EL GRANO.** La matvista de IC.12 es por LÍNEA de kdm2 y ésta es por SKU. Si alguien
 *    "simplifica" colgando las señales de aquélla, los `sum(...) filter` cuentan de más y
 *    **nada se ve roto**: los totales siguen siendo plausibles. Medido: 22,332 líneas sobre
 *    20,849 pares = 1,483 de más.
 *
 * 2. **EL ABANICO.** El join al roll-forward por `hasta = fecha` tiene que seguir siendo 1:1.
 *    Sin esa igualdad multiplica filas — error ya cometido una vez en esta misma fase (6,852
 *    filas sobre un universo de 4,271).
 *
 * 3. **LA PARTICIÓN.** `explicacion` tiene que particionar: ningún renglón sin etiqueta,
 *    ninguna etiqueta fuera del vocabulario. Y la frontera que importa:
 *    `sin_explicacion` ⟹ no falta ningún testigo. Mezclarlos infla la pila accionable 14 veces.
 *
 * 4. ⛔ **LA PREMISA DE QUE LA PISTA SEA PISTA.** `excede_la_venta` NO está en la partición
 *    porque su placebo falla: dispara en ~17% de los sobrantes y ~10% de los faltantes, donde
 *    no explica nada. Este candado **vuelve a medir el placebo**, no sólo el resultado. Si
 *    alguna vez la razón se separa de verdad, el test lo dice y recién ahí se puede promover.
 *    (Un candado que sólo mira la salida deja pasar un cambio de premisa.)
 *
 * 5. ⛔ **EL ESPEJO DE LOS UMBRALES.** `inventory-variance.service.ts` publica 0.2 / 0.8 en la
 *    leyenda, pero el cálculo vive en SQL desde `[EXP.1a]`. Un espejo se desfasa en silencio:
 *    acá se comparan contra los bordes que la vista produce de verdad.
 *
 * 6. **LA REFUTACIÓN QUE NO HAY QUE RECONSTRUIR.** La entrada duplicada se midió y NO aplica:
 *    las 1,001 recepciones marcadas son de la sucursal 00 y el universo contado son 01 a 06.
 *    Si algún día se tocan, este test lo avisa en vez de dejar la señal perdida en un plan.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knexLib = require('knex');

let ok = 0, bad = 0, nm = 0;
const t = (n, c, x) => { if (c) { ok++; console.log(`  ✔ ${n}`); }
  else { bad++; console.log(`  ✘ ${n}${x ? ' — ' + x : ''}`); } };
const noMedido = (n, m) => { nm++; console.log(`  ◻ NO MEDIDO: ${n} — ${m}`); };

const VOCABULARIO = ['costo_de_caja', 'movimientos_lo_explican', 'merma_sostenida',
  'sobra_sostenida', 'se_compensa', 'sin_explicacion', 'no_medido',
  // [EXP.3] Los tres flujos arbitrados que el roll-forward no cuenta.
  'salida_de_almacen', 'devolucion_de_cliente', 'devolucion_de_compra'];

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const db = knexLib({
    client: 'pg',
    connection: { connectionString: url,
      ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(url) ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });

  console.log('\n=== [EXP.1] las señales que explican el descuadre ===\n');
  try {
    await db.raw("SET statement_timeout = '180s'");

    const [{ mv, hist_patron }] = (await db.raw(`
      SELECT to_regclass('analytics.mv_erp_count_line_signals') IS NOT NULL AS mv,
             EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='analytics'
                        AND table_name='v_sku_count_variance_history'
                        AND column_name='patron') AS hist_patron`)).rows;

    // ── [EXP.1a] El patrón vive en SQL, y el servicio lo LEE ──────────────────────────
    t('[EXP.1a] la vista de historial publica `patron`', hist_patron === true,
      'falta correr 20260930230000_sku_variance_history_patron.js');
    {
      const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'libs', 'commercial', 'src',
        'lib', 'commercial-inventory', 'inventory-variance.service.ts'), 'utf8');
      // ⚠️ Comprobación ESTRUCTURAL sobre el fuente: no prueba que la regla sea correcta, sólo
      // que no volvió a haber dos. Se declara como lo que es.
      const deriva = /THEN 'se_compensa'/.test(src);
      t('⛔ el servicio NO vuelve a derivar el patrón — una definición, dos lectores', !deriva,
        'reapareció el CASE en inventory-variance.service.ts');
    }

    if (!mv) {
      noMedido('toda la matvista de señales',
        'no existe analytics.mv_erp_count_line_signals en este destino: falta aplicar '
        + '20260930240000_erp_count_line_signals_mv.js');
      console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
      await db.destroy(); process.exit(bad > 0 ? 1 : 0);
    }

    // ── 1. EL GRANO ───────────────────────────────────────────────────────────────────
    {
      const [g] = (await db.raw(`
        SELECT (SELECT count(*)::int FROM analytics.mv_erp_count_line_signals) AS filas,
               (SELECT count(*)::int FROM analytics.mv_erp_physical_count_variance
                 WHERE tipo_evento='conteo') AS lineas,
               (SELECT count(*)::int FROM (
                  SELECT 1 FROM analytics.mv_erp_physical_count_variance
                   WHERE tipo_evento='conteo'
                   GROUP BY tenant_id, warehouse_id, fecha, sku) z) AS pares`)).rows;
      t(`la matvista tiene UNA fila por (almacén, fecha, SKU) — ${g.filas}`,
        g.filas === g.pares, `filas=${g.filas} pares=${g.pares}`);
      t(`⛔ y son MENOS que las líneas del ajuste (${g.lineas} − ${g.filas} = ${g.lineas - g.filas} de más)`,
        g.filas < g.lineas,
        'si fueran iguales, el grano colapsó y los sum() filter cuentan de más sin verse roto');
    }

    // ── 2. EL ABANICO: el roll-forward sigue siendo 1:1 ──────────────────────────────
    {
      const [{ peor }] = (await db.raw(`
        SELECT coalesce(max(n), 0)::int AS peor FROM (
          SELECT count(*)::int AS n
            FROM analytics.mv_erp_count_line_signals s
            JOIN analytics.mv_erp_count_rollforward r
              ON r.tenant_id=s.tenant_id AND r.warehouse_id=s.warehouse_id
             AND r.hasta=s.fecha AND r.sku=s.sku
           GROUP BY s.tenant_id, s.warehouse_id, s.fecha, s.sku) z`)).rows;
      t('⛔ el roll-forward une 1:1 por `hasta = fecha` — el abanico NO se dispara',
        Number(peor) <= 1, `el peor par trae ${peor} filas del roll-forward`);
    }

    // ── 3. LA PARTICIÓN ──────────────────────────────────────────────────────────────
    {
      const { rows: v } = await db.raw(`
        SELECT explicacion, count(*)::int AS n,
               round(sum(abs(importe_neto)))::bigint AS pesos
          FROM analytics.mv_erp_count_line_signals GROUP BY 1 ORDER BY 1`);
      const fuera = v.filter((r) => !VOCABULARIO.includes(r.explicacion));
      t('toda etiqueta pertenece al vocabulario cerrado', fuera.length === 0,
        fuera.map((r) => r.explicacion).join(','));
      const [{ sin_etiqueta }] = (await db.raw(
        `SELECT count(*)::int AS sin_etiqueta FROM analytics.mv_erp_count_line_signals
          WHERE explicacion IS NULL`)).rows;
      t('ningún renglón se queda sin explicación', Number(sin_etiqueta) === 0);
      for (const r of v) console.log(`      ⓘ ${r.explicacion}: ${r.n} SKUs · $${r.pesos}`);
    }
    {
      const [f] = (await db.raw(`
        SELECT count(*) FILTER (WHERE explicacion='sin_explicacion'
                                  AND cardinality(testigos_faltantes) > 0)::int AS pila_sucia,
               count(*) FILTER (WHERE explicacion='no_medido'
                                  AND cardinality(testigos_faltantes) = 0)::int AS medido_mal
          FROM analytics.mv_erp_count_line_signals`)).rows;
      t('⛔ `sin_explicacion` NUNCA lleva un testigo faltante — es «busqué y no hay», no «no pude»',
        Number(f.pila_sucia) === 0, `${f.pila_sucia} renglones mezclan las dos cosas`);
      t('⛔ y `no_medido` SIEMPRE nombra qué testigo le faltó',
        Number(f.medido_mal) === 0, `${f.medido_mal} dicen no_medido sin decir de qué`);
    }

    // ── 4. ⛔ LA PREMISA: el placebo de la pista se vuelve a medir ───────────────────
    // Un candado que sólo mira la salida deja pasar un cambio de premisa. Acá se re-mide la
    // razón sobrante/faltante: es LA razón por la que `excede_la_venta` no está en la
    // partición. Si algún día separa de verdad, este test lo dice.
    {
      const [p] = (await db.raw(`
        WITH d AS (SELECT CASE WHEN importe_neto > 0 THEN 'sob' ELSE 'fal' END AS lado,
                          (demanda_motivo = 'medida') AS medible,
                          (abs(dias_de_venta) > 90)   AS excede
                     FROM analytics.mv_erp_count_line_signals)
        SELECT count(*) FILTER (WHERE lado='sob' AND medible)::int AS sob,
               count(*) FILTER (WHERE lado='fal' AND medible)::int AS fal,
               count(*) FILTER (WHERE lado='sob' AND medible AND excede)::int AS sob_x,
               count(*) FILTER (WHERE lado='fal' AND medible AND excede)::int AS fal_x
          FROM d`)).rows;
      if (!Number(p.sob) || !Number(p.fal)) {
        noMedido('el placebo de `excede_la_venta`',
          'no hay demanda medible de los dos lados en este destino');
      } else {
        const rSob = Number(p.sob_x) / Number(p.sob);
        const rFal = Number(p.fal_x) / Number(p.fal);
        const razon = rFal > 0 ? rSob / rFal : Infinity;
        console.log(`      ⓘ dispara en ${(100 * rSob).toFixed(1)}% de sobrantes `
          + `vs ${(100 * rFal).toFixed(1)}% de faltantes · razón ${razon.toFixed(2)}x`);
        t('⛔ la pista SIGUE sin discriminar (razón < 3x) — por eso NO es una explicación',
          razon < 3,
          `razón ${razon.toFixed(2)}x: ya separa. Re-evaluar si merece entrar en la partición`);
        t('y por eso no figura en la partición', VOCABULARIO.indexOf('excede_la_venta') === -1);
      }
      const [{ infinitos }] = (await db.raw(`
        SELECT count(*)::int AS infinitos FROM analytics.mv_erp_count_line_signals
         WHERE demanda_diaria = 0 AND dias_de_venta IS NOT NULL`)).rows;
      t('⛔ con demanda 0 los días de venta son NULL, nunca infinito ni cero',
        Number(infinitos) === 0, `${infinitos} filas dividieron entre cero`);
      const [{ mudos }] = (await db.raw(`
        SELECT count(*)::int AS mudos FROM analytics.mv_erp_count_line_signals
         WHERE dias_de_venta IS NULL AND demanda_motivo = 'medida'`)).rows;
      t('y todo NULL de demanda trae su motivo', Number(mudos) === 0);
    }

    // ── 5. ⛔ EL ESPEJO DE LOS UMBRALES ──────────────────────────────────────────────
    {
      const [u] = (await db.raw(`
        SELECT max(retencion) FILTER (WHERE patron='se_compensa')        AS compensa_max,
               min(retencion) FILTER (WHERE patron IN ('merma','sobra')) AS persiste_min
          FROM analytics.v_sku_count_variance_history`)).rows;
      if (u.compensa_max == null || u.persiste_min == null) {
        noMedido('los bordes reales del patrón', 'la vista no tiene filas de los dos lados');
      } else {
        // ⚠️ `<=` y no `<` a propósito: `retencion` se publica con `round(…, 4)` mientras el
        // CASE parte del cociente SIN redondear, así que un 0.19996 sale como 0.2000 y un `<`
        // estricto daría rojo por el redondeo, no por un cambio de umbral. Con `<=` sigue
        // atrapando la deriva que importa (mover los cortes a 0.3/0.7, por ejemplo).
        t(`⛔ el espejo de la leyenda coincide con el SQL (compensa ≤ ${u.compensa_max} · persiste ≥ ${u.persiste_min})`,
          Number(u.compensa_max) <= 0.2 && Number(u.persiste_min) >= 0.8,
          `compensa_max=${u.compensa_max} persiste_min=${u.persiste_min} contra 0.2/0.8 en el servicio`);
      }
    }

    // ── 6. LA REFUTACIÓN: la entrada duplicada sigue sin aplicar ────────────────────
    {
      const [{ cruce, marcadas }] = (await db.raw(`
        SELECT (SELECT count(*)::int FROM analytics.erp_goods_receipts h
                 WHERE h.dup_of_folio IS NOT NULL
                   AND h.sucursal IN (SELECT DISTINCT kepler_sucursal
                                        FROM analytics.mv_erp_count_line_signals)) AS cruce,
               (SELECT count(*)::int FROM analytics.erp_goods_receipts
                 WHERE dup_of_folio IS NOT NULL) AS marcadas`)).rows;
      t(`⛔ las ${marcadas} recepciones duplicadas NO tocan ningún almacén contado — por eso `
        + 'la señal no se construyó', Number(cruce) === 0,
        `${cruce} sí cruzan: la señal ya vale la pena y hay que construirla`);
    }

    // ── 7. El neto y el bruto, y los signos mezclados ───────────────────────────────
    {
      const [m] = (await db.raw(`
        SELECT count(*) FILTER (WHERE importe_bruto < abs(importe_neto))::int AS imposible,
               count(*) FILTER (WHERE signos_mezclados)::int AS mezclados,
               count(*) FILTER (WHERE NOT signos_mezclados
                                  AND round(importe_bruto,2) <> round(abs(importe_neto),2))::int
                 AS difieren_sin_motivo,
               round(sum(importe_bruto - abs(importe_neto)))::bigint AS se_cancela
          FROM analytics.mv_erp_count_line_signals`)).rows;
      t('el bruto nunca es menor que el neto en valor absoluto', Number(m.imposible) === 0);
      t('⛔ y sólo difieren donde los signos se mezclan — si no, el neto se calculó mal',
        Number(m.difieren_sin_motivo) === 0,
        `${m.difieren_sin_motivo} difieren sin tener los dos signos`);
      console.log(`      ⓘ ${m.mezclados} pares con los dos signos · $${m.se_cancela} se cancelan solos`);
    }

    // ── 8. Metadata: índice único, grant, umbral del latido ────────────────────────
    {
      const [md] = (await db.raw(`
        SELECT (SELECT count(*)::int FROM pg_index i
                 WHERE i.indrelid='analytics.mv_erp_count_line_signals'::regclass
                   AND i.indisunique) AS unicos,
               has_table_privilege('app_runtime','analytics.mv_erp_count_line_signals','SELECT')
                 AS grant_ok`)).rows;
      t('tiene índice ÚNICO (sin él no hay REFRESH CONCURRENTLY: la pantalla se vacía al refrescar)',
        Number(md.unicos) >= 1);
      t('app_runtime la puede leer', md.grant_ok === true);
      const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'apps', 'api', 'src',
        'modules', 'db-health', 'db-health.service.ts'), 'utf8');
      t("⛔ su umbral está en CRON_JOBS — sin eso el sensor da VERDE INCONDICIONAL",
        src.includes('analytics_refresh_count_signals'));
    }

    // ── 9. El latido, que lo escribe el nocturno ───────────────────────────────────
    {
      const { rows: lat } = await db.raw(
        "SELECT status, last_finish FROM analytics.cron_runs WHERE job_key='analytics_refresh_count_signals'");
      if (!lat.length) {
        noMedido('el latido del refresco',
          'lo escribe el lote nocturno cuando el worker lleve este código: hasta el redeploy no existe');
      } else {
        t(`el refresco latió (${lat[0].status})`, lat[0].status === 'ok');
      }
    }

    // ── 10. ⭐ [EXP.3] EL ARBITRAJE DE LOS DOCTYPES, RE-MEDIDO ───────────────────────
    // Los tres flujos nuevos no se eligieron leyendo el catálogo: se arbitraron contra el
    // cuadre del roll-forward, uno por uno, y uno se RECHAZÓ con el mismo instrumento.
    // ⛔ Este bloque vuelve a correr la medición en vez de mirar el resultado: si el ERP
    // cambia de comportamiento, un candado que sólo comprueba la salida no se entera.
    {
      const [a] = (await db.raw(`
        WITH flujo AS (
          SELECT r.warehouse_id, r.sku, r.desde, r.hasta,
                 coalesce(sum(l.c9::numeric) FILTER (WHERE m.c2='N' AND m.c3='D' AND m.c4::int=5), 0) AS f_sal,
                 coalesce(sum(l.c9::numeric) FILTER (WHERE m.c2='U' AND m.c3='A' AND m.c4::int IN (21,25)), 0) AS f_dev,
                 coalesce(sum(l.c9::numeric) FILTER (WHERE m.c2='U' AND m.c3='D' AND m.c4::int IN (8,12)), 0) AS f_fac,
                 coalesce(sum(l.c9::numeric) FILTER (WHERE m.c2='X' AND m.c3='D' AND m.c4::int=40), 0) AS f_dvc
            FROM analytics.mv_erp_count_rollforward r
            JOIN kepler_ods.kdm1 m
              ON m.sucursal = r.kepler_sucursal
             AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
             AND m.c9::date > r.desde AND m.c9::date <= r.hasta
             AND (   (m.c2='N' AND m.c3='D' AND m.c4::int = 5)
                  OR (m.c2='U' AND m.c3='A' AND m.c4::int IN (21,25))
                  OR (m.c2='U' AND m.c3='D' AND m.c4::int IN (8,12))
                  OR (m.c2='X' AND m.c3='D' AND m.c4::int = 40))
            JOIN kepler_ods.kdm2 l
              ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
             AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6 AND btrim(l.c8) = r.sku
           WHERE r.veredicto <> 'no_recontado'
           GROUP BY 1,2,3,4
        ), ev AS (
          SELECT r.no_explicado AS res, coalesce(f.f_sal,0) f_sal, coalesce(f.f_dev,0) f_dev,
                 coalesce(f.f_fac,0) f_fac, coalesce(f.f_dvc,0) f_dvc
            FROM analytics.mv_erp_count_rollforward r
            LEFT JOIN flujo f ON f.warehouse_id=r.warehouse_id AND f.sku=r.sku
                             AND f.desde=r.desde AND f.hasta=r.hasta
           WHERE r.veredicto <> 'no_recontado'
        )
        SELECT round(100.0*count(*) FILTER (WHERE abs(res) < 0.01)/count(*), 3) AS base,
               round(100.0*count(*) FILTER (WHERE abs(res + f_sal - f_dev + f_dvc) < 0.01)/count(*), 3) AS ganadores,
               round(100.0*count(*) FILTER (WHERE abs(res + f_sal - f_dev + f_dvc + f_fac) < 0.01)/count(*), 3) AS con_rechazado,
               count(*) FILTER (WHERE abs(res) >= 0.01 AND abs(res + f_sal - f_dev + f_dvc) < 0.01)::int AS gana
          FROM ev`)).rows;
      console.log(`      ⓘ cuadre del roll-forward: base ${a.base}% · con los 3 ganadores `
        + `${a.ganadores}% · sumando el rechazado ${a.con_rechazado}%`);
      t('⭐ los TRES doctypes arbitrados SIGUEN mejorando el cuadre del roll-forward',
        Number(a.ganadores) > Number(a.base),
        `base=${a.base}% ganadores=${a.ganadores}% — dejaron de aportar`);
      t('⛔ y U-D-8/12 SIGUE empeorándolo — esa mercancía ya está en U-D-10, es re-facturación',
        Number(a.con_rechazado) < Number(a.base),
        `con_rechazado=${a.con_rechazado}% vs base=${a.base}%: dejó de ser espejo, re-evaluar`);
      t(`⛔ y cierran el hueco de ${a.gana} SKUs que el motor llama merma o sobrante`,
        Number(a.gana) > 0);
    }

    // ── 11. [EXP.3] DÓNDE CAE EL VALOR, declarado ───────────────────────────────────
    // ⚠️ Lo que estos flujos arreglan es el ROLL-FORWARD, no la pila de ajustes: son
    // documentos REALES de Kepler, así que su propio libro ya los movió y nunca emitió un
    // ajuste por ellos. Medido: de los SKUs cuyo hueco cierran, sólo el 6.7% tiene ajuste.
    // Mientras el roll-forward no los sume, sigue llamando MERMA a dinero que tiene papel.
    {
      const [f] = (await db.raw(`
        SELECT count(*) FILTER (WHERE flujo_dominante IS NOT NULL)::int AS con_flujo,
               count(*) FILTER (WHERE flujo_explica)::int AS explican_el_ajuste
          FROM analytics.mv_erp_count_line_signals`)).rows;
      t(`${f.con_flujo} renglones muestran su flujo en el expediente`, Number(f.con_flujo) > 0);
      console.log(`      ⓘ y sólo ${f.explican_el_ajuste} explican el AJUSTE: el valor de estos `
        + 'doctypes está en el roll-forward, que todavía no los suma');
    }
    console.log(`\n=== ${ok} ✓ / ${bad} ✗ / ${nm} no medidos ===\n`);
  } catch (e) {
    console.error('ERROR:', e.message); bad++;
  } finally { await db.destroy(); }
  process.exit(bad > 0 ? 1 : 0);
})();
