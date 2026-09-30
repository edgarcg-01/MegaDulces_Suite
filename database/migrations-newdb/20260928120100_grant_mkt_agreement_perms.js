'use strict';
/**
 * `[MKT.1]` — Reparte `MKT_AGREEMENTS_VER` / `MKT_AGREEMENTS_GESTIONAR` /
 * `MKT_AGREEMENT_EVIDENCE_SUBIR`, las claves de Acuerdos con proveedor (`/mkt/acuerdos`).
 *
 * ── Por qué esta migración existe ────────────────────────────────────────────────────────────
 * Declarar una clave en el enum NO le da acceso a nadie: el gate es un lookup por clave exacta
 * sobre `identity.role_permissions` (ADR-054). Ya pasó dos veces —`FISCAL_PURCHASE_BOOK_*`
 * (`[LC.6.2]`) estuvo un día en producción sin que NINGÚN rol lo tuviera, y `STORE_PRICE_CHECK_VER`
 * necesitó su propia migración por lo mismo. **Un módulo no está entregado hasta que su permiso
 * está REPARTIDO, no sólo declarado.**
 *
 * ── El alcance se DERIVA del estado vivo, con DOS correcciones medidas ───────────────────────
 * Medido en producción el 2026-09-28 sobre `identity.role_permissions` (14 roles con alguna de
 * las claves de origen). Lo obvio era derivar las tres de `COMMERCIAL_PROMOTIONS_*`. Está mal por
 * dos razones distintas, y las dos se vieron en la medición:
 *
 *   ⛔ **`customer_b2b` tiene `COMMERCIAL_PROMOTIONS_VER = true`.** Es el CLIENTE del portal
 *      mayorista, no un empleado. Derivar sin mirar le habría abierto el formato MKTN001 completo
 *      —con el **monto negociado con el proveedor**, el presupuesto y la mecánica interna— al
 *      mismo actor del que se protege esa información. Queda excluido por nombre, no por filtro
 *      genérico, para que se vea en el diff.
 *
 *   ⚠️ **GESTIONAR no se deriva de `COMMERCIAL_PROMOTIONS_GESTIONAR`.** Esa clave la tienen hoy
 *      `telemarketing` y `credito_cobranza`, que administran promociones de PRECIO del portal.
 *      Gestionar un acuerdo es otra cosa: **autorizarlo** (asigna folio, es el acto que lo vuelve
 *      un compromiso con el proveedor) y **ver el dinero de la negociación**. Se reparte sólo a
 *      Mercadotecnia, que es quien negocia y firma — mismo criterio que
 *      `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` (TP.6): preparar ≠ autorizar, y una clave que no se
 *      necesita no se regala «por si acaso». Sumar un rol después es un clic en `/admin/roles`;
 *      quitarlo después de que alguien ya autorizó con él, no.
 *
 * ── Las tres claves y de dónde sale cada una ─────────────────────────────────────────────────
 *   · `VER`             ← `COMMERCIAL_PROMOTIONS_VER` **menos `customer_b2b`**
 *   · `GESTIONAR`       ← lista explícita de Mercadotecnia (no derivada)
 *   · `EVIDENCE_SUBIR`  ← `STORE_PRICE_CHECK_VER` **o** `STORE_ARQUEO_CAPTURAR` **o**
 *                         `STORE_LIVE_VER` — la unión que describe «quien está parado en la
 *                         plaza». Incluye a `cajero`, que **no tiene** el verificador y sí el
 *                         arqueo (la misma trampa que midió `[FLT.2]`).
 *
 * La consecuencia buscada: el encargado de plaza sube su evidencia y **no** ve el monto; el jefe
 * de MKT ve las once plazas. El corte de QUÉ plazas ve cada quien no lo hace el permiso — lo hace
 * el alcance (`ScopeService`, ADR-050), y por eso no hay una clave por sucursal.
 *
 * ── Idempotente ──────────────────────────────────────────────────────────────────────────────
 * `permissions -> 'KEY' IS NULL` = "nunca se tocó". ⚠️ Un `false` NO se pisa: `/admin/roles`
 * guarda el JSONB completo, así que toda clave nueva del enum aterriza en `false` en cualquier
 * rol que alguien salve después del deploy. Es a propósito (no pisar decisiones manuales), pero
 * significa que si esta migración corre DESPUÉS de ese guardado, ese rol no la recibe: se declara
 * en el log con nombre, en vez de forzarlo en silencio.
 *
 * Los permisos viajan en el JWT → los afectados deben **RE-LOGUEAR**.
 *
 * @param { import("knex").Knex } knex
 */

/** Roles de baja: no se les suma nada. */
const EXCLUIDOS_LIKE = 'retirado%';

/**
 * ⛔ Nunca reciben ninguna de estas claves, aunque la derivación los alcance.
 * `customer_b2b` es el cliente del portal: el formato trae el monto negociado con su proveedor.
 */
const NUNCA = ['customer_b2b'];

/** Mercadotecnia: quien negocia, firma y autoriza. Lista explícita, ver cabecera. */
const GESTORES = ['jefe_marketing', 'marketing', 'superadmin'];

