/**
 * `[CG.40]` Dos trampas de la capa de datos de Caja General, declaradas en la base.
 *
 * Salen de la auditoría por capas del 2026-10-06, medida contra prod (read-only). Ninguna de las
 * dos cambia un número publicado hoy: las dos evitan que alguien rompa algo creyendo que lo
 * arregla.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * 1 · `finance.v_caja_ingresos_pendientes` — vista HUÉRFANA con el anclaje de la era vieja
 * ──────────────────────────────────────────────────────────────────────────────────────────
 *
 * Nació en `[CG.19]` para la bandeja de ingresos por capturar. En `[CG.21]` fue **reemplazada**
 * por `finance.v_caja_movimientos_pendientes` (que cubre ingreso Y egreso), y desde entonces
 * **no tiene un solo consumidor** — verificado por grep sobre `libs/` y `apps/`: la única
 * mención viva era un comentario en `cash-ledger.service.ts` que afirmaba que el monto se leía
 * de acá. Ese comentario ya se corrigió; esto cierra la otra mitad.
 *
 * ⛔ El defecto: trae `sucursal = '00'` cableado sobre `analytics.erp_collections`. Era CORRECTO
 * mientras el `00` concentraba (del 1-ene al 30-sep-2026 las demás plazas tenían **cero** cobros,
 * medido), y es FALSO desde el corte del 1-oct-2026, cuando cada centro empezó a operar por su
 * cuenta (Fase PO). Medido el 2026-10-06: desde el 1-oct las plazas 01/02/04/05 llevan
 * **12 cobros por $107,588.05** que esta vista esconde — y los esconde **sin un solo error**,
 * que es lo que vuelve peligroso al patrón.
 *
 * Hoy no le hace daño a nadie porque nadie la lee. Se de-ancla igual, por el mismo motivo por el
 * que uno no deja un cable pelado: el día que alguien la tome por viva —y el comentario invitaba
 * a eso— se lleva los dos defectos juntos.
 *
 * ⚠️ El `COMMENT` no es decoración: es lo único que, desde `psql`, distingue una vista viva de
 * una jubilada. No se DROPEA porque el proyecto no borra objetos de prod sin autorización
 * explícita, y porque una vista de la que no estamos 100% seguros se jubila, no se destruye.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * 2 · ⛔⛔ Las tres vistas `analytics.caja_general_*` son SECURITY DEFINER **a la fuerza**
 * ──────────────────────────────────────────────────────────────────────────────────────────
 *
 * Éste es el hallazgo que de verdad importa, porque su "arreglo" obvio es un apagón.
 *
 * Una auditoría de higiene nota que `analytics.caja_general_movimientos`, `_cuentas` y
 * `caja_arqueos` **no tienen `security_invoker`**, mientras sus hermanas de `finance.v_caja_*`
 * sí — y concluye que es un descuido. **No lo es.** Medido contra prod el 2026-10-06:
 *
 *   · `app_runtime` tiene `SELECT` sobre las 3 tablas de `caja_general_ods`  →  true
 *   · `app_runtime` tiene `USAGE` sobre el schema `caja_general_ods`         →  **FALSE**
 *
 * Y `caja_general_ods` es el **único** schema de la base sin USAGE para `app_runtime`
 * (`analytics`, `finance`, `commercial`, `public` y `kepler_ods` lo tienen todos).
 *
 * ⭐ Sin USAGE en el schema, el `SELECT` sobre la tabla **no se puede ejercer**. La pantalla
 * funciona hoy precisamente porque las vistas corren como su dueño (`postgres`), que sí alcanza
 * el schema. Ponerles `security_invoker = true` haría que `app_runtime` intentara leer el landing
 * **como él mismo** y fallara en el acto: `/finanzas/caja-general` se queda en blanco, y el error
 * habla de permisos de schema, no de la vista que se tocó.
 *
 * O sea: **tener SELECT no es poder leer.** Es la misma forma de la lección de `[CV.17]`
 * (`GOTCHAS.md` §33) — *de dónde sale el login no es lo mismo que qué hace el login*.
 *
 * Que el filtro de tenant viva DENTRO de cada vista (y vive, verificado) es lo que hace que esto
 * sea seguro y no una fuga: el patrón es el de `kepler_ods` y está declarado desde `CG.9c`.
 *
 * Si algún día se quiere la defensa en profundidad, el orden es **USAGE primero, invoker
 * después**, y hay que medir la pantalla entre los dos pasos. Al revés es un apagón.
 */

const VISTA_HUERFANA = 'finance.v_caja_ingresos_pendientes';

