'use strict';
/**
 * `[PGP.209]` C0 — **Los cargos que el banco cobra solo, propuestos por su historia**, derivados
 * (`derive-no-copy`, regla 1 / ADR-056): `finance.v_recurring_bank_charges`, una fila por serie de cargos que se
 * repite cada mes en la misma cuenta. Es la PROPUESTA de la DCR1 («el sistema propone, Tesorería confirma») y lo que
 * `[PGP.218]` aparta del saldo antes de armar el programa mientras el contrato no exista (DCR9).
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_CARGOS_DEL_BANCO.md` §3.2 y §4 (`[PGP.209]`).
 *
 * ── Las dos reglas ─────────────────────────────────────────────────────────────────────────────
 *  · `fixed_amount`: la misma cuenta, la misma CABEZA del concepto (sus 3 primeras palabras, sólo letras y sin
 *    acentos) y el mismo importe AL CENTAVO, en 3 meses distintos o más. La cabeza, y no el concepto entero,
 *    porque el folio de una domiciliación cambia cada mes y la descarga del banco recorta lo que el estado subido
 *    trae completo («DOMICILIACION PAGO SERVICIO» contra «DOMICILIACION PAGO SERVICIO '<folio> RFC <acreedor>»).
 *  · `variable_amount`: la misma cuenta, la misma cabeza y la misma REFERENCIA (la primera corrida de 6 dígitos o
 *    más: el número del crédito), en 3 meses o más: el interés que baja cada mes. Lo que ya tomó la regla fija no
 *    entra aquí (un movimiento nunca está en dos series). El importe esperado es el último cobrado: del lado
 *    seguro mientras el interés baje, y rotulado como estimado (DCR8/DCR10).
 *
 * ── Lo que NO es un cargo del banco (lo hace la empresa, o ya es de otro) ──────────────────────
 *  · Las categorías que inicia la empresa: traspaso entre cuentas, compra de mercancía, compra con tarjeta, nómina.
 *  · La comisión variable de terminal: es `[CB.62]`. Se excluye con SU definición (`cargoDeTarjeta` de
 *    `comisiones-kepler.armador.ts`) llevada a SQL; la prueba exige que las dos digan lo mismo renglón por renglón.
 *  · Más de 3 cargos al mes de la misma serie: es por transacción, no de contrato.
 *  · La Caja General (no es banco) y el libro `sheet` (agosto: reescribe el concepto).
 *
 * ── Lo medido antes (sólo lectura, pg-prod `system_identifier` 7688376744939610156, 2026-11-25) ──
 *  · Descarga (`banco`, desde el 31-oct) y estados subidos (`upload`, enero–10-nov): **0** movimientos en las dos
 *    a la vez, así que no se cuentan doble.
 *  · Agrupar sólo por cuenta e importe mete traspasos, Caja General y compras con tarjeta (47 series de traspaso,
 *    49 de mercancía); con las exclusiones, las 18 series de $300 o más de jun–nov son todas cargos del banco.
 *  · Resultado (12 meses): **81 series; 47 vigentes, ≈ $512 mil al mes, en 10 cuentas** (39 fijas, $473 mil;
 *    8 variables, $39 mil), y 34 que ya no cobran. Ningún movimiento en dos series. La vista entera: 0.3 s.
 *  · Controles contra lo que la vista NO lee: el RFC del acreedor de las domiciliaciones (13 de 13 series de importe
 *    fijo, 2 acreedores); el número del crédito (2 de 2 capitales fijos; 2 intereses, cada uno UNA serie); las cuotas
 *    fijas del anexo §1.2 con otra normalización (129 de 129 cargos). Placebo (importe + $37): 0 de 39 series.
 *    `cargoDeTarjeta` de CB.62 y su réplica en SQL: lo mismo en 34,270 retiros (5,749 de terminal).
 *  · De los 32 cargos de noviembre del anexo §1.1 propone 19 (≈ $420 mil de $708 mil). Lo que NO ve (se declara):
 *    la disposición de crédito con menos de 3 meses (BBVA, ≈ $98 mil: es del contrato de la línea), el cargo de un
 *    solo mes (apertura, prima nueva), el contrato que aún no cumple 3 meses, y el concepto que cambia de forma
 *    entre estados (un seguro). FONACOT no es cargo automático: es un pago referenciado (CIE).
 *
 * Sólo DDL de una vista (sin datos, sin re-login). Idempotente (`CREATE OR REPLACE VIEW`). `security_invoker`: la
 * RLS de `finance.bank_movements` (forzada) aplica a quien consulta.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'finance.v_recurring_bank_charges';
const MEGA_DULCES = '00000000-0000-0000-0000-00000000d01c';

/** Una serie es tal desde 3 meses distintos (DCR1, anexo §3.2). */
const MESES_MINIMOS = 3;
/** Más de 3 cargos al mes de la misma serie ya es por transacción (3 terminales con su renta es el máximo medido). */
const MAX_CARGOS_POR_MES = 3;
/** La historia que se lee. */
const VENTANA_DIAS = 365;
/** Vigente: cobró en los 40 días anteriores al último movimiento de SU cuenta (no a hoy: una cuenta sin descarga
 *  reciente no apaga sus series). Un mes y diez días de holgura para el cargo que se atrasa. */
