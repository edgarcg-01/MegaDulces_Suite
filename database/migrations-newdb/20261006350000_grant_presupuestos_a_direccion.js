'use strict';
/**
 * `[VE.2]` — **Presupuestos tenía dueño declarado y ese dueño NO EXISTE.** Decisión de Edgar,
 * 2026-10-06.
 *
 * ── El hallazgo ─────────────────────────────────────────────────────────────────────────────
 *
 * La migración `20260914150000_grant_presupuestos_to_roles.js` (Fase TP.2) dice, textual, que *el
 * dueño de Presupuestos es `coordinador_presupuestos`* y le otorga las dos claves. Medido contra
 * prod el 2026-10-06: **ese rol no existe**, ni en `identity.role_permissions` ni en
 * `identity.users`. Tampoco `gerente_finanzas`, al que la misma migración le daba VER. Las dos
 * pasaron sin ruido: el `UPDATE` filtra por `lower(role_name) = ANY(...)` y una lista que no
 * matchea no es un error, es cero filas.
 *
 * Lo que quedó en prod, y explica por qué el módulo está vacío:
 *
 *     PRESUPUESTOS_VER        → superadmin (8 personas) · finanzas (1)
 *     PRESUPUESTOS_GESTIONAR  → superadmin (8 personas)
 *
 * O sea: **ninguna persona de negocio podía capturar un presupuesto.** `finanzas` tiene VER a
 * propósito (oversight sin gestionar, y eso se respeta). El resultado es que `budget.budgets` tiene
 * 2 ejercicios —uno llamado `prueba`, el otro `presupesto` con el typo— y las 418 metas del plan de
 * ventas las escribió `superoot`, una sesión técnica. Las demás 10 tablas de `budget.*` están en 0.
 *
 * ⭐ El diagnóstico del tablero decía «falta que alguien le dé al botón de proponer». Medida la
 * causa, es anterior: **quien tendría que darle al botón no puede abrir la pantalla.** Mismo
 * patrón que `[LC.6.2]` (un módulo en prod que nadie podía abrir) e `[IC.23]`.
 *
 * ── Qué hace esta migración, y por qué tan poco ─────────────────────────────────────────────
 *
 * Otorga **las dos claves a `direccion`** (2 personas) y nada más. No se eligió por derivación —
 * se eligió por decisión, porque `PRESUPUESTOS_GESTIONAR` incluye **fijar la capacidad de pago por
 * fecha**, que es el tope dentro del cual el Calendario de Pagos puede programar: es una facultad
 * financiera, no un permiso de consulta.
 *
 * El criterio que la sostiene: el permiso hermano `FINANCE_PAYMENT_CALENDAR_AUTORIZAR` (Fase TP.6)
 * lo tienen hoy **exactamente `direccion` + `superadmin`**, y por ADR-064 **Presupuestos FIJA el
 * tope que el Calendario CONSUME** — quien fija no puede estar repartido más laxo que quien
 * asigna dentro de él.
 *
 * ⛔ **No se otorga a los otros 8 roles de la familia de pagos** (`finanzas_operativo` 7 personas,
 * `contabilidad` 4, `credito_cobranza` 2, `gerente_compras` 2, `marketing` 2, `tesoreria` 1), aun
 * teniendo todos `FINANCE_PAYMENTS_VER`. Tener el permiso de pagos no implica responder del
 * presupuesto, y ADR-064 separa a propósito Presupuestos de Tesorería. Si hace falta ampliar, se
 * hace **desde `/admin/roles`**, que es donde vive esa decisión.
 *
 * ⛔ **Tampoco se crea `coordinador_presupuestos`.** Un rol sin una sola persona es una bandeja
 * vacía con nombre propio: el rol legado sigue en `LEGACY_ROLE_AREA` para cuando se ocupe.
 *
 * ── La trampa que se midió ANTES de escribir ────────────────────────────────────────────────
 *
 * ⚠️ El patrón `permissions -> 'KEY' IS NULL` es **no-op silencioso** cuando la clave ya viene en
 * `false` explícito — residuo de guardar el mapa completo desde `/admin/roles`, que es lo que hizo
 * fallar a `[LC.6.2]` y a `[IC.23]`. Pre-vuelo read-only contra prod: la fila de `direccion`
 * (`9f760326…`) tiene **122 claves, 116 en true, y las dos de Presupuestos AUSENTES** (`?` da
 * false, no `false`). O sea acá `IS NULL` sí aplica. Igual la migración **cuenta y declara** lo
 * que tocó: si algún día la clave llegara en `false`, se ve en el log en vez de pasar de largo.
 *
 * Los permisos viajan en el JWT → **las 2 personas de `direccion` deben RE-LOGUEAR.**
 */

