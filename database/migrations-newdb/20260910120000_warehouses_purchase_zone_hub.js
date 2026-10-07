/**
 * `[RA-PRO.48]` Zona de COMPRA y CEDIS de consolidación — el desglose de `/compras/pedido`.
 *
 * Pedido por Edgar 2026-09-10: agrupar los almacenes por zona en el desglose del pedido, y poder
 * decir por renglón si la mercancía se entrega **directo en la sucursal** o **consolidada en un
 * CEDIS**.
 *
 * ── Por qué DOS columnas nuevas y no reusar lo que hay (medido antes de agregarlas) ──────────
 *
 * 1. `warehouses.zone_id` NO sirve: apunta a `trade.zones`, que son territorios de **venta**, y su
 *    grano no es el de compras. Hoy Morelia está partida en dos zonas (`MORELIA ABASTOS` 10
 *    usuarios / `MORELIA MADERO` 4) y Zamora también (`CANINDO` / `ZAMORA`), mientras que para
 *    comprar son UNA zona cada una. Además su único consumidor es `UsersService.derivarZona()`
 *    (el default que propone el alta de usuarios, ver mig 20260907220000): reescribirla para
 *    agrupar compras le cambiaría el alcance propuesto a los usuarios nuevos de esas plazas.
 *
 * 2. `warehouses.source_warehouse_id` (topología DRP, RA-PRO.6) casi alcanza — ya dice
 *    `02→01`, `04→01`, `05→06`, `MD-32→MD-30`, y que `01`/`06`/`MD-30` cuelgan del `00`. Pero
 *    **no alcanza para la lista de CEDIS**: `03` 8ESQ también cuelga del `00`, así que derivar
 *    "es CEDIS = se abastece del 00" daría CINCO hubs y Edgar enumeró CUATRO (00, 01, Morelia
 *    Abastos, 06). Y `source_warehouse_id` responde otra pregunta —de dónde se RESURTE— que no
 *    tiene por qué coincidir siempre con dónde se RECIBE una compra consolidada.
 *
 * Por eso el dato se hace explícito y editable, en vez de deducirlo de una columna que significa
 * otra cosa. La alternativa era clavar el mapa código→zona en el frontend, y el propio workbook
 * de `/compras/pedido` declara "Cero códigos hardcodeados; columnas dinámicas".
 *
 * ── Sobre Morelia: el CEDIS es `MD-30`, no `08` ⭐ ────────────────────────────────────────────
 * Edgar lo dictó como "08 Morelia Abastos". **`08` no existe y no está planeado.** El patrón real
 * es el de `07` (mig 20260909160000): cuando una sucursal migra su POS de Wincaja a Kepler nace un
 * warehouse NUEVO con código numérico y el `MD-*` conserva la historia previa — Madero lo hizo el
 * 2026-09-08 y por eso hoy conviven `MD-32` (Wincaja, < 09-08) y `07` (Kepler, ≥ 09-08). Abastos
 * todavía es Wincaja puro (`wincaja_source_branch='30'`, sin `kepler_code`), así que su CEDIS hoy
 * es `MD-30`. Cuando migre y nazca `08`, esto se corrige **editando el dato** (mover el flag de
 * `MD-30` a `08`), sin tocar código: exactamente la razón por la que la bandera vive en la tabla.
 *
 * `07` se siembra como Morelia NO-hub por si la migración de Madero ya corrió en este entorno.
 *
 * ── Idempotencia ──────────────────────────────────────────────────────────────────────────────
 * Siembra SÓLO donde `purchase_zone IS NULL`. Un almacén ya configurado a mano (desde el admin)
 * no se pisa al re-correr, ni se le revierte el flag de CEDIS.
 *
 * @param { import("knex").Knex } knex
 */

/** [code, zona, ¿es CEDIS donde se puede consolidar una compra?] */
const SEED = [
  ['00',    'Corporativo', true],   // CEDIS Bpirapuato — servicio corporativo
  ['01',    'La Piedad',   true],   // CEDIS de la zona La Piedad
  ['02',    'La Piedad',   false],
  ['03',    'La Piedad',   false],
  ['04',    'La Piedad',   false],
  ['MD-30', 'Morelia',     true],   // CEDIS de la zona Morelia (será '08' cuando migre a Kepler)
  ['MD-32', 'Morelia',     false],
  ['07',    'Morelia',     false],
  ['06',    'Zamora',      true],   // CEDIS de la zona Zamora
  ['05',    'Zamora',      false],
];

exports.up = async function up(knex) {
  const hasZone = await knex.schema.withSchema('commercial').hasColumn('warehouses', 'purchase_zone');
  if (!hasZone) {
    await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => {
      t.text('purchase_zone').nullable();
    });
    await knex.raw(`COMMENT ON COLUMN commercial.warehouses.purchase_zone IS
      'RA-PRO.48 — zona de COMPRA (agrupa el desglose de /compras/pedido). NO es zone_id, que es territorio de venta de trade.zones y parte Morelia y Zamora en dos. Editable; NULL = sin agrupar.'`);
  }
  const hasHub = await knex.schema.withSchema('commercial').hasColumn('warehouses', 'is_purchase_hub');
  if (!hasHub) {
    await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => {
      t.boolean('is_purchase_hub').notNullable().defaultTo(false);
    });
    await knex.raw(`COMMENT ON COLUMN commercial.warehouses.is_purchase_hub IS
      'RA-PRO.48 — CEDIS donde se puede CONSOLIDAR una compra (00, 01, MD-30, 06). No se deriva de source_warehouse_id: ahí 03 también cuelga del 00 y daría cinco. Mover el flag cuando Abastos migre a Kepler y nazca 08.'`);
  }

  const tenants = await knex('tenants').select('id');
  for (const { id: tenantId } of tenants) {
    for (const [code, zone, hub] of SEED) {
      await knex('commercial.warehouses')
        .where({ tenant_id: tenantId, code })
        .whereNull('purchase_zone')          // no pisa lo configurado a mano
        .update({ purchase_zone: zone, is_purchase_hub: hub, updated_at: knex.fn.now() });
    }
  }
};

exports.down = async function down(knex) {
  // Columnas aditivas y sin consumidores fuera de la pantalla de pedido: se pueden retirar.
  const hasHub = await knex.schema.withSchema('commercial').hasColumn('warehouses', 'is_purchase_hub');
  if (hasHub) await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => t.dropColumn('is_purchase_hub'));
  const hasZone = await knex.schema.withSchema('commercial').hasColumn('warehouses', 'purchase_zone');
  if (hasZone) await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => t.dropColumn('purchase_zone'));
};
