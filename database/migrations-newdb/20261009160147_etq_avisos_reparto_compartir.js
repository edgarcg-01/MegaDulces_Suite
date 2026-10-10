'use strict';
/**
 * `[ETQ-AVISOS.3]` — Reparte `STORE_LABELS_COMPARTIR` (compartir la lista de «Cambios de precio»:
 * avisar a las sucursales y descargar la lista).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * Declarar una clave en el enum NO le da acceso a nadie: el gate es un lookup por clave exacta
 * sobre `identity.role_permissions` (ADR-054). Pasó con `FISCAL_PURCHASE_BOOK_*` (LC.6.2) y con
 * `STORE_PRICE_CHECK_VER` (CV.24): el módulo llegó a producción y sólo `superadmin` lo abría.
 * **Una función no está entregada hasta que su permiso está REPARTIDO, no sólo declarado.**
 *
 * ── A quién: se DERIVA del estado vivo, no de nombres de rol ────────────────────────────────
 * Quien debe poder avisar a OTRAS plazas es quien compra: el que ve la etiquetera
 * (`STORE_LABELS_VER`) Y genera pedidos o requisiciones (`COMPRAS_PEDIDO_GESTIONAR` /
 * `COMPRAS_REQUISICIONES_GESTIONAR`). Se pide **las dos**:
 *
 *   · ⛔ NO se deriva de `COMPRAS_VER`: medido (`permissions.ts`, 2026-10), esa clave está en
 *     **0 de 37 roles** — colgarse de ella dejaba el botón sin nadie, el bug de LC.6.2.
 *   · ⛔ NO se deriva de «cualquier clave `COMPRAS_*`»: `COMPRAS_ENTRADAS_VALIDAR` la tienen ~25
 *     personas y casi todas son de SUCURSAL (encargados, almacenistas). Eso era justo repartir el
 *     permiso a quien no debe poder avisarle a las demás tiendas.
 *
 * La migración IMPRIME la lista de roles que recibe, para revisarla ANTES de aplicarla (las
 * migraciones de prod se aplican una por una). Si no hay ninguno, FALLA en vez de repartir a
 * ciegas o de dejar la función sin nadie.
 *
 * Excepciones: `retirado_*` (roles de baja) y `etiquetas_*` (cuentas de puesto que sólo sacan
 * etiquetas; sumarles esto contradice `20260908140000`).
 *
 * ── Idempotente ─────────────────────────────────────────────────────────────────────────────
 * `permissions -> 'KEY' IS NULL` = «nunca se tocó». ⚠️ Un `false` NO se pisa: `/admin/roles` guarda
 * el JSONB completo, así que toda clave nueva del enum aterriza en `false` en cualquier rol que
 * alguien haya salvado después del deploy. Es a propósito (no pisar decisiones manuales) y se
 * DECLARA al final con nombre, no se fuerza.
 *
 * Los permisos viajan en el JWT → los afectados deben **RE-LOGUEAR**.
 *
 * ⚠️ Esta migración sólo hace UPDATE: la compuerta del despliegue la clasifica NO_MEDIDO y FRENA a
 *    todo el equipo hasta que alguien la aplique a mano. **Aplicala ANTES de mergear**, una por
 *    una con `apply-one-migration-prod.js`, nunca con `migrate:latest`.
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'STORE_LABELS_COMPARTIR';
const VEN_ETIQUETERA = 'STORE_LABELS_VER';
const COMPRADORES = ['COMPRAS_PEDIDO_GESTIONAR', 'COMPRAS_REQUISICIONES_GESTIONAR'];

/** Roles que ven la etiquetera Y compran, leídos del estado vivo. */
const SQL_DESTINO = `
  SELECT rp.role_name, rp.permissions -> ?::text AS ya
    FROM identity.role_permissions rp
   WHERE rp.deleted_at IS NULL
     AND rp.role_name NOT LIKE 'retirado%'
     AND rp.role_name NOT LIKE 'etiquetas%'
     AND rp.permissions -> ?::text = 'true'::jsonb
     AND (rp.permissions -> ?::text = 'true'::jsonb OR rp.permissions -> ?::text = 'true'::jsonb)
   ORDER BY rp.role_name`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const { rows: destino } = await knex.raw(SQL_DESTINO, [CLAVE, VEN_ETIQUETERA, COMPRADORES[0], COMPRADORES[1]]);
  if (!destino.length) {
    throw new Error(
      `Ningun rol concede ${VEN_ETIQUETERA} junto con ${COMPRADORES.join(' o ')}: no hay de donde derivar ` +
      `quien comparte. Revisar identity.role_permissions y asignar ${CLAVE} desde /admin/roles; ` +
      'no se reparte a ciegas.',
    );
  }

  const nuevos = destino.filter((r) => r.ya === null).map((r) => r.role_name);
  const enFalse = destino.filter((r) => r.ya === false).map((r) => r.role_name);
  const yaLoTiene = destino.filter((r) => r.ya === true).map((r) => r.role_name);

  console.log(`  ${CLAVE}: ${destino.length} rol(es) ven la etiquetera y compran: ${destino.map((r) => r.role_name).join(', ')}`);

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

  // Lo que no se tocó se DECLARA: un `false` explícito se respeta, pero callarlo haría leer
  // «reparto completo» donde hay roles sin acceso.
  if (enFalse.length) {
    console.log(`  ! ${enFalse.length} rol(es) con ${CLAVE} en false (decision manual, NO se pisa): ${enFalse.join(', ')}`);
    console.log('    Si deben tenerlo, se asigna desde /admin/roles.');
  }

  // Gate: tiene que haber quedado > 0, o la funcion esta entregada y nadie puede usarla.
  const { rows: cob } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_permissions
      WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb`,
    [CLAVE],
  );
  if (cob[0].n === 0) throw new Error(`${CLAVE} quedo en 0 roles: compartir seria inaccesible.`);
  console.log(`\n  Cobertura: ${cob[0].n} rol(es) con ${CLAVE}. Los afectados deben RE-LOGUEAR (el JWT lleva el mapa).`);
};

exports.down = async function down(knex) {
  // Se apaga la clave en los roles que la tienen, no se borra: `false` es la forma que
  // /admin/roles lee y escribe, y deja rastro de que la decisión fue explícita.
  const off = JSON.stringify({ [CLAVE]: false });
  const res = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || ?::jsonb, updated_at = now()
      WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb`,
    [off, CLAVE],
  );
  console.log(`  ${CLAVE} apagado en ${res.rowCount} rol(es).`);
};
