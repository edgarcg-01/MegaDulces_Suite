'use strict';
/**
 * ⭐⭐ `[CGS.8]` — **Un movimiento puede entrar SIN clasificar, pero tiene que decir por qué.**
 *
 * Edgar, 2026-10-21: *«entonces no hagamos que sea obligatorio agregar concepto y eso, para no
 * frenar el proceso de caja general»*.
 *
 * ── Lo que lo motiva, medido ────────────────────────────────────────────────────────────────
 *
 * El par contable de un gasto **existe y está completo en Kepler** —verificado sobre
 * `X-A-10 0000100` de Canindo: cuenta `601-001`, concepto `002`, y en las piernas de resultados
 * el concepto viene lleno en **el 100 %** de los renglones—, pero vive en el documento de
 * **comprobación**, y el que mueve la caja es el **pago** (`X-D-26`). Y el pago **no guarda a qué
 * comprobación salda**: sus columnas `c36..c39` —donde Kepler sí escribe el «docto previo»— vienen
 * vacías.
 *
 * ⛔ Medido antes de rendirse: el identificador que la pantalla muestra (`XA1001-0000100`) **no
 * existe en el ODS** —barrido de las 240 tablas con columna `sucursal`, ninguna se pasó del
 * tiempo—, y emparejar pago↔comprobación por su llave natural (sucursal + entidad + importe +
 * fecha) cubre **7.5 %**: 139 de 1,854 pagos de octubre. El placebo dice que cuando empareja
 * empareja bien (0 falsos a ±30 días), pero hay el doble de pagos que de comprobaciones.
 *
 * ⇒ **No es un problema de lógica: falta una tabla que nadie replica.** Mientras tanto, la caja
 * no puede quedarse esperando.
 *
 * ── ⛔ Por qué NO se quitó el candado a secas ───────────────────────────────────────────────
 *
 * Hoy el libro tiene **316 de 316 movimientos clasificados**, y eso es lo que permite que lo que
 * viaje a contabilidad esté completo. Dejar pasar `NULL` habría borrado esa garantía **y** la
 * distinción entre «falta» y «no aplica»: nada quedaría listable, así que nadie podría vaciar la
 * cola de lo que quedó a medias.
 *
 * Acá el hueco se DECLARA (ADR-056): el movimiento entra con el par vacío **y** un motivo, y eso
 * se puede contar, listar y cerrar después.
 *
 * ── La forma, y por qué es un solo CHECK y no dos ───────────────────────────────────────────
 *
 * Dos CHECK independientes (uno por columna) dejarían pasar el estado **mixto**: cuenta puesta y
 * concepto vacío, que es justo el medio dato que no sirve ni para contabilizar ni para buscar.
 * Un solo CHECK obliga a que sea **todo o nada**:
 *
 *   · clasificado   → cuenta Y concepto con contenido, y `sin_clasificar_motivo` en NULL;
 *   · sin clasificar→ los dos vacíos, y un motivo de 5 caracteres o más.
 *
 * ⚠️ Las columnas **siguen siendo `NOT NULL`**. El marcador es la cadena vacía, no el nulo: así
 * ninguna fila puede quedar sin clasificar por un `INSERT` descuidado que omita la columna — hay
 * que escribir `''` a propósito, y entonces el CHECK pide el motivo.
 *
 * @param { import("knex").Knex } knex
 */

const VIEJOS = ['cash_ledger_cuenta_chk', 'cash_ledger_concepto_chk'];
const NUEVO = 'cash_ledger_clasificacion_chk';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── Guarda: nada de esto tiene sentido si ya hay filas a medio clasificar.
  const { rows: mixtas } = await knex.raw(`
    SELECT count(*)::int n FROM finance.cash_ledger
     WHERE (length(btrim(kepler_cuenta)) = 0) <> (length(btrim(kepler_concepto)) = 0)`);
  if (Number(mixtas[0].n) > 0) {
    throw new Error(`[CGS.8] hay ${mixtas[0].n} movimiento(s) con la mitad del par; el CHECK nuevo los rechazaria. Parar.`);
  }

  const existe = await knex.schema.withSchema('finance').hasColumn('cash_ledger', 'sin_clasificar_motivo');
  if (!existe) {
    await knex.schema.withSchema('finance').alterTable('cash_ledger', (t) => {
      t.text('sin_clasificar_motivo').nullable();
    });
  }

  await knex.raw(`
    COMMENT ON COLUMN finance.cash_ledger.sin_clasificar_motivo IS
      '[CGS.8] Por que este movimiento entro sin cuenta ni concepto. NULL = esta clasificado. Con texto = el par quedo vacio a proposito y hay que cerrarlo despues; nunca es "no aplica" sin decirlo.'`);

  for (const c of VIEJOS) {
    await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS ${c}`);
  }

  const { rows: ya } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'finance.cash_ledger'::regclass`, [NUEVO]);
  if (!ya.length) {
    await knex.raw(`
      ALTER TABLE finance.cash_ledger ADD CONSTRAINT ${NUEVO} CHECK (
        (length(btrim(kepler_cuenta)) > 0 AND length(btrim(kepler_concepto)) > 0
         AND sin_clasificar_motivo IS NULL)
        OR
        (length(btrim(kepler_cuenta)) = 0 AND length(btrim(kepler_concepto)) = 0
         AND length(btrim(coalesce(sin_clasificar_motivo, ''))) >= 5)
      )`);
  }

  await probarElCandado(knex);

  // eslint-disable-next-line no-console
  console.log('  ✅ [CGS.8] un movimiento entra sin clasificar SOLO si dice por que; el medio dato sigue prohibido.');
};

