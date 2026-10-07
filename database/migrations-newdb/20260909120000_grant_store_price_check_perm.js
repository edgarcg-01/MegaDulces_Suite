'use strict';
/**
 * `[CV.24]` — Reparte `STORE_PRICE_CHECK_VER`, el permiso del verificador de precios
 * de mostrador (`/tienda/verificador`).
 *
 * ── Por qué esta migración existe ────────────────────────────────────────────
 * Declarar una clave en el enum NO le da acceso a nadie: el gate es un lookup por
 * clave exacta sobre `identity.role_permissions`. Ya pasó con
 * `FISCAL_PURCHASE_BOOK_VER/_GESTIONAR` (Fase LC): el módulo llevaba un día en
 * producción, sólo entraban `superadmin`/`admin` por `ALL_PERMS`, y cualquier otro
 * recibía 403 al abrir la URL. **Un módulo no está entregado hasta que su permiso
 * está REPARTIDO, no sólo declarado.**
 *
 * ── El alcance se DERIVA del estado vivo, no se inventa una lista ────────────
 * Se calca del hermano del mismo proyecto: quien hoy ve el monitor de Tienda
 * (`STORE_LIVE_VER`) o imprime etiquetas de anaquel (`STORE_LABELS_VER`) es
 * exactamente el personal que se para en el mostrador. Nada de nombres de rol
 * quemados acá: la lista sale de un `SELECT` en tiempo de corrida.
 *
 * Excepciones deliberadas:
 *   · `retirado_*` — roles de baja, no se les suma nada.
 *   · `etiquetas_anaquel` — la migración `20260908140000` lo recortó a propósito a
 *     UNA sola clave (`STORE_LABELS_VER`) y dejó un gate que revienta si concede
 *     otra. Es una cuenta de puesto que sólo saca etiquetas; sumarle el verificador
 *     contradiría esa decisión. Si el mostrador lo necesita, se le asigna a mano en
 *     `/admin/roles`, que es una decisión explícita y no un efecto colateral.
 *
 * ── Idempotente ──────────────────────────────────────────────────────────────
 * `permissions -> 'KEY' IS NULL` = "nunca se tocó". ⚠️ Un `false` NO se pisa: la
 * pantalla `/admin/roles` guarda el JSONB completo, así que toda clave nueva del
 * enum aterriza en `false` en cualquier rol que alguien haya salvado después del
 * deploy. Eso es a propósito (no pisar decisiones manuales), pero significa que si
 * esta migración corre DESPUÉS de que alguien salve un rol, ese rol no la recibe.
 * Se declara en el log al final, con nombre y apellido, en vez de forzarlo.
 *
 * Los permisos viajan en el JWT → los usuarios afectados deben **RE-LOGUEAR**.
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'STORE_PRICE_CHECK_VER';
const HERMANAS = ['STORE_LIVE_VER', 'STORE_LABELS_VER'];
const EXCLUIDOS = ['etiquetas_anaquel'];

/** Roles que hoy operan el mostrador, leídos del estado vivo. */
const SQL_DESTINO = `
  SELECT rp.role_name, rp.permissions -> ?::text AS ya
    FROM identity.role_permissions rp
   WHERE rp.deleted_at IS NULL
     AND rp.role_name NOT LIKE 'retirado%'
     AND rp.role_name <> ALL(?)
     AND (rp.permissions -> ?::text = 'true'::jsonb OR rp.permissions -> ?::text = 'true'::jsonb)
   ORDER BY rp.role_name`;

exports.up = async function up(knex) {
  const { rows: destino } = await knex.raw(SQL_DESTINO, [CLAVE, EXCLUIDOS, HERMANAS[0], HERMANAS[1]]);
  if (!destino.length) {
    throw new Error(
      `Ningun rol concede ${HERMANAS.join(' ni ')}: no hay de donde derivar el alcance de ${CLAVE}. ` +
      'Revisar identity.role_permissions antes de repartir a ciegas.',
    );
  }

  const nuevos = destino.filter((r) => r.ya === null).map((r) => r.role_name);
  const enFalse = destino.filter((r) => r.ya === false).map((r) => r.role_name);
  const yaLoTiene = destino.filter((r) => r.ya === true).map((r) => r.role_name);

  if (nuevos.length) {
    const patch = JSON.stringify({ [CLAVE]: true });
    const res = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || ?::jsonb, updated_at = now()
        WHERE role_name = ANY(?) AND deleted_at IS NULL AND permissions -> ?::text IS NULL`,
      [patch, nuevos, CLAVE],
    );
    console.log(`  ✓ ${CLAVE} concedido a ${res.rowCount} rol(es): ${nuevos.join(', ')}`);
  } else {
    console.log(`  ~ ningun rol nuevo por tocar (${yaLoTiene.length} ya lo tenian).`);
  }

  // Lo que no se tocó se DECLARA: un `false` explícito se respeta, pero callarlo
  // haría leer "reparto completo" donde hay roles sin acceso.
  if (enFalse.length) {
    console.log(`  ! ${enFalse.length} rol(es) con ${CLAVE} en false (decision manual, NO se pisa): ${enFalse.join(', ')}`);
    console.log(`    Si deben tenerlo, se asigna desde /admin/roles.`);
  }

  // ── Gate: el reparto tiene que haber quedado > 0, o el modulo esta entregado y
  //    nadie puede abrirlo (que es el bug que esta migracion existe para evitar).
  const { rows: cob } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_permissions
      WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb`,
    [CLAVE],
  );
  if (cob[0].n === 0) throw new Error(`${CLAVE} quedo en 0 roles: el verificador seria inaccesible.`);
  console.log(`\n  Cobertura: ${cob[0].n} rol(es) con ${CLAVE}. Los afectados deben RE-LOGUEAR (el JWT lleva el mapa).`);
};

exports.down = async function down(knex) {
  // Se apaga la clave en los roles que la tienen, no se borra: `false` es la forma
  // que /admin/roles lee y escribe, y deja rastro de que la decision fue explicita.
  const off = JSON.stringify({ [CLAVE]: false });
  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || ?::jsonb, updated_at = now()
      WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb`,
    [off, CLAVE],
  );
  console.log(`  ${CLAVE} apagado en ${res.rowCount} rol(es).`);
};
