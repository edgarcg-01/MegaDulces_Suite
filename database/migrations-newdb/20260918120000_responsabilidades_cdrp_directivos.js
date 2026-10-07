'use strict';
/**
 * `[CDRP.0]` — **DE QUÉ RESPONDE CADA PUESTO DIRECTIVO, con lo que HOY existe.**
 *
 * ── El pedido ───────────────────────────────────────────────────────────────────────────────
 * Edgar, 2026-09-17, sobre `CDRP_Dashboard_Inicial_Directivos_Megadulces.md`: *«necesito que
 * asignemos estas responsabilidades»*. El documento define 9 puestos directivos con su propósito,
 * sus KPIs y su «mi foco hoy».
 *
 * ── ⛔ Lo que esta migración NO hace, y por qué ──────────────────────────────────────────────
 * **No siembra una clave por KPI del documento.** `identity.responsibilities` no es un catálogo de
 * indicadores: es lo que enciende un ORGANISMO en «Mi trabajo», y el candado de
 * `test-newdb-me-context.js` exige que cada clave del catálogo tenga una cola detrás. Una clave sin
 * superficie es un bloque que no ve nadie — el defecto exacto de `[LC.6.2]` («un módulo no está
 * entregado hasta que su permiso está REPARTIDO, no sólo declarado»), sólo que al revés.
 *
 * Así que acá se reparte **sólo lo que ya tiene cola viva**, y lo que el documento pide y no existe
 * queda declarado abajo con nombre. Repartir claves de KPIs inexistentes sería exactamente el
 * «dibujar un cero» que ADR-056 prohíbe, un nivel más arriba.
 *
 * ── Los cuatro huecos que destapó medir el reparto (prod, 2026-09-17) ───────────────────────
 *
 *  1. ⛔ **`finanzas.conciliacion_ingresos` y `finanzas.conciliacion_egresos` no las tenía NADIE.**
 *     Sus colas existen y llevan meses sin dueño declarado. Son 2 de las 14 claves del catálogo.
 *
 *  2. ⛔ **`almacen.cuadre` la tenían `encargado_sucursal` y `supervisor_inventarios`, y NO
 *     Prevención.** O sea: el descuadre lo revisa quien lo produce, y el área que existe para
 *     auditarlo (§9 del documento, sus KPIs primarios 1, 2 y 7) no lo veía en su portada. Es un
 *     hueco de control interno, no de software. La clave se AGREGA a `prevencion`; **no se le
 *     quita a nadie** — el encargado sigue respondiendo de su propio cuadre, que está bien.
 *
 *  3. ⚠️ `logistica.flota` (a `encargado_logistica`) y `comercial.venta_zonas` (a los dos puestos
 *     de dirección) están repartidas a puestos con **0 personas**: la clave existe, el dueño es un
 *     puesto vacío. No es un error de esta migración; se declara para que se vea.
 *
 *  4. ⚠️ **5 de los 9 puestos del documento no tienen ni una clave**, y 3 de ellos NO se pueden
 *     arreglar acá porque no hay nada que repartirles (ver «Declarado» abajo).
 *
 * ── Lo que sí se reparte ────────────────────────────────────────────────────────────────────
 *
 *   direccion_comercial  → comercial.thot
 *       §3 «Mi foco hoy», último bullet: *decisiones comerciales pendientes de autorización*.
 *       Hoy la tiene sólo `supervisor_rd` (quien PROPONE). Mismo patrón que
 *       `finanzas.acciones → jefe_finanzas`: quien aprueba responde de la cola de aprobación.
 *
 *   prevencion           → almacen.cuadre, almacen.conteo
 *       §9 KPIs primarios: exactitud de inventario, diferencia sobre ventas, conciliación de
 *       traspasos. Ver el hueco 2.
 *
 *   jefe_finanzas        → finanzas.conciliacion_ingresos, finanzas.conciliacion_egresos
 *       §4 KPIs primarios 2 y 3 (ingresos/cobranza y egresos/pagos) y su meta de corto plazo
 *       «entregar cierre financiero completo y oportuno». Ver el hueco 1.
 *
 * ── ⛔ Declarado, NO construido (lo que el documento pide y no tiene dónde apoyarse) ─────────
 *
 *   · **Dirección General** se queda sólo con `comercial.venta_zonas`. Sus otros 7 KPIs primarios
 *     no son colas: son cifras contra un presupuesto que **no existe** — medido, las seis tablas
 *     de meta (`budget.budgets`, `budget.budget_lines`, `budget.line_movements`,
 *     `budget.daily_capacity`, `budget.expense_obligations`, `commercial.sales_targets`) tienen
 *     **0 filas**. Darle colas operativas contradiría la tesis del propio documento («dirección
 *     por excepción, no un repositorio de reportes»).
 *   · **`jefe_marketing`** (1 persona, 0 claves): el propio documento (§6) dice que el
 *     levantamiento de Mercadotecnia «debe ser la fuente final para fijar fórmulas, metas y
 *     umbrales». Sin eso, cualquier clave sería inventada.
 *   · **`sistemas`** (5 personas, 0 claves): sus 8 KPIs son del backlog de desarrollo, y no existe
 *     ninguna tabla de tickets en la plataforma.
 *   · **`jefatura_capital_humano`**: el puesto existe con **0 personas** y no hay dominio de RH.
 *   · **`tesoreria`** (1 persona) no aparece en el documento y las dos claves de conciliación
 *     podrían ser suyas y no de `jefe_finanzas`. Queda como pregunta abierta, sin repartir a
 *     ciegas.
 *
 * Aditiva e idempotente. No toca a ninguna persona ni le quita una clave a ningún puesto.
 *
 * @param { import("knex").Knex } knex
 */

