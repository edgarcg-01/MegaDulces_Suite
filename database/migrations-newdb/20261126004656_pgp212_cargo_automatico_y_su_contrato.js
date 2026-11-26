'use strict';
/**
 * `[PGP.212]` C1 — **Cada cargo que el banco cobra solo, con el contrato que lo sustenta o con su porqué** (anexo CR
 * §3.4, DCR2: «todos los cargos tienen que estar sustentados por contratos»). Derivado (`derive-no-copy`):
 * `finance.v_automatic_bank_charges`, una fila por movimiento del banco que es un cargo automático.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_CARGOS_DEL_BANCO.md` §3.4 y §4 (`[PGP.212]`).
 *
 * ── Qué es un cargo automático ─────────────────────────────────────────────────────────────────
 *  · Todo movimiento de una serie de `[PGP.209]` (lo que el banco cobra cada mes: arrendamiento, crédito, seguros,
 *    cuotas de comisión). Y además
 *  · todo retiro cuyo concepto es de cargo automático (`PATRONES`, lista explícita y medida): domiciliación,
 *    cobranza domiciliada, prima de seguro, capital/intereses/IVA de crédito, disposición de crédito, comisión de
 *    apertura, tarjeta domiciliada, STM, seguros domiciliados. Cubre lo que una serie no ve: el cargo de un solo mes
 *    (la apertura) y el contrato que todavía no cumple 3 meses.
 *  · NO: «cargo por pago concentración» de Banorte ni el CIE de BBVA (pagos referenciados que hace la empresa:
 *    impuestos, luz, teléfono, FONACOT), ni la comisión de terminal (`[CB.62]`), ni el pago de tarjeta que no dice
 *    «domicilia».
 *
 * ── Con qué contrato casa, y si no, por qué ──────────────────────────────────────────────────────
 *  Un renglón de contrato es candidato si cita la serie del movimiento (`series_key`) o, en la misma cuenta, la misma
 *  cabeza del concepto (`bank_concept_head`; la regla de la cabeza es la de `[PGP.209]`) — ⚠️ esto último sólo si a
 *  uno de los dos le falta serie: con las dos series y distintas, NO. Corregido el 2026-11-26 (`[PGP.219]`): dos
 *  créditos en la misma cuenta cobran con las mismas cabezas («pago de intereses»…) y distinto número; por la cabeza,
 *  el cobro de uno quedaba ligado al contrato del otro (medido en Postgres local: 30 de 60). De sus candidatos gana el
 *  mejor: `con_contrato` (confirmado o terminado, vigente ese día y con el importe: fijo ±$1, tabla ±$1 y ±10 días,
 *  estimado cualquiera) > `importe_distinto` > `fuera_de_vigencia` > `propuesta_sin_confirmar` >
 *  `propuesta_rechazada`; sin candidato, `sin_contrato`. Sólo `con_contrato` lo sustenta (`supported`).
 *
 * ── Lo medido antes (sólo lectura, pg-prod `system_identifier` 7688376744939610156, 2026-11-26) ──
 *  · Con los contratos vacíos (aún no existen en prod): **561 cargos automáticos en 12 meses, ≈ $24.3 M**, cada
 *    movimiento una vez (1.2 s): 257 sólo por su serie, 239 por serie y concepto, 65 sólo por su concepto (≈ $10.9 M:
 *    las amortizaciones de las disposiciones de BBVA, la apertura, las primas y las domiciliaciones de un mes).
 *  · Noviembre (1–25): **59 cargos, $781,571** — más que los 32 del anexo §1.1 porque ahora entran las cuotas de
 *    comisión (DCR2 también las pide) y sin los pagos referenciados de Banorte. Por mes: $0.5–1.5 M, salvo enero–marzo
 *    (≈ $3 M: el factoraje de BanBajío) y septiembre (≈ $9.7 M: las amortizaciones de BBVA).
 *  · M1 (lo sustentado por un contrato) = **0 %**: no hay ningún contrato.
 *
 * Sólo DDL de una vista (sin datos, sin re-login). Idempotente. `security_invoker`. Va DESPUÉS de las migraciones de
 * `[PGP.209]` (la vista de series) y `[PGP.210]` (los contratos).
 *
 * @param { import("knex").Knex } knex
 */
const M209 = require('./20261125224611_pgp209_cargos_recurrentes_del_banco.js');

const VISTA = 'finance.v_automatic_bank_charges';
const MEGA_DULCES = '00000000-0000-0000-0000-00000000d01c';

