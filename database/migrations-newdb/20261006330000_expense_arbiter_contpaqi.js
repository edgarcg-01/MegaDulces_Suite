'use strict';
/**
 * `[VE.1]` — **El egreso gana su árbitro INDEPENDIENTE: los libros del contador.** (ADR-059 R5 y
 * R7; ADR-056.)
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 *
 * `docs/VERDAD_ABSOLUTA.md` tiene 18 dimensiones arbitradas y **ninguna es de egreso**. Medido el
 * 2026-10-06 sobre el documento: `egreso`, `gasto`, `familia 6`, `expense_entries` y
 * `cuenta por pagar` aparecen **0 veces**. No es un olvido de redacción — es que el egreso nunca
 * tuvo testigo.
 *
 * Lo que hoy se compara en `/presupuesto` (`BudgetResultService.arbitroGasto`) es
 * `analytics.expense_entries` contra `analytics.ledger_monthly`, y el propio archivo ya se
 * autocorrigió: **las dos leen la misma tabla primaria**, `kepler_ods.kdc2YYMM`. Atrapan un error
 * de filtro o de agregación —por eso ene–mar salta y de abril en adelante cuadra al centavo— y
 * **no pueden atrapar un error de la fuente**. *Otra implementación no es otro testigo.*
 *
 * El testigo independiente existe, está poblado y está fresco: `analytics.contpaqi_ledger_monthly`
 * (Fase CP, ADR-040), los libros que ve el contador y el SAT. Carga medida el 2026-10-06 a las
 * 18:25, hasta `2026-10`. **Nunca estuvo cableado a nada.** Esta vista lo cablea.
 *
 * ── Lo que la medición encontró, y que cambia cómo hay que leerlo ───────────────────────────
 *
 * ⛔ **Los dos planes de cuentas NO son el mismo, y la columna `familia` no cruza.** ContPAQi no
 * tiene familia 6: sus familias vivas en 2026 son 1, 2, 4, 5 y `_`, y el gasto está adentro de la
 * 5. El único eje común es el **agrupador SAT** de contabilidad electrónica, que es un catálogo
 * estándar. Cruzar por `familia` devuelve NULL en silencio, no cero.
 *
 * ⚠️ **Y el agrupador trae SUBNIVEL.** El dato real es `601.01`, `602.56`, `701.01`; un filtro
 * `agrupador_sat IN ('601','602')` —que es como lo describe el comentario de `BudgetResultService`—
 * devuelve **NULL**. Es la trampa que se cobró primero al medir esto, y por eso el candado la
 * ejerce como prueba negativa.
 *
 * ⭐⭐ **La brecha no es un factor constante: va de −7.2 % a −44.1 % según el bloque.** Medido
 * ene–sep 2026 **sobre los meses en que existen las dos piernas**, con el delta y el porcentaje
 * contra el árbitro (mismo criterio que `pct(delta, arbitro)` del servicio):
 *
 *     bloque           meses  Kepler↑  CP↑         Kepler        ContPAQi         delta      pct
 *     compra               9        9    0    453,680,343     314,919,449  −138,760,895  −44.1 %
 *     gasto_resto          9        8    1     24,802,458      18,503,254    −6,299,204  −34.0 %
 *     nómina               9        8    1     31,153,775      25,407,879    −5,745,896  −22.6 %
 *     financieros          6        3    3      4,461,317       5,400,621      −301,484   −7.2 %
 *
 * ⚠️ **Y esta tabla corrige una conclusión que la primera versión de este archivo daba por buena.**
 * Comparando TOTALES anuales, financieros parecía **invertido** (ContPAQi $939,304 **más alto**,
 * +21.1 %), y de ahí salía el argumento de que la brecha no podía ser recorte de alcance. Al
 * partirlo por mes se ve que ese signo venía de **ene–feb–mar, donde Kepler no tiene la pierna**
 * ($1,240,788 de intereses que los libros registran y la operación no): un total anual **suma
 * meses comparables con meses que no lo son**, y el resultado se lee como un hallazgo. Sobre los
 * 6 meses comparables el signo **alterna 3 y 3** y el neto vuelve al mismo sentido que los demás.
 *
 * Lo que queda en pie, medido: el sentido es **dominante pero no uniforme** (9/9 en compra, 8/9 en
 * nómina y en el resto, 3/3 en financieros) y la magnitud cambia 6× entre bloques. Eso descarta un
 * factor de escala único, y **no alcanza para nombrar la causa**. Lo que falta es la
 * **correspondencia de conceptos** —qué cuenta de Kepler va a qué agrupador del SAT— y eso **no se
 * deduce desde acá: lo firma Contabilidad**.
 *
 * Por eso esta vista publica la brecha **partida en bloques y declarada**, nunca explicada, su
 * veredicto dice `difiere` —que es la verdad— en vez de aflojar una banda hasta que salga verde, y
 * un mes con una sola pierna sale como `solo_libros`/`solo_operacion` con el delta en **NULL**:
 * *lo que no es comparable no se resta* (ADR-056).
 *
 * ── Los cortes, verificados contra el catálogo, no inventados ───────────────────────────────
 *
 * `nomina` = `601.01`–`601.33`. Verificado leyendo los nombres del propio catálogo en prod: ahí
 * caen sueldos, premios de asistencia y puntualidad, vacaciones, prima vacacional y dominical,
 * primas de antigüedad, aguinaldo, IMSS, Infonavit, SAR e impuesto estatal sobre nóminas; y
 * `601.34` ya es *Honorarios a personas físicas*, que no es nómina. La frontera es del catálogo.
 *
 * ⚠️ `cuenta_mayor = '601'` del lado de Kepler es su **SUELDOS Y SALARIOS**, que coincide de
 * número con el agrupador SAT `601` por casualidad del plan de cuentas, no por correspondencia.
 * No se apoya nada en esa coincidencia: son dos catálogos distintos y así se tratan.
 *
 * ── Lo que esta vista NO hace ───────────────────────────────────────────────────────────────
 *
 * No corrige a nadie (ADR-040: ContPAQi es el SoR contable, Kepler el operativo; acá sólo se leen
 * los dos). No cruza por sucursal: la contabilidad fiscal casi no segmenta (~2 %) y del lado de
 * Kepler el 98.8 % del gasto vive en la `00`. No inventa una banda de tolerancia para el testigo
 * independiente: sin el mapeo firmado, una banda sería una opinión con forma de umbral.
 */

