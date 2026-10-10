/**
 * `[CG.76]` **La lectura EN VIVO de la bandeja de caja: 1,021 ms -> 101 ms.**
 *
 * Pedido de Edgar: *"no necesito un cron, el movimiento sale del ODS y ya... solo un puente
 * entre el ODS y la vista"*. Tiene razon, y lo que lo impedia era un numero: leer la vista en
 * vivo costaba **1,021 ms**, por eso habia un matview en el medio y un cron refrescandolo.
 *
 * -- LOS DOS CUELLOS, medidos con EXPLAIN contra prod (2026-10-09) ------------------------
 *
 * 1. **El CTE flj escaneaba kepler_ods.kdm1 ENTERA** -678,918 filas para devolver 75- porque
 *    el filtro de fecha vive FUERA del CTE y nunca llega al escaneo. Con la ventana adentro y
 *    el indice ix_kdm1_captura, el CTE pasa de **51,606 filas / 503 ms** a **701 / 24.6 ms**.
 *
 * 2. **El LEFT JOIN contra v_kepler_payment_complement hacia 224,025 evaluaciones de filtro.**
 *    Con la vista en linea su doc_tipo se calcula con regexp_replace, asi que el ON no es
 *    indexable y el planificador elige nested loop. Materializandola una vez (2,987 filas,
 *    6.6 ms) el join se resuelve de golpe.
 *
 *    1,021 ms -> (indice) 633 -> (ventana adentro) 493 -> (complemento materializado) **101.6**
 *
 * -- POR QUE UNA FUNCION Y NO ARREGLAR LA VISTA ------------------------------------------
 *
 * La vista la leen tres pantallas, y flj se referencia **dos veces** (es un UNION ALL), que es
 * justo por lo que Postgres la materializa. Un NOT MATERIALIZED la aceleraria para consultas
 * con ventana y la volveria **el doble de lenta** para el refresco del matview, que lee todo
 * sin filtro. Esto es **aditivo**: la vista no se toca y nadie se entera.
 *
 * RETURNS SETOF analytics.kepler_bank_movements y no una lista de columnas a mano: el tipo
 * sale de la vista, asi que si manana alguien le agrega una columna esta funcion **deja de
 * compilar** en vez de devolver en silencio una forma distinta de la que la pantalla espera.
 *
 * Verificado ANTES de aplicar, fila por fila contra la vista para la misma ventana:
 * **706 = 706 / sobran 0 / faltan 0** (excluyendo computed_at, que es now() en las dos).
 *
 * STABLE: solo lee. Sin eso el planificador la trata como volatil y no la puede optimizar
 * dentro de una consulta mayor.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.caja_movimientos_desde(desde date)
      RETURNS SETOF analytics.kepler_bank_movements
      LANGUAGE sql
      STABLE
    AS $fn$
 WITH kb AS (
         SELECT DISTINCT ON ((btrim(kdb1.c1))) btrim(kdb1.c1) AS clave,
            btrim(kdb1.c2) AS nombre,
            btrim(kdb1.c5) AS cta,
                CASE
                    WHEN btrim(kdb1.c5) !~~ '102%'::text THEN 'puente'::text
                    WHEN upper(btrim(COALESCE(kdb1.c3, ''::text))) = 'EFECTIVO'::text THEN 'caja'::text
                    ELSE 'banco'::text
                END AS tipo
           FROM kepler_ods.kdb1
          WHERE btrim(COALESCE(kdb1.c1, ''::text)) <> ''::text
          ORDER BY (btrim(kdb1.c1)), kdb1.sucursal
        ), xw AS (
         SELECT kb_1.clave,
            COALESCE(( SELECT ba.account_label
                   FROM finance.bank_accounts ba
                  WHERE ba.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND ba.account_label = kb_1.clave
                 LIMIT 1),
                CASE
                    WHEN kb_1.clave = '0011'::text THEN 'CG'::text
                    ELSE NULL::text
                END, ( SELECT ba.account_label
                   FROM finance.bank_accounts ba
                  WHERE ba.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND length(ba.account_label) >= 3 AND kb_1.clave ~~ ('%'::text || ba.account_label) AND kb_1.clave <> ba.account_label
                  ORDER BY (length(ba.account_label)) DESC
                 LIMIT 1)) AS account_label
           FROM kb kb_1
        ), flj AS (
         SELECT btrim(d.c1) AS suc,
            (((btrim(d.c2) || '-'::text) || btrim(d.c3)) || '-'::text) || btrim(d.c4::text) AS dt,
            btrim(d.c6) AS folio,
            d.c9::date AS fval,
            d.c68::date AS fcap,
            round(COALESCE(NULLIF(regexp_replace(d.c16::text, '[^0-9.-]'::text, ''::text, 'g'::text), ''::text)::numeric, 0::numeric), 2) AS importe,
            NULLIF(btrim(d.c24), ''::text) AS concepto,
            NULLIF(btrim(d.c31), ''::text) AS metodo,
            NULLIF(btrim(d.c32), ''::text) AS beneficiario,
            btrim(d.c45) AS c45,
            NULLIF(btrim(d.c47), ''::text) AS c47,
            NULLIF(btrim(d.c10), ''::text) AS entidad,
                CASE (((btrim(d.c2) || '-'::text) || btrim(d.c3)) || '-'::text) || btrim(d.c4::text)
                    WHEN 'U-A-5'::text THEN 'entrada'::text
                    WHEN 'U-A-25'::text THEN 'entrada'::text
                    WHEN 'X-A-45'::text THEN 'entrada'::text
                    WHEN 'X-D-26'::text THEN 'salida'::text
                    WHEN 'X-D-25'::text THEN 'salida'::text
                    WHEN 'X-D-60'::text THEN 'salida'::text
                    WHEN 'X-D-10'::text THEN 'salida'::text
                    WHEN 'N-A-26'::text THEN 'traspaso'::text
                    ELSE
                    CASE
                        WHEN btrim(d.c31) = 'Cob'::text THEN 'entrada'::text
                        WHEN btrim(d.c31) = ANY (ARRAY['Tra'::text, 'Che'::text, 'Ant'::text]) THEN 'salida'::text
                        ELSE 'otro'::text
                    END
                END AS flujo
           FROM kepler_ods.kdm1 d
          WHERE d.c68::date >= desde AND btrim(d.c1) = d.sucursal AND btrim(COALESCE(d.c43, ''::text)) <> 'C'::text AND (btrim(d.c45) IN ( SELECT kb_1.clave
                   FROM kb kb_1))
        ), legs AS (
         SELECT flj.suc,
            flj.dt,
            flj.folio,
            flj.fval,
            flj.fcap,
            flj.importe,
            flj.concepto,
            flj.metodo,
            flj.beneficiario,
            flj.entidad,
            flj.c45 AS clave,
                CASE
                    WHEN flj.flujo = 'traspaso'::text THEN 'traspaso'::text
                    ELSE flj.flujo
                END AS flujo,
                CASE
                    WHEN flj.flujo = 'traspaso'::text THEN '-1'::integer
                    WHEN flj.flujo = 'entrada'::text THEN 1
                    WHEN flj.flujo = 'salida'::text THEN '-1'::integer
                    ELSE NULL::integer
                END AS signo,
            flj.flujo = 'traspaso'::text AS es_traspaso,
                CASE
                    WHEN flj.flujo = 'traspaso'::text THEN flj.c47
                    ELSE NULL::text
                END AS contra,
                CASE
                    WHEN flj.flujo = 'traspaso'::text THEN 'origen'::text
                    ELSE 'mov'::text
                END AS pierna
           FROM flj
        UNION ALL
         SELECT flj.suc,
            flj.dt,
            flj.folio,
            flj.fval,
            flj.fcap,
            flj.importe,
            flj.concepto,
            flj.metodo,
            flj.beneficiario,
            flj.entidad,
            flj.c47 AS clave,
            'traspaso'::text AS flujo,
            1 AS signo,
            true AS es_traspaso,
            flj.c45 AS contra,
            'destino'::text AS pierna
           FROM flj
          WHERE flj.flujo = 'traspaso'::text AND flj.c47 IS NOT NULL AND (flj.c47 IN ( SELECT kb_1.clave
                   FROM kb kb_1))
        )
, pcm AS MATERIALIZED (
         SELECT * FROM analytics.v_kepler_payment_complement
        )
 SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
    legs.suc AS sucursal,
    legs.dt AS doc_tipo,
    legs.folio,
    legs.clave AS clave_banco,
    kb.cta AS cuenta_contable,
    kb.nombre AS banco_nombre,
    kb.tipo AS tipo_cuenta,
    legs.flujo,
    legs.importe,
    legs.signo::smallint AS signo,
    legs.fval AS fecha_valor,
    legs.fcap AS fecha_captura,
    legs.concepto,
    legs.metodo,
    legs.beneficiario,
    legs.es_traspaso,
    legs.contra AS contra_clave,
    legs.pierna,
    xw.account_label,
    now() AS computed_at,
    legs.entidad AS entidad_code,
    pc.fecha_pago AS fecha_pago_sat,
    COALESCE(pc.fecha_pago, legs.fval) AS fecha_efectiva
   FROM legs
     LEFT JOIN kb ON kb.clave = legs.clave
     LEFT JOIN xw ON xw.clave = legs.clave
     LEFT JOIN pcm pc ON pc.sucursal = legs.suc AND pc.doc_tipo = legs.dt AND pc.folio = legs.folio
    $fn$
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.caja_movimientos_desde(date)`);
};
