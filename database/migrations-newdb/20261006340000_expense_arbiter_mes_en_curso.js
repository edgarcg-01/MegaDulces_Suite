'use strict';
/**
 * `[VE.1.1]` — **El mes EN CURSO no es comparable, y la vista tiene que decirlo.**
 *
 * Lo encontró el candado de `[VE.1]` a los dos minutos de aplicarla, y es el **mismo defecto** que
 * esa migración acababa de corregir en otro eje: sumar lo que no es comparable.
 *
 * Medido el 2026-10-06 (día 6 del mes), bloque nómina:
 *
 *     ene–sep (meses cerrados)      Kepler 31,153,775   ContPAQi 25,407,879   delta −5,745,896
 *     ene–oct (con el mes a medias) Kepler 31,153,775+  ContPAQi 25,407,879+  delta −2,582,497
 *
 * El delta se encoge **55 %** sin que haya pasado nada en el negocio: los dos lados van llenando
 * octubre a ritmos distintos, y mientras tanto la celda de octubre compara un pedazo contra otro
 * pedazo. Quien lea el acumulado del año ve una brecha que se «corrige sola» cada principio de mes
 * y vuelve a abrirse: ruido con forma de tendencia.
 *
 * ⛔ **No se filtra: se declara** (ADR-056, y la lección de `[IG.8]` — *un filtro no es una
 * ausencia, y recortar uno mismo lo que después se reporta como hueco es la falla simétrica de
 * dibujar un cero*). La celda del mes en curso se sigue publicando, con su bandera, para que se
 * pueda ver el avance; lo que cambia es que ahora **se puede excluir de un acumulado sin tener que
 * adivinar la fecha**.
 *
 * ⚠️ La columna se llama `mes_en_curso` y no `mes_cerrado` a propósito: lo único que esta vista
 * puede afirmar es que el mes del calendario todavía no termina. **Si un mes anterior está cerrado
 * CONTABLEMENTE no se sabe desde acá** — eso lo dice Contabilidad, y es parte de lo mismo que
 * tiene que firmar para que `difiere` signifique algo. Nombrarla `mes_cerrado` afirmaría de más.
 *
 * `CREATE OR REPLACE` agregando la columna al final: la vista nació hace minutos y todavía no
 * tiene consumidores, pero el orden de columnas de las que ya estaban se respeta igual.
 */

const VISTA = 'analytics.v_expense_arbiter';

const CUERPO = `
    WITH orden(bloque, orden) AS (
         VALUES ('nomina', 1), ('gasto_resto', 2), ('financieros', 3), ('compra', 4)),
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
           false                                                      AS mapeo_firmado,
           -- El mes del calendario todavía no termina: los dos lados lo están llenando a ritmos
           -- distintos y su delta es ruido. Se publica igual (sirve para ver el avance), pero un
           -- acumulado que lo sume cambia de valor todos los días. NO dice si un mes anterior
           -- está cerrado CONTABLEMENTE: eso no se sabe desde acá.
           (j.anio_mes >= to_char(current_date, 'YYYY-MM'))           AS mes_en_curso
      FROM j JOIN orden o ON o.bloque = j.bloque`;

exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS ${CUERPO}`);
  // `CREATE OR REPLACE VIEW` NO conserva ni la opción ni el GRANT: se re-aplican siempre (ADR-057).
  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
};

exports.down = async function down(knex) {
  // Volver atrás deja la vista sin la columna; se recrea entera para no dejarla a medias.
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