const VISTA = 'analytics.v_expense_arbiter';

/** Los cuatro bloques, con su corte de cada lado. El orden es el de lectura, no el del monto. */
const BLOQUES = `
         VALUES ('nomina',          1),
                ('gasto_resto',     2),
                ('financieros',     3),
                ('compra',          4)`;

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW ${VISTA} AS
    WITH orden(bloque, orden) AS (${BLOQUES}),
    kepler AS (
      SELECT e.tenant_id,
             to_char(e.fecha, 'YYYY-MM')                      AS anio_mes,
             CASE
               WHEN e.familia = '6' AND e.cuenta_mayor = '601' THEN 'nomina'
               WHEN e.familia = '6'                            THEN 'gasto_resto'
               WHEN e.familia = '7'                            THEN 'financieros'
               WHEN e.cuenta LIKE '511%'                       THEN 'compra'
             END                                              AS bloque,
             e.importe
        FROM analytics.expense_entries e
    ),
    k AS (
      SELECT tenant_id, anio_mes, bloque, sum(importe)::numeric AS monto
        FROM kepler WHERE bloque IS NOT NULL
       GROUP BY 1, 2, 3
    ),
    contpaqi AS (
      SELECT l.tenant_id,
             l.anio_mes,
             CASE
               -- El subnivel es parte del dato: '601' a secas no existe y devuelve NULL.
               WHEN l.agrupador_sat ~ '^601\\.(0[1-9]|1[0-9]|2[0-9]|3[0-3])$' THEN 'nomina'
               WHEN l.agrupador_sat LIKE '601%'
                 OR l.agrupador_sat LIKE '602%'                               THEN 'gasto_resto'
               WHEN l.agrupador_sat LIKE '701%'                               THEN 'financieros'
               WHEN l.agrupador_sat LIKE '502%'
                 OR l.agrupador_sat LIKE '503%'                               THEN 'compra'
             END                                                              AS bloque,
             (l.cargos - l.abonos)                                            AS monto
        FROM analytics.contpaqi_ledger_monthly l
    ),
    c AS (
      SELECT tenant_id, anio_mes, bloque, sum(monto)::numeric AS monto
        FROM contpaqi WHERE bloque IS NOT NULL
       GROUP BY 1, 2, 3
    ),
    j AS (
      SELECT coalesce(k.tenant_id, c.tenant_id) AS tenant_id,
             coalesce(k.anio_mes,  c.anio_mes)  AS anio_mes,
             coalesce(k.bloque,    c.bloque)    AS bloque,
             k.monto                            AS kepler,
             c.monto                            AS contpaqi
        FROM k FULL JOIN c
          ON c.tenant_id = k.tenant_id AND c.anio_mes = k.anio_mes AND c.bloque = k.bloque
    )
    SELECT j.tenant_id,
           j.anio_mes,
           j.bloque,
           o.orden                                                    AS bloque_orden,
           round(j.kepler,   2)                                       AS kepler,
           round(j.contpaqi, 2)                                       AS contpaqi,
           CASE WHEN j.kepler IS NULL OR j.contpaqi IS NULL THEN NULL
                ELSE round(j.contpaqi - j.kepler, 2) END              AS delta,
           CASE WHEN j.kepler IS NULL OR j.contpaqi IS NULL
                  OR j.contpaqi = 0 THEN NULL
                ELSE round(100.0 * (j.contpaqi - j.kepler) / j.contpaqi, 2) END AS delta_pct,
           CASE
             WHEN j.kepler IS NULL AND j.contpaqi IS NULL THEN 'no_medido'
             WHEN j.kepler IS NULL   THEN 'solo_libros'
             WHEN j.contpaqi IS NULL THEN 'solo_operacion'
             WHEN j.contpaqi <> 0
              AND abs(100.0 * (j.contpaqi - j.kepler) / j.contpaqi) <= 0.5 THEN 'cuadra'
             ELSE 'difiere'
           END                                                        AS veredicto,
           -- La correspondencia concepto -> agrupador SAT NO está firmada por Contabilidad.
           -- Mientras siga en false, un 'difiere' NO significa que alguien se equivocó: significa
           -- que los dos catálogos no se han pareado. Lo vigila test-newdb-expense-arbiter.
           false                                                      AS mapeo_firmado
      FROM j JOIN orden o ON o.bloque = j.bloque`);

  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);

  await knex.raw(`
    COMMENT ON VIEW ${VISTA} IS
      'El egreso contra su testigo INDEPENDIENTE (ContPAQi, los libros del contador) por mes y '
      'bloque. Kepler y ContPAQi usan planes de cuentas distintos: el unico eje comun es el '
      'agrupador SAT, CON subnivel. La correspondencia concepto->agrupador no esta firmada por '
      'Contabilidad, asi que un veredicto difiere declara una brecha, no imputa un error. '
      'Medido 2026-10-06: el signo se INVIERTE en financieros, lo que refuta que la brecha sea '
      'recorte de alcance fiscal. Candado: test-newdb-expense-arbiter.js'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
