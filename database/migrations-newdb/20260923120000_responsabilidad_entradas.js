'use strict';
/**
 * `[SN.39]` — **Subir el comprobante de las entradas de mercancía es trabajo de Compras.**
 *
 * ── El pedido ───────────────────────────────────────────────────────────────────────────────
 * Edgar, 2026-09-22, sobre `juan_elizarraras`: *«es encargado de subir /compras/entradas de su
 * sucursal, cada auxiliar de compras debe ver el porcentaje que subió en su sucursal»*.
 *
 * ── Por qué una fila y no una pantalla ──────────────────────────────────────────────────────
 * La pantalla **ya existe** desde la Fase CC ext: `/compras/entradas` adjunta el comprobante de la
 * orden de entrada (`XA2001`) con OCR y cuadre de total, sobre `analytics.erp_goods_receipts` +
 * `finance.goods_receipt_proofs`. Falta decir de quién ES, y con qué se mide.
 *
 * ── Lo medido en prod el 2026-09-22 (solo lectura) ──────────────────────────────────────────
 * Cobertura de comprobante en los últimos 90 días, por sucursal:
 *
 *     08  25 de  32   78.1%       04   0 de  57    0.0%
 *     01 205 de 546   37.5%       05   0 de  45    0.0%
 *     00  59 de 2568   2.3%       06   0 de 129    0.0%
 *     02   2 de 117    1.7%       07   0 de  30    0.0%
 *     03   1 de 210    0.5%
 *
 * **3,442 entradas sin comprobante en 90 días**, y la sucursal `00` sola aporta 2,509 por
 * **$140.2 M**. Histórico completo: **294 de 12,634 = 2.33%**. O sea que el porcentaje que pide
 * Edgar no es un adorno: hoy es la diferencia entre dos sucursales que trabajan (`08` y `01`) y
 * siete que no arrancaron.
 *
 * ── ⛔ DOS cosas que faltan y NO las puede poner esta migración ──────────────────────────────
 * El pedido dice *«de su sucursal»*, y hoy **no se puede saber cuál es**:
 *
 *   1. **Ninguno de los 5 tiene `warehouse_code`** en su ficha (`juan_elizarraras`,
 *      `gerardo_ramirez`, `janette_garcia`, `mario_ventura`, `rafael_quirino`: todos `null`).
 *   2. Y aunque lo tuvieran, el rol `auxiliar_compras` declara `warehouse: all` en
 *      `identity.role_scopes`, con nota de `[ID.8c]`: *«Rol administrativo: su población se
 *      controla por la RED, no por sucursal»*. Con `all`, `sucursalesDelAlcance()` devuelve `null`
 *      y el conteo NO se acota.
 *
 * Las dos son **dato operativo**, y eso se administra desde la UI, no por script (regla de Edgar,
 * 2026-08-27). Mientras tanto la bandeja se comporta como la casa manda: se rotula «de toda la
 * red» y **el desglose trae UNA FILA POR SUCURSAL con su porcentaje**, así que cada auxiliar
 * encuentra la suya igual. El día que la ficha tenga sucursal, la fila se acota sola.
 *
 * ⛔ **Esto NO otorga permisos.** Los 5 ya tienen `COMPRAS_ENTRADAS_GESTIONAR`, que es lo que
 * gatea la ruta.
 *
 * ⚠️ **Hallazgo colateral, reportado y no corregido:** hay **5 entradas con `receipt_date` en el
 * FUTURO** (hasta el 29-dic-2026). Inflan el denominador de `00` y no son de nadie. Es de la Fase
 * CC ext, no de acá.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/** [key, label, descripcion, dimension, orden] */
const NUEVAS = [
  [
    'compras.entradas',
    'Comprobantes de entrada de mercancía',
    'Órdenes de entrada del ERP a las que todavía no se les subió el comprobante. Dimensión ' +
      'sucursal: cada auxiliar de compras responde de la suya.',
    'warehouse',
    44,
  ],
];

/**
 * Los dos puestos que hacen este trabajo. Medido: `auxiliar_compras` son 4 personas
 * (`gerardo_ramirez`, `janette_garcia`, `mario_ventura`, `rafael_quirino`) y
 * `analista_abastecimiento_comercial` es `juan_elizarraras` — el que motivó el pedido.
 *
 * ⚠️ **`gerente_compras` queda fuera a propósito.** Es la jefatura (`arizbeth_gonzalez`) y también
 * abre la pantalla, pero lo que ella necesita de esto es el resultado de la red, no la cola de una
 * sucursal. Sumarla es una línea el día que se decida; no se asume.
 */
const PUESTOS = ['auxiliar_compras', 'analista_abastecimiento_comercial'];

exports.up = async function up(knex) {
  for (const [key, label, desc, dim, orden] of NUEVAS) {
    await knex.raw(
      `INSERT INTO identity.responsibilities (key, label, descripcion, dimension, orden)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, descripcion = EXCLUDED.descripcion,
                                       dimension = EXCLUDED.dimension, orden = EXCLUDED.orden`,
      [key, label, desc, dim, orden],
    );
  }
  console.log(`  [SN.39] catálogo: +${NUEVAS.length} responsabilidad (comprobantes de entrada)`);

  for (const PUESTO of PUESTOS) {
    const puestos = await knex('identity.positions')
      .where({ code: PUESTO })
      .whereNull('deleted_at')
      .select('tenant_id');
    if (puestos.length === 0) {
      console.log(`  [SN.39] ⚠️ el puesto "${PUESTO}" no existe — no recibe la clave`);
      continue;
    }
    for (const { tenant_id } of puestos) {
      for (const [key] of NUEVAS) {
        const ya = await knex('identity.position_responsibilities')
          .where({ tenant_id, position_code: PUESTO, responsibility_key: key })
          .whereNull('deleted_at')
          .first();
        if (ya) {
          console.log(`  [SN.39] ${PUESTO} ya responde de "${key}" — sin cambios`);
          continue;
        }
        await knex('identity.position_responsibilities').insert({
          tenant_id,
          position_code: PUESTO,
          responsibility_key: key,
          es_principal: true,
        });
        const gente = await knex('identity.users')
          .where({ tenant_id, position_code: PUESTO })
          .whereNull('deleted_at')
          .pluck('username');
        console.log(
          `  [SN.39] ${PUESTO} → ${key}  (la reciben ${gente.length}: ${gente.join(', ') || '—'})`,
        );
        // El pedido es «de su sucursal» y la ficha no la tiene: se DICE en el log de la migración,
        // que es donde alguien lo va a leer, en vez de quedar sólo en el comentario de arriba.
        const sinSucursal = await knex('identity.users')
          .where({ tenant_id, position_code: PUESTO })
          .whereNull('deleted_at')
          .whereNull('warehouse_code')
          .pluck('username');
        if (sinSucursal.length) {
          console.log(
            `  [SN.39] ⚠️ sin sucursal en su ficha (verán «de toda la red»): ${sinSucursal.join(', ')}`,
          );
        }
      }
    }
  }
};

exports.down = async function down(knex) {
  await knex('identity.position_responsibilities')
    .whereIn('position_code', PUESTOS)
    .whereIn(
      'responsibility_key',
      NUEVAS.map(([k]) => k),
    )
    .del();
  await knex('identity.responsibilities')
    .whereIn(
      'key',
      NUEVAS.map(([k]) => k),
    )
    .del();
};
