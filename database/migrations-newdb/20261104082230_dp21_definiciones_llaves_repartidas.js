'use strict';
/**
 * `[DP.2.1]` **Las tres llaves de Definiciones de negocio, REPARTIDAS.**
 *
 * ── Por qué existe esta migración ────────────────────────────────────────────────────────────
 *
 * El reparto se escribió dentro de `20261103153257_dp_business_definitions.js`, pero ESA migración
 * **ya estaba aplicada en prod** (batch 1092, 2026-11-03) cuando se le agregó el bloque. Knex compara
 * el ledger contra el filesystem por NOMBRE: una migración ya registrada no se vuelve a correr nunca,
 * por más que su archivo cambie. Medido en prod el 2026-11-04 antes de escribir esto:
 * `DEFINICIONES_VER` / `_GESTIONAR` / `_CONTESTAR` en **0 roles** (control positivo: la misma
 * consulta devuelve 36 para `SUCURSAL_PENDIENTES_VER`, repartida el día anterior).
 *
 * Sin esto, la pantalla de Definiciones sale a producción y **nadie puede abrirla** (regla 20: un
 * módulo no está entregado hasta que su permiso está repartido en prod, no sólo declarado en el enum).
 *
 * ── Qué reparte ──────────────────────────────────────────────────────────────────────────────
 *
 * Las mismas tres llaves, con el mismo criterio que quedó escrito en la migración original:
 * VER y GESTIONAR arrancan en Dirección (lo decide Edgar); CONTESTAR va a todo rol con personas,
 * como `SERVICIO_REPORTAR`, porque la llave sólo abre la bandeja propia y el servidor exige además
 * ser el dueño de la pregunta.
 *
 * Idempotente: sólo toca el rol al que le FALTA la clave (`permissions -> 'KEY' IS NULL`, nunca el
 * operador `?` de JSONB — knex no lo escapa). Correrla dos veces no cambia nada.
 *
 * @param { import("knex").Knex } knex
 */

const TAG = '[dp21_definiciones_llaves_repartidas]';

/** Roles sin personas detrás: cuentas de sistema o de kiosco, no reciben CONTESTAR. */
const SIN_PERSONAS = ['customer_b2b', 'servicio', 'checador_kiosco', 'verificador_precios', 'etiquetas_tienda'];

const LLAVES = {
  DEFINICIONES_VER: { solo: ['direccion', 'superadmin'] },
  DEFINICIONES_GESTIONAR: { solo: ['direccion', 'superadmin'] },
  DEFINICIONES_CONTESTAR: { excepto: SIN_PERSONAS },
};

/** `?,?,?` para una lista: knex EXPANDE un arreglo en varios `?`, así que `?::text[]` no sirve. */
const marcas = (xs) => xs.map(() => '?').join(',');

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const { rows: [hay] } = await knex.raw(
    'SELECT count(*)::int n FROM identity.role_permissions WHERE deleted_at IS NULL',
  );

  for (const [llave, regla] of Object.entries(LLAVES)) {
    const lista = regla.solo || regla.excepto;
    const valor = regla.solo ? `role_name IN (${marcas(lista)})` : `role_name NOT IN (${marcas(lista)})`;
    const res = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || jsonb_build_object(?::text, (${valor}))
        WHERE permissions -> ?::text IS NULL
          AND role_name NOT LIKE 'retirado%'
          AND deleted_at IS NULL`,
      [llave, ...lista, llave],
    );
    const { rows } = await knex.raw(
      `SELECT role_name FROM identity.role_permissions
        WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL
        ORDER BY 1`,
      [llave],
    );
    // En una base sin roles (la del CI recien creada) no hay a quien repartir: no es un error.
    if (hay.n > 0 && !rows.length) {
      throw new Error(`${TAG} Ningun rol (fuera de superadmin) quedo con ${llave}: la pantalla naceria sin dueno (regla 20)`);
    }
    // Un UPDATE de 0 filas se ve igual que «ya estaba»: se DECLARA cuantas toco y quien quedo en true.
    // eslint-disable-next-line no-console
    console.log(
      `  ${TAG} ${llave}: ${res.rowCount ?? 0} fila(s) tocada(s) · en true → ${rows.length} rol(es): `
      + `${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(`  ${TAG} Permisos frescos por request (RolesGuard lee role_permissions, cache 30 s): alcanza con recargar la pagina.`);
};

exports.down = async function down(knex) {
  for (const llave of Object.keys(LLAVES)) {
    await knex.raw(
      `UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`,
      [llave, llave],
    );
  }
};
