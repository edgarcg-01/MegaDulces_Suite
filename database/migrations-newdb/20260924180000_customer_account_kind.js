/**
 * [CXC.25] **A quién le estás cobrando**: el resolvedor único de tipo de cuenta de cliente.
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * `/finanzas/cartera` publica **$57,780,190.86** y la balanza de contabilidad dice que los
 * clientes valen **$9,144,402.36**. No están en desacuerdo: están contando cosas distintas.
 * Medido en prod el 2026-09-24, del saldo que la pantalla muestra:
 *
 *     cliente_final .... $28,357,562.01   49.1%   1,186 cuentas
 *     interno .......... $26,583,657.82   46.0%       8 cuentas  <-- plaza contra plaza
 *     ruta .............  $2,838,971.03    4.9%      28 cuentas
 *     ───────────────────────────────────────────────────────────
 *     suma ............. $57,780,190.86  (idéntico al KPI, al centavo)
 *
 * **Ocho cuentas concentran el 46% de la cartera y ninguna es un cliente**: `30-73 TLMKT
 * Morelia Abastos`, `50-75 TLMKT Canindo Abastos`, `10-00 P.V. Padre Hidalgo Piso`… Crédito y
 * cobranza estaba mirando, en su mayoría, deuda entre plazas propias — que no se cobra por
 * teléfono. Y del lado de Kepler pasa lo mismo: de los $452M cobrados en 2026, **$392.7M
 * (86.8%) son cuentas internas** y sólo **$11.2M (2.5%) es cliente final**.
 *
 * ── LA LÓGICA NO ES NUEVA: ESTABA ENTERRADA EN UNA VISTA ─────────────────────────────────
 * `analytics.erp_collections` ya clasificaba (`tipo_cuenta`, mig `20260819220000`), pero sólo
 * para sus propias filas de cobro y sin forma de que nadie más la use. Acá sube a resolvedor,
 * que es lo que ADR-056 pide de un primitivo que sirve a más de un consumidor.
 *
 * ── EL ÁRBITRO: EL NOMBRE QUE EL PROPIO KEPLER LE PUSO ───────────────────────────────────
 * El patrón del código **no alcanza solo** (ADR-059: un árbitro que nunca contradice es un
 * espejo). Medido contra `kdud.c3` sobre las 1,222 cuentas con saldo, discrepaban 8 por
 * $1,047,338.95 — y el que tenía razón **cambiaba según el caso**:
 *
 *   · `2-32-RV01` → el código calla, el nombre dice `R.V. MORELIA MADERO 01`. Es ruta.
 *   · `RUTA 505`  → el código lo afirma, y el nombre dice `TAMPORAL`. Es ruta igual.
 *
 * De ahí la precedencia, que resuelve los 8 casos sin excepciones a mano:
 *
 *     el CÓDIGO afirma  →  el NOMBRE rescata cuando el código calla  →  'cliente_final'
 *
 * ⭐ La clave es que **`cliente_final` NO es una afirmación: es el `ELSE`**. Nadie dijo que lo
 * sea; es lo que queda cuando ninguna señal habló. Por eso no puede ganarle a una señal
 * positiva, y por eso `kind_source` viaja al lado del veredicto: `codigo` | `nombre` |
 * `ninguno`. Un `cliente_final (ninguno)` se lee distinto de un `interno (codigo)`.
 *
 * ⚠️ `disputed` marca cuando **las dos señales afirman cosas distintas**. Hoy son **0** — pero
 * la compuerta va igual: sin ella, el día que aparezcan, la precedencia elegiría en silencio.
 *
 * ⚠️ El nombre sale de `kepler_ods.kdud` **crudo**, no de `analytics.erp_customers`, que filtra
 * los `c3 ILIKE 'NO USAR%'`. Una cuenta marcada «no usar» es justamente candidata a ser interna:
 * filtrarla antes de clasificarla sería perder la señal que se viene a buscar.
 *
 * ⛔ **No cambia ningún total.** Reparte el que ya hay. El candado del smoke lo comprueba al
 * centavo: `cliente_final + interno + ruta == KPI`.
 *
 * @param { import("knex").Knex } knex
 */

