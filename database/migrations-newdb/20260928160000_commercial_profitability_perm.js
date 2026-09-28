'use strict';
/**
 * `[MR.PERM]` — **Rentabilidad deja de colgar del paraguas de Analítica.**
 *
 * ── Qué estaba mal ──────────────────────────────────────────────────────────
 * `/comercial/rentabilidad` (Fase MR) se abría con `COMMERCIAL_ANALYTICS_VER`,
 * el mismo permiso que abre Command Center, Ventas generales y Wincaja. O sea
 * que darle a alguien la pantalla del **margen** le abría otras tres — y al
 * revés: no se podía dar el margen sin dar el resto.
 *
 * No es una política nueva. El propio enum ya lo declaraba en la sección de
 * Fase AZ: *«cada REPORTE tiene su propio permiso abajo para poder acotar un rol
 * a un solo reporte sin abrir todo el analytics»*. Rentabilidad nació después y
 * nunca recibió el suyo. Esta migración lo reparte.
 *
 * ── Nadie pierde acceso ─────────────────────────────────────────────────────
 * El reparto se **ancla al hermano leído del estado VIVO**, no a una lista de
 * roles escrita a mano: todo rol que hoy tiene `COMMERCIAL_ANALYTICS_VER = true`
 * recibe `COMMERCIAL_PROFITABILITY_VER = true`. El resto queda en `false`.
 * Es la misma forma que usó `COMMERCIAL_SELLOUT_ANALYSIS_VER` (mig
 * `20260907130000`) y que la receta de permisos fija desde `[LC.6.2]`.
 *
 * ⚠️ **Un permiso declarado en el enum NO le da acceso a nadie.** El módulo no
 * está entregado hasta que la clave está REPARTIDA. Por eso esta migración
 * existe y por eso imprime a quién le llegó.
 *
 * ⛔ **El gotcha que puede dejar esto inerte:** `/admin/roles` guarda el JSONB
 * **completo**, así que en cuanto alguien salva un rol cualquiera **después** de
 * que el enum conozca la clave, ésta aterriza en `false` en ese rol. El backfill
 * usa `-> 'KEY' IS NULL` (= «nunca se tocó») y **respeta ese `false` a
 * propósito**: no pisa decisiones manuales. Pero un `false` puesto por el
 * guardado masivo no es una decisión de nadie — así que acá **se cuentan y se
 * nombran** los roles que tienen el ancla y quedaron fuera, en vez de que la
 * diferencia se pierda en silencio.
 *
 * `permissions -> 'KEY' IS NULL` y NO el operador `?` de JSONB: knex no lo
 * escapa bien (regla vieja del proyecto).
 *
 * Aditiva e idempotente. Tras aplicarla: **re-login**, porque el frontend gatea
 * con la foto de permisos del JWT.
 *
 * @param { import("knex").Knex } knex
 */
const KEY = 'COMMERCIAL_PROFITABILITY_VER';
const ANCLA = 'COMMERCIAL_ANALYTICS_VER';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  // Antes: quién tiene el ancla hoy. Es el universo que NO debe perder la pantalla.
  const { rows: conAncla } = await knex.raw(
    `SELECT role_name FROM role_permissions
      WHERE permissions -> ? = 'true'::jsonb AND deleted_at IS NULL
      ORDER BY role_name`,
    [ANCLA],
  );
  console.log(`  · [MR.PERM] roles con ${ANCLA} hoy: ${conAncla.length}` +
    (conAncla.length ? ` — ${conAncla.map((r) => r.role_name).join(', ')}` : ''));

  const bf = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object(?, COALESCE((permissions->>?)::boolean, false))
      WHERE permissions -> ? IS NULL`,
    [KEY, ANCLA, KEY],
  );
  console.log(`  ✓ [MR.PERM] ${bf.rowCount ?? 0} rol(es) tocados por el backfill.`);

  // Después: a quién le llegó de verdad.
  const { rows: conNuevo } = await knex.raw(
    `SELECT role_name FROM role_permissions
      WHERE permissions -> ? = 'true'::jsonb AND deleted_at IS NULL
      ORDER BY role_name`,
    [KEY],
  );
  console.log(`  ✓ [MR.PERM] roles con ${KEY}: ${conNuevo.length}` +
    (conNuevo.length ? ` — ${conNuevo.map((r) => r.role_name).join(', ')}` : ''));

  // ── El hueco, dicho en voz alta ───────────────────────────────────────────
  // Un rol con el ancla que NO recibió la clave sólo puede ser el gotcha de
  // /admin/roles. No se pisa (podría ser una decisión), pero se NOMBRA: si se
  // pierde acá, alguien abre la pantalla mañana y recibe 403 sin explicación.
  const llegaron = new Set(conNuevo.map((r) => r.role_name));
  const fuera = conAncla.map((r) => r.role_name).filter((r) => !llegaron.has(r));
  if (fuera.length) {
    console.log(
      `  ! [MR.PERM] ${fuera.length} rol(es) TIENEN ${ANCLA} y NO recibieron ${KEY} ` +
        `porque la clave ya estaba en false (guardado masivo de /admin/roles, no una decisión): ` +
        `${fuera.join(', ')}. Si tienen que verla, marcala a mano en /admin/roles.`,
    );
  } else {
    console.log('  ✓ [MR.PERM] ningún rol con el ancla se quedó afuera.');
  }

  // Gate: el reparto no puede terminar en cero. Un permiso nuevo con cero roles
  // es un módulo entregado que nadie puede abrir — el defecto de `[LC.6.2]`.
  if (!conNuevo.length && conAncla.length) {
    throw new Error(
      `[MR.PERM] ${conAncla.length} rol(es) tienen ${ANCLA} y NINGUNO quedó con ${KEY}: ` +
        'el reparto no surtió efecto y la pantalla quedaría sin dueño.',
    );
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  await knex.raw(
    `UPDATE role_permissions SET permissions = permissions - ? WHERE permissions -> ? IS NOT NULL`,
    [KEY, KEY],
  );
  console.log('  ✓ [MR.PERM] down: clave removida (la pantalla vuelve a colgar del paraguas).');
};
