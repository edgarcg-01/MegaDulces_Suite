'use strict';
/**
 * `[MKT.6]` — `commercial.v_promo_agreement_sellout`: ¿la activación movió la aguja,
 * o sólo se subieron fotos?
 *
 * ── Qué agrega sobre `[MKT.1]` ───────────────────────────────────────────────────────────────
 * El expediente (`promo_agreement_channels` + `_files`) prueba que la promoción **se ejecutó**:
 * hay evidencia, en tal plaza, en tal fecha. No dice si **sirvió**. Esta vista cierra ese lazo
 * leyendo la venta real del ERP, sin capturar nada a mano.
 *
 * El flujo en papel mide la promoción **fotografiando tickets y tecleando el importe**. Eso
 * tiene tres defectos que no se arreglan con más disciplina:
 *   · sólo ve los tickets que alguien fotografió — es un muestreo sesgado, no una medición;
 *   · el orden lo da un campo opcional (piezas), así que una plaza que vendió bien con ese
 *     campo vacío **desaparece del ranking**, y la ausencia se lee como "ahí no se vendió";
 *   · el número es BRUTO: $80,000 durante la promo no dice nada si antes ya se vendían $78,000.
 *
 * ── Por qué es una VISTA ─────────────────────────────────────────────────────────────────────
 * La venta ya está derivada del ODS en `analytics.v_sellout_daily` — la DEFINICIÓN ÚNICA del
 * universo del sell-out, con sus tres piernas y su dedup de cutover horneados. Materializar acá
 * una segunda forma del mismo hecho es exactamente lo que la regla ⭐ del proyecto prohíbe, y
 * además envejecería sola. Se deriva: cuesta un JOIN y siempre está fresca.
 *
 * ── El grano es el CANAL, no el acuerdo ─────────────────────────────────────────────────────
 * Una fila por `promo_agreement_channels`, que es la misma unidad del expediente. Así la
 * pregunta "¿esta plaza ejecutó **y** vendió?" se contesta con una sola fila, y no hay que
 * cruzar dos granos distintos para saber si la foto y el resultado hablan del mismo lugar.
 *
 * ── El dinero manda; las unidades sólo si son conmensurables (ADR-059 / ADR-055 / ADR-057) ──
 * `v_sellout_daily.units` viene **cruda**, con su `unit_kind` al lado: sumar piezas con cajas da
 * un número que no significa nada. Por eso `monto_*` (pesos) es la cifra publicable —siempre
 * conmensurable— y `units_*` sólo se llena cuando TODO el alcance comparte un único `unit_kind`;
 * si se mezclan va **NULL** y `unidad_estado='mixta'` lo dice. Nunca se convierte con un factor
 * de caja inventado acá.
 *
 * ── Las cuatro maneras de no poder medir, cada una con su nombre ────────────────────────────
 * `medicion` NO es un booleano, porque "no se pudo medir" y "vendió cero" son conclusiones
 * opuestas y un solo estado las confundiría (ADR-056):
 *   · `medida`        — hay venta en la ventana y hay línea base: el uplift significa algo.
 *   · `sin_baseline`  — hubo venta, pero el periodo anterior no tiene NADA con qué comparar
 *                       (producto nuevo, plaza nueva). El bruto se publica; el uplift va NULL.
 *   · `sin_venta`     — la ventana no registró una sola venta de esos códigos en esa plaza.
 *                       Es un HALLAZGO, no un hueco: la promoción no vendió.
 *   · `sin_alcance`   — ningún código del acuerdo está ligado a un producto del catálogo, así
 *                       que no hay a qué mirarle la venta. Es un problema de captura, no comercial.
 *
 * ── Dos coberturas que el acuerdo no declara solo, y sin las cuales la cifra miente ─────────
 *  1. **`codigos_ligados` / `codigos_total`.** `promo_agreement_codes.product_id` es NULLABLE:
 *     un acuerdo puede tener seis códigos y sólo dos resueltos contra el catálogo. La venta de
 *     los otros cuatro **no se está viendo**, y sin esta razón a la vista el número parece
 *     completo. Es el mismo principio que obliga a declarar cobertura en la Fase VP.
 *  2. **`ventana_abierta`.** El formato admite "HASTA AGOTAR" (`vigencia_hasta` NULL). Ahí la
 *     ventana se corta HOY, y la línea base toma los mismos días corridos hacia atrás. El
 *     resultado es legítimo pero **provisional**, y la bandera lo dice en vez de que alguien
 *     compare mañana un número contra el de ayer sin saber por qué cambió.
 *
 * ── `security_invoker` ──────────────────────────────────────────────────────────────────────
 * Las tablas `commercial.promo_agreement*` tienen RLS FORZADO. Sin `security_invoker=true` la
 * vista corre con los privilegios de su dueño y el RLS del que consulta **no aplica** — una
 * vista se vuelve el agujero por el que se escapa el aislamiento entre tenants.
 * ⚠️ Tras cada `CREATE OR REPLACE VIEW` hay que RE-APLICAR `security_invoker` y el `GRANT`: no
 * se heredan (lección de ADR-057, donde una migración lo perdió y sólo lo vio la aserción de
 * metadata del candado).
 *
 * Depende de `20260928120000_commercial_promo_agreements.js` (`[MKT.1]`). Idempotente
 * (`CREATE OR REPLACE VIEW`) y reversible.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = `
CREATE OR REPLACE VIEW commercial.v_promo_agreement_sellout AS
WITH canal AS (
  SELECT
    ch.id                        AS channel_id,
    ch.tenant_id,
    ch.agreement_id,
    ch.warehouse_id,
    ch.warehouse_code,
    ch.warehouse_name,
    ch.evidence_required,
    ch.evidence_count,
    ag.folio,
    ag.proveedor,
    ag.empresa,
    ag.status                    AS agreement_status,
    ag.monto                     AS monto_negociado,
    ag.vigencia_desde            AS desde,
    -- "HASTA AGOTAR" (vigencia_hasta NULL) se corta HOY: medir hasta el infinito no se puede,
    -- y dejar la fila fuera esconderia justo los acuerdos abiertos, que son los que mas duran.
    COALESCE(ag.vigencia_hasta, CURRENT_DATE) AS hasta,
    (ag.vigencia_hasta IS NULL)  AS ventana_abierta
  FROM commercial.promo_agreement_channels ch
  JOIN commercial.promo_agreements ag
    ON ag.tenant_id = ch.tenant_id AND ag.id = ch.agreement_id AND ag.deleted_at IS NULL
),
ventana AS (
  -- 'c.*' trae channel_id: repetirlo arriba lo vuelve ambiguo en los JOIN de abajo.
  -- Inclusivo en los dos extremos: del 1 al 7 son SIETE dias, no seis. Un dia de menos en la
  -- ventana corre la linea base un dia y hace que dos corridas no den lo mismo.
  SELECT (c.hasta - c.desde + 1) AS dias, c.*
  FROM canal c
),
-- Alcance: los codigos del acuerdo QUE ESTAN LIGADOS a un producto del catalogo.
-- Los no ligados se cuentan aparte (cobertura), no se ignoran en silencio.
alcance AS (
  SELECT
    tenant_id,
    agreement_id,
    count(*)::int                                          AS codigos_total,
    count(*) FILTER (WHERE product_id IS NOT NULL)::int     AS codigos_ligados
  FROM commercial.promo_agreement_codes
  GROUP BY 1, 2
),
-- Venta DENTRO de la vigencia, acotada a los productos del acuerdo y a la plaza del canal.
vta AS (
  SELECT
    v.channel_id,
    count(DISTINCT s.business_date)::int AS dias_con_venta,
    sum(s.monto)                         AS monto,
    sum(s.units)                         AS units,
    count(DISTINCT s.unit_kind)::int     AS unit_kinds
  FROM ventana v
  JOIN commercial.promo_agreement_codes k
    ON k.tenant_id = v.tenant_id AND k.agreement_id = v.agreement_id AND k.product_id IS NOT NULL
  JOIN analytics.v_sellout_daily s
    ON s.tenant_id      = v.tenant_id
   AND s.product_id     = k.product_id
   AND s.warehouse_code = v.warehouse_code
   AND s.business_date BETWEEN v.desde AND v.hasta
  GROUP BY 1
),
-- Linea base: MISMA cantidad de dias, inmediatamente antes de arrancar. No "el mes pasado" ni
-- "el anio anterior": una ventana de distinto largo no es comparable con la de la promocion.
base AS (
  SELECT
    v.channel_id,
    sum(s.monto)                         AS monto,
    sum(s.units)                         AS units,
    count(DISTINCT s.unit_kind)::int     AS unit_kinds
  FROM ventana v
  JOIN commercial.promo_agreement_codes k
    ON k.tenant_id = v.tenant_id AND k.agreement_id = v.agreement_id AND k.product_id IS NOT NULL
  JOIN analytics.v_sellout_daily s
    ON s.tenant_id      = v.tenant_id
   AND s.product_id     = k.product_id
   AND s.warehouse_code = v.warehouse_code
   AND s.business_date BETWEEN (v.desde - v.dias) AND (v.desde - 1)
  GROUP BY 1
)
SELECT
  v.tenant_id,
  v.channel_id,
  v.agreement_id,
  v.folio,
  v.empresa,
  v.proveedor,
  v.agreement_status,
  v.warehouse_id,
  v.warehouse_code,
  v.warehouse_name,
  v.desde,
  v.hasta,
  v.dias                                        AS dias_ventana,
  v.ventana_abierta,
  v.monto_negociado,

  -- Cobertura del alcance: sin esto, medir 2 de 6 codigos parece medir el acuerdo entero.
  COALESCE(a.codigos_total, 0)                  AS codigos_total,
  COALESCE(a.codigos_ligados, 0)                AS codigos_ligados,

  -- Ejecucion (lo que ya media el expediente), al lado del resultado: la pregunta util es
  -- "ejecuto Y vendio", y cruzar dos granos distintos para contestarla es como se pierde.
  v.evidence_required,
  v.evidence_count,

  COALESCE(t.dias_con_venta, 0)                 AS dias_con_venta,
  t.monto                                       AS monto_ventana,
  b.monto                                       AS monto_baseline,
  -- El uplift solo existe si hay con que comparar. Sin baseline va NULL, no el bruto disfrazado.
  CASE WHEN t.monto IS NOT NULL AND b.monto IS NOT NULL
       THEN t.monto - b.monto END               AS uplift_monto,
  -- Y el porcentaje solo con denominador > 0: dividir entre cero publicaria un infinito, y un
  -- baseline de 0 con venta positiva no es "+infinito%", es "no habia base".
  CASE WHEN t.monto IS NOT NULL AND b.monto IS NOT NULL AND b.monto > 0
       THEN round(((t.monto - b.monto) / b.monto * 100)::numeric, 2) END AS uplift_pct,

  CASE WHEN t.unit_kinds = 1 THEN t.units END   AS units_ventana,
  CASE WHEN b.unit_kinds = 1 THEN b.units END   AS units_baseline,
  CASE
    WHEN t.unit_kinds IS NULL THEN 'sin_dato'
    WHEN t.unit_kinds = 1     THEN 'unica'
    ELSE 'mixta'
  END                                           AS unidad_estado,

  CASE
    WHEN COALESCE(a.codigos_ligados, 0) = 0 THEN 'sin_alcance'
    WHEN t.monto IS NULL                    THEN 'sin_venta'
    WHEN b.monto IS NULL                    THEN 'sin_baseline'
    ELSE 'medida'
  END                                           AS medicion
FROM ventana v
LEFT JOIN alcance a ON a.tenant_id = v.tenant_id AND a.agreement_id = v.agreement_id
LEFT JOIN vta     t ON t.channel_id = v.channel_id
LEFT JOIN base    b ON b.channel_id = v.channel_id
`;

exports.up = async function up(knex) {
  const base = await knex.schema.withSchema('commercial').hasTable('promo_agreement_channels');
  if (!base) {
    // Sin las tablas de `[MKT.1]` esta vista no tiene sobre que pararse. Se declara en vez de
    // reventar el batch de otra persona: la migracion que las crea corre antes que esta.
    console.log('  ⚠️  commercial.promo_agreement_channels no existe todavia — vista NO creada.');
    return;
  }
  await knex.raw(VISTA);
  // NO se heredan del CREATE OR REPLACE: van SIEMPRE despues (ADR-057).
  await knex.raw('ALTER VIEW commercial.v_promo_agreement_sellout SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON commercial.v_promo_agreement_sellout TO app_runtime');
  await knex.raw(`
    COMMENT ON VIEW commercial.v_promo_agreement_sellout IS
      '[MKT.6] Resultado de cada canal del acuerdo: venta en la vigencia contra una linea base del '
      'MISMO largo inmediatamente anterior. El dinero es la cifra publicable; las unidades solo '
      'cuando el alcance comparte un unico peldano (ADR-055/057). medicion declara los cuatro casos '
      '(medida / sin_baseline / sin_venta / sin_alcance) porque "no se puede medir" y "vendio cero" '
      'son conclusiones opuestas. codigos_ligados/codigos_total declara cuanto del acuerdo se esta '
      'mirando de verdad, y ventana_abierta avisa que un HASTA AGOTAR se corta hoy.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS commercial.v_promo_agreement_sellout');
};