// ⛔⛔ **NI UN SOLO `?` EN ESTOS REGEX.** `knex.raw()` trata el signo de interrogación como
// placeholder de binding, así que un cuantificador `\.?` dentro de una cadena llega MUTILADO a
// Postgres — y como `CREATE FUNCTION` no falla, la función queda creada y clasificando mal, en
// silencio. Pasó en esta misma migración: la compuerta de abajo la atrapó devolviendo
// `cliente_final` para `2-32-RV01`. Es la trampa de `[CV.7]` (`pgRaw`), acá con otra cara.
// Por eso `?` se escribe **`{0,1}`**, que es el mismo cuantificador y no colisiona con nada.
//
// ── El CÓDIGO. Devuelve NULL cuando no afirma nada (no 'cliente_final': eso es el ELSE) ──
// Los dos patrones son los de `analytics.erp_collections` (mig 20260819220000), verbatim salvo
// por el `?` → `{0,1}`.
const FN_CODE = `
CREATE OR REPLACE FUNCTION analytics.customer_account_kind_by_code(p_code text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE
    WHEN btrim(COALESCE(p_code, '')) = '' THEN NULL
    WHEN btrim(p_code) ~* '^(RUTA|R\\.{0,1}[DV]\\.{0,1}|R[DV][\\s\\-0-9])' THEN 'ruta'
    WHEN btrim(p_code) ~  '^\\d{2}-\\d{2}'                                THEN 'interno'
    ELSE NULL
  END
$fn$;`;

// ── El NOMBRE. Mismo contrato: afirma o calla. Los prefijos salen de los nombres REALES que
// Kepler tiene hoy (R.V./R.D./RUTA para ruta; P.V./TLMKT/BODEGA/CEDIS para interno). ──
const FN_NAME = `
CREATE OR REPLACE FUNCTION analytics.customer_account_kind_by_name(p_nombre text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE
    WHEN btrim(COALESCE(p_nombre, '')) = '' THEN NULL
    WHEN upper(btrim(p_nombre)) ~ '^(R\\.{0,1}\\s{0,1}[DV]\\.{0,1}[\\s\\-0-9]|RUTA[\\s\\-0-9]|RV[\\s\\-0-9]|RD[\\s\\-0-9])'
      THEN 'ruta'
    WHEN upper(btrim(p_nombre)) ~ '^(P\\.{0,1}\\s{0,1}V\\.{0,1}[\\s\\-]|TLMKT|TELEMARKETING|BODEGA|CEDIS)'
      THEN 'interno'
    ELSE NULL
  END
$fn$;`;

const FN_KIND = `
CREATE OR REPLACE FUNCTION analytics.customer_account_kind(p_code text, p_nombre text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT COALESCE(analytics.customer_account_kind_by_code(p_code),
                  analytics.customer_account_kind_by_name(p_nombre),
                  'cliente_final')
$fn$;`;

// Qué señal decidió. Va SIEMPRE junto al veredicto: 'cliente_final' por defecto y
// 'cliente_final' porque alguien lo afirmó serían la misma palabra con distinto respaldo.
const FN_SOURCE = `
CREATE OR REPLACE FUNCTION analytics.customer_account_kind_source(p_code text, p_nombre text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE
    WHEN analytics.customer_account_kind_by_code(p_code)   IS NOT NULL THEN 'codigo'
    WHEN analytics.customer_account_kind_by_name(p_nombre) IS NOT NULL THEN 'nombre'
    ELSE 'ninguno'
  END
$fn$;`;

