/**
 * [CB.48] El complemento de pago SAT: la fecha REAL del cobro y la cuenta bancaria a la que entró.
 *
 * Kepler guarda el complemento de pago (CFDI "Pagos") en `kepler_ods.kdfe33pagm1`, y NADIE lo
 * estaba leyendo. Adentro están las dos cosas que la Fase CB declaró imposibles:
 *
 *   1. `c7` = fecha y hora REALES del pago, retrofechada. La póliza (`kdm1.c9`) trae el día en
 *      que se TECLEÓ, y en la sucursal 01 eso es el mismo valor que `c68` (fecha de captura) —
 *      el síntoma que CB.44 documentó. Medido: 532 de 544 cobros de la suc 01 (97.8%) tienen
 *      fecha de pago distinta de la de su póliza, 6.8 días de promedio y hasta 369;
 *      la suc 06 es el 100% de 101. Son **$6,795,140 + $1,706,724** que hoy ningún motor puede
 *      conciliar por fecha. ⚠️ Esto REFUTA lo escrito en CB.44 y en el CLAUDE.md ("mientras no
 *      se retrofeche, ningún motor puede conciliar por fecha: $6,858,008.40"): sí se retrofecha,
 *      en el complemento. El monto coincide al peso con los cobros de la suc 01 que TIENEN
 *      complemento ($6,858,008) — o sea, el dinero declarado irreconciliable es exactamente éste.
 *
 *   2. `c19`/`c20` = RFC del banco + CLABE de NUESTRA cuenta receptora. El 102 de Kepler no se
 *      desglosa por banco (CB.24 lo declara), pero el complemento sí: 9 CLABEs distintas, 8 de
 *      ellas identificadas contra `finance.bank_accounts` sin ambigüedad. 202 de 206
 *      transferencias (98%), $2,112,689.
 *
 * DECODE VERIFICADO contra una captura de pantalla del propio Kepler (documento UA0701-0000214
 * de la sucursal PH), campo por campo — seis coincidencias independientes: fecha+hora 31/07/2026
 * 16:52, forma de pago "Efectivo" (01), moneda PESOS (MXN), paridad 1.000000, monto 6,784.00 y
 * número de operación 0000214. No es decode por corazonada (ERP_KEPLER §5 regla 0).
 *
 * ⚠️ ALCANCE, para que nadie lo sobrevenda: el complemento SOLO existe para `U-A-7` (Cobro CFDI),
 * 3,370 filas. El grueso de la cobranza es `U-A-5` del CEDIS — 29,127 cobros / $452M, CERO
 * complementos, porque el SAT sólo lo exige en pago diferido (PPD). O sea cubre el ~2% del dinero
 * de cobranza… y el 100% del problema: donde la póliza no trae la fecha real (suc 01 y 06) hay
 * complemento, y donde no hay complemento (suc 00) la póliza ya viene retrofechada.
 *
 * VISTA, no tabla (regla ⭐ del proyecto): se deriva del ODS, lo alimenta el CDC, cero importers.
 */
