'use strict';
/**
 * `[IDG.9.6]` — Dos decisiones de Edgar, aplicadas.
 *
 * ── A. Las promotoras van a capturar caducidades, y el sistema se lo negaba ──
 *
 * Edgar: «las promotoras deben agregar las caducidades, aún no se capacitan».
 * O sea: los 8 `promotor_ruta` que nunca entraron **no son baja**, son gente
 * pendiente de capacitación. Y al medir el permiso apareció lo de siempre:
 *
 *     promotor_ruta → COMMERCIAL_EXPIRY_VER = false · COMMERCIAL_EXPIRY_CAPTURAR = false
 *
 * En `false` EXPLÍCITO, no ausente. Hoy sólo `encargado_tienda` (6 personas) y
 * `piso_tienda` (3) pueden capturar caducidad; los **19 `promotor_ruta`** que
 * van a hacer ese trabajo no. Es `[LC.6.2]` otra vez: el módulo entregado y el
 * permiso sin repartir a la población que hace la tarea.
 *
 * Se conceden **sólo** las dos claves que el módulo pide para operar. Los otros
 * 4 endpoints de `commercial-expiry-reviews` exigen `USUARIOS_GESTIONAR` y son
 * la administración de marcas del promotor (quién revisa qué marca): eso lo
 * hace un admin, no la promotora. `vendedor_ruta` NO se toca: Edgar dijo
 * promotoras.
 *
 * ── B. Telemarketing necesita una sucursal ───────────────────────────────────
 *
 * Edgar: «hay que asignarles un warehouse». Los 2 (`maria_garcia`,
 * `monse_frausto`) tenían override `warehouse = all` —las 9 sucursales— y
 * ninguna sucursal en su ficha.
 *
 * Medido contra el hecho independiente (`analytics.erp_sales_invoices`, canal
 * `TELEMARK`, 90 días): el canal factura desde **exactamente 2 sucursales**,
 * `01` Padre Hidalgo (992 docs · $10.0M) y `06` Canindo (384 · $3.9M). Ninguna
 * otra.
 *
 * ⚠️ **No se puede bajar a una sucursal POR PERSONA, y no se adivina.** Se
 * intentó: la tabla trae `vendedor_nombre`, pero en TELEMARK esos nombres son
 * `RUTA VECINAL PH 01`, `SUCURSAL PADRE HIDALGO PISO`, `E-COMMERCE`,
 * `DANIEL FRANCISCO FRANCO`… — vendedores de ruta y de piso. Ni
 * `MARIA DEL CARMEN GARCIA MEJIA` ni `MONSERRATH FRAUSTO NAVA` aparecen. El
 * canal describe **cómo entró la venta, no quién la capturó**: la telemarketista
 * toma el pedido por teléfono y la factura queda a nombre de quien la surte.
 * Y no hay puente estructural `identity.users` → vendedor de Kepler
 * (`analytics.vendor_identity` liga por `vendedor`, sin `user_id`).
 *
 * Por eso el alcance queda `listed ['01','06']`: es el universo REAL del canal,
 * y pasa de 9 sucursales a 2 sin inventar un detalle por persona que no se puede
 * verificar. Si mañana se sabe quién atiende cuál, se baja a `own` o a un
 * `listed` de una sola — `user_scopes` ya lo soporta.
 *
 * Nota: sus overrides de `zone` NO se tocan (siguen en `all`). Ninguna de las
 * dos tiene `zona_id`, así que quitarlo las dejaría ciegas en esa dimensión, y
 * Edgar habló de sucursal.
 *
 * Idempotente. Aditivo para A; para B es un RECORTE deliberado (9 → 2).
 *
 * @param { import("knex").Knex } knex
 */

const CLAVES_CADUCIDAD = ['COMMERCIAL_EXPIRY_VER', 'COMMERCIAL_EXPIRY_CAPTURAR'];
const ROL_PROMOTOR = 'promotor_ruta';
const SUCURSALES_TELEMARKETING = ['01', '06'];

