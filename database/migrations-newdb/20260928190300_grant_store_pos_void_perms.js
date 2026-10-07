'use strict';
/**
 * `[BP.2]` — Reparte `STORE_POS_VOID_CAPTURAR` / `STORE_POS_VOID_VER`, las claves de la
 * bitácora de retiros en caja (`/tienda/retiros`).
 *
 * ── Por qué esta migración existe ────────────────────────────────────────────────────────────
 * Declarar una clave en el enum NO le da acceso a nadie: el gate es un lookup por clave exacta
 * sobre `identity.role_permissions` (ADR-054). Ya pasó tres veces en este repo
 * (`FISCAL_PURCHASE_BOOK_*`, `STORE_PRICE_CHECK_VER`, `STORE_STOCKOUT_*`).
 * **Un módulo no está entregado hasta que su permiso está REPARTIDO, no sólo declarado.**
 *
 * ── El alcance se DERIVA del estado vivo, medido en prod el 2026-09-28 ───────────────────────
 *
 *   rol                  personas  STORE_LIVE_VER  RECONCILIATION_VER
 *   encargado_tienda          7      true            true
 *   superadmin                8      true            true
 *   auxiliar_tienda           4      true            false
 *   direccion                 2      true            true
 *   prevencion                1      false           true
 *   prevencion_auxiliar       2      false           true
 *   cajero                   19      -               -
 *
 * **CAPTURAR ← `STORE_LIVE_VER`** (supervisión de tienda). ⚠️ `cajero` queda FUERA a propósito,
 * y es la diferencia de fondo con su hermana `floor_stockouts`: ahí la cajera reporta porque es
 * quien oye al cliente. Acá el hecho que se registra es **una autorización**, y la firma es de
 * quien la dio. Un cajero registrando sus propios retiros sin el autorizante sería un log que
 * no prueba nada.
 *
 * **VER ← `STORE_LIVE_VER` o `RECONCILIATION_VER`** (supervisión + prevención de pérdidas).
 * ⛔ **Costo declarado:** `RECONCILIATION_VER` está repartido ancho y arrastra a `marketing`,
 * `compras` y `gerente_compras` (4 personas que no lo necesitan). Se midió también la variante
 * estrecha `RECONCILIATION_GESTIONAR` y **no estrecha nada** — los mismos tres la tienen. Se
 * elige pagar ese costo porque la alternativa es dejar fuera a **prevención de pérdidas**, que
 * es el consumidor natural de una señal antifraude. Si algún día se acota
 * `RECONCILIATION_VER`, esta clave hereda la corrección sola.
 *
 * ── Idempotente ──────────────────────────────────────────────────────────────────────────────
 * `permissions -> 'KEY' IS NULL` = "nunca se tocó". ⚠️ Un `false` NO se pisa: `/admin/roles`
 * guarda el JSONB completo, así que toda clave nueva del enum aterriza en `false` en cualquier
 * rol que alguien salve después del deploy. Eso es a propósito; se declara en el log en vez de
 * forzarlo en silencio.
 *
 * Los permisos viajan en el JWT → los afectados deben **RE-LOGUEAR**.
 *
 * @param { import("knex").Knex } knex
 */

/** Cada clave con las claves vivas de las que se deriva su alcance. */
const REPARTO = [
  {
    clave: 'STORE_POS_VOID_CAPTURAR',
    origen: ['STORE_LIVE_VER'],
    porque: 'supervisión de tienda: quien AUTORIZA el retiro es quien lo firma (cajero queda fuera a propósito)',
  },
  {
    clave: 'STORE_POS_VOID_VER',
    origen: ['STORE_LIVE_VER', 'RECONCILIATION_VER'],
    porque: 'supervisión de tienda + prevención de pérdidas (consumidor natural de la señal antifraude)',
  },
];

/** Roles de baja: no se les suma nada. */
const EXCLUIDOS_LIKE = 'retirado%';

/** Roles cuya ausencia rompe el módulo. Se verifica, no se asume. */
const CANDADOS = [
  {
    rol: 'encargado_tienda',
    clave: 'STORE_POS_VOID_CAPTURAR',
    porque: 'es el autorizante principal en la sucursal (7 personas): sin él nadie captura y la fase es decorativa',
  },
  {
    rol: 'prevencion',
    clave: 'STORE_POS_VOID_VER',
    porque: 'prevención de pérdidas es la razón por la que el alcance de VER se amplió más allá de tienda',
  },
];

async function destinatarios(knex, clave, origen) {
  // El OR se arma con ANY() sobre el arreglo de claves origen: funciona con 1 o con N,
  // a diferencia del patrón de dos posiciones fijas que usó `[FLT.2]`.
  const { rows } = await knex.raw(
    `SELECT rp.role_name, rp.permissions -> ?::text AS ya
       FROM identity.role_permissions rp
      WHERE rp.deleted_at IS NULL
        AND rp.role_name NOT LIKE ?
        AND EXISTS (
          SELECT 1 FROM unnest(?::text[]) AS k(key)
           WHERE rp.permissions -> k.key = 'true'::jsonb
        )
      ORDER BY rp.role_name`,
    [clave, EXCLUIDOS_LIKE, origen],
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

    const { rows: cob } = await knex.raw(
      `SELECT count(*)::int AS n FROM identity.role_permissions
        WHERE deleted_at IS NULL AND permissions -> ?::text = 'true'::jsonb`,
      [clave],
    );
    if (cob[0].n === 0) throw new Error(`${clave} quedo en 0 roles: la pantalla seria inaccesible.`);
    console.log(`    Cobertura: ${cob[0].n} rol(es).`);
  }

  // Los candados: si estos roles quedaron fuera, el módulo está entregado y no sirve.
  for (const { rol, clave, porque } of CANDADOS) {
    const { rows } = await knex.raw(
      `SELECT permissions -> ?::text AS puede FROM identity.role_permissions
        WHERE role_name = ? AND deleted_at IS NULL`,
      [clave, rol],
    );
    if (!rows.length) {
      console.log(`\n  ~ Candado omitido: el rol \`${rol}\` no existe en este entorno.`);
      continue;
    }
    if (rows[0].puede !== true) {
      throw new Error(`El rol \`${rol}\` quedo SIN ${clave}. ${porque}.`);
    }
    console.log(`\n  ✓ Candado: \`${rol}\` tiene ${clave}.`);
  }

  console.log('\n  Los afectados deben RE-LOGUEAR (el JWT lleva el mapa de permisos).');
};

exports.down = async function down(knex) {
  for (const { clave } of REPARTO) {
    // ⚠️ `permissions -> 'KEY' IS NOT NULL` y NO el operador `?` de JSONB: knex no lo escapa y
    // lo confunde con un placeholder de binding (regla dura del proyecto, CLAUDE.md).
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions - ?::text, updated_at = now()
        WHERE permissions -> ?::text IS NOT NULL`,
      [clave, clave],
    );
  }
};