/** [puesto, clave, por qué] — cada fila cita la sección del documento que la justifica. */
const REPARTO = [
  ['direccion_comercial', 'comercial.thot', '§3 foco: decisiones comerciales por autorizar'],
  ['prevencion', 'almacen.cuadre', '§9 KPI 2 y 7: diferencias y conciliación de traspasos'],
  ['prevencion', 'almacen.conteo', '§9 KPI 1: exactitud de inventario'],
  ['jefe_finanzas', 'finanzas.conciliacion_ingresos', '§4 KPI 2: ingresos/cobranza vs ventas'],
  ['jefe_finanzas', 'finanzas.conciliacion_egresos', '§4 KPI 3: egresos/pagos vs presupuesto'],
];

exports.up = async function up(knex) {
  for (const [puesto, clave, motivo] of REPARTO) {
    const puestos = await knex('identity.positions')
      .where({ code: puesto })
      .whereNull('deleted_at')
      .select('tenant_id');
    if (puestos.length === 0) {
      console.log(`  [CDRP.0] ⚠️ el puesto "${puesto}" no existe — NO se asignó "${clave}"`);
      continue;
    }
    /*
     * ⛔ La clave tiene que existir en el catálogo. Si no, se DECLARA y se sigue: inventar la fila
     * del catálogo acá dejaría una responsabilidad sin cola detrás, que es lo que esta migración
     * existe para no hacer.
     */
    const enCatalogo = await knex('identity.responsibilities').where({ key: clave }).first();
    if (!enCatalogo) {
      console.log(`  [CDRP.0] ⛔ "${clave}" no está en el catálogo — NO se asignó a ${puesto}`);
      continue;
    }
    for (const { tenant_id } of puestos) {
      const ya = await knex('identity.position_responsibilities')
        .where({ tenant_id, position_code: puesto, responsibility_key: clave })
        .whereNull('deleted_at')
        .first();
      if (ya) {
        console.log(`  [CDRP.0] ${puesto} ya responde de "${clave}" — sin cambios`);
        continue;
      }
      await knex('identity.position_responsibilities').insert({
        tenant_id,
        position_code: puesto,
        responsibility_key: clave,
        es_principal: true,
      });
      const n = await knex('identity.users')
        .where({ tenant_id, position_code: puesto })
        .whereNull('deleted_at')
        .count({ n: '*' })
        .first();
      console.log(
        `  [CDRP.0] ${puesto} → ${clave}  (${(n && n.n) || 0} persona(s))  · ${motivo}`,
      );
    }
  }

  /*
   * El estado después de repartir, impreso: una migración que no dice a cuánta gente llegó deja al
   * siguiente con la misma pregunta que ésta vino a contestar.
   */
  const huerfanas = await knex('identity.responsibilities as r')
    .leftJoin('identity.position_responsibilities as pr', function () {
      this.on('pr.responsibility_key', '=', 'r.key').andOnNull('pr.deleted_at');
    })
    .groupBy('r.key')
    .havingRaw('count(pr.position_code) = 0')
    .pluck('r.key');
  console.log(
    huerfanas.length === 0
      ? '  [CDRP.0] ✔ ninguna clave del catálogo se quedó sin puesto'
      : `  [CDRP.0] ⚠️ siguen sin puesto: ${huerfanas.join(', ')}`,
  );
};

exports.down = async function down(knex) {
  for (const [puesto, clave] of REPARTO) {
    await knex('identity.position_responsibilities')
      .where({ position_code: puesto, responsibility_key: clave })
      .del();
  }
};