const VIGENCIA_DIAS = 40;
const FUENTES = ['banco', 'upload'];
const CATEGORIAS_DE_LA_EMPRESA = ['traspaso_entre_cuentas', 'compra_mercancia', 'compra_tarjeta', 'nomina'];

/**
 * `cargoDeTarjeta` de `[CB.62]` en SQL (el concepto limpio: mayúsculas, sin espacios dobles). Sin «?»: knex lo
 * tomaría por parámetro; `X{0,1}` es lo mismo.
 */
const CARGO_DE_TARJETA = String.raw`^(IVA (TASA DE DESC (CREDITO|DEBITO)|COM\.{0,1} VTAS{0,1} TDC INTER|COM\.{0,1} VTA\.{0,1} (NAL|INTL)\.{0,1} AMEX)/[0-9]{2}[0-9]{5,}|(APLI TASA DE DES (CREDITO|DEBITO)|COM\.{0,1} VTAS{0,1} TDC INTER|COM\.{0,1} VTA\.{0,1} (NAL|INTL)\.{0,1} AMEX)/[0-9]{2}[0-9]{5,}|I\.{0,1}\s{0,1}V\.{0,1}\s{0,1}A\.{0,1} COMISION [0-9]{6,}[CD]\y|COMISION [0-9]{6,}[CD]APLICACION DE TASAS)`;
const CONCEPTO_LIMPIO = String.raw`upper(btrim(regexp_replace(coalesce(m.concept, ''), '\s+', ' ', 'g')))`;
const lista = (xs) => xs.map((x) => `'${x}'`).join(', ');
/** La CABEZA del concepto (sus 3 primeras palabras, sólo letras y sin acentos). La usa también `[PGP.212]`: una regla. */
const CABEZA_DEL_CONCEPTO = (col) => String.raw`array_to_string((regexp_split_to_array(btrim(regexp_replace(
           translate(upper(${col}), 'ÁÉÍÓÚÜáéíóúüñ', 'AEIOUUAEIOUUÑ'), '[^A-ZÑ]+', ' ', 'g')), ' '))[1:3], ' ')`;

