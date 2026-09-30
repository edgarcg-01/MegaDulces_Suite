'use strict';
/**
 * `[PR.D2c]` — **Repartir los permisos del experimento de precio.**
 *
 * ⭐ Un módulo nuevo **no está entregado hasta que su permiso está REPARTIDO en prod**, no
 * declarado en el enum. El repo ya lo pagó: `[LC.6.2]` midió un módulo que llevaba tiempo en
 * producción y **nadie podía abrir**, porque el par de permisos nació en el enum y ninguna
 * migración lo otorgó — la única fila que los mencionaba los tenía en `false`.
 *
 * ── ⛔ Por qué NO se calca al hermano ──────────────────────────────────────────────────────
 * Lo obvio sería copiar quién tiene `COMMERCIAL_PRICING_VER`. Medido en prod, lo tienen **12
 * roles**: `credito_cobranza, customer_b2b, direccion, gerente_compras, jefe_marketing,
 * marketing, promotor_ruta, repartidor, superadmin, telemarketing, vendedor_ruta,
 * vendedor_telemarketing`.
 *
 * Entre ellos hay **un CLIENTE** (`customer_b2b`, 3 usuarios) y **gente de campo**
 * (`promotor_ruta` 19, `vendedor_ruta` 16, `repartidor` 2): tienen ese permiso para **consultar
 * el precio al que venden**, no para ver qué precios se están moviendo a propósito ni para
 * decidirlo.
 *
 * ⭐ Es la misma trampa que la Fase FLT documentó al revés (*"`cajero` NO tiene el permiso del
 * verificador y calcarlo lo habría dejado sin reportar"*): **el calco ciego falla en las dos
 * direcciones**. El reparto se deriva del rol que la persona cumple, no del permiso vecino.
 *
 * ── El criterio ────────────────────────────────────────────────────────────────────────────
 *  · **`_VER`** — ve resultados **y captura los precios en Kepler**. Va a quien decide sobre
 *    precio o ejecuta el cambio: dirección, compras, marketing y telemarketing.
 *  · **`_GESTIONAR`** — **diseña y asigna**, o sea decide qué precios se mueven y sobre qué
 *    venta. Es estrictamente más chico, y deja fuera a quien sólo teclea.
 *
 * ⛔ Excluidos a propósito, con su razón: `customer_b2b` (es un cliente), `repartidor`,
 * `promotor_ruta`, `vendedor_ruta`, `vendedor_telemarketing` (campo: consultan precio, no lo
 * deciden) y `credito_cobranza` (cobra, no fija precio). Los `retirado_*` quedan fuera siempre.
 *
 * ⚠️ Aditiva y NO destructiva: si un rol ya tiene la clave en `false` porque alguien guardó el
 * mapa completo desde `/admin/roles`, **no se pisa** — ese `false` puede ser una decisión.
 * Medido antes de escribir: hoy **cero** filas mencionan estas claves, así que no hay nada que
 * respetar todavía, pero el código lo respeta igual.
 *
 * @param { import("knex").Knex } knex
 */

const VER = 'COMMERCIAL_PRICE_EXPERIMENT_VER';
const GESTIONAR = 'COMMERCIAL_PRICE_EXPERIMENT_GESTIONAR';

/** Ve el experimento y captura los precios. */
const ROLES_VER = [
  'direccion', 'gerente_compras', 'jefe_marketing', 'marketing', 'superadmin', 'telemarketing',
];

/** Diseña y asigna: decide QUÉ precios se mueven. Estrictamente más chico que VER. */
const ROLES_GESTIONAR = [
  'direccion', 'gerente_compras', 'marketing', 'superadmin',
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ⛔ El invariante que la lista tiene que cumplir: quien diseña tiene que poder ver.
  const huerfanos = ROLES_GESTIONAR.filter((r) => !ROLES_VER.includes(r));
  if (huerfanos.length) {
    throw new Error(`[PR.D2c] ${huerfanos.join(', ')} pueden DISEÑAR y no VER: `
      + 'un rol que diseña un experimento y no puede abrir su resultado es una puerta rota.');
  }

  let tocados = 0;
  let respetados = 0;

  for (const [perm, roles] of [[VER, ROLES_VER], [GESTIONAR, ROLES_GESTIONAR]]) {
    for (const rol of roles) {
      // ⚠️ `permissions -> 'KEY' IS NULL`, NUNCA el operador `?` de JSONB: knex no lo escapa.
      const { rows } = await knex.raw(`
        SELECT role_name, (permissions -> ?) IS NULL AS ausente
          FROM identity.role_permissions WHERE role_name = ?`, [perm, rol]);
      if (!rows.length) continue;              // el rol no existe en este destino
      if (!rows[0].ausente) { respetados++; continue; }  // ya tiene un valor: no se pisa

      await knex.raw(`
        UPDATE identity.role_permissions
           SET permissions = permissions || jsonb_build_object(?::text, true)
         WHERE role_name = ?`, [perm, rol]);
      tocados++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`  · [PR.D2c] ${tocados} claves otorgadas · ${respetados} respetadas (ya tenían valor)`);

  // ── Compuerta ─────────────────────────────────────────────────────────────────────
  const [g] = (await knex.raw(`
    SELECT
      count(*) FILTER (WHERE (permissions ->> ?) = 'true')::int con_ver,
      count(*) FILTER (WHERE (permissions ->> ?) = 'true')::int con_gestionar,
      count(*) FILTER (WHERE (permissions ->> ?) = 'true'
                         AND (permissions ->> ?) IS DISTINCT FROM 'true')::int gestiona_sin_ver,
      count(*) FILTER (WHERE role_name LIKE 'retirado%'
                         AND (permissions ->> ?) = 'true')::int retirados,
      count(*) FILTER (WHERE role_name = 'customer_b2b'
                         AND (permissions ->> ?) = 'true')::int cliente
      FROM identity.role_permissions`,
  [VER, GESTIONAR, GESTIONAR, VER, VER, VER])).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.D2c] VER en ${g.con_ver} roles · GESTIONAR en ${g.con_gestionar}`);

  if (g.con_ver === 0) {
    throw new Error('[PR.D2c] cero roles con VER: el módulo quedaría invisible, que es '
      + 'exactamente el defecto de [LC.6.2].');
  }
  if (g.gestiona_sin_ver > 0) {
    throw new Error(`[PR.D2c] ${g.gestiona_sin_ver} roles pueden diseñar sin poder ver.`);
  }
  if (g.retirados > 0) {
    throw new Error(`[PR.D2c] ${g.retirados} roles retirados recibieron el permiso.`);
  }
  // ⛔ La prueba de que NO se calcó al hermano: el cliente no puede entrar.
  if (g.cliente > 0) {
    throw new Error('[PR.D2c] customer_b2b recibió el permiso: es un CLIENTE, y eso sería '
      + 'haber copiado la lista de COMMERCIAL_PRICING_VER sin leerla.');
  }
};

exports.down = async function down(knex) {
  for (const perm of [VER, GESTIONAR]) {
    await knex.raw(
      `UPDATE identity.role_permissions SET permissions = permissions - ?::text`, [perm]);
  }
};
