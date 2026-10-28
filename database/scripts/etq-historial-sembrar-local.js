#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[ETQ-HISTORIAL.0.2]` Siembra REVERSIBLE y sintética para probar «Historial de precios» en la base LOCAL (`:5442`).
 *
 *   node database/scripts/etq-historial-sembrar-local.js            # siembra (idempotente: borra lo suyo y vuelve a poner)
 *   node database/scripts/etq-historial-sembrar-local.js --borrar   # deja la base como estaba
 *
 * ⛔ Sólo corre contra 127.0.0.1:5442. Nunca prod. Todo lo que pone lleva la marca `ETQ-HIST-SEED`
 *    (`kdpv_bitacora_precios.c9` y `catalog.products.description`) y por eso `--borrar` no toca nada ajeno.
 *
 * Casos (cada uno existe porque la medición en prod los encontró o porque la pantalla debe distinguirlos):
 *   99001  «el 92013 de prod»: 9 plazas × 98 días; Kepler reescribe el MISMO cambio 5–8 veces por día (676 de 686
 *          pasos repetidos en prod) y el precio sólo cambia ~21 veces en 2 años. Pieza CJA + 13 filas de PAQ.
 *   99002  ida y vuelta A→B→A ($10 → $12 → $10) sólo en la plaza 06: son TRES precios, no dos.
 *   99003  Kepler le quita el precio (nuevo = 0.00) en la plaza 02: no es una rebaja.
 *   99004  existe en el catálogo y NO tiene ni una fila en la bitácora: «sin cambios», no «sin historial».
 */
const path = require('node:path');
const req = require('node:module').createRequire(path.resolve(__dirname, '..', '..', 'package.json'));
req('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = req('knex')(require('../knexfile-newdb.js').development);

const MARCA = 'ETQ-HIST-SEED';
const PLAZAS = ['00', '01', '02', '03', '04', '05', '06', '07', '08'];
const TENANT = '00000000-0000-0000-0000-00000000d01c';

const dia = (atras) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - atras);
  return d;
};
const hh = (n) => {
  const s = 6 * 3600 + n * 1713; // hora creciente y distinta por fila
  const z = (x) => String(x).padStart(2, '0');
  return `${z(Math.floor(s / 3600) % 24)}:${z(Math.floor(s / 60) % 60)}:${z(s % 60)}.${String(n % 100).padStart(2, '0')}`;
};
const fila = (sucursal, d, n, sku, unidad, nombre, ant, nvo) => ({
  sucursal, c1: d, c2: hh(n), c3: sku, c4: unidad, c5: nombre, c6: ant, c7: nvo, c8: +(nvo - ant).toFixed(4), c9: MARCA,
});

async function main() {
  const c = knex.client.config.connection;
  const host = c.host ?? /@([^:/]+)/.exec(c.connectionString ?? '')?.[1];
  const port = String(c.port ?? /:(\d+)\//.exec(c.connectionString ?? '')?.[1]);
  if (!['127.0.0.1', 'localhost'].includes(host) || port !== '5442') throw new Error(`Sólo contra la base local 127.0.0.1:5442 (hay ${host}:${port}). No siembro.`);

  await knex('kepler_ods.kdpv_bitacora_precios').where({ c9: MARCA }).del();
  await knex('catalog.products').where({ tenant_id: TENANT, description: MARCA }).del();
  if (process.argv.includes('--borrar')) {
    console.log('✓ borrado: bitácora y catálogo sintéticos (marca', MARCA + ')');
    return;
  }

  const brand = (await knex('catalog.products').whereNot({ description: MARCA }).first('brand_id'))?.brand_id
    ?? (await knex('catalog.brands').first('id'))?.id;
  if (!brand) throw new Error('No hay ninguna marca en el catálogo local para colgar los productos sintéticos.');
  const productos = [
    ['99001', 'SEED VASO REPETIDO 25P'], ['99002', 'SEED IDA Y VUELTA'], ['99003', 'SEED SIN PRECIO'], ['99004', 'SEED SIN CAMBIOS'],
  ];
  await knex('catalog.products').insert(productos.map(([sku, nombre]) => ({
    tenant_id: TENANT, brand_id: brand, sku, nombre, description: MARCA, activo: true,
  })));

  const filas = [];
  // 99001 — 98 días; el precio de la caja sube ~7.5 por escalón cada ~5 días (21 escalones) y cada día Kepler
  // reescribe el último movimiento 5–8 veces.
  for (const plaza of PLAZAS) {
    let nivel = 1000 + Number(plaza) * 3;
    for (let atras = 98; atras >= 0; atras--) {
      const d = dia(atras);
      let n = 0;
      if (atras % 5 === 0) {
        const previo = nivel;
        nivel = +(nivel + 7.5).toFixed(2);
        filas.push(fila(plaza, d, n++, '99001', 'CJA', 'SEED VASO REPETIDO 25P', previo, nivel));
      }
      const veces = 5 + ((atras + Number(plaza)) % 4);
      for (let k = 0; k < veces; k++) filas.push(fila(plaza, d, n++, '99001', 'CJA', 'SEED VASO REPETIDO 25P', +(nivel - 0.01).toFixed(2), nivel));
    }
    for (let k = 0; k < 13; k++) filas.push(fila(plaza, dia(90 - k * 6), k, '99001', 'PAQ', 'SEED VASO REPETIDO 25P', 24.2 + k, 25.2 + k));
  }
  // 99002 — A→B→A sólo en 06 (cada movimiento reescrito 2 veces)
  for (const [atras, ant, nvo] of [[58, 10, 12], [27, 12, 10]]) {
    for (let k = 0; k < 2; k++) filas.push(fila('06', dia(atras), k, '99002', 'PZA', 'SEED IDA Y VUELTA', ant, nvo));
  }
  // 99003 — Kepler le quita el precio en 02
  filas.push(fila('02', dia(8), 0, '99003', 'PZA', 'SEED SIN PRECIO', 45.5, 0));

  for (let i = 0; i < filas.length; i += 500) await knex('kepler_ods.kdpv_bitacora_precios').insert(filas.slice(i, i + 500));
  const v = await knex.raw(`select sku, count(*) n, count(distinct sucursal) plazas from analytics.v_label_price_changes where sku like '9900%' group by 1 order by 1`);
  console.log(`✓ sembradas ${filas.length} filas en la bitácora y 4 productos. La vista los ve así:`);
  console.table(v.rows);
}

main().catch((e) => { console.error('✖', e.message); process.exitCode = 1; }).finally(() => knex.destroy());
