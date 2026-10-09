'use strict';
/**
 * `[CP.8.1]` — **El catalogo de reglas evento -> cuenta de ContPAQi.** Es la pieza que convierte
 * un hecho de la Suite en un asiento contable. Sin esto, "comunicacion ERP/CRM con ContPAQi" es
 * un transporte sin carga.
 *
 * ── De donde salen las reglas: se DERIVARON, no se inventaron ───────────────────────────────
 * Medido el 2026-10-08 contra la contabilidad real (`ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ`,
 * 4,735 polizas de egreso del 2026), agrupando por concepto y mirando a que cuenta de
 * **resultado** cargan, pesado por importe:
 *
 *     PAGO ARRENDADORA HMS       -> 5200510002 RENTA DE BIENES MUEBLES      100.0%
 *     PAGO TRASLADO DE EFECTIVO  -> 5200680000 TRASLADO DE EFECTIVO         100.0%
 *     PAGO MANT EQ DE REPARTO    -> 5200730000 MANT. DE EQUIPO DE REPARTO    98.0%
 *     PAGO RENTA                 -> 5200510001 RENTA BIENES INMUEBLES        97.9%
 *     PAGO COMBUSTIBLE           -> 5200600000 GASOLINA Y LUBRICANTES        97.2%
 *
 * 97-100% de concentracion significa que el contador **no decide caso por caso: aplica una
 * regla**. Por eso `confianza_pct` viaja en la fila: es el respaldo medido de cada regla, y es
 * lo que el contador revisa en vez de una hoja en blanco.
 *
 * ⚠️ **La primera derivacion estuvo MAL y la correccion importa.** Ordenaba por frecuencia sin
 * filtrar familia, y corono a `1060000000 IVA ACREDITABLE` como la cuenta de casi todo concepto
 * -- porque cada poliza de gasto lleva su renglon de IVA, empata en conteo con el gasto y gana
 * por uniformidad. Estaba midiendo el impuesto, no el gasto.
 *
 * ── Lo que NO se siembra, a proposito ───────────────────────────────────────────────────────
 * ⛔ `PAGO IMSS, RCV E INFONAVIT` concentra **10.2%**: se reparte entre subcuentas por sucursal
 * (`RCV CEDIS`...). Entra como `estado='sin_regla'` con su medicion, **nunca forzado a una
 * cuenta para que cuadre** (ADR-056: lo que no se puede medir se declara).
 * ⛔ Los `PAGO FACT ...` cargan a la **subcuenta del proveedor** (`5010xxxxxx`/`5020xxxxxx`,
 * las 6,101 cuentas que CP.0 ya habia visto). Esa regla no es por concepto sino
 * **proveedor -> su subcuenta**, y se resuelve contra `analytics.contpaqi_suppliers` (3,411
 * proveedores, 99.6% con RFC) en tiempo de armado. No cabe en esta tabla y no se simula aca.
 *
 * ── Por que `cuenta_iva` es una COLUMNA y no una constante ──────────────────────────────────
 * El asiento medido tiene SIEMPRE tres renglones: cargo al gasto por el subtotal, cargo al IVA,
 * abono al banco por el total. Pero el IVA **no se calcula**: medido, `134,082.29 x 0.16` da
 * `21,453.17` y ContPAQi tiene asentado `21,453.18`; en otra poliza la diferencia son 2
 * centavos. ⭐ Viene del CFDI, no de multiplicar. El motor DEBE tomarlo de `fiscal.cfdis` -- si
 * lo calcula, la poliza no cuadra y ContPAQi la rechaza (que es justo lo que queremos que haga).
 *
 * Idempotente. RLS forzado + `tenant_id`, como el resto del schema.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const RULES = 'contpaqi.account_rules';
const EXPORTS = 'contpaqi.poliza_exports';

// categoria_code (el de `finance.movement_categories`), concepto medido, cuenta de gasto,
// nombre tal como ContPAQi la tiene, confianza medida, estado.
const SEMILLA = [
  ['renta',             'PAGO RENTA',                '5200510001', 'RENTA BIENES INMUEBLES',     97.9, 'derivada'],
  ['renta_muebles',     'PAGO ARRENDADORA HMS',      '5200510002', 'RENTA DE BIENES MUEBLES',   100.0, 'derivada'],
  ['traslado_valores',  'PAGO TRASLADO DE EFECTIVO', '5200680000', 'TRASLADO DE EFECTIVO',      100.0, 'derivada'],
  ['combustible',       'PAGO COMBUSTIBLE',          '5200600000', 'GASOLINA Y LUBRICANTES',     97.2, 'derivada'],
  ['mant_reparto',      'PAGO MANT EQ DE REPARTO',   '5200730000', 'MANT. DE EQUIPO DE REPARTO', 98.0, 'derivada'],
  // ⛔ Medida y NO resuelta. Se siembra para que se vea el hueco, no para usarla.
  ['imss_sua',          'PAGO IMSS, RCV E INFONAVIT', null,        null,                         10.2, 'sin_regla'],
];

exports.up = async function up(knex) {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS contpaqi');

  if (!(await knex.schema.withSchema('contpaqi').hasTable('account_rules'))) {
    await knex.raw(`
      CREATE TABLE ${RULES} (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        categoria_code  text NOT NULL,
        concepto_medido text,
        cuenta_gasto    text,
        cuenta_nombre   text,
        cuenta_iva      text NOT NULL DEFAULT '1060000000',
        -- Respaldo medido de la regla, 0..100. NULL = nadie la midio; NO es cero.
        confianza_pct   numeric(5,2),
        -- 'derivada'  = salio de los libros con respaldo medido
        -- 'aprobada'  = el contador la firmo
        -- 'sin_regla' = medida y NO concluyente -> el motor se NIEGA a asentar
        estado          text NOT NULL DEFAULT 'sin_regla',
        medido_en       date,
        aprobada_por    text,
        aprobada_en     timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT account_rules_estado_chk
          CHECK (estado IN ('derivada','aprobada','sin_regla')),
        -- ⭐ El freno que importa: una regla utilizable NO puede no tener cuenta. Sin esto, un
        -- NULL llega al armador, padR lo vuelve 30 espacios y ContPAQi rechaza el archivo
        -- entero -- el modo de falla que [LC.9] ya cobro una vez.
        CONSTRAINT account_rules_cuenta_chk
          CHECK (estado = 'sin_regla' OR cuenta_gasto IS NOT NULL),
        CONSTRAINT account_rules_confianza_chk
          CHECK (confianza_pct IS NULL OR (confianza_pct >= 0 AND confianza_pct <= 100))
      )`);
    await knex.raw(
      `CREATE UNIQUE INDEX account_rules_tenant_cat_uq ON ${RULES} (tenant_id, categoria_code)`);
  }

  if (!(await knex.schema.withSchema('contpaqi').hasTable('poliza_exports'))) {
    await knex.raw(`
      CREATE TABLE ${EXPORTS} (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL,
        -- ⭐ Idempotencia por EVENTO: reenviar no duplica. Es el riesgo que [LC.2] ya midio
        -- (271 CFDIs por $32.6M contabilizados sin marca, que el criterio ingenuo duplicaba).
        evento_tipo      text NOT NULL,
        evento_id        text NOT NULL,
        periodo          text NOT NULL,
        asiento          jsonb NOT NULL,
        total            numeric(16,2) NOT NULL,
        -- 'armada' -> 'entregada' (TXT bajado) -> 'aplicada' (ContPAQi la tiene) -> 'rechazada'
        estado           text NOT NULL DEFAULT 'armada',
        sink             text,
        contpaqi_folio   integer,
        contpaqi_guid    uuid,
        -- Cuadre de vuelta: NULL = NO SE VERIFICO. Distinto de false.
        verificada       boolean,
        verificada_en    timestamptz,
        motivo           text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT poliza_exports_estado_chk
          CHECK (estado IN ('armada','entregada','aplicada','rechazada')),
        CONSTRAINT poliza_exports_sink_chk
          CHECK (sink IS NULL OR sink IN ('txt','sdk'))
      )`);
    await knex.raw(
      `CREATE UNIQUE INDEX poliza_exports_evento_uq ON ${EXPORTS} (tenant_id, evento_tipo, evento_id)`);
    await knex.raw(
      `CREATE INDEX poliza_exports_periodo_idx ON ${EXPORTS} (tenant_id, periodo, estado)`);
  }

  for (const t of [RULES, EXPORTS]) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${t}`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO app_runtime`);
  }

  for (const [cat, concepto, cuenta, nombre, conf, estado] of SEMILLA) {
    await knex.raw(
      `INSERT INTO ${RULES}
         (tenant_id, categoria_code, concepto_medido, cuenta_gasto, cuenta_nombre,
          confianza_pct, estado, medido_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, DATE '2026-10-08')
       ON CONFLICT (tenant_id, categoria_code) DO NOTHING`,
      [TENANT, cat, concepto, cuenta, nombre, conf, estado]);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS ${EXPORTS}`);
  await knex.raw(`DROP TABLE IF EXISTS ${RULES}`);
};
