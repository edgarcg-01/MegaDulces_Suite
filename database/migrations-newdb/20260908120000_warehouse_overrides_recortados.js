'use strict';
/**
 * `[IDG.9.9]` — Los overrides `warehouse = all` dejan de ser un cheque en blanco.
 *
 * `[ID.3]` materializó como `all` explícito el acceso amplio IMPLÍCITO que la
 * convención vieja («sin sucursal = ve todas») le daba a la gente de ruta, y
 * dejó la nota «Candidato a recortar». Esta migración recorta.
 *
 * ── Por qué es seguro, medido y no supuesto ──────────────────────────────────
 * La dimensión `warehouse` tiene **6 consumidores vivos, en 3 controllers, todos
 * del proyecto Tienda**: monitor en vivo (`store.controller`), análisis semanal
 * (`store-analytics.controller`) y arqueo ciego (`store-arqueo.controller`). Se
 * midió si esta gente puede abrirlos:
 *
 *     promotor_ruta      19 · vendedor_ruta 12 · supervisor_ventas 3 · supervisor 1
 *     STORE_LIVE_VER = false · STORE_ANALYTICS_VER = false · STORE_ARQUEO_VER = false
 *     → 0 de 35 puede abrir alguna de las 3 pantallas.
 *
 * O sea que hoy el override **no concede nada** y recortarlo **no quita nada**.
 * Se hace ahora justamente porque es inerte: deja de serlo en cuanto otro
 * dominio migre a esta dimensión o alguien les dé un `STORE_*` — y con
 * `[IDG.9.6]` `promotor_ruta` ya entró al proyecto Tienda por las caducidades,
 * lo que hace más probable lo segundo.
 *
 * ── De dónde sale la sucursal ────────────────────────────────────────────────
 * De `commercial.warehouses.zone_id` (el mapeo que `[ID.23]` introdujo), en la
 * llave canónica de 2 dígitos de `[RE.23]`. Medido en prod:
 *
 *     CANINDO → 06 · LA PIEDAD RD → 01,02,03 · MORELIA ABASTOS → 30
 *     MORELIA MADERO → 32 · YURECUARO → 04 · ZAMORA → 05
 *
 * 17 personas caen en una zona de UNA sucursal y 11 en LA PIEDAD RD (tres).
 * Se les pone `listed` con lo que su zona implica: de 9 sucursales a 1 o 3.
 *
 * ── Los 7 que NO se recortan, y por qué ──────────────────────────────────────
 * Quedan en `all` con la nota cambiada: sus zonas **no tienen ninguna sucursal
 * asociada** (`LA PIEDAD VECINAL` 3 · `ZAMORA VECINAL` 3 · `OFICINAS` 1). Se
 * intentó derivarla de la plaza madre por el nombre y **no se sostiene con
 * datos**: las rutas `RVPH01` y `RVPH02` tienen **0 tiendas cargadas** (son
 * promotoras que aún no se capacitan) y las 3 de Zamora Vecinal comparten una
 * ruta con **1 tienda**. Sin hecho independiente no se inventa el valor: se
 * declara que falta. Ver `feedback_declare_missing_never_disguise_default`.
 *
 * Idempotente y derivada en tiempo de corrida, así que si mañana una de esas 3
 * zonas recibe su sucursal, una segunda pasada la recorta sola.
 *
 * @param { import("knex").Knex } knex
 */

const NOTA_RECORTE =
  '[IDG.9.9] Recortado de all a las sucursales que su zona implica ' +
  '(commercial.warehouses.zone_id). Seguro al aplicar: 0 de los 35 tenia permiso ' +
  'para las 3 pantallas que consumen esta dimension (STORE_LIVE/ANALYTICS/ARQUEO).';

const NOTA_PENDIENTE =
  '[IDG.9.9] NO recortado: su zona no tiene ninguna sucursal asociada en ' +
  'commercial.warehouses.zone_id, y la plaza madre no se pudo verificar (sus rutas ' +
  'tienen 0-1 tiendas cargadas). Falta que un humano diga de que sucursal carga.';