/** Conceptos de cargo automático (sobre el concepto limpio: mayúsculas, sin espacios dobles). Sin «?»: knex lo toma por parámetro. */
const PATRONES = String.raw`^(DOMICILIACION|CARGO COBRANZA DOMICILIADA|COBRANZA DOMICILIADA|VI[0-9]+ CARGO COBRANZA|COBRO PRIMA|PAGO DE CAPITAL|PAGO DE INTERESES|INTERESES NO REALES|PAGO DE IVA|CREDITO LIQUIDO DISP|COMISION DE PRESTAMO|IVA COMISION DE PRESTAMO|PAGO TARJETA DE CREDITO.*DOMICILIA|STM FINANCIAL|PAGO FAMILIASEGURA|PAGO VIDASEGURA)`;
/** Tolerancias para casar el importe (anexo CR §1.1: ±$1) y el día de una tabla de amortización. */
const TOLERANCIA_PESOS = 1;
const TOLERANCIA_DIAS_TABLA = 10;
const MOTIVOS = ['con_contrato', 'sin_contrato', 'propuesta_sin_confirmar', 'propuesta_rechazada', 'fuera_de_vigencia', 'importe_distinto'];
const LIMPIO = String.raw`upper(btrim(regexp_replace(coalesce(m.concept, ''), '\s+', ' ', 'g')))`;
const lista = (xs) => xs.map((x) => `'${x}'`).join(', ');

const SELECT_SQL = String.raw`
WITH serie AS (
  SELECT v.tenant_id, unnest(v.movement_ids) AS movement_id, v.series_key
    FROM finance.v_recurring_bank_charges v
),
mov AS (
  SELECT m.id, m.tenant_id, m.bank_account_id, m.movement_date, m.amount_out AS importe, m.concept,
         ${M209.CABEZA_DEL_CONCEPTO('m.concept')} AS cabeza,
         ${LIMPIO} AS limpio
    FROM finance.bank_movements m
    JOIN finance.bank_accounts ba ON ba.id = m.bank_account_id
   WHERE m.deleted_at IS NULL
     AND m.amount_out > 0
     AND ba.kind = 'bank'
     AND m.sync_source IN (${lista(M209.FUENTES)})
     AND m.movement_date >= current_date - ${M209.VENTANA_DIAS}
),
auto AS (
  SELECT mov.*, s.series_key,
         CASE WHEN s.series_key IS NOT NULL AND mov.limpio ~ '${PATRONES}' THEN 'serie_y_concepto'
              WHEN s.series_key IS NOT NULL THEN 'serie'
              ELSE 'concepto' END AS detectado_por
    FROM mov
    LEFT JOIN serie s ON s.movement_id = mov.id AND s.tenant_id = mov.tenant_id
   WHERE s.series_key IS NOT NULL OR mov.limpio ~ '${PATRONES}'
),
renglon AS (
  SELECT l.id AS line_id, l.tenant_id, l.contract_id, l.series_key, l.bank_concept_head, l.amount_rule, l.fixed_amount,
         c.status, c.charge_bank_account_id, c.starts_on, c.ends_on
    FROM finance.charge_contract_lines l
    JOIN finance.charge_contracts c ON c.tenant_id = l.tenant_id AND c.id = l.contract_id
),
cand AS (
  SELECT a.id AS movement_id, r.contract_id, r.line_id, r.status,
         (a.movement_date >= coalesce(r.starts_on, a.movement_date) AND a.movement_date <= coalesce(r.ends_on, a.movement_date)) AS vigente,
         CASE r.amount_rule
           WHEN 'fijo' THEN abs(a.importe - r.fixed_amount) <= ${TOLERANCIA_PESOS}
           WHEN 'tabla' THEN EXISTS (SELECT 1 FROM finance.charge_contract_schedule sc
                                      WHERE sc.line_id = r.line_id AND abs(sc.amount - a.importe) <= ${TOLERANCIA_PESOS}
                                        AND abs(sc.due_date - a.movement_date) <= ${TOLERANCIA_DIAS_TABLA})
           ELSE true END AS casa_importe
    FROM auto a
    JOIN renglon r ON r.tenant_id = a.tenant_id
     AND (r.series_key = a.series_key
          OR (r.charge_bank_account_id = a.bank_account_id AND r.bank_concept_head = a.cabeza
              AND (r.series_key IS NULL OR a.series_key IS NULL)))
),
calificado AS (
  SELECT c.*,
         CASE WHEN c.status IN ('confirmado', 'terminado') AND c.vigente AND c.casa_importe THEN 'con_contrato'
              WHEN c.status IN ('confirmado', 'terminado') AND c.vigente THEN 'importe_distinto'
              WHEN c.status IN ('confirmado', 'terminado') THEN 'fuera_de_vigencia'
              WHEN c.status = 'propuesto' THEN 'propuesta_sin_confirmar'
              ELSE 'propuesta_rechazada' END AS motivo
    FROM cand c
),
mejor AS (
  SELECT DISTINCT ON (movement_id) movement_id, contract_id, line_id, motivo
    FROM calificado
   ORDER BY movement_id, array_position(ARRAY['con_contrato', 'importe_distinto', 'fuera_de_vigencia', 'propuesta_sin_confirmar', 'propuesta_rechazada'], motivo), contract_id
)
SELECT a.tenant_id,
       a.id AS bank_movement_id,
       a.bank_account_id,
       a.movement_date,
       a.importe AS amount,
       a.concept,
       a.cabeza AS concept_head,
       a.series_key,
       a.detectado_por AS detected_by,
       b.contract_id,
       b.line_id AS contract_line_id,
       coalesce(b.motivo, 'sin_contrato') AS reason,
       coalesce(b.motivo, '') = 'con_contrato' AS supported
  FROM auto a
  LEFT JOIN mejor b ON b.movement_id = a.id
`;

