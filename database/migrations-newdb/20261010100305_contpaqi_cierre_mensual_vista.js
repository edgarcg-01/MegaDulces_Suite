'use strict';
/**
 * `[CPA.0]` — `analytics.v_contpaqi_cierre_mensual`: **qué mes está asentado en ContPAQi y cuál
 * no**, con el testigo independiente al lado.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-10-10: **septiembre-2026 no tiene póliza de compras**. Se pagaron
 * $30,334,529 a proveedores y se registraron **$0 de compras**; el pasivo `2120` cayó de
 * $109.9 M a $51.7 M sin que nadie comprara menos. Nadie se enteró — se encontró con una
 * consulta a mano, el día 10, y por casualidad. **Esta vista es lo que lo habría gritado el 1.**
 *
 * ── Qué publica, y por qué cada columna ─────────────────────────────────────────────────────
 *  · `senal`        — el importe que la contabilidad SÍ tiene para esa familia ese mes.
 *  · `testigo`      — el mismo hecho medido por una fuente **independiente de ContPAQi**.
 *  · `cobertura`    — `senal / testigo`. **El veredicto NO se calcula acá**: lo emite el servicio
 *                     contra un umbral registrado en `analytics.kpi_thresholds` (ADR-076). Sin
 *                     umbral el estado es `sin_meta`, **nunca `ok`** — que es exactamente el
 *                     `cfg ? classify : 'ok'` que la Fase VP encontró dando verde incondicional.
 *  · `provisional`  — ⭐ lo que ContPAQi tiene **fechado en el futuro**. Medido: octubre trae
 *                     **231 de 377 pólizas con fecha posterior a hoy** (el provisional de
 *                     `[CP.8]` §9.3). Si eso entrara a la señal, octubre se vería *asentado*
 *                     publicando ventas por **$52,813,192** cuando lo realmente asentado son
 *                     **$16,007,700**. Por eso la señal **excluye** esas pólizas y el provisional
 *                     se publica aparte: ni se suma, ni se esconde.
 *  · `senal_renglones` — ⛔ `0 renglones` y `$0` NO son lo mismo, y en un `LEFT JOIN` los dos
 *                     llegan como NULL y se leen como sanos (ADR-056). Por eso el conteo viaja.
 *  · `periodo_estado` — el mes en curso **no se juzga**: está incompleto por definición, y un
 *                     tablero que grita todos los días 1 enseña a ignorarlo.
 *  · `data_as_of`   — frescura del carril `contpaqi` (@1 min). Un semáforo verde sobre un carril
 *                     caído es la mentira que esta vista existe para no cometer.
 *
 * ── Las bandas, MEDIDAS, no elegidas ────────────────────────────────────────────────────────
 * Cobertura real abr–ago 2026 (5 meses cerrados), de donde salen los umbrales que siembra la
 * migración hermana `..._cierre_umbrales`:
 *
 *   | familia  | señal                  | testigo                        | banda medida      |
 *   |----------|------------------------|--------------------------------|-------------------|
 *   | compras  | abonos `2120`          | CFDI **recibidas** del mes     | 66.7 % – 72.3 %   |
 *   | ventas   | abonos `401`+`403`     | CFDI **emitidas** del mes      | 90.2 % – 91.8 %   |
 *   | bancos   | movimiento `1020`      | `finance.bank_movements`       | 87.4 % – 110.6 %  |
 *   | gastos   | cargos `5200`          | — (su propia historia)         | $4.2 M – $6.9 M   |
 *   | nomina   | cargos `2150`          | — (su propia historia)         | $1.5 M – $2.1 M   |
 *
 * ⭐ La banda de **ventas tiene 1.6 pp de amplitud en 6 meses**: es el testigo más firme de los
 * tres. La de compras, 5.6 pp. Ninguna se inventó.
 *
 * ⛔ **Las razones no valen 1.0 y eso es correcto**: el CFDI trae impuestos y cubre universos que
 * no pasan por esas cuentas. Lo que se vigila es que la razón **se salga de su banda**, no que
 * valga uno.
 *
 * ── Tres decisiones que parecen detalle y no lo son ─────────────────────────────────────────
 * ⭐ **`gastos` y `nomina` se comparan contra su propia historia** (mediana de los 6 meses
 * previos) porque no tienen testigo independiente. Eso es más débil y **se declara**
 * (`cobertura_base = 'historia'`), no se disfraza de lo mismo que las otras tres.
 *
 * ⛔ **El cruce mes × familia es un `CROSS JOIN`, no un `GROUP BY`.** Con `GROUP BY`, el mes que
 * no tiene **ni un renglón** de compras simplemente no produce fila — y una familia ausente
 * desaparece del tablero en vez de salir en rojo. *Que es, literalmente, cómo se perdió
 * septiembre.* Verificado: con esta vista, `(2026-09, compras)` sale con `senal = 0` y
 * `senal_renglones = 0`, no deja de existir.
 *
 * ⭐ **El provisional se resta por ANTI-JOIN contra las pólizas futuras, no por un join general.**
 * Medido: las pólizas con fecha futura son **231 en toda la historia** y encontrarlas cuesta
 * 24 ms; unir las 249,677 líneas a sus 19,418 pólizas sólo para leer una fecha costaba más que
 * todo lo demás junto.
 *
 * ── Medido antes de escribirla (sólo lectura, pg-prod 2026-10-10) ───────────────────────────
 *  · Las cinco señales calculadas desde el detalle (`gl_poliza_lines`) **cuadran al peso** con
 *    `analytics.contpaqi_ledger_monthly` en jul, ago, sep y oct. Se lee del detalle y no de la
 *    balanza porque la balanza ya viene agregada y **no deja separar el provisional**.
 *  · Esta forma contra la forma directa (join completo + subconsulta correlacionada):
 *    **110 filas contra 110, cero diferencias**, y de **1,150 ms a 870 ms**.
 *
 * ⚠️ **870 ms sigue arriba del gate de 500 ms.** De esos, **~450 ms son el `Seq Scan` de
 * `fiscal.cfdis`** (460 MB de heap: la tabla carga `xml`, `pdf` y `raw`, así que cualquier
 * recorrido completo es caro). Lo cierra el índice cubriente de la migración
 * `..._cfdis_indice_mes`, que **va fuera de horario** porque construirlo es una escritura
 * pesada. Hasta que exista, la pantalla **declara** el tiempo, no lo esconde.
 *
 * Es VISTA, no tabla: cero importers, se deriva (regla principal del proyecto). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_contpaqi_cierre_mensual AS
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
       WHERE fecha >= DATE '2025-01-01'
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
             percentile_cont(0.5) WITHIN GROUP (ORDER BY h.senal)::numeric(18,2) AS mediana_6m
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
           fr.data_as_of
      FROM base b
      LEFT JOIN mediana md
             ON md.tenant_id = b.tenant_id AND md.anio_mes = b.anio_mes AND md.familia = b.familia
      LEFT JOIN frescura fr ON fr.tenant_id = b.tenant_id`);

  // ⚠️ `security_invoker` NO se hereda y se pierde en cada `CREATE OR REPLACE VIEW` (ADR-057).
  // Sin esto la vista leería con los permisos del DUEÑO y saltaría el RLS de `fiscal.cfdis` y
  // `finance.bank_movements` — o sea, un tenant vería los libros de otro.
  await knex.raw(`ALTER VIEW analytics.v_contpaqi_cierre_mensual SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_contpaqi_cierre_mensual TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW analytics.v_contpaqi_cierre_mensual IS
    'CPA.0 — que mes esta asentado en ContPAQi y cual no, con testigo independiente. La senal EXCLUYE las polizas fechadas en el futuro (el provisional viaja aparte, en su propia columna). El veredicto NO se calcula aqui: lo emite el servicio contra analytics.kpi_thresholds (ADR-076); sin umbral el estado es sin_meta, nunca ok. El cruce mes x familia es CROSS JOIN a proposito: con GROUP BY la familia ausente no produce fila y desaparece del tablero, que es como se perdio la poliza de compras de septiembre-2026.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_contpaqi_cierre_mensual`);
};