const ROL = 'direccion';
const CLAVES = ['PRESUPUESTOS_VER', 'PRESUPUESTOS_GESTIONAR'];

exports.up = async function up(knex) {
  for (const perm of CLAVES) {
    const { rows: antes } = await knex.raw(
      `SELECT id, role_name, permissions -> ?::text AS ya,
              (SELECT count(*) FROM jsonb_object_keys(permissions)) AS claves
         FROM identity.role_permissions
        WHERE lower(role_name) = ? AND deleted_at IS NULL`,
      [perm, ROL]);

    if (!antes.length) {
      console.log(`[VE.2] ${perm}: el rol "${ROL}" no existe en este destino — no se toca nada.`);
      continue;
    }
    const nuevos = antes.filter((r) => r.ya === null);
    const enFalse = antes.filter((r) => r.ya === false);
    const yaEnTrue = antes.filter((r) => r.ya === true);

    if (yaEnTrue.length) console.log(`[VE.2] ${perm}: ya estaba en true en ${yaEnTrue.length} fila(s).`);
    if (enFalse.length) {
      // No se pisa en silencio: un `false` ahí es una decisión manual de alguien, y esta
      // migración nació para arreglar un no-op, no para causar otro al revés.
      console.log(`[VE.2] ⚠️ ${perm}: en FALSE explícito en ${enFalse.length} fila(s) — NO se pisa. `
        + 'Si la decisión es otorgarlo, hacerlo desde /admin/roles.');
    }
    if (nuevos.length) {
      const res = await knex.raw(
        `UPDATE identity.role_permissions
            SET permissions = permissions || ?::jsonb, updated_at = now()
          WHERE id = ANY(?) AND deleted_at IS NULL AND permissions -> ?::text IS NULL`,
        [JSON.stringify({ [perm]: true }), nuevos.map((r) => r.id), perm]);
      console.log(`[VE.2] ${perm} otorgado a "${ROL}" en ${res.rowCount ?? 0} fila(s).`);

      // Candado de la operación, no del resultado: el `||` sólo puede AGREGAR una clave.
      const { rows: despues } = await knex.raw(
        `SELECT (SELECT count(*) FROM jsonb_object_keys(permissions)) AS claves
           FROM identity.role_permissions WHERE id = ANY(?)`,
        [nuevos.map((r) => r.id)]);
      for (let i = 0; i < despues.length; i++) {
        const d = Number(despues[i].claves), a = Number(nuevos[i].claves);
        if (d !== a + 1) {
          throw new Error(`[VE.2] ${perm}: la fila pasó de ${a} a ${d} claves — se esperaba +1. `
            + 'Abortado: el UPDATE tocó algo que no era esta clave.');
        }
      }
    }
  }

  const { rows: cob } = await knex.raw(
    `SELECT (SELECT count(*) FROM identity.users u
              WHERE lower(u.role_name) = lower(rp.role_name) AND u.deleted_at IS NULL) AS personas
       FROM identity.role_permissions rp
      WHERE lower(rp.role_name) = ? AND rp.deleted_at IS NULL
        AND (rp.permissions->>'PRESUPUESTOS_VER')::boolean IS TRUE`,
    [ROL]);
  const total = cob.reduce((a, r) => a + Number(r.personas), 0);
  console.log(`[VE.2] ${total} persona(s) de "${ROL}" ganan acceso a /presupuesto — deben RE-LOGUEAR.`);
};

exports.down = async function down(knex) {
  for (const perm of CLAVES) {
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions - ?::text, updated_at = now()
        WHERE lower(role_name) = ? AND deleted_at IS NULL`,
      [perm, ROL]);
  }
};