exports.up = async function up(knex) {
  // Un solo SELECT resuelve a quien le toca que: la zona de la persona contra el
  // mapeo zona -> sucursal, en la llave canonica de 2 digitos.
  const { rows: gente } = await knex.raw(`
    WITH zona_suc AS (
      SELECT w.tenant_id, w.zone_id,
             array_agg(DISTINCT (CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code
                                      ELSE w.wincaja_source_branch END)) AS sucs
        FROM commercial.warehouses w
       WHERE w.deleted_at IS NULL AND w.zone_id IS NOT NULL
         AND (CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code
                   ELSE w.wincaja_source_branch END) ~ '^[0-9]{2}$'
       GROUP BY w.tenant_id, w.zone_id)
    SELECT us.tenant_id, us.user_id, u.username, u.role_name,
           COALESCE(z.name, '(sin zona)') AS zona, zs.sucs
      FROM identity.user_scopes us
      JOIN identity.users u ON u.id = us.user_id AND u.tenant_id = us.tenant_id
      LEFT JOIN trade.zones z ON z.tenant_id = u.tenant_id AND z.id = u.zona_id
      LEFT JOIN zona_suc zs ON zs.tenant_id = u.tenant_id AND zs.zone_id = u.zona_id
     WHERE us.dimension = 'warehouse' AND us.mode = 'all'
       AND u.activo AND u.deleted_at IS NULL
     ORDER BY u.username`);

  if (!gente.length) {
    console.log('  No hay overrides `warehouse = all` que revisar — nada que hacer.');
    return;
  }

  let recortados = 0;
  let pendientes = 0;
  for (const g of gente) {
    if (g.sucs && g.sucs.length) {
      await knex.raw(
        `UPDATE identity.user_scopes
            SET mode = 'listed', values = ?, nota = ?, updated_at = now()
          WHERE tenant_id = ? AND user_id = ? AND dimension = 'warehouse'`,
        [g.sucs, NOTA_RECORTE, g.tenant_id, g.user_id],
      );
      console.log(
        `  ✓ ${g.username.padEnd(20)} ${g.zona.padEnd(19)} → listed [${g.sucs.join(',')}]`,
      );
      recortados++;
    } else {
      await knex.raw(
        `UPDATE identity.user_scopes SET nota = ?, updated_at = now()
          WHERE tenant_id = ? AND user_id = ? AND dimension = 'warehouse'`,
        [NOTA_PENDIENTE, g.tenant_id, g.user_id],
      );
      console.log(`  ~ ${g.username.padEnd(20)} ${g.zona.padEnd(19)} → sigue en all (zona sin sucursal)`);
      pendientes++;
    }
  }

  console.log(`\n  ${recortados} recortado(s) · ${pendientes} pendiente(s) de decision humana.`);

  // ── Gates ─────────────────────────────────────────────────────────────────
  // (a) Nadie con `listed` y la lista vacia: seria "restringido" leyendose como
  //     "no ve nada". El CHECK de la tabla ya lo rechaza; esto lo dice mas claro.
  const { rows: vacios } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.user_scopes
      WHERE dimension = 'warehouse' AND mode = 'listed'
        AND (values IS NULL OR cardinality(values) = 0)`,
  );
  if (vacios[0].n > 0) throw new Error(`${vacios[0].n} override(s) de sucursal con listed y lista vacia.`);

  // (b) Los que quedan en `all` tienen que ser exactamente los que no se pudieron
  //     resolver, y con su nota puesta. Un `all` sin motivo escrito vuelve a ser
  //     el cheque en blanco que esta migracion existe para quitar.
  const { rows: sinNota } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.user_scopes
      WHERE dimension = 'warehouse' AND mode = 'all' AND COALESCE(nota, '') NOT LIKE '[IDG.9.9]%'`,
  );
  if (sinNota[0].n > 0) throw new Error(`Quedan ${sinNota[0].n} override(s) all sin motivo declarado.`);
};

exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE identity.user_scopes
        SET mode = 'all', values = NULL, updated_at = now(),
            nota = '[IDG.9.9] revertido: vuelve al acceso amplio de [ID.3]'
      WHERE dimension = 'warehouse' AND nota LIKE '[IDG.9.9] Recortado%'`,
  );
  console.log('  Revertido: los recortes vuelven a `warehouse = all`.');
};
