'use strict';
/**
 * ⭐⭐ `[CG.129]` — **Ajusta los ingresos de caja a la cuenta que dice la póliza de Kepler.**
 *
 * Edgar: *"hay que generar una migración para ajustar los movimientos a sus conceptos adecuados"*.
 *
 * ── Qué se corrige, medido en prod el 2026-10-13 ────────────────────────────────────────────
 *
 * **25 ingresos sin sellar, y el árbitro propone `115/071 ABONO A CLIENTES` para los 25**, con
 * **16,700 renglones** de respaldo en la póliza `UA0501` de la sucursal `00`:
 *
 *     102/011  CAJA GENERAL ............. 15 movs   la caja contra SI MISMA
 *     201/201  PASIVO A PROVEEDORES ......  5 movs   deuda con un proveedor
 *     607-002  HONORARIOS CONTADOR .......  3 movs   ← lo que Edgar leyó en pantalla
 *     102/037  CAJA CHICA MORELIA ........  1 mov
 *     ──────────────────────────────────────────
 *     115/071  ABONO A CLIENTES ..........  0 movs   ← lo correcto, y nadie lo usaba
 *
 * ⛔ **La cuenta NO se escribe acá.** Se lee de `analytics.v_caja_por_reclasificar`, que la deriva
 * del abono de la póliza del propio Kepler (ADR-040/059). Si mañana la contabilidad cambia esa
 * cuenta, esta migración ya corrió con la de su momento **y la bitácora dice cuál era** — que es
 * exactamente lo que un `UPDATE ... SET kepler_cuenta = '115'` no podría contar.
 *
 * ── Las tres cosas que esta migración NO hace ───────────────────────────────────────────────
 *
 * ⛔ **No toca lo sellado.** La vista ya excluye `corte_id IS NOT NULL`: un corte firmado describe
 * un hecho, y reescribirlo por detrás dejaría a alguien habiendo firmado otra cosa.
 * ⛔ **No toca gastos.** El árbitro de un cobro es el abono de `UA0501`; un gasto tiene otro
 * circuito y otra contrapartida. Mezclarlos sería aplicar una medición fuera de su universo.
 * ⛔ **No borra ni cancela nada.** Cambia el par contable y deja el anterior escrito.
 *
 * ── Por qué es idempotente sin un flag ──────────────────────────────────────────────────────
 *
 * ⭐ La condición de trabajo es «el árbitro y el movimiento **no coinciden**». Después de correr,
 * coinciden — así que una segunda corrida encuentra **cero filas** y no escribe nada. No hace
 * falta una marca de «ya corrí», que es la clase de estado que después nadie sabe si es cierto.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  /**
   * ⚠️ El motivo lo exige el CHECK de la bitácora (≥12 caracteres) y acá lo escribe la migración,
   * no una persona. Por eso dice de dónde salió y queda `hecho_por` en NULL: **nadie firmó esto a
   * mano**, y fingir un usuario sería peor que decirlo.
   */
  const MOTIVO = '[CG.129] Ajuste automatico a la cuenta que dice la poliza UA0501 de Kepler, '
    + 'derivada por sucursal en analytics.v_caja_contracuenta_cobro.';

  // --- 1) La bitácora, ANTES del cambio -----------------------------------------------------
  //
  // ⭐ Primero el rastro y después el UPDATE, dentro de la misma transacción: al revés, un fallo
  //    entre medio dejaría el cambio hecho y sin explicación.
  const ins = await knex.raw(`
    INSERT INTO finance.cash_ledger_reclasificaciones
      (tenant_id, cash_ledger_id, de_cuenta, de_concepto, a_cuenta, a_concepto,
       origen, respaldo, motivo, corte_id, hecho_por, hecho_por_username)
    SELECT v.tenant_id, v.cash_ledger_id, v.de_cuenta, v.de_concepto, v.a_cuenta, v.a_concepto,
           'arbitro', nullif(v.respaldo, 0), ?, NULL, NULL, 'migracion [CG.129]'
      FROM analytics.v_caja_por_reclasificar v
    RETURNING cash_ledger_id`, [MOTIVO]);

  const tocados = ins.rowCount ?? (ins.rows?.length ?? 0);

  // --- 2) El ajuste -------------------------------------------------------------------------
  /**
   * ⚠️ Los NOMBRES se resuelven contra el catálogo vivo y la tabla de cuentas. Sin esto el
   * movimiento quedaría con la cuenta nueva y el nombre de la VIEJA, y la pantalla —que muestra
   * el nombre, no el código— seguiría diciendo «HONORARIOS CONTADOR» con la cuenta ya corregida.
   * Es la mentira más difícil de ver: el dato bien y la etiqueta mal.
   */
  await knex.raw(`
    UPDATE finance.cash_ledger l
       SET kepler_cuenta           = v.a_cuenta,
           kepler_concepto         = v.a_concepto,
           kepler_concepto_nombre  = k.concepto_nombre,
           kepler_cuenta_nombre    = a.cuenta_nombre,
           updated_at              = now()
      FROM analytics.v_caja_por_reclasificar v
      LEFT JOIN analytics.v_kepler_conceptos k
             ON k.tenant_id = v.tenant_id AND k.sucursal = v.sucursal
            AND k.cuenta = v.a_cuenta AND k.concepto = v.a_concepto
      LEFT JOIN finance.kepler_accounts a
             ON a.tenant_id = v.tenant_id AND a.cuenta = v.a_cuenta
     WHERE l.id = v.cash_ledger_id`);

  // --- 3) El candado de la propia migración -------------------------------------------------
  /**
   * ⛔ Una migración de datos que no comprueba su efecto es un `UPDATE` con esperanza. Después de
   * correr, la cola tiene que quedar **vacía**: si algo quedó, es que el `UPDATE` no alcanzó a
   * todas las filas que la bitácora dice haber registrado, y eso hay que verlo ahora y no dentro
   * de un mes.
   */
  const [{ quedan }] = (await knex.raw(
    `SELECT count(*)::int AS quedan FROM analytics.v_caja_por_reclasificar`)).rows;
  if (Number(quedan) !== 0) {
    throw new Error(
      `[CG.129] se registraron ${tocados} reclasificaciones pero quedan ${quedan} movimientos que `
      + 'el arbitro sigue contradiciendo. La migracion se revierte entera.');
  }

  // eslint-disable-next-line no-console
  console.log(`[CG.129] ${tocados} ingreso(s) ajustado(s) a la cuenta de la poliza; cola en 0.`);
};

/**
 * ⛔ **No se puede deshacer de forma segura, y por eso NO se finge.**
 *
 * Revertir exigiría devolver cada movimiento a su cuenta anterior — que la bitácora SÍ guarda—,
 * pero entre el `up` y un eventual `down` alguien pudo reclasificar a mano, y este `down` le
 * pisaría su decisión con un valor viejo. Un `down` que restaura a ciegas es peor que ninguno.
 *
 * Si hay que volver atrás, se hace leyendo `finance.cash_ledger_reclasificaciones` y decidiendo
 * fila por fila — con una persona mirando, que es justamente lo que esta migración automatiza
 * porque el destino era UNO solo para las 25.
 */
exports.down = async function down() {
  throw new Error(
    '[CG.129] no tiene vuelta automatica: el ANTES esta en finance.cash_ledger_reclasificaciones '
    + 'y la reversion se decide fila por fila, porque alguien pudo reclasificar a mano despues.');
};