/** Cada clave derivada, con las claves vivas de las que sale su alcance. */
const DERIVADAS = [
  {
    clave: 'MKT_AGREEMENTS_VER',
    origen: ['COMMERCIAL_PROMOTIONS_VER'],
    porque: 'quien ya consulta promociones, menos el cliente del portal',
  },
  {
    clave: 'MKT_AGREEMENT_EVIDENCE_SUBIR',
    origen: ['STORE_PRICE_CHECK_VER', 'STORE_ARQUEO_CAPTURAR', 'STORE_LIVE_VER'],
    porque: 'quien está parado en la plaza (incluye `cajero`, que NO tiene el verificador)',
  },
];

/** Roles que hoy tienen alguna de las claves de origen en `true`. */
async function destinatarios(knex, origen) {
  const condiciones = origen.map(() => `rp.permissions -> ?::text = 'true'::jsonb`).join(' OR ');
  const { rows } = await knex.raw(
    `SELECT rp.role_name
       FROM identity.role_permissions rp
      WHERE rp.deleted_at IS NULL
        AND rp.role_name NOT LIKE ?
        AND (${condiciones})
      ORDER BY rp.role_name`,
    [EXCLUIDOS_LIKE, ...origen],
  );
  return rows.map((r) => r.role_name).filter((r) => !NUNCA.includes(r));
}

/**
 * Suma la clave sólo donde **nunca se tocó** (`IS NULL`). Devuelve a quién se le puso y a quién
 * no, para declararlo: un reparto que no dice a quién dejó fuera se lee como completo.
 */
async function otorgar(knex, clave, roles) {
  if (!roles.length) return { puestos: [], respetados: [] };

  const { rows: estado } = await knex.raw(
    `SELECT role_name, permissions -> ?::text AS valor
       FROM identity.role_permissions
      WHERE role_name = ANY(?) AND deleted_at IS NULL`,
    [clave, roles],
  );

  const respetados = estado.filter((r) => r.valor !== null).map((r) => r.role_name);
  const puestos = estado.filter((r) => r.valor === null).map((r) => r.role_name);

  if (puestos.length) {
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || jsonb_build_object(?::text, true),
              updated_at = now()
        WHERE role_name = ANY(?) AND deleted_at IS NULL`,
      [clave, puestos],
    );
  }
  return { puestos, respetados };
}

exports.up = async function up(knex) {
  const resumen = [];

  for (const { clave, origen, porque } of DERIVADAS) {
    const roles = await destinatarios(knex, origen);
    const { puestos, respetados } = await otorgar(knex, clave, roles);
    resumen.push({ clave, porque, puestos, respetados });
  }

  // GESTIONAR va por lista explícita: no se deriva (ver cabecera).
  {
    const { rows } = await knex.raw(
      `SELECT role_name FROM identity.role_permissions
        WHERE role_name = ANY(?) AND deleted_at IS NULL`,
      [GESTORES],
    );
    const existentes = rows.map((r) => r.role_name);
    const { puestos, respetados } = await otorgar(knex, 'MKT_AGREEMENTS_GESTIONAR', existentes);
    resumen.push({
      clave: 'MKT_AGREEMENTS_GESTIONAR',
      porque: 'Mercadotecnia: negocia, firma y autoriza (lista explícita, no derivada)',
      puestos,
      respetados,
    });
    const faltantes = GESTORES.filter((g) => !existentes.includes(g));
    if (faltantes.length) {
      console.log(`  ⚠️  roles de la lista que no existen en esta base: ${faltantes.join(', ')}`);
    }
  }

  console.log('\n[MKT.1] Reparto de permisos de Acuerdos con proveedor:');
  for (const r of resumen) {
    console.log(`  · ${r.clave} — ${r.porque}`);
    console.log(`      otorgado a (${r.puestos.length}): ${r.puestos.join(', ') || '—'}`);
    if (r.respetados.length) {
      // Declarado, no forzado: un `false` es una decisión humana previa.
      console.log(`      ya tenían valor, NO se pisan (${r.respetados.length}): ${r.respetados.join(', ')}`);
    }
  }
  console.log(`  ⛔ excluido siempre: ${NUNCA.join(', ')} (cliente del portal — el formato trae el monto negociado)`);
  console.log('  ⚠️  los permisos viajan en el JWT: los afectados deben RE-LOGUEAR.\n');
};

exports.down = async function down(knex) {
  // Quita las tres claves de todos los roles. No restaura un `false` previo (no se pisó ninguno).
  //
  // ⚠️ El filtro va con `permissions -> 'KEY' IS NOT NULL`, **nunca** con el operador `?` de
  // JSONB: knex no lo escapa correctamente y se lo come como placeholder de binding (regla dura
  // del proyecto, CLAUDE.md § convenciones técnicas).
  for (const clave of ['MKT_AGREEMENTS_VER', 'MKT_AGREEMENTS_GESTIONAR', 'MKT_AGREEMENT_EVIDENCE_SUBIR']) {
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions - ?::text, updated_at = now()
        WHERE permissions -> ?::text IS NOT NULL`,
      [clave, clave],
    );
  }
};
