/**
 * [TES.1] analytics.v_supplier_payables - la deuda con proveedor, DERIVADA del ODS.
 *
 * -- POR QUE EXISTE ---------------------------------------------------------------------
 * El flujo de efectivo de Presupuestos (budget-cashflow.service.ts) arma el lado del PAGO
 * con las tres tablas de obligacion. Medido en prod el 2026-10-08, las tres estan vacias de
 * obligaciones vigentes: expense_obligations tiene 312 filas pero las 312 son status
 * 'propuesta' y vencen en 2027 (el motor las excluye a proposito), financial_commitments
 * tiene 0 filas y supplier_payment_obligations tiene 0 filas. Resultado: la proyeccion
 * publica 0 pesos de pago en su ventana de 8 semanas y se lee como liquidez excelente.
 *
 * Lo que de verdad vence en esa ventana, derivado de Kepler y medido el mismo dia:
 *
 *     mercancia   30,582,304.78     servicios   178,038.25     financiero   160,000.00
 *     ya vencido 114,437,348.39 (deuda real, sin traspasos internos)
 *
 * Contraste independiente: la mercancia pendiente da 136,820,939.44 por este camino contra
 * los 138.8M que la Fase ECA midio por el suyo el 2026-10-07. Dos derivaciones, 1.4% de
 * deriva.
 *
 * -- POR QUE VISTA Y NO SINCRONIZADOR ---------------------------------------------------
 * Regla principal del proyecto: cero importers, el dato sale del ODS. La evidencia esta en
 * el lado espejo de este mismo carril: analytics.customer_receivables ES una vista y por eso
 * esta viva; su antecesora era tabla poblada por importer y quedo vacia en prod porque el
 * importer nunca corrio. La cartera se deriva de kdue; la deuda se deriva de kdxe.
 *
 * -- LO QUE ESTA VISTA NO HACE ----------------------------------------------------------
 * NO clasifica. El clasificador canonico ya existe y tiene dueno:
 * clasificarAcreedor(codigo, grupo) en libs/finance/src/lib/creditor-statements/
 * creditor-statements.engine.ts, validado contra el reporte de Kepler para Mondelez. Esta
 * vista expone las dimensiones crudas (proveedor, grupo) para que ese clasificador decida.
 * Re-implementar la regla en SQL seria el primitivo inventado dos veces que ADR-056 prohibe.
 *
 * -- SALVEDADES DECLARADAS --------------------------------------------------------------
 * 1. anterior_al_corte: hasta el 2026-09-30 la sucursal 00 concentraba. ECA midio que de la
 *    deuda vencida de mercancia, 59.9M son facturas de sucursal previas al corte. Se expone
 *    la bandera para que el consumidor las separe; la vista NO las filtra ni afirma el monto.
 * 2. vencimiento llega NULL cuando Kepler trae el centinela (< 1900-01-01), igual que
 *    fechaOnull() del motor. Sin esto un documento centinela se leeria vencido hace siglos.
 * 3. btrim(c1) = sucursal: la replica de la 03 arrastra renglones de la 02 (medido por ECA).
 *
 * -- ADVERTENCIA DE COSTO ---------------------------------------------------------------
 * Medido el 2026-10-08: pg_stat_user_tables dice que kdxe tiene 63 filas y tiene 50,885
 * (808x), kdxf dice 76 y tiene 30,556. 237 de las 240 tablas de kepler_ods tienen
 * last_analyze Y last_autoanalyze en NULL. Con esas estimaciones el planner elige nested
 * loop: la misma pregunta costo 224 ms una vez y mas de 150 s la siguiente. NINGUN consumidor
 * de esta vista puede declarar un gate de tiempo hasta que exista un ANALYZE sobre el ODS.
 */

const M = '00000000-0000-0000-0000-00000000d01c';
const CORTE_CONCENTRADOR = '2026-10-01';

