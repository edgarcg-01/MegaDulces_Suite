'use strict';
/**
 * `[CP.8.20]` — **El mapa proveedor → cuenta, derivado de la contabilidad y no del nombre.**
 *
 * ── El problema ─────────────────────────────────────────────────────────────────────────────
 * `[CP.8.19]` dejó `compra_mercancia` como `tipo_regla = 'por_proveedor'` con
 * `cuenta_prefijo = '2120'`: la cuenta de cargo la decide el PROVEEDOR, no la categoría. Falta
 * resolver, para cada proveedor, **cuál** de las 1,015 cuentas `2120*` es la suya.
 *
 * ⛔ **ContPAQi no lo guarda.** `Proveedores.IdCuenta` / `.CodigoCuenta` están poblados en
 * **1 de 3,426** filas; `Personas.CtaContableGasto` en **0 de 5,676**; y `MovimientosPoliza` no
 * tiene columna de persona — **la identidad del proveedor ES la cuenta**. Hay que derivarlo.
 *
 * ── Dos derivaciones INDEPENDIENTES, y por eso se cruzan ────────────────────────────────────
 * Verificar una vista contra sí misma pasa bugs en verde; lo que los encuentra es comparar dos
 * implementaciones. Medido el 2026-10-09 sobre las **147 cuentas `2120*` usadas en 2026**
 * ($304,207,944.28):
 *
 * | vía | cuentas | % del importe |
 * |---|--:|--:|
 * | **A** — nombre de cuenta ≈ nombre de proveedor (normalizado) | 125 | 89.4 % |
 * | **B** — ⭐ **UUID del CFDI** que ContPAQi asoció al renglón (`AsocCFDIs`) → RFC del emisor | **146** | **100 %** |
 * | unión | 146 | 100 % |
 *
 * ⭐ **B domina a A**: no hay **ni una** cuenta que el nombre resuelva y el UUID no. Y es
 * estructural — ContPAQi mismo ató ese CFDI a ese renglón; no hay que adivinar grafías.
 *
 * ⛔ **Por qué el nombre NO puede ser la llave**, medido: la cuenta
 * `SOCIEDAD COOPERATIVA TRABAJADORES PASCUAL` sólo tiene candidato en el proveedor
 * `PASCUAL ALEJANDRO GONZALEZ LOPEZ` — **una persona física distinta**. Normalizar más agresivo
 * sube la cobertura **y empieza a emparejar cosas distintas**. Por eso el nombre queda como
 * **testigo corroborante**, nunca como resolvedor único.
 *
 * ── ⭐⭐ Lo que el cruce encontró, y que ninguna de las dos vías sola habría visto ──────────
 * De 125 cuentas donde opinan las dos, **124 coinciden y 1 discrepa**: la cuenta
 * `2120000366 CANAP BOLSAS` tiene asociado un CFDI de **ABARROTES LA VIOLETA** por **$44,272.35**
 * — y La Violeta **tiene su propia cuenta** (`2120000336`). Es un **error de captura**, no un
 * empate dudoso.
 *
 * ⚠️ Y la lección de umbral que salió de ahí: esa cuenta tenía **pureza 100 % sobre UN voto**.
 * *Pureza perfecta sobre n=1 no es certeza.* Medida la distribución: **36 de 183 cuentas (20 %)
 * se apoyan en una sola asociación** — exactamente la franja donde vivía el falso positivo. Por
 * eso el veredicto pesa **votos**, no sólo pureza.
 *
 * ── La escalera de veredictos ───────────────────────────────────────────────────────────────
 *  · `confirmado`    — nombre y UUID coinciden: **dos testigos independientes**
 *  · `uuid_solido`   — sólo UUID, n≥3 y pureza≥90 %
 *  · `uuid_debil`    — sólo UUID con n<3: se DECLARA, no alcanza para asentar
 *  · `en_disputa`    — nombre y UUID discrepan: va a bandeja, **jamás se elige uno**
 *  · `solo_nombre`   — sólo el nombre opina
 *  · `sin_proveedor` — ninguna vía (medido: 1 cuenta, `NUEVA WALMART`, $96,980)
 *
 * ⛔ **Esta migración crea las tablas vacías.** Las llena `import-contpaqi-account-map.js`, que
 * es READ-ONLY sobre ContPAQi (ADR-040 intacto: no escribimos en su base).
 *
 * Idempotente. RLS forzado, como el resto del schema.
 *
 * @param { import("knex").Knex } knex
 */