exports.up = async function up(knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  // ── El complemento, normalizado ──────────────────────────────────────────────────────────
  //
  // `sucursal <> c1` = réplica del documento de OTRA sucursal (patrón conocido: la DB 03 trae
  // copias de la 02). Se filtra igual que `analytics.kepler_bank_movements`, que usa
  // `WHERE btrim(d.c1) = d.sucursal`; sin esto el mismo pago se contaría 2-3 veces.
  //
  // `doc_tipo` sale de la serie y NO se adivina: hoy la única serie del complemento es `UA0701`
  // (verificado: 3,370 de 3,370 filas). Si algún día aparece otra, `doc_tipo` queda NULL — la
  // fila sigue visible y la vista de cobertura la enumera. Excluirla en silencio la volvería
  // invisible, que es el modo de falla que ADR-056 prohíbe.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_kepler_payment_complement AS
    WITH base AS (
      SELECT
        btrim(p.c1)                                        AS sucursal,
        regexp_replace(btrim(p.c2), '^[0-9]+', '')         AS serie,
        btrim(p.c3)                                        AS folio,
        p.c7::timestamp                                    AS pago_at,
        p.c7::date                                         AS fecha_pago,
        btrim(p.c8)                                        AS forma_pago_sat,
        NULLIF(btrim(p.c9), '')                            AS moneda,
        p.c11                                              AS tipo_cambio,
        round(COALESCE(p.c12, 0)::numeric, 2)              AS monto,
        NULLIF(btrim(p.c13), '')                           AS num_operacion,
        NULLIF(btrim(p.c19), '')                           AS banco_rfc,
        NULLIF(btrim(p.c20), '')                           AS clabe
      FROM kepler_ods.kdfe33pagm1 p
      WHERE btrim(p.c1) = p.sucursal
    )
    SELECT
      '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
      b.sucursal,
      b.serie,
      CASE WHEN b.serie = 'UA0701' THEN 'U-A-7' END AS doc_tipo,
      b.folio,
      b.pago_at,
      b.fecha_pago,
      b.forma_pago_sat,
      -- Etiqueta legible del catálogo del SAT (c_FormaPago). Sólo las que existen en el dato:
      -- inventar el catálogo entero sería declarar cobertura que no se midió.
      CASE b.forma_pago_sat
        WHEN '01' THEN 'Efectivo'
        WHEN '02' THEN 'Cheque nominativo'
        WHEN '03' THEN 'Transferencia electrónica'
        WHEN '25' THEN 'Cesión de derechos de cobro'
      END AS forma_pago_label,
      b.moneda,
      b.tipo_cambio,
      b.monto,
      b.num_operacion,
      b.banco_rfc,
      b.clabe,
      -- La CLABE trae 3 dígitos de banco + plaza + cuenta + verificador, así que el número de
      -- cuenta va EN MEDIO: se busca por "contiene", nunca por "termina" (probarlo con LIKE
      -- '%'||label dio 0 de 206 — el verificador final siempre estorba).
      -- Se exige length>=4 y se toma la coincidencia más larga: con 3 dígitos ('506', '854')
      -- una CLABE cualquiera casa por azar.
      (SELECT ba.account_label
         FROM finance.bank_accounts ba
        WHERE ba.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
          AND ba.account_label IS NOT NULL
          AND length(ba.account_label) >= 4
          AND b.clabe LIKE '%' || ba.account_label || '%'
        ORDER BY length(ba.account_label) DESC
        LIMIT 1) AS account_label,
      -- Más de una cuenta nuestra dentro de la misma CLABE = el enlace NO es de fiar. Se marca
      -- para que el consumidor pueda descartarlo en vez de quedarse con el primero que salga.
      (SELECT count(*) > 1
         FROM finance.bank_accounts ba
        WHERE ba.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
          AND ba.account_label IS NOT NULL
          AND length(ba.account_label) >= 4
          AND b.clabe LIKE '%' || ba.account_label || '%') AS account_label_ambiguo
    FROM base b
  `);

  // ── Cobertura: lo que el resolvedor NO cubre se ENUMERA (ADR-057) ────────────────────────
  // Una fila ausente llega NULL por un LEFT JOIN y se lee como sana. Esta vista dice, por
  // sucursal, cuánto del complemento es utilizable y por qué no lo es el resto.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_kepler_payment_complement_coverage AS
    SELECT
      sucursal,
      count(*)                                                        AS filas,
      count(*) FILTER (WHERE doc_tipo IS NULL)                        AS sin_doctype,
      count(*) FILTER (WHERE fecha_pago IS NULL)                      AS sin_fecha_pago,
      count(*) FILTER (WHERE forma_pago_sat = '03')                   AS transferencias,
      count(*) FILTER (WHERE forma_pago_sat = '03' AND clabe IS NULL) AS transf_sin_clabe,
      count(*) FILTER (WHERE clabe IS NOT NULL AND account_label IS NULL)     AS clabe_sin_cuenta,
      count(*) FILTER (WHERE account_label_ambiguo)                   AS cuenta_ambigua,
      round(sum(monto), 2)                                            AS monto,
      min(fecha_pago)                                                 AS desde,
      max(fecha_pago)                                                 AS hasta
    FROM analytics.v_kepler_payment_complement
    GROUP BY 1
  `);

  for (const v of ['v_kepler_payment_complement', 'v_kepler_payment_complement_coverage']) {
    // `security_invoker` + GRANT NO se heredan al recrear una vista (ADR-057): se re-aplican
    // siempre, y una migración que lo olvide deja la vista muda para `app_runtime`.
    await knex.raw(`ALTER VIEW analytics.${v} SET (security_invoker = true)`);
    await knex.raw(`GRANT SELECT ON analytics.${v} TO app_runtime`).catch(() => {});
  }

  await knex.raw(`COMMENT ON VIEW analytics.v_kepler_payment_complement IS
    'CB.48 — Complemento de pago SAT (kepler_ods.kdfe33pagm1), SOLO doctype U-A-7 (Cobro CFDI). Trae la fecha REAL del pago (retrofechada, a diferencia de kdm1.c9 que es el día de captura) y la CLABE de la cuenta receptora. Decode verificado contra pantalla de Kepler del doc UA0701-0000214. NO cubre U-A-5 del CEDIS (el SAT sólo exige complemento en pago diferido): ver v_kepler_payment_complement_coverage.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_payment_complement_coverage`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_kepler_payment_complement`);
};