const SELECT_SQL = String.raw`
WITH base AS (
  SELECT m.id, m.tenant_id, m.bank_account_id, m.movement_date AS fecha, m.amount_out AS importe,
         m.concept AS concepto, c.code AS categoria,
         ${CABEZA_DEL_CONCEPTO('m.concept')} AS cabeza,
         substring(m.concept FROM '[0-9]{6,}') AS referencia
    FROM finance.bank_movements m
    JOIN finance.bank_accounts ba ON ba.id = m.bank_account_id
    LEFT JOIN finance.movement_categories c ON c.id = m.category_id
   WHERE m.deleted_at IS NULL
     AND m.amount_out > 0
     AND ba.kind = 'bank'
     AND m.sync_source IN (${lista(FUENTES)})
     AND m.movement_date >= current_date - ${VENTANA_DIAS}
     AND coalesce(c.code, '') NOT IN (${lista(CATEGORIAS_DE_LA_EMPRESA)})
     AND NOT (coalesce(m.amount_in, 0) <= 0 AND ${CONCEPTO_LIMPIO} ~ '${CARGO_DE_TARJETA}')
),
fijo AS (
  SELECT tenant_id, bank_account_id, cabeza, importe
    FROM base
   WHERE cabeza <> ''
   GROUP BY 1, 2, 3, 4
  HAVING count(DISTINCT date_trunc('month', fecha)) >= ${MESES_MINIMOS}
     AND count(*) <= ${MAX_CARGOS_POR_MES} * count(DISTINCT date_trunc('month', fecha))
),
variable AS (
  SELECT b.tenant_id, b.bank_account_id, b.cabeza, b.referencia
    FROM base b
   WHERE b.referencia IS NOT NULL AND b.cabeza <> ''
     AND NOT EXISTS (SELECT 1 FROM fijo f WHERE f.tenant_id = b.tenant_id AND f.bank_account_id = b.bank_account_id
                       AND f.cabeza = b.cabeza AND f.importe = b.importe)
   GROUP BY 1, 2, 3, 4
  HAVING count(DISTINCT date_trunc('month', b.fecha)) >= ${MESES_MINIMOS}
     AND count(*) <= ${MAX_CARGOS_POR_MES} * count(DISTINCT date_trunc('month', b.fecha))
),
miembros AS (
  SELECT b.*, 'fixed_amount'::text AS regla, NULL::text AS referencia_serie, b.importe AS importe_serie
    FROM base b JOIN fijo f USING (tenant_id, bank_account_id, cabeza, importe)
  UNION ALL
  SELECT b.*, 'variable_amount'::text, b.referencia, NULL::numeric
    FROM base b JOIN variable v USING (tenant_id, bank_account_id, cabeza, referencia)
   WHERE NOT EXISTS (SELECT 1 FROM fijo f WHERE f.tenant_id = b.tenant_id AND f.bank_account_id = b.bank_account_id
                       AND f.cabeza = b.cabeza AND f.importe = b.importe)
),
serie AS (
  SELECT tenant_id, bank_account_id, regla, cabeza, referencia_serie, importe_serie,
         count(DISTINCT date_trunc('month', fecha))::int AS meses,
         count(*)::int AS cargos,
         min(fecha) AS primer_cargo, max(fecha) AS ultimo_cargo,
         mode() WITHIN GROUP (ORDER BY extract(day FROM fecha)::int) AS dia_tipico,
         min(extract(day FROM fecha))::int AS dia_min, max(extract(day FROM fecha))::int AS dia_max,
         min(importe) AS importe_min, max(importe) AS importe_max,
         (array_agg(importe ORDER BY fecha DESC, id DESC))[1] AS importe_ultimo,
         (array_agg(concepto ORDER BY fecha DESC, id DESC))[1] AS concepto_reciente,
         mode() WITHIN GROUP (ORDER BY categoria) AS categoria,
         array_agg(id ORDER BY fecha, id) AS movimientos,
         array_agg(fecha ORDER BY fecha, id) AS fechas
    FROM miembros
   GROUP BY tenant_id, bank_account_id, regla, cabeza, referencia_serie, importe_serie
),
frescura AS (
  SELECT tenant_id, bank_account_id, max(movement_date) AS ultima_fecha_cuenta
    FROM finance.bank_movements
   WHERE deleted_at IS NULL
   GROUP BY 1, 2
)
SELECT s.tenant_id,
       s.regla || '|' || s.bank_account_id::text || '|' || s.cabeza || '|' ||
         coalesce(s.referencia_serie, round(s.importe_serie, 2)::text) AS series_key,
       s.regla AS rule,
       s.bank_account_id,
       s.cabeza AS concept_head,
       s.referencia_serie AS series_reference,
       s.concepto_reciente AS latest_concept,
       s.categoria AS category_code,
       s.meses AS months,
       s.cargos AS charges,
       greatest(1, round(s.cargos::numeric / s.meses))::int AS charges_per_month,
       round(s.importe_serie, 2) AS fixed_amount,
       s.importe_ultimo AS last_amount,
       s.importe_min AS min_amount,
       s.importe_max AS max_amount,
       round(coalesce(s.importe_serie, s.importe_ultimo) * greatest(1, round(s.cargos::numeric / s.meses)), 2) AS expected_monthly_amount,
       s.primer_cargo AS first_charge_date,
       s.ultimo_cargo AS last_charge_date,
       s.dia_tipico AS typical_day,
       s.dia_min AS min_day,
       s.dia_max AS max_day,
       ((date_trunc('month', s.ultimo_cargo) + interval '1 month')::date
         + (least(s.dia_tipico,
                  extract(day FROM date_trunc('month', s.ultimo_cargo) + interval '2 month' - interval '1 day')::int) - 1)) AS next_expected_date,
       fr.ultima_fecha_cuenta AS account_last_date,
       s.ultimo_cargo >= fr.ultima_fecha_cuenta - ${VIGENCIA_DIAS} AS is_active,
       s.movimientos AS movement_ids,
       s.fechas AS movement_dates
  FROM serie s
  JOIN frescura fr USING (tenant_id, bank_account_id)
`;

/** La compuerta pide los retiros de prod; con menos es una base de pruebas y se declara. */
const RETIROS_DE_PROD = 10000;
/** Pisos (medido el 2026-11-25: 47 series vigentes, $512 mil al mes, en 10 cuentas). */
const PISO_SERIES = 20;
const PISO_AL_MES = 300000;

