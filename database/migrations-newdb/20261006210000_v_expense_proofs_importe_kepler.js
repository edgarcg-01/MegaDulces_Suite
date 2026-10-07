/**
 * `[GX.69]` El importe del vale de gasto se LEE de Kepler, no se copia.
 *
 * Regla del usuario (2026-10-06): **el importe del vale es el «Saldo» del GASTO en Kepler**
 * (`X-A-10`, `kdm1.c42`), tal cual — sin sumar impuestos, sin recalcular, sin el importe
 * contable que `analytics.expense_documents` pone encima (de ahí salía un $192.28 que era sólo
 * el IVA del folio 0010102, cuyo gasto en Kepler dice $1,394.00).
 *
 * Medido en prod antes de escribir esto:
 *  · en el gasto, Saldo = Importe (`c42 = c16`) en **2,636 de 2,636** documentos desde agosto;
 *  · en la SOLICITUD (`X-A-15`) no: ahí el saldo es lo que FALTA por aplicar (0008489: $113.02);
 *  · gastos cancelados (`c43='C'`, 337) quedan en $0 → no cuentan;
 *  · una solicitud puede tener VARIOS gastos (142 casos) → se suman sus saldos;
 *  · el vale nace antes que el gasto (74 vales hoy sin gasto) → mientras no exista, el importe
 *    es el de la solicitud de Kepler (`c16`), y si ni ésa aparece, lo capturado.
 *
 * Por qué una VISTA y no un UPDATE agendado: la regla principal del proyecto (cero importers,
 * derivar del ODS). Con la vista el número se mueve solo cuando Kepler cambia, sin cron.
 * Costo medido: los 238 vales en 18–30 ms (índices `idx_kdm1_xa_chain` e `idx_kdm1_xa_doc`).
 *
 * Columnas: las de `finance.expense_proofs`, con `importe` sustituido por el vivo, más
 * `importe_capturado` (lo que quedó grabado), `importe_fuente` (`gasto_kepler` ·
 * `solicitud_kepler` · `capturado`) e `importe_gastos` (cuántos gastos vivos lo forman).
 * ⚠️ La lista se toma de la tabla AL APLICAR: si una migración futura agrega una columna a
 * `expense_proofs`, tiene que re-crear esta vista (re-correr este `up`). El servicio lee de la
 * vista y escribe en la tabla.
 *
 * `security_invoker`: la RLS de `expense_proofs` se aplica a quien consulta.
 *
 * @param { import("knex").Knex } knex
 */
const VISTA = 'finance.v_expense_proofs';

async function crear(knex) {
  const { rows } = await knex.raw(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'finance' AND table_name = 'expense_proofs'
     ORDER BY ordinal_position`);
  const cols = rows.map((r) => r.column_name);
  if (!cols.includes('importe')) throw new Error('finance.expense_proofs sin columna importe');
  const lista = cols.map((c) => (c === 'importe'
    ? `COALESCE(g.saldo, s.importe, p.importe) AS importe`
    : `p.${JSON.stringify(c)}`)).join(',\n           ');

  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
  await knex.raw(`
    CREATE VIEW ${VISTA} WITH (security_invoker = true) AS
    SELECT ${lista},
           p.importe AS importe_capturado,
           CASE WHEN g.saldo IS NOT NULL THEN 'gasto_kepler'
                WHEN s.importe IS NOT NULL THEN 'solicitud_kepler'
                ELSE 'capturado' END AS importe_fuente,
           g.n_gastos AS importe_gastos
      FROM finance.expense_proofs p
      LEFT JOIN LATERAL (
        SELECT sum(round(COALESCE(NULLIF(regexp_replace(d.c42::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2)) AS saldo,
               count(*)::int AS n_gastos
          FROM kepler_ods.kdm1 d
         WHERE d.c2 = 'X' AND d.c3 = 'A'
           AND d.sucursal = btrim(p.sucursal)
           AND btrim(d.c39) = p.folio_solicitud
           AND btrim(d.c4::text) = '10' AND btrim(d.c5::text) = '1'
           AND btrim(d.c1) = d.sucursal
           AND COALESCE(btrim(d.c43), '') <> 'C'
        HAVING count(*) > 0) g ON p.folio_solicitud IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT round(COALESCE(NULLIF(regexp_replace(r.c16::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2) AS importe
          FROM kepler_ods.kdm1 r
         WHERE r.c2 = 'X' AND r.c3 = 'A'
           AND r.sucursal = btrim(p.sucursal)
           AND btrim(r.c4::text) = '15' AND btrim(r.c5::text) = '1'
           AND btrim(r.c1) = r.sucursal
           AND btrim(r.c6) = p.folio_solicitud
         LIMIT 1) s ON p.folio_solicitud IS NOT NULL`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    'GX.69: el vale de gasto con importe = Saldo del gasto Kepler (X-A-10 c42), o la solicitud (X-A-15 c16) si aún no hay gasto. Leer de aquí, escribir en finance.expense_proofs.'`);
}

exports.up = async function (knex) {
  const t = await knex.raw(`SELECT to_regclass('finance.expense_proofs') p, to_regclass('kepler_ods.kdm1') k`);
  if (!t.rows[0]?.p || !t.rows[0]?.k) return; // entorno sin el módulo o sin ODS
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await crear(knex);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA}`);
};