/**
 * ⭐⭐ Los tres CTE van `AS MATERIALIZED`, y NO es cosmético — medido el 2026-10-08.
 *
 * `btrim(c1) = sucursal` (el ancla anti-réplica de ECA) es una comparación COLUMNA CONTRA
 * COLUMNA a través de una función: Postgres no tiene con qué estimarla y cae a una
 * selectividad por defecto. Apilada con `c3 = 'A'` el plan estima **1 fila** sobre `kdxe`
 * cuando son miles, elige `Nested Loop` y **re-agrega `kdxf` entero por cada fila de afuera**.
 * Una consulta de esta forma estuvo **más de 150 s** sin terminar y hubo que cancelarla.
 *
 * ⛔ **No lo arregla `ANALYZE`.** Se corrieron las cuatro tablas (las estadísticas estaban mal
 * por 800x, un defecto real y aparte) y la consulta **siguió pasando de 60 s**: el problema no
 * es cuántas filas tiene la tabla, es que el predicado no se puede estimar. Con los CTE
 * materializados la misma pregunta baja a **405 ms**.
 *
 * Es el mismo recurso que ya usa `cobranza-prevista.ts` del lado del cobro, por la misma razón:
 * fijar la forma en vez de confiar en que el planner adivine bien.
 */
const DEF = `
WITH doc AS MATERIALIZED (
  SELECT sucursal,
         btrim(c2)                                               AS proveedor,
         c4                                                      AS doc_tipo,
         c5                                                      AS doc_sub,
         btrim(c6)                                               AS folio,
         CASE WHEN c7  >= '1900-01-01' THEN c7::date  END        AS fecha,
         CASE WHEN c10 >= '1900-01-01' THEN c10::date END        AS vencimiento,
         c11                                                     AS importe
    FROM kepler_ods.kdxe
   WHERE btrim(c1) = sucursal
     AND c3 = 'A'
), apl AS MATERIALIZED (
  SELECT sucursal, c7 AS t, c8 AS s, btrim(c9) AS f, sum(c10) AS aplicado
    FROM kepler_ods.kdxf
   WHERE btrim(c1) = sucursal
   GROUP BY 1,2,3,4
), prov AS MATERIALIZED (
  SELECT DISTINCT ON (btrim(c2)) btrim(c2) AS ck, c3 AS nombre, c13 AS grupo
    FROM kepler_ods.kdxd
   ORDER BY btrim(c2), (sucursal <> '00'), sucursal
)
SELECT '${M}'::uuid                                              AS tenant_id,
       d.sucursal,
       d.proveedor,
       p.nombre                                                  AS proveedor_nombre,
       p.grupo,
       d.doc_tipo,
       d.doc_sub,
       d.folio,
       d.fecha,
       d.vencimiento,
       d.importe,
       coalesce(a.aplicado, 0)                                   AS aplicado,
       d.importe - coalesce(a.aplicado, 0)                        AS pendiente,
       CASE WHEN d.vencimiento IS NULL THEN NULL
            ELSE d.vencimiento < current_date END                AS vencido,
       CASE WHEN d.vencimiento IS NULL THEN NULL
            ELSE (current_date - d.vencimiento) END              AS dias_vencido,
       CASE WHEN d.fecha IS NULL THEN NULL
            ELSE d.fecha < '${CORTE_CONCENTRADOR}'::date END     AS anterior_al_corte
  FROM doc d
  LEFT JOIN apl  a ON a.sucursal = d.sucursal AND a.t = d.doc_tipo AND a.s = d.doc_sub AND a.f = d.folio
  LEFT JOIN prov p ON p.ck = d.proveedor
 WHERE d.importe - coalesce(a.aplicado, 0) > 0.005
`;

exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_supplier_payables AS ${DEF}`);
  await knex.raw(`COMMENT ON VIEW analytics.v_supplier_payables IS
    'Deuda con proveedor con saldo ABIERTO, derivada de kepler_ods.kdxe/kdxf/kdxd. NO clasifica: usar clasificarAcreedor() de creditor-statements.engine.ts. Ver cabecera de la migracion 20261008174741.'`);
  await knex.raw('GRANT SELECT ON analytics.v_supplier_payables TO app_runtime');
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_supplier_payables');
};
