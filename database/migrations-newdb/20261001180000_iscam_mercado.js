'use strict';
/**
 * `[PR.M1]` — **ISCAM: la posición de mercado entra al motor de margen.**
 *
 * ── Por que una TABLA, con la regla principal diciendo "cero importers" ────────────────────
 * La regla pide que todo dato salga del ODS por una vista `derive-no-copy`, y reserva la tabla
 * real para **datos propios o historico/snapshots**. ISCAM es lo segundo y no admite lo primero:
 * es una **medicion de un tercero** que llega en un archivo, una vez por mes. No existe en
 * `kepler_ods` ni puede existir: mide el mercado, no nuestras operaciones. Derivarla es
 * imposible; inventarla, prohibido. Entra como snapshot, con la fecha de entrega en la llave.
 *
 * ⛔ Y por eso la carga es un **CLI explicito**, no un feed agendado: el archivo llega por correo
 *    una vez al mes y lo sube una persona. Un cron que lea una carpeta que puede estar vacia
 *    publicaria el mes anterior como si fuera el actual.
 *
 * ── Que entra ──────────────────────────────────────────────────────────────────────────────
 * Dos cosas distintas, en dos tablas, porque tienen grano y vida distintos:
 *
 *  1. `analytics.iscam_market` — la medicion. Una fila por
 *     (periodo, region, subcanal, mercado, division, categoria, tipo_medida) con **las cuatro
 *     medidas crudas** que ISCAM entrega: lo nuestro y lo del mercado, en el periodo actual y en
 *     el anterior. ⭐ **Nada derivado se guarda**: share, crecimiento y delta salen de la vista.
 *     Un share guardado envejece distinto que sus insumos y empieza a mentir solo.
 *
 *  2. `analytics.iscam_taxonomy` — el **puente**: codigo de barras → segmento/categoria/marca.
 *     Es lo que permite que una pantalla que trabaja por SKU alcance un numero que ISCAM publica
 *     por categoria. Medido el 2026-10-01: **3,898 codigos**, que cubren **36.1 % de la venta de
 *     90 dias** ($40.98M de $113.51M).
 *     ⭐ De paso trae la **marca de consumo** ("DE LA ROSA", "MENTOS"), que nuestro catalogo no
 *     tiene: `catalog.brands` guarda la **razon social del proveedor** ("DISTRIBUIDORA DE LA ROSA
 *     SA DE CV", y hasta "BOLSAS DE LOS ALTOS", que ni dulce es).
 *
 * ── ⚠️⚠️ La advertencia que viaja CON el dato, no en un correo ─────────────────────────────
 * A ISCAM se le trasladan **todos los movimientos de salida**, traspasos entre sucursales
 * incluidos (deuda tecnica de Wincaja). O sea que **nuestro numerador esta inflado**: medido, la
 * brecha contra `analytics.sales_daily` es de **$19.5M a $21.6M por mes**, estable en cinco meses,
 * equivalente al **22-29 %** de los traspasos del periodo.
 *
 * ⛔ Si esa distorsion fuera **solo nuestra**, el share de Region III no es 5.79 % sino **~3.76 %**.
 *    Si los demas mayoristas del panel cargan la misma deuda, el share esta bien.
 *    **Cual de las dos es NO se puede saber desde el archivo**, asi que la vista lo publica en una
 *    columna: `numerador_inflado_por_traspasos = true`. No se corrige a mano y no se esconde.
 *
 * ── Lo que NO entra, y por que ─────────────────────────────────────────────────────────────
 * ⛔ `PcioDisp`. Parece un precio y no lo es: su formula, leida del propio archivo, es
 *    **`Val / Vol / 24`** — un divisor **fijo de 24 para todo el catalogo**. Para un producto que
 *    viene de 12 o de 30 el numero esta mal. Es la misma trampa de la escalera de unidades que
 *    este proyecto ya pago dos veces. No se importa.
 */

const T_MKT = 'analytics.iscam_market';
const T_TAX = 'analytics.iscam_taxonomy';

