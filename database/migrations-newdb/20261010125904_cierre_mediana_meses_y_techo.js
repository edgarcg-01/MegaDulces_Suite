'use strict';
/**
 * [CPA.0.1] — La vista publica SOBRE CUÁNTOS MESES descansa la mediana.
 *
 * ── El hueco que cierra ─────────────────────────────────────────────────────────────────────
 * gastos y nomina no tienen testigo independiente: se comparan contra la mediana de sus 6 meses
 * previos, contando sólo los que tienen renglones. Medido contra prod el 2026-10-10,
 * 2025-02 gastos y 2025-02 nomina la calculan con UN SOLO MES, y 2025-03 con dos.
 *
 * ⛔ Y la vista no lo decía: un veredicto apoyado en n=1 se publicaba IDÉNTICO a uno apoyado en
 * n=6. Es la lección de [CP.8.20], que ya costó un falso positivo: pureza perfecta sobre n=1 no
 * es certeza. Ahora el número viaja, y el engine se niega a juzgar por debajo de su mínimo.
 *
 * ⚠️ Sale con coalesce(…, 0) y no NULL a propósito: para las tres familias CON testigo la
 * mediana no aplica, y 0 se lee como "no se usó", que es lo que pasa. El engine sólo mira esta
 * columna cuando cobertura_base es historia.
 *
 * ⛔⛔ La columna va AL FINAL de la lista, no al lado de mediana_6m. CREATE OR REPLACE VIEW sólo
 * permite AÑADIR columnas al final; intercalarla corre las posiciones y Postgres la rechaza con
 * "cannot change name of view column cobertura to mediana_meses". No es estilo: es el límite
 * del comando, y lo encontró el primer intento de aplicarla.
 *
 * Es CREATE OR REPLACE VIEW: no reescribe datos, no toma lock pesado. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_contpaqi_cierre_mensual AS
    WITH meses AS (
      SELECT DISTINCT tenant_id, anio_mes
        FROM analytics.gl_polizas
       WHERE source = 'contpaqi' AND anio_mes >= '2025-01'
    ),
    familias(familia, etiqueta, senal_cuentas, testigo_fuente, cobertura_base) AS (
      VALUES
        ('compras', 'Compras del mes',     'abonos 2120*',        'fiscal.cfdis recibidas', 'testigo'),
        ('ventas',  'Ventas',              'abonos 401*/403*',    'fiscal.cfdis emitidas',  'testigo'),
        ('bancos',  'Movimiento bancario', 'cargos+abonos 1020*', 'finance.bank_movements', 'testigo'),
        ('gastos',  'Gastos de operacion', 'cargos 5200*',        NULL,                     'historia'),
        ('nomina',  'Nomina',              'cargos 2150*',        NULL,                     'historia')
    ),
    -- Sólo los renglones que miden alguna familia. El filtro va ANTES del anti-join.
    fam_de AS (
      SELECT l.tenant_id, l.anio_mes, l.ejercicio, l.periodo, l.tipo_pol, l.folio, l.sucursal,
             l.importe,
             CASE
               WHEN left(l.cuenta,4) = '2120' AND l.cargo_abono = 'A' THEN 'compras'
               WHEN left(l.cuenta,3) IN ('401','403') AND l.cargo_abono = 'A' THEN 'ventas'
               WHEN left(l.cuenta,4) = '1020' THEN 'bancos'
               WHEN left(l.cuenta,4) = '5200' AND l.cargo_abono = 'C' THEN 'gastos'
               WHEN left(l.cuenta,4) = '2150' AND l.cargo_abono = 'C' THEN 'nomina'
             END AS familia
        FROM analytics.gl_poliza_lines l
       WHERE l.source = 'contpaqi' AND l.anio_mes >= '2025-01'
         AND (left(l.cuenta,4) IN ('2120','1020','5200','2150') OR left(l.cuenta,3) IN ('401','403'))
    ),
    -- Las pólizas que ContPAQi tiene fechadas MÁS ADELANTE que hoy: el provisional.
    futuras AS (
      SELECT tenant_id, ejercicio, periodo, tipo_pol, folio, sucursal
        FROM analytics.gl_polizas
       WHERE source = 'contpaqi' AND anio_mes >= '2025-01' AND fecha > CURRENT_DATE
    ),
    senal AS (
      SELECT f.tenant_id, f.anio_mes, f.familia,
             sum(f.importe) FILTER (WHERE x.folio IS NULL)     AS importe,
             count(*)       FILTER (WHERE x.folio IS NULL)     AS renglones,
             sum(f.importe) FILTER (WHERE x.folio IS NOT NULL) AS provisional
        FROM fam_de f
        LEFT JOIN futuras x
               ON x.tenant_id = f.tenant_id AND x.ejercicio = f.ejercicio
              AND x.periodo   = f.periodo   AND x.tipo_pol  = f.tipo_pol
              AND x.folio     = f.folio     AND x.sucursal  = f.sucursal
       WHERE f.familia IS NOT NULL
       GROUP BY 1, 2, 3
    ),
    testigo_cfdi AS (
      SELECT tenant_id, to_char(fecha, 'YYYY-MM') AS anio_mes,
             sum(total) FILTER (WHERE rol = 'recibidas') AS recibidas,
             sum(total) FILTER (WHERE rol = 'emitidas')  AS emitidas
        FROM fiscal.cfdis
       WHERE fecha >= TIMESTAMPTZ '2025-01-01 00:00:00+00'
       GROUP BY 1, 2
    ),
    testigo_banco AS (
      SELECT tenant_id, to_char(movement_date, 'YYYY-MM') AS anio_mes,
             sum(coalesce(amount_in,0) + coalesce(amount_out,0)) AS movimiento
        FROM finance.bank_movements
       WHERE deleted_at IS NULL AND movement_date >= DATE '2025-01-01'
       GROUP BY 1, 2
    ),
    -- MATERIALIZED a propósito: la mediana la vuelve a leer, y sin esto Postgres puede empujar
    -- el filtro del consumidor hacia adentro y dejar a la mediana sin historia que promediar.
    base AS MATERIALIZED (
      SELECT m.tenant_id, m.anio_mes, f.familia, f.etiqueta, f.senal_cuentas,
             f.testigo_fuente, f.cobertura_base,
             coalesce(s.importe, 0)::numeric(18,2) AS senal,
             coalesce(s.renglones, 0)::int         AS senal_renglones,
             s.provisional::numeric(18,2)          AS provisional,
             CASE f.familia
               WHEN 'compras' THEN tc.recibidas
               WHEN 'ventas'  THEN tc.emitidas
               WHEN 'bancos'  THEN tb.movimiento
             END::numeric(18,2)                    AS testigo
        FROM meses m
        CROSS JOIN familias f
        LEFT JOIN senal s
               ON s.tenant_id = m.tenant_id AND s.anio_mes = m.anio_mes AND s.familia = f.familia
        LEFT JOIN testigo_cfdi tc
               ON tc.tenant_id = m.tenant_id AND tc.anio_mes = m.anio_mes
        LEFT JOIN testigo_banco tb
               ON tb.tenant_id = m.tenant_id AND tb.anio_mes = m.anio_mes
    ),
    -- Para las familias sin testigo: la mediana de los 6 meses previos de su propia señal.
    -- ⚠️ Sólo cuentan los meses CON renglones: un mes vacío arrastraría la mediana a cero y
    -- volvería "normal" justo la ausencia que se busca.
    mediana AS (
      SELECT b.tenant_id, b.anio_mes, b.familia,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY h.senal)::numeric(18,2) AS mediana_6m,
             count(*)::int AS mediana_meses
        FROM base b
        JOIN base h
          ON h.tenant_id = b.tenant_id AND h.familia = b.familia
         AND h.senal_renglones > 0
         AND h.anio_mes <  b.anio_mes
         AND h.anio_mes >= to_char((to_date(b.anio_mes,'YYYY-MM') - INTERVAL '6 months'), 'YYYY-MM')
       WHERE b.cobertura_base = 'historia'
       GROUP BY 1, 2, 3
    ),
    frescura AS (
      SELECT tenant_id, max(computed_at) AS data_as_of
        FROM analytics.gl_polizas WHERE source = 'contpaqi' GROUP BY 1
    )
    SELECT b.tenant_id,
           b.anio_mes,
           b.familia,
           b.etiqueta,
           b.senal_cuentas,
           b.senal,
           b.senal_renglones,
           b.provisional,
           b.testigo,
           b.testigo_fuente,
           b.cobertura_base,
           md.mediana_6m,
           -- La razón contra lo que corresponda. NULL cuando no hay con qué dividir: el servicio
           -- lo clasifica como sin_medir, que NO es lo mismo que bad.
           CASE
             WHEN b.cobertura_base = 'testigo'  AND b.testigo     > 0 THEN round(b.senal / b.testigo, 4)
             WHEN b.cobertura_base = 'historia' AND md.mediana_6m > 0 THEN round(b.senal / md.mediana_6m, 4)
           END AS cobertura,
           CASE WHEN b.anio_mes >= to_char(CURRENT_DATE, 'YYYY-MM') THEN 'en_curso' ELSE 'cerrado' END
             AS periodo_estado,
           fr.data_as_of,
           coalesce(md.mediana_meses, 0) AS mediana_meses
      FROM base b
      LEFT JOIN mediana md
             ON md.tenant_id = b.tenant_id AND md.anio_mes = b.anio_mes AND md.familia = b.familia
      LEFT JOIN frescura fr ON fr.tenant_id = b.tenant_id`);

  // ⚠️ ADR-057: security_invoker NO se hereda y se PIERDE en cada CREATE OR REPLACE VIEW.
  await knex.raw(`ALTER VIEW analytics.v_contpaqi_cierre_mensual SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_contpaqi_cierre_mensual TO app_runtime`);
};

/** Quitar la columna sería volver a esconder sobre qué descansa el veredicto. No se deshace. */
exports.down = async function down() {
  /* intencionalmente vacío */
};
