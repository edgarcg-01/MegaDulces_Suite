/* eslint-disable */
/**
 * `[IC.CEDIS.1]` — **El CEDIS declara su corte a Kepler.** Paso 3 del checklist de
 * `FASE_IC_INVENTARIO_CONTINUO.md` §1.11c, el día que tocaba.
 *
 * ── POR QUÉ HOY, Y POR QUÉ URGE ─────────────────────────────────────────────────────────────
 * `import-cedis-stock-wincaja.js` hace un MERGE **con DELETE de lo que no venga de Irapuato**.
 * Lo frenaban dos puertas (`lib/cedis-source-guard.js`):
 *   · **A) cutover** — `commercial.warehouses.kepler_code` del CEDIS. Estaba en **NULL**.
 *   · **B) frescura** — la fuente Wincaja llevaba 10 días muerta, así que frenaba por accidente.
 *
 * ⛔ Medido el 2026-09-30: la puerta B **dejó de frenar**. El último movimiento de Wincaja `00`
 * pasó a ser del **2026-09-28 (2 días, tope 3)** porque los carriles PM2 de la réplica —parados
 * desde el 22-sep— se reiniciaron ese mismo día. O sea que la única contención era circunstancial
 * y se evaporó sola. Esta migración cierra la puerta A, que es la que el diseño previó.
 *
 * ── QUÉ SE DECLARA, Y POR QUÉ EN LAS DOS TABLAS ─────────────────────────────────────────────
 * El guard pregunta a `commercial.warehouses` **y** a `analytics.v_branch_erp_cutover` (derivado
 * de `wincaja.branches`) justamente porque hoy **discrepan**, y las cuatro migraciones anteriores
 * marcaron sólo la segunda. Se dejan de acuerdo:
 *   · `commercial.warehouses` code `00` → `kepler_code = '00'`  (retira el feed de Wincaja)
 *   · `wincaja.branches` rama `00` → `kepler_cutover_date = 2026-09-30`
 *
 * ⭐ **Esa fecha es lo que hace funcionar el HISTÓRICO**, y es el motivo por el que NO se borran
 * las referencias a Irapuato: `wincaja_source_branch = '00'` sigue siendo el puente al pasado.
 * El resolvedor de corte lo usa para decidir *antes del 30-sep → Wincaja · desde → Kepler*.
 * Borrar esa fila no retiraría una fuente vieja: borraría el acceso a la historia.
 *
 * La fecha sale del hecho, no de una preferencia: la carga inicial del CEDIS en Kepler es
 * `N-A-45` / `N-A-30` folio `0000001` del **2026-09-30** (127 líneas · $8,655,455 · 340,077 u),
 * verificada por `database/scripts/check-cedis-cutover.js`.
 *
 * ── ⛔ LO QUE ESTA MIGRACIÓN NO HACE, A PROPÓSITO ───────────────────────────────────────────
 * **No apunta la existencia del CEDIS a Kepler.** El mecanismo existe —`stockMap({ cedis: true })`
 * en `lib/kepler-branches.js`— y queda APAGADO, porque encenderlo hoy publicaría un número falso:
 * la compuerta midió que `kepler_ods.kdil` de la sucursal `00` trae **12,181,690 u** sin
 * pseudo-SKUs (5,022 SKUs) contra **340,077 u** capturadas — razón **35.82×**. La carga parece
 * haberse SUMADO al saldo viejo de OFICINAS en vez de reemplazarlo. Mientras eso no se corrija
 * EN KEPLER (ADR-040: no escribimos el ERP), apuntar ahí la existencia la inflaría 35 veces en la
 * pantalla de almacén y en el sugerido de compras.
 *
 * ⚠️ Consecuencia DECLARADA: al retirarse el feed de Wincaja, `commercial.stock` del CEDIS queda
 * **congelado en la foto del 2026-09-28**. Congelado y declarado le gana a 35× y mudo — pero es
 * un hueco con nombre, no un estado sano. Se cierra encendiendo `cedis: true` el día que el saldo
 * de Kepler cuadre contra lo capturado.
 *
 * ⚠️ Pendiente aparte, medido el mismo día: la carga cubre **127 líneas contra 196 SKUs con
 * existencia** en Wincaja (65 %) y **104 SKUs / $516,534 (6.3 %)** no llegaron.
 */
exports.up = async function up(knex) {
  const TENANT = '00000000-0000-0000-0000-00000000d01c';
  const CUTOVER = '2026-09-30';

  // ── 1. commercial.warehouses: la puerta A del guard ───────────────────────────────────────
  // Idempotente y acotada: sólo toca la fila del CEDIS y sólo si todavía no lo declara.
  const wh = await knex('commercial.warehouses')
    .where({ tenant_id: TENANT, code: '00' }).whereNull('deleted_at')
    .first('id', 'kepler_code', 'wincaja_source_branch');
  if (!wh) throw new Error('[IC.CEDIS.1] no existe commercial.warehouses code=00 — abortado');
  if (!wh.kepler_code) {
    await knex('commercial.warehouses').where({ id: wh.id, tenant_id: TENANT })
      .update({ kepler_code: '00', updated_at: knex.fn.now() });
  }
  // ⛔ `wincaja_source_branch` NO se toca: es el puente al histórico (ver cabecera).

  // ── 2. wincaja.branches: la fecha que parte el antes del después ──────────────────────────
  const has = await knex.schema.withSchema('wincaja').hasTable('branches');
  if (has) {
    await knex('wincaja.branches')
      .where({ tenant_id: TENANT, source_branch: '00' })
      .whereNull('kepler_cutover_date')
      .update({ kepler_cutover_date: CUTOVER });
  }

  // ── 3. El rótulo: fuera el nombre del archivo .mdb de la pantalla ─────────────────────────
  // `CEDIS BPIRAPUATO` nombraba la FUENTE, no el almacén. La fuente cambió; el almacén no.
  await knex('commercial.warehouses')
    .where({ tenant_id: TENANT, code: '00' })
    .andWhere('name', 'CEDIS BPIRAPUATO')
    .update({ name: 'CEDIS Irapuato', updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  const TENANT = '00000000-0000-0000-0000-00000000d01c';
  await knex('commercial.warehouses')
    .where({ tenant_id: TENANT, code: '00' })
    .update({ kepler_code: null, name: 'CEDIS BPIRAPUATO', updated_at: knex.fn.now() });
  const has = await knex.schema.withSchema('wincaja').hasTable('branches');
  if (has) {
    await knex('wincaja.branches')
      .where({ tenant_id: TENANT, source_branch: '00' })
      .update({ kepler_cutover_date: null });
  }
};
