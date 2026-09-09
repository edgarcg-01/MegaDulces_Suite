'use strict';
/**
 * `[ID.27]` — Etapa 0b del plan de la capa de usuarios: limpieza del padrón.
 *
 * Va primero por decisión del lead: reestructurar sobre datos sucios es
 * reestructurar el ruido junto con el modelo. Toca **cinco** cosas, todas
 * medidas en prod el 2026-09-09 y ninguna de ellas un cambio de modelo — el
 * modelo empieza en `[ID.28]` (Etapa 1).
 *
 * ── 1. `rvph03` dice llamarse `RVLPA01` ──────────────────────────────────────
 * El `username` y la zona coinciden entre sí (zona PH, la misma que `rvph01` y
 * `rvph02`); el `nombre` apunta a otra plaza. Dos de tres testigos concuerdan,
 * así que el que se corrige es el `nombre`.
 *
 * ── 2. Las 6 cegueras de alcance son 3 clientes B2B, y el mecanismo miente ───
 * `customer_b2b` resuelve `warehouse` y `zone` en `own`, y un cliente del portal
 * no tiene sucursal ni zona — no puede tenerlas, no es empleado. El **resultado**
 * es correcto (no ve sucursales) pero se llega por el camino equivocado: `own`
 * sin valor. Desde `[ID.26]` eso se publica como `unknown`, o sea que hoy el
 * diagnóstico del padrón reporta 6 pares irresolubles que en realidad son la
 * configuración deseada.
 *
 * Pasa a `none` **declarado**. Los dos modos emiten el mismo SQL
 * (`WHERE false`), así que **no cambia nada funcional**: deja de mentir, nada
 * más. Verificado antes de escribir: ninguno de los 3 clientes tiene
 * `warehouse_code` ni `zona_id`, así que `own` tampoco resolvía a algo hoy.
 *
 * ── 3. La cuenta `prueba` ────────────────────────────────────────────────────
 * Activa, rol `jefe_marketing` (**46 permisos concedidos**), creada el
 * 2026-06-05 y **nunca entró**. El barrido de `[IDG.5]` fue por lista de nombres
 * literales (`hacker`, `cajera_smoke`, …) y ésta no estaba.
 *
 * Se retira con **soft-delete**, no con DELETE: `status='terminated'` +
 * `terminated_at` + `deleted_at`. Tres razones:
 *   · es reversible, y una cuenta con 46 permisos no se borra a ciegas;
 *   · `identity.users.activo` NO es generada — la sincroniza el trigger
 *     `trg_sync_user_status_activo`, que ante `status<>'active'` pone
 *     `activo=false`. O sea que escribir el `status` **es** darla de baja, y de
 *     paso ejercita el camino que la Etapa 13 necesita;
 *   · **es la primera baja registrada como baja en la historia del padrón.**
 *     Hasta hoy las 126 cuentas estaban en `status='active'` y `terminated_at`
 *     tenía 0 escrituras en todo el repo.
 * ⚠️ NO se escribe `activo` a mano: lo deriva el trigger. Escribir los dos en el
 * mismo UPDATE es pedirle al shim que resuelva una contradicción.
 *
 * ── 4. `superoot` tiene 5 rutas asignadas ────────────────────────────────────
 * RUTA 21, 505, 26, 322 y 28, vigentes. Es la cuenta de plataforma, no un
 * vendedor: residuo de pruebas. Y no es inocuo — es una de las **tres** dueñas
 * de los 84 clientes de `RUTA 26`, que es el hallazgo de propiedad compartida de
 * la Etapa 9, e infla el «27 personas con marco de trabajo» de la Etapa 10.
 * ⚠️ `trade.daily_assignments.activo` **SÍ es GENERATED** (`deleted_at IS NULL`):
 * se escribe `deleted_at`, nunca `activo` — la lección de K-debt.
 *
 * ── 5. `test_tenant_b` se DECLARA fixture; NO se borra ───────────────────────
 * `test-authz-tenant-failclosed.js` busca un `role_name` duplicado entre tenants
 * para su prueba negativa, y **si no encuentra ninguno reporta `NO MEDIDO`** en
 * vez de verde. Borrar el tenant apagaría ese candado. Cambiar un dato sucio por
 * una compuerta muerta es peor negocio.
 *
 * Sus 2 roles (`checador_kiosco`, `recursos_humanos`) **se dejan a propósito**:
 * son justamente los duplicados que le dan sujeto a la prueba, y dos son mejor
 * margen que uno. Lo que faltaba no era limpiarlos: era que **nada declaraba qué
 * es este tenant**, y por eso toda migración que itera «tenants activos» le
 * escribe encima sin querer (la de `recursos_humanos` fue una de ésas, mía).
 * Queda declarado en `nombre` —donde lo ve cualquiera que mire la fila— y en
 * `metadata`, donde lo puede leer una migración antes de iterar.
 *
 * Idempotente: cada bloque sólo escribe si la condición sigue viva.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT_FIXTURE = '00000000-0000-0000-0000-00000000beef';

/** Nota que queda en `role_scopes` para que el `none` se lea como decisión. */
const NOTA_B2B =
  '[ID.27] `none` DECLARADO: un cliente del portal no es empleado y no puede ' +
  'tener sucursal ni zona. Antes era `own` sin valor, que emite el mismo ' +
  'WHERE false pero se publica como irresoluble (`unknown`) en el diagnóstico.';

