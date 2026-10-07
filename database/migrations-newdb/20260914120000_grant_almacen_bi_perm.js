'use strict';
/**
 * Reparte `ALMACEN_BI_VER`, el permiso del módulo **Análisis BI** de Almacén
 * (`/almacen/analisis-bi`).
 *
 * ── Por qué esta migración existe ────────────────────────────────────────────
 * Declarar la clave en el enum NO le da acceso a nadie: el gate es un lookup por
 * clave exacta sobre `identity.role_permissions` (ADR-054). Ya cobró dos veces:
 * `FISCAL_PURCHASE_BOOK_VER` (Fase LC) estuvo un día en producción con el módulo
 * abierto y sólo `superadmin`/`admin` entrando por `ALL_PERMS`, y
 * `STORE_PRICE_CHECK_VER` (CV.24) necesitó su propia migración por lo mismo.
 * **Un módulo no está entregado hasta que su permiso está REPARTIDO, no sólo
 * declarado.**
 *
 * ── El alcance se DERIVA del estado vivo, no se inventa una lista ────────────
 * Análisis BI es una lectura CRUZADA del almacén, así que su público es el que ya
 * tiene una lectura del almacén completo: quien **supervisa el inventario
 * físico** (`COMMERCIAL_INVENTORY_SUPERVISAR`) o quien ve el **diario de
 * movimientos** (`COMMERCIAL_MOVEMENTS_VER`). Nada de nombres de rol quemados
 * acá: la lista sale de un `SELECT` en tiempo de corrida, contra la base donde
 * corra.
 *
 * Se descartaron a propósito otros dos hermanos:
 *   · `COMMERCIAL_INVHEALTH_VER` / `COMMERCIAL_DEADSTOCK_VER` — medido en
 *     `platform_test`: los conceden 10 roles, entre ellos `repartidor`,
 *     `telemarketing` y `credito_cobranza`. Son tableros que se repartieron
 *     ancho; derivar de ahí le abriría el BI del almacén a gente que no pisa el
 *     almacén.
 *   · `EXISTENCIA_VER` — 14 roles, incluye tesorería. Mismo problema, peor.
 *
 * Excepción deliberada: `retirado_*` — roles de baja, no se les suma nada.
 *
 * ── Idempotente ──────────────────────────────────────────────────────────────
 * `permissions -> 'KEY' IS NULL` = "nunca se tocó". ⚠️ Un `false` NO se pisa: la
 * pantalla `/admin/roles` guarda el JSONB completo, así que toda clave nueva del
 * enum aterriza en `false` en cualquier rol que alguien haya salvado después del
 * deploy. Eso es a propósito (no pisar decisiones manuales), pero significa que
 * si esta migración corre DESPUÉS de que alguien salve un rol, ese rol no la
 * recibe. Se declara en el log con nombre y apellido, en vez de forzarlo.
 *
 * Los permisos viajan en el JWT → los usuarios afectados deben **RE-LOGUEAR**.
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'ALMACEN_BI_VER';
const HERMANAS = ['COMMERCIAL_INVENTORY_SUPERVISAR', 'COMMERCIAL_MOVEMENTS_VER'];

/** Roles que hoy leen el almacén completo, leídos del estado vivo. */
const SQL_DESTINO = `
  SELECT rp.id, rp.role_name, rp.permissions -> ?::text AS ya
    FROM identity.role_permissions rp
   WHERE rp.deleted_at IS NULL
     AND rp.role_name NOT LIKE 'retirado%'
     AND (rp.permissions -> ?::text = 'true'::jsonb OR rp.permissions -> ?::text = 'true'::jsonb)
   ORDER BY rp.role_name`;

exports.up = async function up(knex) {
  const { rows: destino } = await knex.raw(SQL_DESTINO, [CLAVE, HERMANAS[0], HERMANAS[1]]);
  if (!destino.length) {
    throw new Error(
      `Ningun rol concede ${HERMANAS.join(' ni ')}: no hay de donde derivar el alcance de ${CLAVE}. ` +
      'Revisar identity.role_permissions antes de repartir a ciegas.',
    );
  }

  // Se apunta por `id`, no por `role_name`: la tabla es por tenant y un mismo rol puede tener
  // varias filas (medido: `superadmin` tiene 2). Filtrando por nombre, el UPDATE tocaba tambien
  // la fila del otro tenant, que la derivacion NO habia seleccionado — el reparto real salia mas
  // ancho que el declarado en el log. (Misma imprecision en la migracion hermana 20260909120000.)
  const nuevos = destino.filter((r) => r.ya === null);
  const nuevosIds = nuevos.map((r) => r.id);
  const nuevosNombres = nuevos.map((r) => r.role_name);
  const enFalse = destino.filter((r) => r.ya === false).map((r) => r.role_name);
  const yaLoTiene = destino.filter((r) => r.ya === true).map((r) => r.role_name);

  if (nuevos.length) {
    const patch = JSON.stringify({ [CLAVE]: true });
    const res = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || ?::jsonb, updated_at = now()
        WHERE id = ANY(?) AND deleted_at IS NULL AND permissions -> ?::text IS NULL`,
      [patch, nuevosIds, CLAVE],
    );
    console.log(`  ✓ ${CLAVE} concedido a ${res.rowCount} rol(es): ${nuevosNombres.join(', ')}`);
  } else {
    console.log(`  ~ ningun rol nuevo por tocar (${yaLoTiene.length} ya lo tenian).`);
  }

  // Lo que no se tocó se DECLARA: un `false` explícito se respeta, pero callarlo
  // haría leer "reparto completo" donde hay roles sin acceso.
  if (enFalse.length) {
    console.log(`  ! ${enFalse.length} rol(es) con ${CLAVE} en false (decision manual, NO se pisa): ${enFalse.join(', ')}`);
    console.log('    Si deben tenerlo, se asigna desde /admin/roles.');
  }

  // ── Gate: el reparto tiene que haber quedado > 0, o el modulo esta entregado y
  //    nadie puede abrirlo (que es el bug que esta migracion existe para evitar).
  const { rows: cob } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_permissions
      WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb`,
    [CLAVE],
  );
  if (cob[0].n === 0) throw new Error(`${CLAVE} quedo en 0 roles: Analisis BI seria inaccesible.`);
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