/** El `sucursal = '00'` que esta migración retira. Se conserva para el `down()`. */
const DEF_CON_ANCLAJE = `
  SELECT tenant_id, sucursal, folio,
         (sucursal || '|') || folio AS origen_ref,
         cobro_date, cliente_code, cliente_nombre, concepto, monto, tipo_cuenta, forma_pago
    FROM analytics.erp_collections c
   WHERE tenant_id = current_tenant_id()
     AND monto > 0::numeric
     AND cobro_clase = 'PUE'
     AND sucursal = '00'
     AND NOT (EXISTS (
       SELECT 1 FROM finance.cash_ledger l
        WHERE l.tenant_id = c.tenant_id
          AND l.origen_tipo = 'cobro'
          AND l.origen_ref = ((c.sucursal || '|') || c.folio)
          AND l.deleted_at IS NULL
          AND l.estado <> 'cancelado'))`;

const DEF_SIN_ANCLAJE = `
  SELECT tenant_id, sucursal, folio,
         (sucursal || '|') || folio AS origen_ref,
         cobro_date, cliente_code, cliente_nombre, concepto, monto, tipo_cuenta, forma_pago
    FROM analytics.erp_collections c
   WHERE tenant_id = current_tenant_id()
     AND monto > 0::numeric
     AND cobro_clase = 'PUE'
     AND NOT (EXISTS (
       SELECT 1 FROM finance.cash_ledger l
        WHERE l.tenant_id = c.tenant_id
          AND l.origen_tipo = 'cobro'
          AND l.origen_ref = ((c.sucursal || '|') || c.folio)
          AND l.deleted_at IS NULL
          AND l.estado <> 'cancelado'))`;

const COMENTARIO_HUERFANA = `[CG.40] JUBILADA desde [CG.21]: sin consumidor en libs/ ni apps/. `
  + `La bandeja viva es finance.v_caja_movimientos_pendientes (cubre ingreso Y egreso). `
  + `Se le retiró el filtro sucursal='00', correcto mientras el 00 concentraba y falso desde el `
  + `corte del 1-oct-2026 (Fase PO). No usar sin revisarla contra la era actual.`;

const COMENTARIO_DEFINER = (q) => `[CG.40] NO agregar security_invoker. app_runtime tiene SELECT `
  + `sobre ${q} pero NO tiene USAGE sobre el schema caja_general_ods (el unico schema sin USAGE, `
  + `medido 2026-10-06), asi que solo puede leerlo a traves de esta vista, que corre como su `
  + `dueno. Con security_invoker la pantalla /finanzas/caja-general se queda en blanco. `
  + `El aislamiento por tenant vive DENTRO de la vista (patron kepler_ods, CG.9c). `
  + `Si alguna vez se quiere invoker: GRANT USAGE primero, medir la pantalla, y recien despues.`;

/**
 * ⛔ `COMMENT ON` **no admite parámetros**: es un comando de utilidad, no una consulta, y el
 * planificador nunca ve un bind. `knex.raw('COMMENT ON ... IS ?', [txt])` manda `IS $1` y el
 * servidor responde `syntax error at or near "$1"` — la migración revienta entera y revierte.
 * Medido acá el 2026-10-06: fallaba para cualquiera, en cualquier base.
 *
 * El texto va LITERAL, con las comillas simples duplicadas. Hace falta de verdad: los comentarios
 * de abajo citan `sucursal='00'`.
 */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = async function up(knex) {
  // ── 1 · De-anclar la vista huérfana ────────────────────────────────────────────────────
  // `CREATE OR REPLACE` conserva dueño y privilegios, pero el GRANT se re-aplica explícito:
  // esta casa ya perdió un GRANT en un replace y sólo lo vio una aserción de metadata.
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA_HUERFANA} AS ${DEF_SIN_ANCLAJE}`);
  await knex.raw(`GRANT SELECT ON ${VISTA_HUERFANA} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VISTA_HUERFANA} IS ${lit(COMENTARIO_HUERFANA)}`);

  // ── 2 · Dejar escrito que el security definer es LOAD-BEARING ──────────────────────────
  // Sin esto, la próxima auditoría de higiene "arregla" la inconsistencia y apaga la pantalla.
  for (const [vista, origen] of [
    ['analytics.caja_general_movimientos', 'caja_general_ods.doctos'],
    ['analytics.caja_general_cuentas', 'caja_general_ods.cuenta'],
    ['analytics.caja_arqueos', 'caja_general_ods.arqueo_movimientos'],
  ]) {
    await knex.raw(`COMMENT ON VIEW ${vista} IS ${lit(COMENTARIO_DEFINER(origen))}`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA_HUERFANA} AS ${DEF_CON_ANCLAJE}`);
  await knex.raw(`GRANT SELECT ON ${VISTA_HUERFANA} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${VISTA_HUERFANA} IS NULL`);
  for (const vista of [
    'analytics.caja_general_movimientos',
    'analytics.caja_general_cuentas',
    'analytics.caja_arqueos',
  ]) {
    await knex.raw(`COMMENT ON VIEW ${vista} IS NULL`);
  }
};