exports.up = async function up(knex) {
  const { rows: tenants } = await knex.raw(
    'SELECT id, slug FROM identity.tenants WHERE activo IS NOT FALSE',
  );

  for (const t of tenants) {
    // ── A. Caducidades para promotor_ruta ───────────────────────────────────
    const { rows: antes } = await knex.raw(
      `SELECT permissions->>'COMMERCIAL_EXPIRY_VER' AS ver,
              permissions->>'COMMERCIAL_EXPIRY_CAPTURAR' AS cap
         FROM identity.role_permissions
        WHERE tenant_id = ? AND lower(role_name) = ?`,
      [t.id, ROL_PROMOTOR],
    );
    if (!antes.length) {
      console.log(`  ~ ${t.slug}: no existe el rol ${ROL_PROMOTOR} — se salta.`);
    } else if (antes[0].ver === 'true' && antes[0].cap === 'true') {
      console.log(`  = ${t.slug}: ${ROL_PROMOTOR} ya podía capturar caducidades.`);
    } else {
      const upd = await knex.raw(
        `UPDATE identity.role_permissions
            SET permissions = permissions || ?::jsonb, updated_at = now()
          WHERE tenant_id = ? AND lower(role_name) = ?`,
        [JSON.stringify(Object.fromEntries(CLAVES_CADUCIDAD.map((k) => [k, true]))), t.id, ROL_PROMOTOR],
      );
      const { rows: n } = await knex.raw(
        `SELECT count(*)::int AS n FROM identity.users
          WHERE tenant_id = ? AND lower(role_name) = ? AND activo AND deleted_at IS NULL`,
        [t.id, ROL_PROMOTOR],
      );
      console.log(
        `  ✓ ${t.slug}: ${ROL_PROMOTOR} ahora ve y captura caducidades ` +
          `(era ver=${antes[0].ver ?? 'ausente'} capturar=${antes[0].cap ?? 'ausente'}) — ${n[0].n} persona(s), ${upd.rowCount} fila(s).`,
      );
    }

    // ── B. Sucursal para telemarketing ──────────────────────────────────────
    const { rows: tele } = await knex.raw(
      `SELECT id, username FROM identity.users
        WHERE tenant_id = ? AND lower(role_name) = 'telemarketing'
          AND activo AND deleted_at IS NULL
        ORDER BY username`,
      [t.id],
    );
    for (const u of tele) {
      await knex.raw(
        `INSERT INTO identity.user_scopes (tenant_id, user_id, dimension, mode, values, nota)
         VALUES (?, ?, 'warehouse', 'listed', ?, ?)
         ON CONFLICT (tenant_id, user_id, dimension)
         DO UPDATE SET mode = 'listed', values = EXCLUDED.values, nota = EXCLUDED.nota, updated_at = now()`,
        [
          t.id,
          u.id,
          SUCURSALES_TELEMARKETING,
          '[IDG.9.6] Universo real del canal TELEMARK medido en erp_sales_invoices (90d): solo 01 y 06. ' +
            'No se baja a una por persona: en TELEMARK el vendedor de la factura es quien SURTE, no quien captura.',
        ],
      );
      console.log(
        `  ✓ ${t.slug}: ${u.username} → warehouse listed [${SUCURSALES_TELEMARKETING.join(', ')}] (era all = 9 sucursales).`,
      );
    }
  }

  // ── Gates de salida ───────────────────────────────────────────────────────
  const { rows: g1 } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.role_permissions
      WHERE lower(role_name) = ? AND permissions->>'COMMERCIAL_EXPIRY_CAPTURAR' <> 'true'`,
    [ROL_PROMOTOR],
  );
  if (g1[0].n > 0) throw new Error(`${ROL_PROMOTOR} sigue sin COMMERCIAL_EXPIRY_CAPTURAR en ${g1[0].n} tenant(s).`);

  const { rows: g2 } = await knex.raw(
    `SELECT count(*)::int AS n
       FROM identity.users u
       LEFT JOIN identity.user_scopes us
         ON us.tenant_id = u.tenant_id AND us.user_id = u.id AND us.dimension = 'warehouse'
      WHERE lower(u.role_name) = 'telemarketing' AND u.activo AND u.deleted_at IS NULL
        AND (us.mode IS DISTINCT FROM 'listed' OR us.values IS NULL OR cardinality(us.values) = 0)`,
  );
  if (g2[0].n > 0) throw new Error(`Quedan ${g2[0].n} usuario(s) de telemarketing sin alcance de sucursal.`);
  console.log('  ✓ gates: promotor_ruta captura caducidades y telemarketing tiene sucursal acotada.');
};

exports.down = async function down(knex) {
  for (const k of CLAVES_CADUCIDAD) {
    // `permissions -> 'CLAVE' IS NOT NULL` y NO el operador `?` de JSONB: knex
    // no lo escapa y choca con su propio placeholder (42P18). Regla en CLAUDE.md.
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = jsonb_set(permissions, ?::text[], 'false'::jsonb)
        WHERE lower(role_name) = ? AND permissions -> ? IS NOT NULL`,
      [`{${k}}`, ROL_PROMOTOR, k],
    );
  }
  await knex.raw(
    `UPDATE identity.user_scopes SET mode = 'all', values = NULL, updated_at = now()
      WHERE dimension = 'warehouse' AND nota LIKE '[IDG.9.6]%'`,
  );
  console.log('  Revertido: caducidades en false para promotor_ruta y telemarketing de vuelta a warehouse=all.');
};
