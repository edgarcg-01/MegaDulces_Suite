'use strict';
/**
 * `[FLT.2]` — Reparte `STORE_STOCKOUT_CAPTURAR` / `STORE_STOCKOUT_VER`, las claves de la
 * Lista de faltantes (`/tienda/faltantes`).
 *
 * ── Por qué esta migración existe ────────────────────────────────────────────────────────────
 * Declarar una clave en el enum NO le da acceso a nadie: el gate es un lookup por clave exacta
 * sobre `identity.role_permissions` (ADR-054). Ya pasó dos veces —`FISCAL_PURCHASE_BOOK_*` en la
 * Fase LC quedó un día en producción sin que NINGÚN rol lo tuviera, y `STORE_PRICE_CHECK_VER`
 * necesitó su propia migración por lo mismo. **Un módulo no está entregado hasta que su permiso
 * está REPARTIDO, no sólo declarado.**
 *
 * ── El alcance se DERIVA del estado vivo, con una corrección medida ──────────────────────────
 * Lo obvio habría sido calcar el verificador (`STORE_PRICE_CHECK_VER`), que es el kiosco hermano
 * del mismo mostrador. **Está mal, y se midió antes de escribir esto (2026-09-19):**
 *
 *     rol        STORE_PRICE_CHECK_VER   STORE_ARQUEO_CAPTURAR
 *     cajero     null                    true
 *
 * `cajero` **no tiene** el verificador. Derivar de esa sola clave habría dejado sin reportar
 * justo a la persona que atiende al cliente que pregunta — o sea, al único instrumento que este
 * módulo tiene para capturar el dato. Por eso el mostrador se define como la UNIÓN de las dos
 * claves que de verdad lo describen hoy: consultar precio **o** capturar el arqueo de su caja.
 *
 *   · `CAPTURAR` ← `STORE_PRICE_CHECK_VER` **o** `STORE_ARQUEO_CAPTURAR`  (quien se para al frente)
 *   · `VER`      ← `STORE_LIVE_VER` **o** `STORE_PRICE_CHECK_VER`         (quien supervisa la plaza)
 *
 * La consecuencia buscada: `cajero` queda con CAPTURAR y **sin** VER. Reporta y sigue atendiendo;
 * no se le abre una bandeja que no le toca trabajar.
 *
 * La bandeja de Compras NO se reparte acá: reusa `COMPRAS_HALLAZGOS_VER/GESTIONAR`, que ya tienen
 * las nueve áreas que trabajan Hallazgos y Reclamos. Una clave nueva ahí sería una puerta más que
 * alguien tendría que acordarse de abrir.
 *
 * ── Idempotente ──────────────────────────────────────────────────────────────────────────────
 * `permissions -> 'KEY' IS NULL` = "nunca se tocó". ⚠️ Un `false` NO se pisa: `/admin/roles`
 * guarda el JSONB completo, así que toda clave nueva del enum aterriza en `false` en cualquier
 * rol que alguien salve después del deploy. Eso es a propósito (no pisar decisiones manuales),
 * pero significa que si esta migración corre DESPUÉS de ese guardado, ese rol no la recibe. Se
 * declara en el log con nombre y apellido, en vez de forzarlo en silencio.
 *
 * Los permisos viajan en el JWT → los afectados deben **RE-LOGUEAR**.
 *
 * @param { import("knex").Knex } knex
 */

/** Cada clave con las claves vivas de las que se deriva su alcance. */
const REPARTO = [
  {
    clave: 'STORE_STOCKOUT_CAPTURAR',
    origen: ['STORE_PRICE_CHECK_VER', 'STORE_ARQUEO_CAPTURAR'],
    porque: 'quien se para en el mostrador (incluye `cajero`, que NO tiene el verificador)',
  },
  {
    clave: 'STORE_STOCKOUT_VER',
    origen: ['STORE_LIVE_VER', 'STORE_PRICE_CHECK_VER'],
    porque: 'quien supervisa la sucursal',
  },
];

/** Roles de baja: no se les suma nada. */
const EXCLUIDOS_LIKE = 'retirado%';

