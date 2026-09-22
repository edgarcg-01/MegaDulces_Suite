'use strict';
/**
 * `[SN.37]` — **Tres puestos que ya podían abrir su cola y no sabían que era suya.**
 *
 * ── El pedido ───────────────────────────────────────────────────────────────────────────────
 * Edgar, 2026-09-22: *«vayamos haciéndolo sin perder la afinidad por cada uno y el detalle»* —
 * seguir puesto por puesto. Esta migración **no crea ninguna clave**: reparte tres que ya existen,
 * a tres puestos cuyo rol ya tiene el permiso de la pantalla. Cero código, cero permisos nuevos.
 *
 * ── Los tres, medidos en prod el 2026-09-22 (solo lectura) ──────────────────────────────────
 *
 *   ⭐ `auxiliar_prevencion` → `almacen.cuadre`
 *      «Auxiliar de Auditoría y Prevención», 1 persona activa (`guadalupe_sanchez`, rol
 *      `prevencion_auxiliar`, `RECONCILIATION_VER = true`). Su jefatura (`prevencion`) ya responde
 *      de la clave; ella no. La cola: **2,526 descuadres abiertos**, el más viejo del 8-jul, 719
 *      entrados en 30 días y **0 cerrados**. Detectar pérdida es literalmente el puesto.
 *
 *   ⭐ `analista_abastecimiento_comercial` → `compras.reabasto`
 *      1 persona activa (`juan_elizarraras`, rol `auxiliar_compras`, `COMPRAS_HALLAZGOS_VER =
 *      true`). Responden hoy `auxiliar_compras`, `comprador` y `gerente_compras` — su puesto, que
 *      se llama exactamente como la cola, no. **18,752 hallazgos abiertos.**
 *
 *   · `tesoreria` → `finanzas.caja`
 *      1 persona activa (`maria_gutierrez`, rol `tesoreria`, `FINANCE_CAJA_VER = true`).
 *      ⚠️ **Hoy no le va a aparecer nada, y se dice**: `finance.v_caja_movimientos_pendientes`
 *      devuelve **0 filas**, así que la bandeja no se pinta (una cola en cero no ocupa lugar). Se
 *      reparte igual porque la responsabilidad declara de quién ES el trabajo, no cuánto hay hoy
 *      — y confirmar los movimientos de caja es Tesorería, no la Gerencia que hoy la tiene sola.
 *
 * ── ⛔ Los TRES puestos que se midieron y quedaron FUERA, con su motivo ──────────────────────
 * Estaban en mi lista y la medición los sacó. Se escriben acá para que nadie los vuelva a
 * proponer sin releer esto:
 *
 *   ⛔ **Las cajeras** (`cajera` 14 + `cajero_rv_promotor` 2 — el grupo MÁS grande sin nada).
 *      `[FLT.2]` decidió **a propósito y midiéndolo** que el rol `cajero` tenga
 *      `STORE_STOCKOUT_CAPTURAR` y **no** `_VER`: *«reporta y sigue atendiendo; no se le abre una
 *      bandeja que no le toca trabajar»*. Y tiene razón: la cajera CAPTURA, **Compras DECIDE** —
 *      un faltante abierto es justo lo único sobre lo que ella no puede hacer nada. Además la ruta
 *      `/tienda/faltantes` ya acepta `CAPTURAR`, así que **no hay permiso que falte ni bug que
 *      arreglar**. Su trabajo es de CAPTURA, no de pila: lo que le sirve de la portada es la
 *      columna «Tus espacios», no la de colas. Se revisó si tenía otra cola propia y no:
 *      `finance.expense_comprobaciones` tiene **1 fila en todo el tenant**, validada, de agosto.
 *
 *   ⛔ **`vendedor_piso` → `tienda.caducidades`**: sería un **no-op**. Esa clave sólo mapea a
 *      `caducidades-mias`, que es `alcance: 'mio'` — y `alcance: 'mio'` está **exento** del filtro
 *      de `[SN.30]`. Ya ve sus borradores sin la clave; dársela no cambia un pixel.
 *
 *   ⛔ **`encargado_operaciones` → `compras.reabasto`**: su ficha dice `warehouse_code = '08'` y
 *      la sucursal **08 tiene CERO hallazgos** (la cola se acota por sucursal). Le repartiríamos
 *      una bandeja que no se pinta. Antes hay que decidir si su alcance es su zona o su almacén —
 *      y eso es una decisión de negocio, no una fila.
 *
 * ⛔ **Esto NO otorga permisos ni crea claves.** Los tres roles ya abren su pantalla; las tres
 * claves ya están en el catálogo. Lo único que cambia es de quién ES.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** [puesto, clave] — claves EXISTENTES del catálogo. Esta migración no inserta ninguna. */
const REPARTO = [
  ['auxiliar_prevencion', 'almacen.cuadre'],
  ['analista_abastecimiento_comercial', 'compras.reabasto'],
  ['tesoreria', 'finanzas.caja'],
];

exports.up = async function up(knex) {
  for (const [puesto, key] of REPARTO) {
    /*
     * ⛔ Se verifica que la clave EXISTA en el catálogo en vez de insertarla. Si falta, se declara
     * y se sigue: crear una clave desde una migración de reparto escondería que el catálogo y el
     * código se desincronizaron, que es justo lo que el candado del smoke vigila.
     */
    const cat = await knex('identity.responsibilities').where({ key }).first();
    if (!cat) {
      console.log(`  [SN.37] ⚠️ la clave "${key}" NO está en el catálogo — ${puesto} no la recibe`);
      continue;
    }
    const puestos = await knex('identity.positions')
      .where({ code: puesto })
      .whereNull('deleted_at')
      .select('tenant_id');
    if (puestos.length === 0) {
      console.log(`  [SN.37] ⚠️ el puesto "${puesto}" no existe — "${key}" no se reparte`);
      continue;
    }
    for (const { tenant_id } of puestos) {
      const ya = await knex('identity.position_responsibilities')
        .where({ tenant_id, position_code: puesto, responsibility_key: key })
        .whereNull('deleted_at')
        .first();
      if (ya) {
        console.log(`  [SN.37] ${puesto} ya responde de "${key}" — sin cambios`);
        continue;
      }
      await knex('identity.position_responsibilities').insert({
        tenant_id,
        position_code: puesto,
        responsibility_key: key,
        es_principal: true,
      });
      const gente = await knex('identity.users')
        .where({ tenant_id, position_code: puesto })
        .whereNull('deleted_at')
        .pluck('username');
      console.log(
        `  [SN.37] ${puesto} → ${key}  (la reciben ${gente.length}: ${gente.join(', ') || '—'})`,
      );
    }
  }
};

exports.down = async function down(knex) {
  // Sólo se quitan los pares que esta migración puso. El catálogo no se toca: no lo creó.
  for (const [puesto, key] of REPARTO) {
    await knex('identity.position_responsibilities')
      .where({ position_code: puesto, responsibility_key: key })
      .del();
  }
};