const ACCOUNTS = 'analytics.contpaqi_accounts';
const MAP = 'contpaqi.supplier_accounts';

exports.up = async function up(knex) {
  // ── El catálogo de cuentas ────────────────────────────────────────────────────────────────
  // Hoy `Cuentas` (8,811) sólo existe como JOIN dentro de `import-contpaqi-polizas.js`: no hay
  // forma de preguntarle nada sin abrir SQL Server. Sin esto, el mapa no se puede auditar.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ${ACCOUNTS} (
      tenant_id      uuid NOT NULL,
      codigo         text NOT NULL,
      nombre         text,
      tipo           text,
      es_baja        boolean,
      afectable      integer,
      agrupador_sat  text,
      computed_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, codigo)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS contpaqi_accounts_codigo_idx ON ${ACCOUNTS} (tenant_id, codigo text_pattern_ops)`);

  // ── El mapa resuelto, con su veredicto ────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ${MAP} (
      id                uuid NOT NULL DEFAULT gen_random_uuid(),
      tenant_id         uuid NOT NULL,
      cuenta            text NOT NULL,
      cuenta_nombre     text,
      rfc               text,
      proveedor_codigo  text,
      proveedor_nombre  text,
      rfc_por_nombre    text,
      rfc_por_uuid      text,
      votos             integer NOT NULL DEFAULT 0,
      pureza_pct        numeric(5,2),
      veredicto         text NOT NULL,
      motivo            text,
      medido_en         date,
      computed_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, cuenta),
      CONSTRAINT supplier_accounts_veredicto_chk CHECK (veredicto IN (
        'confirmado','uuid_solido','uuid_debil','en_disputa','solo_nombre','sin_proveedor')),
      -- ⛔ Un veredicto utilizable DEBE traer RFC. Sin esto una fila podria decir
      -- "confirmado" con rfc NULL y el armador la leeria como buena.
      CONSTRAINT supplier_accounts_rfc_chk CHECK (
        veredicto IN ('en_disputa','sin_proveedor') OR rfc IS NOT NULL),
      -- ⭐ uuid_solido exige los votos que lo hacen solido: 3. El umbral NO es redondo por
      -- gusto -- 36 de 183 cuentas (20%) se apoyan en UN voto, y ahi vivia el unico falso
      -- positivo medido (CANAP BOLSAS / ABARROTES LA VIOLETA, $44,272.35).
      CONSTRAINT supplier_accounts_solido_chk CHECK (
        veredicto <> 'uuid_solido' OR (votos >= 3 AND pureza_pct >= 90))
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS supplier_accounts_rfc_idx ON ${MAP} (tenant_id, rfc)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS supplier_accounts_veredicto_idx ON ${MAP} (tenant_id, veredicto)`);

  for (const t of [ACCOUNTS, MAP]) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    const pol = `${t.split('.')[1]}_tenant_pol`;
    await knex.raw(`DROP POLICY IF EXISTS ${pol} ON ${t}`);
    await knex.raw(`
      CREATE POLICY ${pol} ON ${t}
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id())`);
    await knex.raw(`GRANT SELECT ON ${t} TO app_runtime`);
    await knex.raw(`GRANT INSERT, UPDATE, DELETE ON ${t} TO app_runtime`);
  }

  // `dev_ro` se olvidó en `[CP.8.1]` y el sintoma engaña: `information_schema` devuelve VACIO,
  // no un error de permisos. Se incluye desde el principio esta vez.
  for (const rol of ['dev_ro']) {
    const existe = await knex.raw('SELECT 1 FROM pg_roles WHERE rolname = ?', [rol]);
    if (existe.rows.length) {
      await knex.raw(`GRANT USAGE ON SCHEMA analytics, contpaqi TO ${rol}`);
      await knex.raw(`GRANT SELECT ON ${ACCOUNTS}, ${MAP} TO ${rol}`);
    }
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS ${MAP}`);
  await knex.raw(`DROP TABLE IF EXISTS ${ACCOUNTS}`);
};
