/**
 * RS.11b — Ocultar vendedores "sin información" (no son personas) de las vistas por vendedor.
 *
 * En el canal mayoreo/RD/RV de Wincaja hay códigos que NO son un vendedor real: buckets
 * estructurales (`00` = venta de piso/mostrador, `99` = traspaso a sucursal), nulos, y
 * etiquetas genéricas (OMNICANAL, RUTA 23, USUARIO 02, VENTA VECINAL). No aportan
 * "información de vendedor" → se sacan del desglose por vendedor y del slicer.
 *
 * Dos capas: (1) regla OBJETIVA en el servicio (vendedor nulo/vacío, o código '00'/'99');
 * (2) flag `exclude` CURADO aquí para los genéricos con código propio. Auditable/reversible.
 *
 * @param { import("knex").Knex } knex
 */
const MEGA = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasColumn('vendor_identity', 'exclude'))) {
    await knex.raw(`ALTER TABLE analytics.vendor_identity ADD COLUMN exclude boolean NOT NULL DEFAULT false`);
  }
  // Genéricos "sin vendedor" con código propio (no los pesca la regla 00/99). key propia = no merge.
  const noise = [
    { br: '10', cod: '01', name: 'Omnicanal' },
    { br: '10', cod: '23', name: 'Ruta 23' },
    { br: '10', cod: '43', name: 'Venta Vecinal 02' },
    { br: '30', cod: '23', name: 'Usuario 02' },
    { br: '50', cod: '15', name: 'Venta Vecinal' },
  ];
  for (const n of noise) {
    await knex.raw(
      `INSERT INTO analytics.vendor_identity (tenant_id, source_branch, vendedor, canonical_key, canonical_name, exclude, note)
       VALUES (?, ?, ?, ?, ?, true, 'no es vendedor (genérico/bucket) — oculto del desglose')
       ON CONFLICT (tenant_id, source_branch, vendedor)
       DO UPDATE SET exclude = true, updated_at = now()`,
      [MEGA, n.br, n.cod, `noise-${n.br}-${n.cod}`, n.name],
    );
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('analytics').hasColumn('vendor_identity', 'exclude')) {
    await knex.raw(`ALTER TABLE analytics.vendor_identity DROP COLUMN exclude`);
  }
};