/**
 * ⭐ **La prueba negativa vive dentro de la migración** (regla dura: un gate sin prueba negativa es
 * una intención). Cuatro casos en `SAVEPOINT`, todos revertidos: dos tienen que pasar —el
 * clasificado de siempre y el nuevo sin clasificar— y dos tienen que rebotar: el medio dato y el
 * vacío sin motivo. Si cualquiera se comporta distinto, la migración entera se revierte.
 */
async function probarElCandado(knex) {
  const { rows: base } = await knex.raw(
    `SELECT * FROM finance.cash_ledger WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`);
  if (!base.length) {
    // eslint-disable-next-line no-console
    console.log('  ⚠️ [CGS.8] NO MEDIDO: el libro esta vacio, no hay fila con que probar el candado.');
    return;
  }
  const f = base[0];
  const upd = (sets) => `UPDATE finance.cash_ledger SET ${sets} WHERE id = '${f.id}'`;

  const casos = [
    ['clasificado de siempre', 'PASA',
      upd(`kepler_cuenta = '601-001', kepler_concepto = '002', sin_clasificar_motivo = NULL`)],
    ['sin clasificar, con motivo', 'PASA',
      upd(`kepler_cuenta = '', kepler_concepto = '', sin_clasificar_motivo = 'sin regla declarada para este beneficiario'`)],
    ['medio dato: cuenta si, concepto no', 'FALLA',
      upd(`kepler_cuenta = '601-001', kepler_concepto = '', sin_clasificar_motivo = 'lo que sea pero largo'`)],
    ['vacio SIN motivo', 'FALLA',
      upd(`kepler_cuenta = '', kepler_concepto = '', sin_clasificar_motivo = NULL`)],
    ['vacio con motivo de 3 letras', 'FALLA',
      upd(`kepler_cuenta = '', kepler_concepto = '', sin_clasificar_motivo = 'ups'`)],
    ['clasificado PERO con motivo (contradictorio)', 'FALLA',
      upd(`kepler_cuenta = '601-001', kepler_concepto = '002', sin_clasificar_motivo = 'no deberia poder'`)],
  ];

  const fallos = [];
  for (const [nombre, espera, sql] of casos) {
    await knex.raw('SAVEPOINT cgs8');
    let real;
    try { await knex.raw(sql); real = 'PASA'; } catch { real = 'FALLA'; }
    await knex.raw('ROLLBACK TO SAVEPOINT cgs8');
    await knex.raw('RELEASE SAVEPOINT cgs8');
    if (real !== espera) fallos.push(`«${nombre}»: se esperaba ${espera} y dio ${real}`);
  }
  if (fallos.length) throw new Error(`[CGS.8] el CHECK no se comporta como debe:\n    - ${fallos.join('\n    - ')}`);

  // eslint-disable-next-line no-console
  console.log(`  ✔ [CGS.8] candado probado: ${casos.length} casos (2 pasan, 4 rebotan), todos revertidos.`);
}

/**
 * Vuelve a exigir el par siempre. ⚠️ Aborta si para entonces hay movimientos sin clasificar: el
 * `down` no los puede inventar, y borrarlos o rellenarlos a ciegas seria peor que no revertir.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows } = await knex.raw(
    `SELECT count(*)::int n FROM finance.cash_ledger WHERE length(btrim(kepler_cuenta)) = 0`);
  if (Number(rows[0].n) > 0) {
    throw new Error(`[CGS.8] hay ${rows[0].n} movimiento(s) sin clasificar: clasificalos antes de revertir.`);
  }
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS ${NUEVO}`);
  await knex.raw(`ALTER TABLE finance.cash_ledger
    ADD CONSTRAINT cash_ledger_cuenta_chk CHECK (length(btrim(kepler_cuenta)) > 0)`);
  await knex.raw(`ALTER TABLE finance.cash_ledger
    ADD CONSTRAINT cash_ledger_concepto_chk CHECK (length(btrim(kepler_concepto)) > 0)`);
  // La columna NO se borra: si hubo movimientos declarados, su motivo es el rastro de por que.
};
