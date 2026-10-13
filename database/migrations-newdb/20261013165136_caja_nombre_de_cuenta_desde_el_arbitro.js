'use strict';
/**
 * ⛔⛔ `[CG.130]` — **El nombre de la cuenta quedó en NULL: medí con un rol y la migración corrió
 * con otro.**
 *
 * `[CG.129]` ajustó los 25 ingresos a `115/071` y la cola quedó en 0. Pero `kepler_cuenta_nombre`
 * quedó **NULL en los 25**, y mi ensayo previo decía «25 de 25 resuelven nombre».
 *
 * ── La causa, medida ────────────────────────────────────────────────────────────────────────
 *
 * `[CG.129]` tomaba el nombre de `finance.kepler_accounts`, que **no es una tabla: es una vista
 * con `security_invoker = true`** que lee de `analytics.ledger_monthly`. Con mi rol devuelve 182
 * filas; **con el rol que corre dentro del pod devolvió cero**, así que el `LEFT JOIN` dio NULL
 * sin error.
 *
 * ⭐⭐ Es la misma trampa de `[CP.8.44]`, al revés: allá un candado se conectaba con otro rol que
 * el de producción y verificaba un permiso que nadie ejercía; acá **ensayé con un rol y ejecuté
 * con otro**. *Un ensayo que no usa el rol del que ejecuta no ensayó nada.*
 *
 * ⚠️ Y el síntoma es de los peores: el dato quedó **bien** (`115/071`) y la etiqueta **vacía**.
 * La pantalla muestra el nombre, no el código — o sea que el movimiento corregido se vería sin
 * nombre de cuenta, y nadie lo leería como un error de la corrección.
 *
 * ── El arreglo: pedirle el nombre a quien ya lo probó ───────────────────────────────────────
 *
 * ⭐ `analytics.v_caja_contracuenta_cobro` **ya publica `cuenta_nombre`**, y se sabe que el rol
 * del pod puede leerla: `[CG.129]` encontró sus 25 filas a través de ella. No hace falta una
 * fuente nueva — hacía falta no haber ido a buscar a otro lado.
 *
 * ⛔ **No se cablea `'ABONO A CLIENTES'`.** Sería el arreglo de dos minutos y volvería a poner en
 * el código un nombre que la contabilidad puede cambiar.
 *
 * ⚠️ Idempotente por la misma vía que `[CG.129]`: sólo toca filas con el nombre en NULL.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  /**
   * Se maneja desde la BITÁCORA y no desde la cola: la cola ya quedó vacía (que es justamente la
   * señal de que `[CG.129]` hizo su trabajo), así que lo único que sabe a quién le tocó el cambio
   * es `cash_ledger_reclasificaciones`.
   */
  const r = await knex.raw(`
    UPDATE finance.cash_ledger l
       SET kepler_cuenta_nombre = a.cuenta_nombre,
           updated_at           = now()
      FROM finance.cash_ledger_reclasificaciones b
      JOIN analytics.v_caja_contracuenta_cobro a
        ON a.tenant_id = b.tenant_id AND a.cuenta = b.a_cuenta
     WHERE l.id = b.cash_ledger_id
       AND l.kepler_cuenta   = b.a_cuenta
       AND l.kepler_concepto = b.a_concepto
       AND l.kepler_cuenta_nombre IS NULL
       AND a.cuenta_nombre IS NOT NULL`);

  const tocados = r.rowCount ?? 0;

  /**
   * ⛔ El candado. `[CG.129]` ya enseñó que un `UPDATE` que no comprueba su efecto pasa por bueno
   * con el trabajo a medias — y lo enseñó **escribiendo 25 NULL**. Acá se verifica que ningún
   * movimiento reclasificado quede sin nombre.
   */
  const [{ sin_nombre }] = (await knex.raw(`
    SELECT count(*)::int AS sin_nombre
      FROM finance.cash_ledger l
      JOIN finance.cash_ledger_reclasificaciones b ON b.cash_ledger_id = l.id
     WHERE l.kepler_cuenta = b.a_cuenta AND l.kepler_cuenta_nombre IS NULL`)).rows;

  if (Number(sin_nombre) !== 0) {
    throw new Error(
      `[CG.130] se completaron ${tocados} nombre(s) y quedan ${sin_nombre} movimiento(s) `
      + 'reclasificados sin nombre de cuenta. La migracion se revierte entera.');
  }

  // eslint-disable-next-line no-console
  console.log(`[CG.130] ${tocados} nombre(s) de cuenta completados desde el arbitro; sin_nombre en 0.`);
};

/** Volver a vaciar un nombre no arregla nada: el `up` sólo rellena lo que estaba en NULL. */
exports.down = async function down() {
  // eslint-disable-next-line no-console
  console.log('[CG.130] sin vuelta: sólo rellenó nombres que estaban vacíos.');
};
