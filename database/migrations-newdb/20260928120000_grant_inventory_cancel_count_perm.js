'use strict';
/**
 * `[WMS-REC.16]` — Reparte `COMMERCIAL_INVENTORY_CANCELAR_CONTEO`, la llave que separa
 * **abandonar** un folio de inventario físico de **aplicarlo**.
 *
 * ── El incidente que la obliga ───────────────────────────────────────────────────────────────
 * Medido en producción el 2026-09-28: el folio `INV-2026-00009` llevaba **100 días** con
 * `freeze_movements = true` sobre Padre Hidalgo, con **3 artículos contados de 2,094** y el
 * último escaneo hacía **67 días**. Mientras tanto, cada intento de fechar mercancía en esa
 * sucursal se guardaba y se revertía: **10 capturas**, todas del almacén 01.
 *
 * Por qué nadie lo destrabó: cancelar y reconciliar colgaban de la MISMA llave
 * (`COMMERCIAL_INVENTORY_RECONCILIAR`), o sea que la acción **segura** (cancelar: no toca una
 * sola pieza de existencia) estaba encerrada detrás de la **peligrosa** (reconciliar: ajusta el
 * saldo al físico contado — con 3 de 2,094 habría puesto el inventario de la sucursal casi en
 * cero). Medido el mismo día:
 *
 *     rol            RECONCILIAR   RECIBIR (entra al Andén)   usuarios
 *     almacenista    false         true                       4
 *     supervisor     true          true                       1
 *
 * **4 de las 5 personas que entran al Andén no podían destrabarse**, y la única asignada a
 * Padre Hidalgo (`luis_espino`) era una de ellas.
 *
 * ── El alcance se DERIVA del estado vivo ─────────────────────────────────────────────────────
 *   · quien ya reconcilia  (`COMMERCIAL_INVENTORY_RECONCILIAR`) — no pierde nada, la gana explícita
 *   · quien recibe mercancía (`COMMERCIAL_INVENTORY_RECIBIR`)   — es a quien el congelamiento frena
 *
 * ⚠️ Repartirla al del Andén es seguro **por el freno que la acompaña**, no por confianza: el
 * servicio sólo deja cancelar a quien NO tiene `RECONCILIAR` cuando el folio lleva 7 días sin un
 * solo escaneo (`InventoryCountService.DIAS_ABANDONADO`). O sea que puede tirar un conteo que
 * nadie toca, y NO puede tirar el trabajo de un equipo que está contando ahora. Si ese freno se
 * quita, esta repartición deja de ser segura — van juntos.
 *
 * ── Idempotente ──────────────────────────────────────────────────────────────────────────────
 * `permissions -> 'KEY' IS NULL` = "nunca se tocó". ⚠️ Un `false` NO se pisa: `/admin/roles`
 * guarda el JSONB completo, así que toda clave nueva del enum aterriza en `false` en cualquier
 * rol que alguien salve después del deploy. Se declara en el log en vez de forzarlo en silencio.
 *
 * Los permisos viajan en el JWT → los afectados deben **RE-LOGUEAR** para ver el botón. El
 * backend los honra antes, porque `RolesGuard` lee el mapa fresco de la DB.
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'COMMERCIAL_INVENTORY_CANCELAR_CONTEO';
const ORIGEN = ['COMMERCIAL_INVENTORY_RECONCILIAR', 'COMMERCIAL_INVENTORY_RECIBIR'];

/** Roles de baja: no se les suma nada. */
const EXCLUIDOS_LIKE = 'retirado%';

