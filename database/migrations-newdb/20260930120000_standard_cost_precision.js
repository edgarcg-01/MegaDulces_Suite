'use strict';
/**
 * `[CE.9]` — **La pantalla tiene que decir la verdad y decir qué hacer.**
 *
 * Disparada por Edgar mirando la pantalla entregada: *"la información es ambigua y no se explica
 * del todo… no nos dice mucho"*, y después, sobre mi propia redacción: *"¿cuando dices subir el
 * costo a qué te refieres? ¿a qué te refieres con ficha?"*. Las dos preguntas destaparon defectos
 * distintos. Todo lo de abajo está medido contra PROD.
 *
 * ── ⛔ 1. El peldaño se elegía por POSICIÓN, y eso rompía el 2º renglón de la pantalla ──
 *
 * `[CE.8]` puso *"razón < 2 ⇒ peldaño base"*, apoyada en que **no existe ningún `f2 < 2`**
 * (mínimo 2.00 sobre 6,518 pares). La premisa es cierta; la regla es incompleta: **con `f2 = 2`
 * exacto, una razón de 1.9 cae en `base` aunque el peldaño dos esté dramáticamente más cerca.**
 *
 * `30540 ALMENDRA CONFITADA 10 KG`, plaza 06 — el renglón #2 por dinero de la pantalla:
 *
 * ```text
 * costo de la ficha, peldano base ("500") ...  $44.60
 * costo de la ficha, peldano dos  ("KG", f2=2)  $89.20
 * costo del ERP (kdik.c16) .................... $86.00
 *
 * distancia al base ... |86.00/44.60 - 1| = 0.928
 * distancia a u2 ...... |86.00/89.20 - 1| = 0.036   <-- 26x mas cerca
 * ```
 *
 * ⭐ Y lo confirma un testigo **independiente del catálogo**: el último costo pagado de esa ficha
 * es **$89.195**, que es el peldaño KG al centavo. Publicábamos "+92.83 % por debajo" y $7,824.60
 * de impacto sobre lo que es un cambio de unidad.
 *
 * ⭐ **El arreglo es el ORDEN, no un umbral nuevo:** los peldaños se prueban ANTES del atajo
 * posicional. La banda de ±25 % de los peldaños es la misma de `[CE.8]` — un factor es un entero
 * exacto, así que un peldaño que "casi" casa no casa. Alcance medido: 35 filas cambian de
 * peldaño, 6 con evidencia clara.
 *
 * ⛔ **Y se descartó, probándola, la solución que parecía obvia:** elegir "el candidato más
 * cercano" con un desempate de 3× volvía **ambiguo** al `17182 PEPPER` (razón 1.99 con `f2 = 12`),
 * que está bien clasificado como base. La asimetría es real y hay que respetarla: **un peldaño
 * tiene que casar fino; la deriva de costo no tiene tope.**
 *
 * ⚠️ **Refutado de paso:** sospeché que TODAS las filas cercanas a +100 % eran peldaños mal
 * clasificados. Falso — `17182 PEPPER` tiene `f2 = 12`, `83595` tiene 24, `95093` tiene 8,
 * `08009` y `20119` tienen `f2 = 1`. Sólo los `f2 = 2` eran ambiguos.
 *
 * ── ⛔ 2. La fecha salía cruda, y la mitad de las veces era un centinela ──────────────
 *
 * El detalle imprimía `2026-09-02T06:00:00.000Z`: `ultimo_costo_al` es un `date`, `pg` lo entrega
 * como objeto `Date` y el JSON lo serializa en ISO. Se arregla **en el origen con `to_char`**, no
 * en el cliente (lección `[LC.16]`). Y **19,101 de 34,368 fechas (55.6 %) son `1800-01-01`**, el
 * centinela de nulo de Kepler: pasan a **NULL**, para que el consumidor pueda esconder la línea
 * en vez de imprimir una fecha inventada.
 *
 * ⚠️ Por eso esta migración hace `DROP` + `CREATE` y no `CREATE OR REPLACE`: la columna cambia de
 * `date` a `text`, y un replace no puede cambiar el tipo de una columna. Verificado antes: **nada
 * depende de esta vista** (`pg_depend` sobre `pg_rewrite`, 0 filas).
 *
 * ── ⛔ 3. La plaza `00` es OFICINAS y salía "al día" sobre cero venta ─────────────────
 *
 * 9,632 filas, **ninguna con venta**. Ya está excluida en existencia y en el sell-out. Acá NO se
 * esconde en la vista —eso sería que la vista decida por el consumidor— sino que se **declara**
 * con `es_plaza_operativa`, y el servicio la filtra por default.
 *
 * ── ⭐⭐ 4. Lo que la pregunta de Edgar destapó: "subir el costo" ES UN CAMBIO DE PRECIO ──
 *
 * La pantalla decía *"Subir el costo de $138.44 a $189.07"* como si fuera higiene de datos.
 * **No lo es.** Medido sobre **6,501 cambios reales de costo** en 90 días, mirando el precio del
 * mismo renglón de venta antes y después:
 *
 * ```text
 * el precio SIGUIO al costo, proporcional (Kepler conserva el margen) ... 4,812 = 74.02 %
 * el precio se movio distinto ............................................ 1,606 = 24.70 %
 * el precio NO se movio ..................................................    83 =  1.28 %
 * ```
 *
 * O sea que "corregir las 6,300 fichas" equivale a **+$421,734 de facturación en 30 días**, alza
 * mediana **+8 %**, con **328 fichas por encima del 20 %**. Eso no es una captura de Compras: es
 * una decisión de precio.
 *
 * ⭐⭐ **Y del otro lado de la bifurcación aparece lo que de verdad importa.** Si el precio NO se
 * mueve, el margen real es el que ya se está sacando — y calculado contra el costo verdadero:
 *
 * ```text
 * fichas 'estandar_bajo' evaluables ....... 2,887
 * que venden BAJO COSTO hoy ............... 272 = 9.4 %
 * su venta en 30 dias ..................... $346,452
 * margen mediano de esas .................. -5.67 %      el peor: -39.2 %
 * ```
 *
 * El catálogo lo esconde porque calcula el margen contra un costo que ya no se paga. Por eso la
 * vista gana `margen_real_pct`, `precio_si_conserva_margen` y `vende_bajo_costo`: **el servidor
 * emite las dos salidas de la decisión**, y el cliente no las recalcula (no puede distinguir "no
 * cuadra" de "no se pudo medir" sin repetir la lógica — ADR-056).
 *
 * ⚠️ El margen de Kepler es **markup sobre el costo**, no margen sobre venta: `costo × (1+m)` da
 * el precio NETO, y el impuesto va encima. Verificado al centavo (`138.44 × 1.23 × 1.08 = 183.90`).
 * Las dos columnas nuevas usan esa misma convención para que sean comparables con `margen_ficha_pct`.
 */

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('analytics.v_kepler_unit_ladder') IS NOT NULL
        AND to_regclass('analytics.mv_kepler_standard_cost_activity') IS NOT NULL
        AND to_regclass('kepler_ods.kdik') IS NOT NULL) AS ok`)).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  faltan dependencias - [CE.9] omitido');
    return;
  }

  // Un DROP que se lleve por delante a otro consumidor seria silencioso hasta que alguien abra
  // su pantalla: se comprueba, no se supone.
  const { rows: dep } = await knex.raw(`
    SELECT DISTINCT c.relname
      FROM pg_depend d
      JOIN pg_rewrite r ON r.oid = d.objid
      JOIN pg_class c ON c.oid = r.ev_class
     WHERE d.refobjid = 'analytics.v_kepler_standard_cost'::regclass
       AND c.relname <> 'v_kepler_standard_cost'`);
  if (dep.length) {
    throw new Error(`[CE.9] hay objetos que dependen de la vista: ${dep.map((d) => d.relname).join(', ')}`);
  }

  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_standard_cost`);

  await knex.raw(`
    CREATE VIEW analytics.v_kepler_standard_cost
      WITH (security_invoker = true) AS
    WITH ficha AS (
      SELECT e.sucursal, e.sku,
             e.u1_label, e.u2_label, e.u3_label, e.f2_cap, e.f3_cap,
             e.costo1, e.costo2, e.costo3, e.margen1, e.pv1
        FROM analytics.v_kepler_unit_ladder e
    ), erp AS (
      -- sucursal = btrim(c1) es el anti-replica, identico al de analytics.v_kepler_unit_cost.
      SELECT k.sucursal, btrim(k.c2) AS sku,
             NULLIF(max(k.c16)::numeric, 0) AS costo_reposicion,
             max(k.c18) AS ultimo_costo,
             -- 1800-01-01 es el centinela de nulo de Kepler: 55.6% de las fechas. NULL, no 1800.
             NULLIF(max(k.c17)::date, '1800-01-01'::date) AS ultimo_costo_al
        FROM kepler_ods.kdik k
       WHERE k.sucursal = btrim(k.c1)
         AND k.c16 = k.c16 AND k.c16 > '-Infinity'::float8 AND k.c16 < 'Infinity'::float8
       GROUP BY k.sucursal, btrim(k.c2)
    ), nom AS (
      SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS sku, btrim(c2) AS nombre
        FROM kepler_ods.kdii ORDER BY btrim(c1), sucursal
    ), base AS (
      SELECT f.sucursal, f.sku, n.nombre,
             f.u1_label AS unidad_base, f.u2_label AS unidad_dos, f.u3_label AS unidad_tres,
             f.f2_cap AS factor_dos, f.f3_cap AS factor_tres,
             NULLIF(f.costo1, 0) AS costo_estandar,
             NULLIF(f.costo2, 0) AS costo_estandar_u2,
             NULLIF(f.costo3, 0) AS costo_estandar_u3,
             f.margen1 AS margen_ficha_pct,
             NULLIF(f.pv1, 0) AS precio_ficha,
             e.costo_reposicion, NULLIF(e.ultimo_costo, 0) AS ultimo_costo,
             CASE WHEN e.ultimo_costo_al >= DATE '1900-01-01'
                  THEN to_char(e.ultimo_costo_al, 'YYYY-MM-DD') END AS ultimo_costo_al,
             a.impuesto_pct, a.impuesto_tasas_distintas, a.renglones AS impuesto_renglones,
             a.unidades_base AS unidades_base_30d,
             a.venta_bruta   AS venta_bruta_30d,
             a.venta_neta    AS venta_neta_30d,
             a.ventana_hasta AS actividad_al
        FROM ficha f
        LEFT JOIN nom n ON n.sku = f.sku
        LEFT JOIN erp e ON e.sucursal = f.sucursal AND e.sku = f.sku
        LEFT JOIN analytics.mv_kepler_standard_cost_activity a
               ON a.sucursal = f.sucursal AND a.sku = f.sku
    ), peld AS (
      -- ⭐ EL ARREGLO ES EL ORDEN, no un umbral nuevo. [CE.8] probaba "razon < 2 => base" ANTES
      -- que los peldanos, asi que con f2 = 2 el atajo posicional ganaba aunque el peldaño dos
      -- estuviera 26x mas cerca (el caso 30540). Ahora los peldanos se prueban PRIMERO y el
      -- atajo queda de respaldo. La banda de +/-25% de los peldanos es la misma de [CE.8]: un
      -- factor es un entero exacto, asi que un peldaño que "casi" casa no casa.
      --
      -- ⛔ Se descarto elegir "el candidato mas cercano" con un umbral de desempate: probado
      -- contra los casos reales, un desempate de 3x volvia ambiguo al 17182 (razon 1.99 con
      -- f2 = 12), que esta BIEN clasificado como base. La asimetria es real y hay que
      -- respetarla: un peldaño tiene que casar fino, la deriva de costo no tiene tope.
      SELECT b.*,
             CASE
               WHEN b.costo_estandar IS NULL OR b.costo_reposicion IS NULL
                 OR b.costo_estandar <= 0 OR b.costo_reposicion <= 0 THEN NULL
               WHEN b.costo_reposicion / b.costo_estandar < 0.5 THEN 'testigo_inverosimil'
               WHEN b.factor_dos > 1
                AND abs(b.costo_reposicion / b.costo_estandar / b.factor_dos - 1) <= 0.25
                 THEN 'unidad_dos'
               WHEN b.factor_tres > 1
                AND abs(b.costo_reposicion / b.costo_estandar / b.factor_tres - 1) <= 0.25
                 THEN 'unidad_tres'
               -- medido: no existe ningun f2 < 2 (minimo 2.00 sobre 6,518 pares), asi que una
               -- razon < 2 que no caso en ningun peldaño es el base con su deriva.
               WHEN b.costo_reposicion / b.costo_estandar < 2 THEN 'base'
               ELSE 'no_resuelto'
             END AS peldano_reposicion
        FROM base b
    ), norm AS (
      SELECT p.*,
             CASE p.peldano_reposicion
               WHEN 'base'        THEN p.costo_reposicion
               WHEN 'unidad_dos'  THEN p.costo_reposicion / NULLIF(p.factor_dos, 0)
               WHEN 'unidad_tres' THEN p.costo_reposicion / NULLIF(p.factor_tres, 0)
               ELSE NULL
             END AS costo_reposicion_base
        FROM peld p
    )
    SELECT n.sucursal, n.sku, n.nombre,
           n.unidad_base, n.unidad_dos, n.unidad_tres, n.factor_dos, n.factor_tres,
           n.costo_estandar, n.costo_estandar_u2, n.costo_estandar_u3,
           n.margen_ficha_pct, n.precio_ficha,
           n.impuesto_pct, n.impuesto_tasas_distintas, n.impuesto_renglones,
           CASE WHEN n.costo_estandar IS NOT NULL AND n.margen_ficha_pct IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(n.costo_estandar * (1 + n.margen_ficha_pct / 100)
                                            * (1 + n.impuesto_pct / 100), 2)
           END AS precio_reconstruido,
           CASE
             WHEN n.precio_ficha IS NULL OR n.costo_estandar IS NULL
               OR n.margen_ficha_pct IS NULL THEN NULL
             WHEN n.impuesto_pct IS NULL THEN NULL
             ELSE abs(n.costo_estandar * (1 + n.margen_ficha_pct / 100)
                                       * (1 + n.impuesto_pct / 100) - n.precio_ficha) <= 0.02
           END AS precio_cuadra,
           CASE
             WHEN n.precio_ficha IS NULL THEN 'sin_precio_en_ficha'
             WHEN n.costo_estandar IS NULL THEN 'sin_costo_estandar'
             WHEN n.margen_ficha_pct IS NULL THEN 'sin_margen_en_ficha'
             WHEN n.impuesto_pct IS NULL THEN 'impuesto_no_medido_sin_venta'
             ELSE NULL
           END AS precio_cuadra_motivo,
           n.costo_reposicion, n.peldano_reposicion, n.costo_reposicion_base,
           n.ultimo_costo, n.ultimo_costo_al,
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar > 0
                THEN round(((n.costo_reposicion_base / n.costo_estandar) - 1) * 100, 3)
           END AS desviacion_pct,
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar IS NOT NULL
                THEN round(n.costo_reposicion_base - n.costo_estandar, 4)
           END AS desviacion_por_unidad,
           CASE
             WHEN n.costo_estandar IS NULL                     THEN 'sin_estandar'
             WHEN n.costo_reposicion IS NULL
              AND n.unidades_base_30d IS NULL                  THEN 'sin_operacion'
             WHEN n.costo_reposicion IS NULL                   THEN 'sin_testigo'
             -- tres maneras distintas de no poder comparar, con tres arreglos distintos
             WHEN n.peldano_reposicion = 'testigo_inverosimil' THEN 'testigo_inverosimil'
             WHEN n.peldano_reposicion = 'no_resuelto'         THEN 'no_comparable'
             WHEN abs(n.costo_reposicion_base - n.costo_estandar) <= 0.01 THEN 'al_dia'
             WHEN n.costo_reposicion_base > n.costo_estandar   THEN 'estandar_bajo'
             ELSE 'estandar_alto'
           END AS veredicto,
           n.unidades_base_30d, n.venta_bruta_30d, n.venta_neta_30d, n.actividad_al,
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.costo_estandar IS NOT NULL
                 AND n.unidades_base_30d IS NOT NULL
                THEN round(n.unidades_base_30d * (n.costo_reposicion_base - n.costo_estandar), 2)
           END AS impacto_cogs_30d,
           -- ── [CE.9] las columnas nuevas van AL FINAL ────────────────────────────────────
           -- La plaza 00 es OFICINAS: 9,632 fichas, cero venta. No se esconde: se DECLARA, y el
           -- consumidor decide (el servicio la filtra por default).
           (n.sucursal <> '00') AS es_plaza_operativa,
           -- Salida A de la decision: si se captura el costo nuevo, Kepler conserva el margen y
           -- RECALCULA EL PRECIO. Medido: el precio siguio al costo en el 74.02% de 6,501 cambios
           -- reales, y solo en el 1.28% se quedo quieto.
           CASE WHEN n.costo_reposicion_base IS NOT NULL AND n.margen_ficha_pct IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(n.costo_reposicion_base * (1 + n.margen_ficha_pct / 100)
                                                   * (1 + n.impuesto_pct / 100), 2)
           END AS precio_si_conserva_margen,
           -- Salida B: si el precio NO se mueve, este es el margen que de verdad se esta sacando.
           -- Misma convencion que margen_ficha_pct: markup sobre el costo, precio NETO.
           CASE WHEN n.costo_reposicion_base > 0 AND n.precio_ficha IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN round(((n.precio_ficha / (1 + n.impuesto_pct / 100))
                            / n.costo_reposicion_base - 1) * 100, 2)
           END AS margen_real_pct,
           -- 272 fichas (9.4% de las evaluables) pierden dinero en cada venta HOY. Es la lista
           -- que importa mañana, no las 6,300.
           CASE WHEN n.costo_reposicion_base > 0 AND n.precio_ficha IS NOT NULL
                 AND n.impuesto_pct IS NOT NULL
                THEN (n.precio_ficha / (1 + n.impuesto_pct / 100)) < n.costo_reposicion_base
           END AS vende_bajo_costo
      FROM norm n`);

  await knex.raw(`ALTER VIEW analytics.v_kepler_standard_cost SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_kepler_standard_cost TO app_runtime`);

  await knex.raw(`
    COMMENT ON VIEW analytics.v_kepler_standard_cost IS
    $$[CE.9] Costo estandar de Kepler (kdii.c77, el que fija el precio) contra el costo del ERP
    por sucursal (kdik.c16, anti-replica sucursal=btrim(c1)). El peldano del testigo se prueba ANTES
    del atajo posicional (ese era el bug de [CE.8] con f2 = 2): si casa un factor dentro de +/-25%
    es ese peldano, si no y la razon < 2 es el base con su deriva, si no es no_comparable. razon < 0.5 es testigo_inverosimil (el costo del ERP esta
    vacio, no bajo). ultimo_costo_al es texto YYYY-MM-DD y el centinela 1800-01-01 llega NULL.
    es_plaza_operativa marca la 00 (OFICINAS, cero venta) sin esconderla.
    ⭐ precio_si_conserva_margen y margen_real_pct son las DOS salidas de la decision: capturar el
    costo nuevo MUEVE EL PRECIO (medido: 74.02% de 6,501 cambios reales), y no capturarlo deja el
    margen real, que en 272 fichas es NEGATIVO. La pantalla muestra las dos, no una instruccion.$$`);
};

exports.down = async function down(knex) {
  // eslint-disable-next-line no-console
  console.log('  [CE.9] down: re-aplicar 20260929190000 para volver a la banda posicional');
};