/** El juicio de la compuerta, aparte para probarlo en rojo (regla 12). Devuelve el error, o null si pasa. */
function juzgarCompuerta(m) {
  if (!(m.vigentes >= PISO_SERIES) || !(Number(m.al_mes) >= PISO_AL_MES) || !(m.fijas_vigentes > 0) || !(m.variables_vigentes > 0) || m.repetidos > 0) {
    return `[PGP.209] ${VISTA}: ${m.vigentes} series vigentes (piso ${PISO_SERIES}), $${Math.round(Number(m.al_mes) || 0)} al mes ` +
      `(piso ${PISO_AL_MES}), ${m.fijas_vigentes} fijas, ${m.variables_vigentes} variables, ${m.repetidos} movimientos en dos series ` +
      `(medido: 47 · $512 mil · 39 · 8 · 0).`;
  }
  return null;
}

// El tenant va EXPLÍCITO: quien migra suele ser superusuario y se salta la RLS (medido en local: sin el filtro
// contaba también las series de otro tenant).
const SQL_COMPUERTA = `
  SELECT count(*) FILTER (WHERE is_active)::int AS vigentes,
         coalesce(sum(expected_monthly_amount) FILTER (WHERE is_active), 0) AS al_mes,
         count(*) FILTER (WHERE is_active AND rule = 'fixed_amount')::int AS fijas_vigentes,
         count(*) FILTER (WHERE is_active AND rule = 'variable_amount')::int AS variables_vigentes,
         (SELECT count(*)::int FROM (SELECT id FROM ${VISTA} v2, unnest(v2.movement_ids) id
                                      WHERE v2.tenant_id = '${MEGA_DULCES}' GROUP BY id HAVING count(*) > 1) d) AS repetidos
    FROM ${VISTA}
   WHERE tenant_id = '${MEGA_DULCES}'`;

exports.SELECT_SQL = SELECT_SQL;
exports.VISTA = VISTA;
exports.CARGO_DE_TARJETA = CARGO_DE_TARJETA;
exports.CABEZA_DEL_CONCEPTO = CABEZA_DEL_CONCEPTO;
exports.FUENTES = FUENTES;
exports.VENTANA_DIAS = VENTANA_DIAS;
exports.MESES_MINIMOS = MESES_MINIMOS;
exports.MAX_CARGOS_POR_MES = MAX_CARGOS_POR_MES;
exports.VIGENCIA_DIAS = VIGENCIA_DIAS;
exports.juzgarCompuerta = juzgarCompuerta;
exports.SQL_COMPUERTA = SQL_COMPUERTA;
exports.RETIROS_DE_PROD = RETIROS_DE_PROD;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} WITH (security_invoker = true) AS ${SELECT_SQL}`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    $$[PGP.209] Cargos que el banco cobra solo, propuestos por su historia (12 meses, descarga y estados subidos):
    una fila por serie. rule fixed_amount = misma cuenta, misma cabeza del concepto (3 palabras) y mismo importe al
    centavo en 3 meses o mas; variable_amount = misma cuenta, cabeza y referencia (6 digitos o mas, el credito), importe
    distinto (el esperado es el ultimo, estimado). Fuera: traspasos, mercancia, tarjeta, nomina, la comision variable de
    terminal (CB.62), mas de 3 cargos al mes, Caja General y el libro sheet. is_active = cobro en los 40 dias previos al
    ultimo movimiento de su cuenta. Es la PROPUESTA (DCR1): un contrato confirmado la sustenta. derive-no-copy.$$`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN GRANT SELECT ON ${VISTA} TO dev_ro; END IF; END $$`);

  // Compuerta: con los retiros de prod, la vista tiene que proponer las series de siempre. Una exclusión rota
  // (o la regla de 3 meses) cambia el número de series o deja un movimiento en dos.
  await knex.raw(`SET LOCAL app.tenant_id = '${MEGA_DULCES}'`);
  const [{ n }] = (await knex.raw(`
    SELECT count(*)::int AS n FROM finance.bank_movements
     WHERE tenant_id = '${MEGA_DULCES}' AND deleted_at IS NULL AND amount_out > 0 AND sync_source IN (${lista(FUENTES)})
       AND movement_date >= current_date - ${VENTANA_DIAS}`)).rows;
  if (n < RETIROS_DE_PROD) {
    console.log(`  · [PGP.209] NO MEDIDO: ${n} retiros de banco en esta base; la compuerta se exige con los de prod`);
    return;
  }
  const [m] = (await knex.raw(SQL_COMPUERTA)).rows;
  const error = juzgarCompuerta(m);
  if (error) throw new Error(error);
  console.log(`  ✓ [PGP.209] ${VISTA}: ${m.vigentes} series vigentes (${m.fijas_vigentes} fijas, ${m.variables_vigentes} variables) · ` +
    `$${Math.round(Number(m.al_mes))} al mes · 0 movimientos en dos series`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la vista es nueva y nada depende de ella todavía. */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};