async function destinatarios(knex, clave, origen) {
  const { rows } = await knex.raw(
    `SELECT rp.role_name, rp.permissions -> ?::text AS ya
       FROM identity.role_permissions rp
      WHERE rp.deleted_at IS NULL
        AND rp.role_name NOT LIKE ?
        AND (rp.permissions -> ?::text = 'true'::jsonb OR rp.permissions -> ?::text = 'true'::jsonb)
      ORDER BY rp.role_name`,
    [clave, EXCLUIDOS_LIKE, origen[0], origen[1]],
  );
  return rows;
}

exports.up = async function up(knex) {
  for (const { clave, origen, porque } of REPARTO) {
    const destino = await destinatarios(knex, clave, origen);

    if (!destino.length) {
      throw new Error(
        `Ningun rol concede ${origen.join(' ni ')}: no hay de donde derivar el alcance de ${clave}. ` +
        'Revisar identity.role_permissions antes de repartir a ciegas.',
      );
    }

    const nuevos = destino.filter((r) => r.ya === null).map((r) => r.role_name);
    const enFalse = destino.filter((r) => r.ya === false).map((r) => r.role_name);
    const yaLoTiene = destino.filter((r) => r.ya === true).map((r) => r.role_name);

    console.log(`\n  ${clave} — ${porque}`);
    if (nuevos.length) {
      const res = await knex.raw(
        `UPDATE identity.role_permissions
            SET permissions = permissions || ?::jsonb, updated_at = now()
          WHERE role_name = ANY(?) AND deleted_at IS NULL AND permissions -> ?::text IS NULL`,
        [JSON.stringify({ [clave]: true }), nuevos, clave],
      );
      console.log(`    ✓ concedido a ${res.rowCount} rol(es): ${nuevos.join(', ')}`);
    } else {
      console.log(`    ~ ningun rol nuevo por tocar (${yaLoTiene.length} ya lo tenian).`);
    }

    // Lo que no se tocó se DECLARA: callarlo haría leer "reparto completo" donde hay roles sin acceso.
    if (enFalse.length) {
      console.log(`    ! ${enFalse.length} rol(es) con ${clave} en false (decision manual, NO se pisa): ${enFalse.join(', ')}`);
      console.log('      Si deben tenerlo, se asigna desde /admin/roles.');
    }

    // Gate: si el reparto quedó en 0, el módulo está entregado y nadie puede usarlo — que es
    // exactamente el bug que esta migración existe para evitar.
    const { rows: cob } = await knex.raw(
      `SELECT count(*)::int AS n FROM identity.role_permissions
        WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb`,
      [clave],
    );
    if (cob[0].n === 0) throw new Error(`${clave} quedo en 0 roles: la pantalla seria inaccesible.`);
    console.log(`    Cobertura: ${cob[0].n} rol(es).`);
  }

  // El candado de la corrección: si `cajero` no puede reportar, este módulo no tiene quien
  // capture el dato y la fase entera es decorativa. Se verifica, no se asume.
  const { rows: cajero } = await knex.raw(
    `SELECT permissions -> 'STORE_STOCKOUT_CAPTURAR' AS puede
       FROM identity.role_permissions
      WHERE role_name = 'cajero' AND deleted_at IS NULL`,
  );
  if (cajero.length && cajero[0].puede !== true) {
    throw new Error(
      "El rol `cajero` quedo SIN STORE_STOCKOUT_CAPTURAR. Es quien atiende al cliente que pregunta: " +
      'sin el, nadie captura faltantes y el modulo no tiene fuente de datos.',
    );
  }
  if (cajero.length) console.log('\n  ✓ Candado: `cajero` puede reportar faltantes.');

  console.log('\n  Los afectados deben RE-LOGUEAR (el JWT lleva el mapa de permisos).');
};

exports.down = async function down(knex) {
  // Se apaga en los roles que la tienen, no se borra: `false` es la forma que /admin/roles lee y
  // escribe, y deja rastro de que la decision fue explicita.
  for (const { clave } of REPARTO) {
    const res = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || ?::jsonb, updated_at = now()
        WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb`,
      [JSON.stringify({ [clave]: false }), clave],
    );
    console.log(`  ${clave} apagado en ${res.rowCount} rol(es).`);
  }
};
