'use strict';
/**
 * `[VPR.5]` — **Incidente: producción rota por separar la base del código. El alias que la cierra.**
 *
 * ── Qué pasó, con nombre y apellido ─────────────────────────────────────────────────────────
 * `[VPR.2]` dejó el servicio consultando `pt.precio_erp`. `[VPR.4]` reescribió la vista con el
 * árbitro correcto y, de paso, renombró esa columna a `precio` — y **arregló el servicio en el
 * mismo commit**. Pero la migración se aplicó a **prod** el mismo día, mientras el código vivía en
 * `integra/resto-2026-10-02`, una rama **sin CI** (el workflow sólo corre en `main`).
 *
 * Resultado medido: el pod de prod sirve `f42dfad8e`, que pregunta por `pt.precio_erp`; la vista de
 * prod expone `precio`. Cualquier carga de catálogo **con sucursal** —o sea `/vendor/take-order`—
 * revienta con `column pt.precio_erp does not exist`.
 *
 * ⛔ **Y no se cura sola**: `origin/ci-green` está clavado en ese mismo `f42dfad8e`, así que
 * `auto-deploy` se niega —correctamente— a avanzar a un commit que el CI no bendijo. El arreglo no
 * podía ser "esperar el deploy".
 *
 * ── Por qué un ALIAS y no esperar a que ruede el código ─────────────────────────────────────
 * Agregar `precio_erp` como alias de `precio` hace que funcionen **las dos versiones a la vez**: la
 * desplegada y la de `main`. Es el patrón expand/contract, y es la respuesta estructural a la regla
 * que este incidente dejó escrita — *si aplicás una migración a prod, su código tiene que estar en
 * `main` el mismo día*. La otra mitad de esa regla es ésta: **un cambio de esquema que rompe al
 * código desplegado no debe existir**; se agrega lo nuevo, se deja lo viejo, y se retira después.
 *
 * ⚠️ `CREATE OR REPLACE VIEW` **sólo deja AGREGAR columnas al final** — no renombrar ni reordenar.
 * Por eso el alias va último.
 *
 * ⚠️ Y hay que RE-APLICAR `security_invoker` y el `GRANT`: no se heredan en un
 * `CREATE OR REPLACE VIEW` (lección U.7 / ADR-057, que una migración de esa fase ya perdió una vez).
 *
 * ── Deuda con fecha ─────────────────────────────────────────────────────────────────────────
 * `precio_erp` es un alias de compatibilidad, **no un nombre del dominio**: el número ya no sale de
 * `kdii.c90` sino de lo que la caja cobra, así que el nombre miente sobre su origen. Se retira
 * cuando prod sirva un commit que use `precio`, y **no antes** — retirarlo mientras el pod viejo
 * siga arriba reabre exactamente este incidente.
 */

const MV = 'analytics.mv_price_truth';
const V = 'analytics.v_price_truth';

exports.up = async function up(knex) {
  const existe = (await knex.raw(`SELECT to_regclass('${MV}') AS t`)).rows[0]?.t;
  if (!existe) {
    // Sin la matvista de `[VPR.4]` no hay nada que aliasar y el servicio degrada solo.
    return;
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW ${V} AS
    SELECT m.*,
           -- [VPR.5] ALIAS DE COMPATIBILIDAD. Lo consume el codigo desplegado hasta que ruede el
           -- commit que ya usa la columna nueva. Mismo valor, nombre viejo. Ver la cabecera.
           -- SIN ACENTOS GRAVES ACA: va dentro de un template literal de JS.
           m.precio AS precio_erp
      FROM ${MV} m
  `);

  await knex.raw(`ALTER VIEW ${V} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${V} TO app_runtime`);

  // ── Verificación: las DOS formas tienen que funcionar, que es el punto del alias ──────────
  const { rows: [v] } = await knex.raw(
    `SELECT count(*)::int con_alias FROM ${V} WHERE precio_erp IS NOT NULL`);
  const { rows: [n] } = await knex.raw(
    `SELECT count(*)::int con_nuevo FROM ${V} WHERE precio IS NOT NULL`);
  if (v.con_alias !== n.con_nuevo) {
    throw new Error(
      `[VPR.5] el alias no refleja la columna: precio_erp=${v.con_alias} vs precio=${n.con_nuevo}`);
  }
  if (!v.con_alias) throw new Error('[VPR.5] el alias quedó en cero filas: no arregla nada');

  // PRUEBA NEGATIVA del motivo por el que esto existe: la forma VIEJA tenía que estar rota antes
  // y tiene que estar sana ahora. Se comprueba que responde, no que exista en el catálogo.
  await knex.raw(`SELECT precio_erp FROM ${V} LIMIT 1`);

  const { rows: [g] } = await knex.raw(
    `SELECT has_table_privilege('app_runtime', '${V}', 'SELECT') AS ok`);
  if (!g.ok) throw new Error('[VPR.5] app_runtime perdió el SELECT al recrear la vista');
};

exports.down = async function down(knex) {
  const existe = (await knex.raw(`SELECT to_regclass('${MV}') AS t`)).rows[0]?.t;
  if (!existe) return;
  await knex.raw(`CREATE OR REPLACE VIEW ${V} AS SELECT * FROM ${MV}`);
  await knex.raw(`ALTER VIEW ${V} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${V} TO app_runtime`);
};