exports.up = async function up(knex) {
  await knex.raw("SET LOCAL lock_timeout = '10s'");

  // ── 1 · La medicion ──────────────────────────────────────────────────────────────────
  const hayMkt = (await knex.raw(`SELECT to_regclass('${T_MKT}') IS NOT NULL AS hay`)).rows[0].hay;
  if (!hayMkt) {
    await knex.raw(`
      CREATE TABLE ${T_MKT} (
        tenant_id     uuid        NOT NULL,
        periodo       date        NOT NULL,
        region        text        NOT NULL,
        subcanal      text        NOT NULL,
        mercado       text        NOT NULL,
        division      text        NOT NULL,
        categoria     text        NOT NULL,
        tipo_medida   text        NOT NULL,
        med_act_mayo  numeric(18,4) NOT NULL,
        med_act_mdo   numeric(18,4) NOT NULL,
        med_ant_mayo  numeric(18,4) NOT NULL,
        med_ant_mdo   numeric(18,4) NOT NULL,
        entrega       text        NOT NULL,
        importado_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT iscam_market_pk
          PRIMARY KEY (tenant_id, periodo, region, subcanal, mercado, division, categoria, tipo_medida),
        CONSTRAINT iscam_medida_valida CHECK (tipo_medida IN ('valor','volumen')),
        -- El mercado no puede ser menor que nuestra parte de el: si pasa, la entrega vino mal.
        CONSTRAINT iscam_mdo_contiene_mayo CHECK (med_act_mdo >= med_act_mayo),
        CONSTRAINT iscam_ant_contiene_mayo CHECK (med_ant_mdo >= med_ant_mayo)
      )`);
    await knex.raw(`CREATE INDEX iscam_market_cat_idx ON ${T_MKT} (division, categoria, periodo DESC)`);
    await knex.raw(`ALTER TABLE ${T_MKT} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${T_MKT} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY iscam_market_tenant ON ${T_MKT}
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${T_MKT} TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE ${T_MKT} IS
      'ISCAM: medicion mensual de mercado (externa, snapshot). Las cuatro medidas CRUDAS; share y crecimiento se derivan en analytics.v_iscam_share. [PR.M1]'`);
    await knex.raw(`COMMENT ON COLUMN ${T_MKT}.med_act_mayo IS
      'Nuestra medida. ADVERTENCIA: incluye traspasos entre sucursales (deuda tecnica de Wincaja). Ver v_iscam_share.numerador_inflado_por_traspasos.'`);
  }

  // ── 2 · El puente al SKU ─────────────────────────────────────────────────────────────
  const hayTax = (await knex.raw(`SELECT to_regclass('${T_TAX}') IS NOT NULL AS hay`)).rows[0].hay;
  if (!hayTax) {
    await knex.raw(`
      CREATE TABLE ${T_TAX} (
        tenant_id     uuid NOT NULL,
        barcode       text NOT NULL,
        barcode_norm  text GENERATED ALWAYS AS (ltrim(barcode, '0')) STORED,
        segmento      text NOT NULL,
        categoria     text NOT NULL,
        subcategoria  text,
        marca         text,
        fabricante    text,
        entrega       text NOT NULL,
        importado_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT iscam_taxonomy_pk PRIMARY KEY (tenant_id, barcode)
      )`);
    // ⭐ El join se hace por el codigo SIN ceros a la izquierda: ISCAM los trae y nuestro
    //   catalogo a veces no. Con el codigo crudo se perderia un tercio de las coincidencias.
    await knex.raw(`CREATE INDEX iscam_tax_norm_idx ON ${T_TAX} (barcode_norm)`);
    await knex.raw(`ALTER TABLE ${T_TAX} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${T_TAX} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY iscam_tax_tenant ON ${T_TAX}
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${T_TAX} TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE ${T_TAX} IS
      'ISCAM: puente codigo de barras -> segmento/categoria/marca. Es lo que deja que una pantalla por SKU alcance un share publicado por categoria. Trae ademas la MARCA DE CONSUMO, que catalog.brands no tiene (ahi vive la razon social del proveedor). [PR.M1]'`);
  }

  // ── 3 · La vista: todo lo derivado, y la advertencia como COLUMNA ────────────────────
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_iscam_share
    WITH (security_invoker = true) AS
    SELECT
      m.tenant_id, m.periodo, m.region, m.subcanal, m.mercado, m.division, m.categoria,
      m.tipo_medida,
      m.med_act_mayo AS nuestro,
      m.med_act_mdo  AS mercado_total,
      CASE WHEN m.med_act_mdo > 0
           THEN round(100.0 * m.med_act_mayo / m.med_act_mdo, 2) END AS share_pct,
      CASE WHEN m.med_act_mdo > 0 AND m.med_ant_mdo > 0
           THEN round(100.0 * m.med_act_mayo / m.med_act_mdo
                    - 100.0 * m.med_ant_mayo / m.med_ant_mdo, 2) END AS share_delta_pp,
      CASE WHEN m.med_ant_mayo > 0
           THEN round(100.0 * (m.med_act_mayo / m.med_ant_mayo - 1), 1) END AS crec_nuestro_pct,
      CASE WHEN m.med_ant_mdo > 0
           THEN round(100.0 * (m.med_act_mdo / m.med_ant_mdo - 1), 1) END AS crec_mercado_pct,
      -- ⭐ El mercado SIN nosotros: lo que hizo la competencia sola. Es la cifra que dice si el
      --   terreno que perdemos se lo esta llevando alguien, o si la categoria entera se cae.
      CASE WHEN (m.med_ant_mdo - m.med_ant_mayo) > 0
           THEN round(100.0 * ((m.med_act_mdo - m.med_act_mayo)
                             / (m.med_ant_mdo - m.med_ant_mayo) - 1), 1) END AS crec_competencia_pct,
      -- ⛔ La advertencia viaja CON el dato. No se corrige y no se esconde.
      true AS numerador_inflado_por_traspasos,
      'a ISCAM se le trasladan todas las salidas, traspasos entre sucursales incluidos (deuda '
      || 'tecnica de Wincaja). La brecha medida contra analytics.sales_daily es de $19.5M a '
      || '$21.6M por mes, estable en cinco meses. Si la distorsion fuera SOLO nuestra, el share '
      || 'de Region III seria ~3.76% y no 5.79%; si los demas mayoristas del panel cargan la '
      || 'misma deuda, el share esta bien. Cual de las dos es NO se puede saber desde el archivo.'
        AS advertencia,
      m.entrega, m.importado_at
    FROM ${T_MKT} m`);
  await knex.raw(`GRANT SELECT ON analytics.v_iscam_share TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_iscam_share IS
    'Share, delta de share y crecimiento (nuestro, del mercado y de la competencia sola), derivados de las cuatro medidas crudas de ISCAM. Nada de esto se guarda: un share guardado envejece distinto que sus insumos. [PR.M1]'`);

  // eslint-disable-next-line no-console
  console.log('[PR.M1] iscam_market + iscam_taxonomy + v_iscam_share listas.');
};

exports.down = async function down(knex) {
  await knex.raw("SET LOCAL lock_timeout = '10s'");
  await knex.raw('DROP VIEW IF EXISTS analytics.v_iscam_share');
  await knex.raw(`DROP TABLE IF EXISTS ${T_TAX}`);
  await knex.raw(`DROP TABLE IF EXISTS ${T_MKT}`);
};