exports.up = async function up(knex) {
  const { rows: destino } = await knex.raw(
    `SELECT rp.role_name, rp.permissions -> ?::text AS ya
       FROM identity.role_permissions rp
      WHERE rp.deleted_at IS NULL
        AND rp.role_name NOT LIKE ?
        AND (rp.permissions -> ?::text = 'true'::jsonb OR rp.permissions -> ?::text = 'true'::jsonb)
      ORDER BY rp.role_name`,
    [CLAVE, EXCLUIDOS_LIKE, ORIGEN[0], ORIGEN[1]],
  );

  if (!destino.length) {
    throw new Error(
      `Ningun rol concede ${ORIGEN.join(' ni ')}: no hay de donde derivar el alcance de ${CLAVE}. ` +
      'Revisar identity.role_permissions antes de repartir a ciegas.',
    );
  }

  const nuevos = destino.filter((r) => r.ya === null).map((r) => r.role_name);
  const enFalse = destino.filter((r) => r.ya === false).map((r) => r.role_name);
  const yaLoTiene = destino.filter((r) => r.ya === true).map((r) => r.role_name);

  console.log(`\n  ${CLAVE} — quien reconcilia + quien recibe mercancia`);
  if (nuevos.length) {
    const res = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || ?::jsonb, updated_at = now()
        WHERE role_name = ANY(?) AND deleted_at IS NULL AND permissions -> ?::text IS NULL`,
      [JSON.stringify({ [CLAVE]: true }), nuevos, CLAVE],
    );
    console.log(`    ✓ concedido a ${res.rowCount} rol(es): ${nuevos.join(', ')}`);
  } else {
    console.log(`    ~ ningun rol nuevo por tocar (${yaLoTiene.length} ya lo tenian).`);
  }

  // Lo que no se tocó se DECLARA: callarlo haría leer "reparto completo" donde hay roles sin acceso.
  if (enFalse.length) {
    console.log(`    ! ${enFalse.length} rol(es) con ${CLAVE} en false (decision manual, NO se pisa): ${enFalse.join(', ')}`);
    console.log('      Si deben tenerlo, se asigna desde /admin/roles.');
  }

  // Gate 1 — un permiso repartido a 0 roles es un modulo entregado que nadie puede usar.
  const { rows: cob } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_permissions
      WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb`,
    [CLAVE],
  );
  if (cob[0].n === 0) throw new Error(`${CLAVE} quedo en 0 roles: el boton no lo veria nadie.`);
  console.log(`    Cobertura: ${cob[0].n} rol(es).`);

  // Gate 2 — el candado de la razon de ser. Si quien RECIBE no puede cancelar, el bodeguero
  // sigue mirando el muro y esta fase no arregla el incidente que la motivo.
  const { rows: huerfanos } = await knex.raw(
    `SELECT rp.role_name
       FROM identity.role_permissions rp
      WHERE rp.deleted_at IS NULL
        AND rp.role_name NOT LIKE ?
        AND rp.permissions -> ?::text = 'true'::jsonb
        AND coalesce(rp.permissions -> ?::text, 'false'::jsonb) <> 'true'::jsonb
      ORDER BY rp.role_name`,
    [EXCLUIDOS_LIKE, ORIGEN[1], CLAVE],
  );
  if (huerfanos.length) {
    const nombres = huerfanos.map((r) => r.role_name).join(', ');
    // No revienta si la razon es un `false` manual — esa es una decision humana explicita.
    const soloFalse = huerfanos.every((r) => enFalse.includes(r.role_name));
    if (!soloFalse) {
      throw new Error(
        `Roles que entran al Anden y quedaron SIN ${CLAVE}: ${nombres}. ` +
        'Son justo los que chocan con el almacen congelado.',
      );
    }
    console.log(`    ! ${nombres} entra al Anden y NO puede cancelar (tiene la clave en false, decision manual).`);
  } else {
    console.log('    ✓ Candado: todo rol que recibe mercancia puede destrabar su almacen.');
  }

  console.log('\n  Los afectados deben RE-LOGUEAR (el JWT lleva el mapa de permisos).');
};

exports.down = async function down(knex) {
  // Se apaga en los roles que la tienen, no se borra: `false` es la forma que /admin/roles lee y
  // escribe, y deja rastro de que la decision fue explicita.
  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || ?::jsonb, updated_at = now()
      WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb`,
    [JSON.stringify({ [CLAVE]: false }), CLAVE],
  );
  console.log(`  ${CLAVE} apagado en ${res.rowCount} rol(es).`);
};