/** La compuerta pide los retiros de prod; con menos es una base de pruebas y se declara. */
const RETIROS_DE_PROD = 10000;
/** Piso de cargos automáticos en 12 meses (medido el 2026-11-26: 561). */
const PISO_CARGOS = 300;

function juzgarCompuerta(m) {
  if (!(m.n >= PISO_CARGOS) || m.repetidos > 0 || m.motivos_fuera > 0) {
    return `[PGP.212] ${VISTA}: ${m.n} cargos automáticos en 12 meses (piso ${PISO_CARGOS}), ${m.repetidos} movimientos repetidos, ` +
      `${m.motivos_fuera} con un motivo fuera del catálogo.`;
  }
  return null;
}
const SQL_COMPUERTA = `
  SELECT count(*)::int AS n,
         (count(*) - count(DISTINCT bank_movement_id))::int AS repetidos,
         count(*) FILTER (WHERE reason NOT IN (${lista(MOTIVOS)}))::int AS motivos_fuera
    FROM ${VISTA} WHERE tenant_id = '${MEGA_DULCES}'`;

exports.SELECT_SQL = SELECT_SQL;
exports.VISTA = VISTA;
exports.PATRONES = PATRONES;
exports.MOTIVOS = MOTIVOS;
exports.juzgarCompuerta = juzgarCompuerta;
exports.SQL_COMPUERTA = SQL_COMPUERTA;
exports.RETIROS_DE_PROD = RETIROS_DE_PROD;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const t of ['finance.v_recurring_bank_charges', 'finance.charge_contracts', 'finance.charge_contract_lines', 'finance.charge_contract_schedule']) {
    if (!(await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS t`, [t])).rows[0].t) {
      throw new Error(`[PGP.212] falta ${t}: aplica antes las migraciones de PGP.209 (20261125224611) y PGP.210 (20261126001551).`);
    }
  }
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} WITH (security_invoker = true) AS ${SELECT_SQL}`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    $$[PGP.212] Cada cargo que el banco cobra solo (12 meses): los movimientos de una serie de PGP.209 y los retiros con
    concepto de cargo automatico (domiciliacion, cobranza domiciliada, prima, credito, disposicion, apertura, tarjeta
    domiciliada, STM, seguros). reason: con_contrato (confirmado o terminado, vigente y con su importe) | importe_distinto
    | fuera_de_vigencia | propuesta_sin_confirmar | propuesta_rechazada | sin_contrato. supported = con_contrato. DCR2.$$`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN GRANT SELECT ON ${VISTA} TO dev_ro; END IF; END $$`);

  await knex.raw(`SET LOCAL app.tenant_id = '${MEGA_DULCES}'`);
  const [{ n }] = (await knex.raw(`
    SELECT count(*)::int AS n FROM finance.bank_movements
     WHERE tenant_id = '${MEGA_DULCES}' AND deleted_at IS NULL AND amount_out > 0 AND movement_date >= current_date - 365`)).rows;
  if (n < RETIROS_DE_PROD) {
    console.log(`  · [PGP.212] NO MEDIDO: ${n} retiros de banco en esta base; la compuerta se exige con los de prod`);
    return;
  }
  const [m] = (await knex.raw(SQL_COMPUERTA)).rows;
  const error = juzgarCompuerta(m);
  if (error) throw new Error(error);
  console.log(`  ✓ [PGP.212] ${VISTA}: ${m.n} cargos automáticos en 12 meses, cada movimiento una vez`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista es nueva y nada depende de ella todavía. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