exports.up = async function up(knex) {
  // ── 1. El nombre que contradice al username ────────────────────────────────
  const nombre = await knex.raw(
    `UPDATE identity.users
        SET nombre = 'RVPH03', updated_at = now()
      WHERE username = 'rvph03' AND nombre = 'RVLPA01' AND deleted_at IS NULL`,
  );
  console.log(`  1. rvph03.nombre RVLPA01 → RVPH03: ${nombre.rowCount} fila(s)`);

  // ── 2. El alcance del cliente B2B pasa a `none` declarado ─────────────────
  // Sólo las 2 dimensiones que estaban en `own` sin poder resolver. `customer`
  // se queda en `own` — ahí SÍ resuelve: es la única que un cliente tiene.
  const b2b = await knex.raw(
    `UPDATE identity.role_scopes
        SET mode = 'none', nota = ?, updated_at = now()
      WHERE role_name = 'customer_b2b'
        AND dimension IN ('warehouse', 'zone')
        AND mode = 'own'`,
    [NOTA_B2B],
  );
  console.log(`  2. customer_b2b warehouse/zone own → none: ${b2b.rowCount} fila(s)`);

  // ── 3. La cuenta de prueba, dada de baja como baja ────────────────────────
  const prueba = await knex.raw(
    `UPDATE identity.users
        SET status = 'terminated',
            terminated_at = COALESCE(terminated_at, now()),
            deleted_at    = COALESCE(deleted_at, now()),
            updated_at    = now()
      WHERE username = 'prueba' AND status <> 'terminated'`,
  );
  console.log(`  3. cuenta \`prueba\` → terminated: ${prueba.rowCount} fila(s)`);

  // ── 4. Las rutas de la cuenta de plataforma ───────────────────────────────
  const rutas = await knex.raw(
    `UPDATE trade.daily_assignments da
        SET deleted_at = now(), updated_at = now()
      WHERE da.deleted_at IS NULL
        AND da.user_id IN (SELECT id FROM identity.users WHERE username = 'superoot')`,
  );
  console.log(`  4. daily_assignments de superoot retiradas: ${rutas.rowCount} fila(s)`);

  // ── 5. El tenant de prueba, declarado ─────────────────────────────────────
  const fixture = await knex.raw(
    `UPDATE identity.tenants
        SET nombre = 'FIXTURE de pruebas — NO BORRAR (test-authz-tenant-failclosed)',
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'es_fixture', true,
              'declarado_en', '[ID.27]',
              'motivo', 'test-authz-tenant-failclosed.js necesita un role_name duplicado entre tenants para su prueba negativa; sin él reporta NO MEDIDO.',
              'invariante', 'debe quedarse en 0 usuarios',
              'excluir_de_iteraciones', true),
            updated_at = now()
      WHERE id = ? AND COALESCE(metadata->>'es_fixture', 'false') <> 'true'`,
    [TENANT_FIXTURE],
  );
  console.log(`  5. test_tenant_b declarado fixture: ${fixture.rowCount} fila(s)`);

  // ── Compuertas ─────────────────────────────────────────────────────────────
  // Cada una afirma el ESTADO resultante, no el rowCount: la migración es
  // idempotente y en la segunda corrida los rowCount son todos 0.
  const { rows } = await knex.raw(
    `SELECT
       (SELECT count(*)::int FROM identity.users
         WHERE username = 'rvph03' AND nombre = 'RVLPA01' AND deleted_at IS NULL) nombre_malo,
       (SELECT count(*)::int FROM identity.role_scopes
         WHERE role_name = 'customer_b2b' AND dimension IN ('warehouse','zone') AND mode = 'own') b2b_own,
       (SELECT count(*)::int FROM identity.users
         WHERE username = 'prueba' AND activo) prueba_activa,
       (SELECT count(*)::int FROM trade.daily_assignments da
          JOIN identity.users u ON u.id = da.user_id
         WHERE u.username = 'superoot' AND da.deleted_at IS NULL) rutas_superoot,
       (SELECT count(*)::int FROM identity.tenants
         WHERE id = ? AND metadata->>'es_fixture' = 'true') fixture_declarado,
       (SELECT count(*)::int FROM identity.users WHERE tenant_id = ?) usuarios_fixture,
       (SELECT count(DISTINCT role_name)::int FROM identity.role_permissions rp
         WHERE rp.deleted_at IS NULL
           AND rp.role_name IN (SELECT role_name FROM identity.role_permissions
                                 WHERE deleted_at IS NULL
                                 GROUP BY role_name HAVING count(DISTINCT tenant_id) > 1)) roles_duplicados`,
    [TENANT_FIXTURE, TENANT_FIXTURE],
  );
  const g = rows[0];

  const fallas = [];
  if (g.nombre_malo !== 0) fallas.push('rvph03 sigue con nombre RVLPA01');
  if (g.b2b_own !== 0) fallas.push(`${g.b2b_own} dimensión(es) de customer_b2b siguen en own`);
  if (g.prueba_activa !== 0) fallas.push('la cuenta "prueba" sigue activa');
  if (g.rutas_superoot !== 0) fallas.push(`superoot conserva ${g.rutas_superoot} ruta(s)`);
  if (g.fixture_declarado !== 1) fallas.push('test_tenant_b no quedó declarado como fixture');
  // El invariante del fixture: si alguien le mete usuarios, la prueba negativa
  // del failclosed deja de significar lo que dice significar.
  if (g.usuarios_fixture !== 0) fallas.push(`el fixture tiene ${g.usuarios_fixture} usuario(s): debe quedarse en 0`);
  // Y el que protege al candado: borrar los roles del fixture lo apagaría.
  if (g.roles_duplicados < 1) {
    fallas.push(
      'no quedó ningún role_name duplicado entre tenants: test-authz-tenant-failclosed ' +
        'perdería su sujeto y pasaría a NO MEDIDO',
    );
  }
  if (fallas.length) throw new Error(`Compuertas de [ID.27]: ${fallas.join(' · ')}`);

  console.log(
    `  ✓ padrón: nombre coherente · 0 ceguera de alcance por B2B · 1ª baja registrada como baja · ` +
      `superoot sin rutas · fixture declarado con ${g.roles_duplicados} rol(es) duplicado(s) intactos`,
  );
};

exports.down = async function down(knex) {
  // Reversible salvo el `nombre`: no se restaura `RVLPA01` porque era el dato
  // incorrecto, y volver a escribirlo re-crea la contradicción a propósito.
  await knex.raw(
    `UPDATE identity.role_scopes SET mode = 'own', updated_at = now()
      WHERE role_name = 'customer_b2b' AND dimension IN ('warehouse','zone') AND mode = 'none'`,
  );
  await knex.raw(
    `UPDATE identity.users
        SET status = 'active', terminated_at = NULL, deleted_at = NULL, updated_at = now()
      WHERE username = 'prueba'`,
  );
  console.log('  Revertido. Las rutas de superoot NO se restauran: eran residuo de pruebas.');
};
