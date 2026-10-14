'use strict';
/**
 * ⭐⭐ `[CG.58.6]` — **Cada depósito de la caja fuerte queda atado al GRANO que su texto aguanta,
 * y ni uno más fino.**
 *
 * Edgar, 2026-10-14: *"el 38.1% hay que cazarlo por monto y fecha, hay que buscar un patron"* ·
 * *"rutas solo maneja efectivo"* · *"depositan en caos, pero en bancos no"*.
 *
 * ── Se intentó cazar por monto y NO funciona. Queda medido para que nadie lo reintente ──────
 *
 * Los 551 depósitos que SÍ declaran su fecha son un conjunto de respuestas conocidas. Se les
 * escondió la fecha y se corrió el cazador por importe contra la venta de su ruta en `[día−6, día]`:
 *
 *     tolerancia   acierta   se equivoca   ambiguo   sin candidato
 *        $10          59          5           2          485
 *        $50         155          8           6          382
 *       $200         195         28          31          297
 *
 * Aun a $200 recupera el **35 %** y ya se equivoca 28 veces. La causa estaba medida antes: en el
 * agregado el depósito de una ruta iguala su venta (105–112 %), pero **día por día no** — un
 * depósito no es un día. El calendario tampoco: la ruta 28 tiene 26 depósitos sin fecha contra
 * **31** días huérfanos (no es 1:1), y las demás rutas tienen huérfanos **negativos**, o sea
 * depósitos fechados a días que la fuente de venta ni registra.
 *
 * ── El patrón estaba en el GRANO, y ahí todo cierra ─────────────────────────────────────────
 *
 *     ruta 28, sumando sus 26 sin fecha ($414,110)   $1,281,650 vs $1,287,985   **99.5 %**
 *     Canindo, a nivel PLAZA (48 depósitos)          $3,864,610 vs $4,059,584   **95.2 %**
 *
 * ⛔ **Canindo cierra sin saber cuál de las 501–505, y así se queda.** El texto dice `rd can`;
 * elegir una ruta concreta sería inventar, y una ruta inventada le cobra el depósito a un camión
 * que no fue. El grano `plaza` es EXACTO; uno más fino sería una suposición con formato de dato.
 *
 * ⚠️ Y de paso cayó un hueco que no es de efectivo: **Morelia 321/322 deposita $1,309,180 contra
 * $349,367 vendidos (375 %)**. Ahí lo que falta no es el dinero — es la VENTA: el push no cubre
 * Morelia. El depósito está delatando una fuente de venta incompleta.
 *
 * ── Por qué TABLA y no vista ────────────────────────────────────────────────────────────────
 *
 * El grano se deriva del texto con un motor de TypeScript (`caos-deposito-grano.ts`), y una vista
 * no puede llamarlo: tendría que reimplementar el clasificador en SQL, y este repo ya tiene
 * escrito lo que cuesta eso ("el regex de ruta vivió en tres lugares con dos formas"). Se escribe
 * el VEREDICTO, no una copia del depósito: la llave al movimiento, el grano, y el texto que se
 * leyó, que es la constancia de contra qué se ató. Mismo criterio que `finance.caos_cash_links`
 * y `caos_ingreso_atribucion`, que ya viven así.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'caos_deposito_grano';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('finance').hasTable(TABLA))) {
    await knex.raw(`
      CREATE TABLE finance.${TABLA} (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,

        -- La llave del movimiento en el espejo de CAOS. No se copia el depósito: se guarda
        -- contra qué se ató.
        caos_device       text NOT NULL,
        caos_external_id  bigint NOT NULL,

        /**
         * El nivel al que el TEXTO permite atribuir. Más fino que esto sería inventar.
         *   ruta_dia  -> el texto dice la ruta y el día            (551 · $10,011,860)
         *   ruta      -> dice la ruta y NO el día                  ( 32 · $504,080)
         *   plaza     -> nombra la plaza y no cuál de sus rutas    ( 76 · $5,173,790)
         *   sin_declarar -> no dice nada, o es vecinal (otro circuito)
         */
        grano             text NOT NULL,
        ruta              text,
        plaza             text,
        business_date     date,

        /** El texto que se leyó y por qué quedó en ese grano. Es la constancia, no decoración. */
        ref_leido         text,
        motivo            text NOT NULL,
        /** Foto del importe el día que se ató, para poder auditar si el espejo cambia. */
        monto             numeric(14,2),

        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        deleted_at        timestamptz,

        CONSTRAINT cdg_grano_chk CHECK (grano IN ('ruta_dia','ruta','plaza','sin_declarar')),
        /**
         * ⛔ La coherencia del grano va en la BASE, no sólo en el motor. Sin esto, un día alguien
         * escribe una business_date en un grano "plaza" y la pantalla publica un día que nadie
         * declaró — que es exactamente el modo de falla que esta fase existe para evitar.
         */
        CONSTRAINT cdg_coherencia_chk CHECK (
          (grano = 'ruta_dia'     AND ruta IS NOT NULL AND business_date IS NOT NULL AND plaza IS NULL)
       OR (grano = 'ruta'         AND ruta IS NOT NULL AND business_date IS NULL     AND plaza IS NULL)
       OR (grano = 'plaza'        AND plaza IS NOT NULL AND ruta IS NULL             AND business_date IS NULL)
       OR (grano = 'sin_declarar' AND ruta IS NULL AND plaza IS NULL AND business_date IS NULL)
        )
      )`);
  }

  // Un depósito, un veredicto vivo.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS cdg_un_deposito
      ON finance.${TABLA} (tenant_id, caos_device, caos_external_id) WHERE deleted_at IS NULL`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS cdg_por_ruta
      ON finance.${TABLA} (tenant_id, grano, ruta) WHERE deleted_at IS NULL`);

  // Mismo molde que sus hermanas de `finance`: RLS forzado + política por tenant + grant.
  await knex.raw(`ALTER TABLE finance.${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname='finance' AND tablename='${TABLA}' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON finance.${TABLA}
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.${TABLA} TO app_runtime`);
  await knex.raw(`GRANT SELECT ON finance.${TABLA} TO dev_ro`);

  await knex.raw(`COMMENT ON TABLE finance.${TABLA} IS
    '[CG.58.6] El grano al que el texto de un deposito de CAOS permite atribuirlo. Cazar la fecha por MONTO se intento y no funciona: con 551 respuestas conocidas, a $50 acierta 155 y se equivoca 8, y 382 no tienen candidato. El patron esta en el grano: la ruta 28 con sus 26 depositos sin fecha cierra en 99.5%, y Canindo cierra en 95.2% a nivel PLAZA, sin saber cual de las 501-505 -- elegir una seria inventar.'`);

  // ── Freno: la coherencia del grano tiene que ser IMPOSIBLE de violar ──────────────────────
  //
  // ⚠️ Va dentro de un SAVEPOINT: knex corre la migración en UNA transacción y el INSERT que
  // falla a propósito la abortaría (25P02). Un `try/catch` solo NO la rescata.
  const tenant = '00000000-0000-0000-0000-00000000d01c';
  await knex.raw('SAVEPOINT prueba_negativa');
  let rechazo = false;
  try {
    await knex.raw(
      `INSERT INTO finance.${TABLA} (tenant_id, caos_device, caos_external_id, grano, plaza, business_date, motivo)
       VALUES (?::uuid, 'PRUEBA', -1, 'plaza', 'canindo', DATE '2026-10-01', 'prueba negativa')`,
      [tenant]);
  } catch {
    rechazo = true;
  }
  await knex.raw('ROLLBACK TO SAVEPOINT prueba_negativa');
  if (!rechazo) {
    throw new Error(`[CG.58.6] el CHECK de coherencia NO rechaza un grano 'plaza' con fecha — `
      + 'sin eso la pantalla puede publicar un dia que nadie declaro');
  }
  console.log('  · [CG.58.6] prueba negativa OK: un grano `plaza` con fecha es rechazado por la base');

  const { rows: [m] } = await knex.raw(`
    SELECT relrowsecurity AS rls, relforcerowsecurity AS forzado,
           has_table_privilege('app_runtime', c.oid, 'SELECT') AS lee
      FROM pg_class c WHERE c.oid = 'finance.${TABLA}'::regclass`);
  if (!m.rls || !m.forzado || !m.lee) {
    throw new Error(`[CG.58.6] RLS/grants incompletos: rls=${m.rls} forzado=${m.forzado} lee=${m.lee}`);
  }
  console.log('  · [CG.58.6] RLS forzado + grant a app_runtime verificados');
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS finance.${TABLA}`);
};
