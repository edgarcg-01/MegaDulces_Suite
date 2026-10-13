'use strict';
/**
 * `[CG.109]` — **La cuenta por entidad, DERIVADA de lo que Kepler ya contabilizó.**
 *
 * Edgar, 2026-10-13: *"quiero el 100%, nosotros pongamos las reglas en nuestro sistema al menos"*.
 *
 * ── Lo medido antes (sólo lectura, prod 2026-10-13) ─────────────────────────────────────────
 *
 * Cola: **13,303 pendientes · 357 entidades**. Tres reglas la cubren casi entera:
 *
 *     Nivel 0  póliza del documento que el pago liquida   7,413   55.7 %
 *     Ingresos regla constante (no liquidan factura)      3,700   27.8 %
 *     Gastos   cuenta dominante de la entidad (>= 80 %)     615    4.6 %
 *     ------------------------------------------------------------------
 *                                                        11,728   88.2 %
 *     sin regla                                           1,575   11.8 %
 *
 * ⭐ Y los 1,575 que faltan están CONCENTRADOS: **18 entidades acumulan 1,519 (96.4 %)**, y son
 * casi todas **cajas chicas** (`GG015` 654, `GG022` 364, `GG001` 181…) y **tarjetas de crédito**
 * (`TC2003`, `TC2009`, `TC5163`, `TC6323`). Una caja chica compra de todo — `GG015` tocó **34
 * cuentas distintas** — así que no tiene UNA cuenta de gasto, y pretender derivársela sería
 * inventar. Ésas son las que se DECLARAN, y por eso la tabla de abajo existe.
 *
 * ── ⛔ La vía que se probó primero y quedó REFUTADA (no la reconstruyas) ────────────────────
 *
 * La póliza del PAGO cubre el **98.48 %** y acierta **1 de 16** contra los movimientos que un
 * humano ya clasificó: dice `201` (se salda el pasivo) donde el humano captura el gasto
 * (`601-001` nómina, `511` mercancía). *Cobertura altísima respondiendo la pregunta equivocada.*
 * La que sirve es la de DOS saltos — pago → `kdxf` → documento liquidado → su póliza — y su
 * placebo da **12 de 13**.
 *
 * ── Por qué una matvista y una tabla, y no una sola cosa ────────────────────────────────────
 *
 * ⭐ Lo DERIVABLE se deriva (regla principal del proyecto): la cuenta dominante por entidad sale
 * de las pólizas de Kepler y no se teclea. Es matvista y no vista porque el cálculo recorre 24
 * tablas `kdc2YYMM` más `kdxf` y tarda ~2 min: a esa velocidad no se puede consultar por
 * movimiento.
 *
 * ⛔ Lo que NO es derivable se DECLARA, en su propia tabla y con motivo escrito (ADR-056). Una
 * caja chica no tiene cuenta derivable; tiene una cuenta que la empresa DECIDE. Mezclar las dos
 * en el mismo lugar borraría la diferencia entre "esto lo leímos" y "esto lo decidimos", que es
 * justo lo que la pantalla tiene que poder decirle a quien captura.
 *
 * ⚠️ Las pólizas viven partidas en 24 tablas `kdc2YYMM` (una por mes). Se descubren del catálogo
 * y NO se listan a mano: una lista fija deja de ver el mes que viene, en silencio.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  // ── 1) Lo DECLARADO: lo que no se puede derivar y la empresa decide ───────────────────────
  if (!(await knex.schema.withSchema('finance').hasTable('caja_autofill_declarada'))) {
    await knex.raw(`
      CREATE TABLE finance.caja_autofill_declarada (
        tenant_id       uuid NOT NULL,
        entidad_code    text NOT NULL,
        kepler_cuenta   text NOT NULL,
        kepler_concepto text NOT NULL,
        -- ⛔ Obligatorio y con largo minimo: una regla sin motivo es un numero que alguien puso
        -- y que nadie puede revisar despues. Es la diferencia entre declarar e inventar.
        motivo          text NOT NULL,
        declarada_por   uuid,
        declarada_por_username text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, entidad_code),
        CONSTRAINT caja_decl_motivo_chk CHECK (length(btrim(motivo)) >= 10)
      )`);
    await knex.raw(`ALTER TABLE finance.caja_autofill_declarada ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.caja_autofill_declarada FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance'
                        AND tablename='caja_autofill_declarada' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.caja_autofill_declarada
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.caja_autofill_declarada TO app_runtime`);
  }

  // ── 2) Lo DERIVADO: la cuenta dominante por entidad, leida de las polizas de Kepler ───────
  const tablas = await knex('information_schema.tables')
    .where('table_schema', 'kepler_ods').andWhereILike('table_name', 'kdc2%')
    .orderBy('table_name').pluck('table_name');
  if (!tablas.length) {
    // ⚠️ Sin el ODS de Kepler no hay nada que derivar. Se DECLARA en el log y la migracion
    // sigue: la tabla de reglas declaradas ya quedo, y es la mitad que no depende de esto.
    // eslint-disable-next-line no-console
    console.log('[CG.109] sin tablas kepler_ods.kdc2*: la matvista derivada NO se crea en este destino');
    return;
  }
  const union = tablas
    .map((t) => `select btrim(c14) suc, c17::text dt, btrim(c19) folio, btrim(c3) cuenta
       from kepler_ods.${t} where btrim(coalesce(c19,'')) <> ''`)
    .join(' union all ');

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_caja_autofill_entidad`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_caja_autofill_entidad AS
    WITH p AS (
      SELECT sucursal, doc_tipo, folio, entidad_code, tipo,
             split_part(doc_tipo, '-', 3) AS tnum
        FROM finance.v_caja_movimientos_pendientes
       WHERE entidad_code IS NOT NULL
    ),
    -- El documento que el pago liquida. 'kdxf' es el casamiento estructural D->A de Kepler.
    d AS (
      SELECT p.entidad_code, p.sucursal, p.doc_tipo, p.folio, p.tipo,
             min(f.c7::text) AS dt_dest, min(btrim(f.c9)) AS folio_dest,
             count(DISTINCT f.c7::text || '-' || btrim(f.c9))::int AS n_dest
        FROM p
        LEFT JOIN kepler_ods.kdxf f
          ON btrim(f.c1) = p.sucursal AND f.c4::text = p.tnum AND f.c5 = 1 AND btrim(f.c6) = p.folio
       GROUP BY 1,2,3,4,5
    ),
    gl AS (${union}),
    -- La cuenta de GASTO: se excluyen bancos/caja (102*,122*) y los pasivos (201,203,210-001),
    -- que son la contrapartida del pago y no su destino. Sin ese filtro todo vuelve a dar 201.
    res AS (
      SELECT d.entidad_code, d.tipo,
             count(DISTINCT g.cuenta)::int AS n_cta,
             min(g.cuenta) AS cuenta
        FROM d
        LEFT JOIN gl g
          ON g.suc = d.sucursal AND g.dt = d.dt_dest AND g.folio = d.folio_dest
         AND g.cuenta NOT LIKE '102%' AND g.cuenta NOT LIKE '122%'
         AND g.cuenta NOT IN ('201','203','210-001')
       WHERE d.n_dest = 1
       GROUP BY d.entidad_code, d.tipo, d.sucursal, d.doc_tipo, d.folio
      HAVING count(DISTINCT g.cuenta) = 1
    ),
    conteo AS (
      SELECT entidad_code, min(tipo) AS tipo, cuenta, count(*)::int AS n
        FROM res WHERE cuenta IS NOT NULL GROUP BY entidad_code, cuenta
    ),
    rank AS (
      SELECT entidad_code, tipo, cuenta, n,
             sum(n) OVER (PARTITION BY entidad_code)::int AS total,
             count(*) OVER (PARTITION BY entidad_code)::int AS cuentas_vistas,
             row_number() OVER (PARTITION BY entidad_code ORDER BY n DESC, cuenta) AS rk
        FROM conteo
    ),
    /*
     * ⭐ EL PUENTE POR NOMBRE. Kepler nombra a algunas cajas chicas en su PROPIO catalogo de
     * conceptos: el tercero 'GASTOS GENERALES CAJA CHICA MORELIA ABASTOS' tiene enfrente el
     * concepto '102 / 037 CAJA CHICA MORELIA ABASTOS.'. Cuando eso pasa no hay nada que
     * derivar ni que declarar: la cuenta esta escrita.
     *
     * ⭐ Y notese CUAL es: 102, o sea CAJA. Mandarle dinero a una caja chica NO es un gasto,
     * es un traspaso entre cajas -- el gasto ocurre despues, cuando la caja chica compra. Por
     * eso ninguna regla de "cuenta de gasto" iba a acertarle nunca.
     *
     * ⚠️ Tres frenos, y los tres hacen falta:
     *   · nombre de 12 caracteres o mas: uno corto ('CAJA') aparearia con medio catalogo;
     *   · el nombre del concepto tiene que estar CONTENIDO en el del tercero, no al reves;
     *   · UN solo candidato. Con dos, elegir seria inventar.
     * Medido: aparea 2 de las 18 entidades sin regla (GG015 y GG002) -- poco, y exacto. Las
     * otras 7 cajas chicas NO estan en el catalogo de Kepler, y por eso no se pueden derivar.
     */
    norm AS (
      SELECT DISTINCT entidad_code,
             btrim(regexp_replace(upper(translate(beneficiario,'ÁÉÍÓÚÜÑ','AEIOUUN')),'[^A-Z0-9]+',' ','g')) AS nb
        FROM finance.v_caja_movimientos_pendientes
       WHERE entidad_code IS NOT NULL AND beneficiario IS NOT NULL
    ),
    kname AS (
      SELECT DISTINCT cuenta, concepto, concepto_nombre,
             btrim(regexp_replace(upper(translate(concepto_nombre,'ÁÉÍÓÚÜÑ','AEIOUUN')),'[^A-Z0-9]+',' ','g')) AS nk
        FROM analytics.v_kepler_conceptos
       WHERE length(btrim(concepto_nombre)) >= 12
    ),
    por_nombre AS (
      SELECT n.entidad_code, min(k.cuenta) AS cuenta, min(k.concepto) AS concepto
        FROM norm n JOIN kname k ON n.nb LIKE '%' || k.nk || '%'
       GROUP BY n.entidad_code
      HAVING count(*) = 1
    )
    SELECT
      '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
      r.entidad_code, r.tipo,
      -- El nombre GANA sobre la mayoria: que Kepler nombre a esa caja chica en su catalogo es
      -- un hecho escrito; la cuenta dominante es una estadistica sobre documentos ajenos.
      coalesce(pn.cuenta, r.cuenta) AS kepler_cuenta,
      r.n                AS support,
      r.total,
      r.cuentas_vistas,
      round(r.n::numeric / NULLIF(r.total, 0), 4) AS support_ratio,
      -- El concepto SOLO si la cuenta tiene uno solo en el catalogo. Elegir entre varios seria
      -- inventar justo donde esta vista promete leer.
      coalesce(pn.concepto,
        (SELECT min(v.concepto) FROM analytics.v_kepler_conceptos v
          WHERE v.cuenta = r.cuenta
          HAVING count(DISTINCT v.concepto) = 1)) AS kepler_concepto,
      -- ⚠️ El veredicto viaja con la fila: quien la consuma no tiene que re-derivar el umbral,
      -- y la pantalla puede DECIR por que propone (ADR-056). 'catalogo' es el mas fuerte: no
      -- es una mayoria, es el nombre que Kepler le puso a esa caja en su propio catalogo.
      CASE WHEN pn.cuenta IS NOT NULL THEN 'catalogo'
           WHEN r.cuentas_vistas = 1 THEN 'unanime'
           WHEN r.n::numeric / NULLIF(r.total,0) >= 0.8 THEN 'dominante'
           ELSE 'disperso' END AS veredicto
      FROM rank r
      LEFT JOIN por_nombre pn ON pn.entidad_code = r.entidad_code
     WHERE r.rk = 1`);

  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS mv_caja_autofill_entidad_uq
                    ON analytics.mv_caja_autofill_entidad (tenant_id, entidad_code)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_caja_autofill_entidad TO app_runtime`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_caja_autofill_entidad`);
  await knex.schema.withSchema('finance').dropTableIfExists('caja_autofill_declarada');
};
