/* eslint-disable no-console */
/**
 * [VP.3.2] Que el escritor diga QUIÉN es (ADR-056).
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * `analytics.master_data_history` (VP.3.1) ya registra el `current_user` del escritor, que
 * distingue la app (`app_runtime`) del feed (`postgres`) sin que nadie declare nada. Pero **no
 * distingue un importer de otro**, y ahí está la pregunta que el negocio hace de verdad:
 * `commercial.reorder_policy` la pisan TRES importers distintos (`import-reorder-policy`,
 * `import-computed-reorder`, `import-network-reorder`), los dos últimos con nueve columnas de golpe
 * y con políticas de nivel de servicio de formas distintas (por clase ABC vs un solo valor de hub)
 * escribiendo **la misma columna `service_level`**. Sin el actor, "el punto de reorden pasó de 40 a
 * 12" queda a medias: se sabe cuándo y cuánto, no **cuál de las tres corridas** lo hizo.
 *
 * ── POR QUÉ ES UN `SET` Y NO UNA COLUMNA MÁS ─────────────────────────────────────────────
 * Porque no hay que tocar ni un solo `INSERT ... ON CONFLICT` de los importers. Se declara una vez
 * al abrir la conexión y el trigger lo lee solo. Es la diferencia entre 9 archivos con una línea
 * añadida y 9 archivos con sus UPSERT reescritos — y estos archivos corren contra PROD.
 *
 * ── NO PUEDE ROMPER UN FEED ──────────────────────────────────────────────────────────────
 * ⚠️ Editar un importer es deploy a prod inmediato (regla del proyecto). Por eso esta función es
 * deliberadamente incapaz de alterar el comportamiento de una corrida:
 *   · si el `SET` falla, se traga el error y sigue — el actor es metadata, no el trabajo;
 *   · usa `SET` de sesión (no `SET LOCAL`), así vale para todas las transacciones del proceso sin
 *     tener que meterse en el manejo de trx de cada importer;
 *   · el valor va con `quote_literal` del lado del server (parámetro), no interpolado.
 *
 * Es lo contrario del criterio del trigger de VP.3.1, que SÍ lanza: allá se pierde la historia
 * entera (grave); acá se pierde sólo el nombre de quién la escribió (leve), y el `db_role` sigue.
 *
 *   const { declararActor } = require('../lib/declare-actor');
 *   await declararActor(db, 'import-reorder-policy');
 */

/**
 * Declara quién escribe, para que `analytics.master_data_history.actor` deje de ser NULL.
 *
 * @param {{ query: Function }} client  cliente `pg` (o knex con `.raw`) ya conectado
 * @param {string} nombre               nombre del importer, sin ruta ni extensión
 * @returns {Promise<boolean>}          si quedó declarado (informativo: nadie debe ramificar en esto)
 */
async function declararActor(client, nombre) {
  const actor = `importer:${String(nombre || 'desconocido').trim()}`;
  try {
    // `set_config(..., false)` = alcance de SESIÓN. Equivale a `SET app.actor = $1` pero admite
    // parámetro: `SET` no acepta binds, y concatenar el nombre a mano sería inyección por comodidad.
    if (typeof client.query === 'function') {
      await client.query(`SELECT set_config('app.actor', $1, false)`, [actor]);
    } else if (typeof client.raw === 'function') {
      await client.raw(`SELECT set_config('app.actor', ?, false)`, [actor]);
    } else {
      return false;
    }
    return true;
  } catch (e) {
    // A propósito: el actor es metadata. Un feed no se cae por no poder firmar.
    console.warn(`  [VP.3.2] no se pudo declarar app.actor (${actor}): ${e.message}`);
    return false;
  }
}

module.exports = { declararActor };
