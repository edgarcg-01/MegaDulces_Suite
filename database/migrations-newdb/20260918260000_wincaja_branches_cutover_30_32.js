/**
 * `[RL.10]` `wincaja.branches` — cerrar el cutover de **Morelia Abastos (`30`)** y **Morelia
 * Madero (`32`)**: las dos migraron su PdV a Kepler y siguen marcadas `live_on_wincaja` con
 * `kepler_code = NULL`.
 *
 * ── Por qué esta columna no es decorativa ───────────────────────────────────────────────────
 * Los sensores de `db-health` derivan **las sucursales a vigilar** de `kepler_code IS NULL`. O
 * sea que mientras estas dos sigan en NULL, el tablero alarma por un `.mdb` que ya nadie escribe
 * — y una alerta que no se puede apagar **entrena al equipo a ignorar el tablero**. Es la lección
 * de Canindo, y es el paso 4 de §9.4 del runbook, que para Madero estaba pendiente desde el
 * 2026-09-07.
 *
 * ── Las fechas están MEDIDAS, no estimadas ──────────────────────────────────────────────────
 * Contra la réplica cruda de Wincaja (`wincaja.w30` / `w32` en `md`), el 2026-09-18:
 *
 *   `32` Madero  — último movimiento **2026-09-07** · Kepler `md_07` arranca el 09-08.
 *   `30` Abastos — último movimiento **2026-09-17** (651 movs) · Kepler `md_08` arranca el 09-18,
 *                  y `md_08.md.kdm1` no tiene un solo documento anterior a esa fecha.
 *
 * Y el control que hace válida la medición: los dos carriles PM2 de Wincaja llevaban **3 días
 * online con 0 reinicios**, así que "no llega nada nuevo" es un hecho y no un carril caído.
 *
 * ⚠️ **`50` Canindo queda FUERA a propósito.** También migró (a Kepler `06`) y también sigue en
 * `live_on_wincaja` / `kepler_code = NULL`, pero su `.mdb` ya salió del carril y el schema `w50`
 * no está en la réplica, así que **no se puede medir su último día**. El corte del sell-out lo
 * ubica en `< 2026-08-15`, lo cual lo sugiere pero no lo prueba. Se declara pendiente en vez de
 * escribir una fecha derivada de otra vista: esta columna alimenta sensores, y un dato inventado
 * ahí es peor que un NULL honesto.
 *
 * `warehouse_code` NO se toca (`MD-30` / `MD-32`): renombrar el `code` de un almacén con historia
 * —stock, ventas, políticas de reorden— es una decisión aparte, §9.4 punto 5.
 *
 * @param { import("knex").Knex } knex
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces

const CUTOVERS = [
  { source_branch: '30', kepler_code: '08', last_movement_date: '2026-09-17', primer_dia_kepler: '2026-09-18', nombre: 'Morelia Abastos' },
  { source_branch: '32', kepler_code: '07', last_movement_date: '2026-09-07', primer_dia_kepler: '2026-09-08', nombre: 'Morelia Madero' },
];

exports.up = async function (knex) {
  for (const c of CUTOVERS) {
    const prev = (await knex.raw(
      `SELECT kepler_code, status, last_movement_date FROM wincaja.branches
        WHERE tenant_id = ? AND source_branch = ?`, [TENANT, c.source_branch])).rows[0];

    if (!prev) {
      throw new Error(`ABORT: no existe wincaja.branches para source_branch='${c.source_branch}'. `
        + `El crosswalk se sembró en 20260713120000 — revisar antes de seguir.`);
    }
    if (prev.kepler_code === c.kepler_code && prev.status === 'legacy_on_kepler') {
      console.log(`  '${c.source_branch}' ${c.nombre} ya estaba cerrada — idempotente, skip.`);
      continue;
    }
    // Se avisa de lo que se pisa: si alguien ya había puesto OTRO kepler_code, eso es un
    // conflicto real y conviene verlo, no enterrarlo bajo el UPDATE.
    if (prev.kepler_code && prev.kepler_code !== c.kepler_code) {
      throw new Error(`ABORT: '${c.source_branch}' ya tiene kepler_code='${prev.kepler_code}' `
        + `y esta migración quiere poner '${c.kepler_code}'. Resolver a mano: dos códigos para una `
        + `sucursal rompe el sell-out por los dos lados.`);
    }

    await knex.raw(
      `UPDATE wincaja.branches
          SET kepler_code = ?, status = 'legacy_on_kepler', last_movement_date = ?::date,
              notes = coalesce(notes, '') || ?
        WHERE tenant_id = ? AND source_branch = ?`,
      [c.kepler_code, c.last_movement_date,
        ` · [RL.10 2026-09-18] cutover a Kepler '${c.kepler_code}': último día Wincaja `
        + `${c.last_movement_date}, primer día Kepler ${c.primer_dia_kepler} (medido en los dos lados).`,
        TENANT, c.source_branch]);

    console.log(`  ✓ '${c.source_branch}' ${c.nombre} → kepler_code='${c.kepler_code}', `
      + `legacy_on_kepler, último movimiento ${c.last_movement_date}`);
  }

  // Verificación en el mismo momento: las dos cerradas, y se DECLARA lo que queda abierto.
  const abiertas = (await knex.raw(
    `SELECT source_branch, branch_name FROM wincaja.branches
      WHERE tenant_id = ? AND kepler_code IS NULL ORDER BY source_branch`, [TENANT])).rows;
  for (const c of CUTOVERS) {
    if (abiertas.some((a) => a.source_branch === c.source_branch)) {
      throw new Error(`ABORT: '${c.source_branch}' sigue con kepler_code NULL tras el UPDATE.`);
    }
  }
  console.log(`  sucursales que SIGUEN sin kepler_code (los sensores las vigilan): `
    + `${abiertas.map((a) => `${a.source_branch} ${a.branch_name}`).join(' · ') || '(ninguna)'}`);
};

exports.down = async function (knex) {
  for (const c of CUTOVERS) {
    await knex.raw(
      `UPDATE wincaja.branches
          SET kepler_code = NULL, status = 'live_on_wincaja', last_movement_date = NULL
        WHERE tenant_id = ? AND source_branch = ? AND kepler_code = ?`,
      [TENANT, c.source_branch, c.kepler_code]);
  }
};