// Una fila por código de cliente del catálogo de Kepler, con su veredicto Y su evidencia.
// El `DISTINCT ON` desempata a propósito —prefiere la fila CON nombre y después por nombre—
// porque un `DISTINCT ON` sin desempate devuelve lo que quiera y no se puede demostrar nada.
const VIEW = `
CREATE OR REPLACE VIEW analytics.v_customer_account_kind AS
SELECT DISTINCT ON (btrim(u.c2))
  btrim(u.c2)                                                        AS cliente_code,
  NULLIF(btrim(u.c3), '')                                            AS cliente_nombre,
  analytics.customer_account_kind(btrim(u.c2), u.c3)                 AS kind,
  analytics.customer_account_kind_source(btrim(u.c2), u.c3)          AS kind_source,
  (analytics.customer_account_kind_by_code(btrim(u.c2)) IS NOT NULL
   AND analytics.customer_account_kind_by_name(u.c3)    IS NOT NULL
   AND analytics.customer_account_kind_by_code(btrim(u.c2))
       <> analytics.customer_account_kind_by_name(u.c3))             AS disputed
FROM kepler_ods.kdud u
WHERE btrim(COALESCE(u.c2, '')) <> ''
ORDER BY btrim(u.c2), (NULLIF(btrim(u.c3), '') IS NOT NULL) DESC, btrim(u.c3);`;

exports.up = async function up(knex) {
  await knex.raw(FN_CODE);
  await knex.raw(FN_NAME);
  await knex.raw(FN_KIND);
  await knex.raw(FN_SOURCE);
  await knex.raw(VIEW);
  await knex.raw('GRANT SELECT ON analytics.v_customer_account_kind TO app_runtime');
  await knex.raw(`
    COMMENT ON VIEW analytics.v_customer_account_kind IS
      '[CXC.25] A quién le estás cobrando: cliente_final | interno | ruta, con kind_source '
      '(codigo|nombre|ninguno) y disputed. El código afirma, el nombre rescata cuando el código '
      'calla, cliente_final es el ELSE. Medido 2026-09-24 sobre la cartera: 49.1% cliente_final, '
      '46.0% interno (8 cuentas), 4.9% ruta — suma idéntica al KPI. NO cambia totales, reparte.'`);

  // ⛔ Compuerta: la precedencia tiene que resolver los casos que la motivaron. Si alguien
  // afloja un regex, esto falla ACÁ y no seis meses después en una cifra publicada.
  const casos = [
    ['2-32-RV01', 'R.V. MORELIA MADERO 01', 'ruta', 'nombre'],   // el código calla, el nombre rescata
    ['RUTA 505', 'TAMPORAL', 'ruta', 'codigo'],                  // el código afirma sobre un nombre basura
    ['30-73', 'TLMKT Morelia Abastos', 'interno', 'codigo'],
    ['C1015', 'JUAN PABLO FONSECA GUTIÉRREZ', 'cliente_final', 'ninguno'],
    ['RD 502', 'R.D. 502 CAN Daniel Padilla Rojao', 'ruta', 'codigo'],
  ];
  for (const [code, nombre, kind, src] of casos) {
    const { rows: [r] } = await knex.raw(
      'SELECT analytics.customer_account_kind(?, ?) k, analytics.customer_account_kind_source(?, ?) s',
      [code, nombre, code, nombre]);
    if (r.k !== kind || r.s !== src) {
      throw new Error(`[CXC.25] el resolvedor da ${r.k}/${r.s} para "${code}" (${nombre}) y se `
        + `esperaba ${kind}/${src}. Los 5 casos son los que MOTIVARON la precedencia — si uno `
        + 'cambia, cambió la regla, no el dato.');
    }
  }
  console.log('  OK analytics.v_customer_account_kind + 4 funciones · 5 casos de precedencia verdes.');
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_customer_account_kind');
  await knex.raw('DROP FUNCTION IF EXISTS analytics.customer_account_kind_source(text, text)');
  await knex.raw('DROP FUNCTION IF EXISTS analytics.customer_account_kind(text, text)');
  await knex.raw('DROP FUNCTION IF EXISTS analytics.customer_account_kind_by_name(text)');
  await knex.raw('DROP FUNCTION IF EXISTS analytics.customer_account_kind_by_code(text)');
};
