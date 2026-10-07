'use strict';
/**
 * `[MKT.6]` — Datos de DESARROLLO para poder ver la pantalla de resultado con números reales.
 *
 * ── Por qué hace falta ───────────────────────────────────────────────────────────────────────
 * Medido 2026-09-28: los **21 canales** de los acuerdos sembrados por `[MKT.1]` devuelven
 * `sin_alcance`, porque los 6 códigos del formato tienen `product_id` en NULL. Con eso la
 * pantalla es correcta pero **está vacía de números**, y no se puede juzgar si sirve.
 *
 * Dos cosas, las dos idempotentes:
 *   1. **Liga los códigos** que tengan un SKU idéntico en el catálogo (los 6 resuelven exacto).
 *      Es lo mismo que el flujo de captura de `[MKT.1]` debería hacer al guardar el acuerdo.
 *   2. **Siembra un acuerdo de demostración** cuya vigencia cae DENTRO del rango con sell-out
 *      real, porque un acuerdo de septiembre contra datos que terminan en agosto sale
 *      `sin_venta` — correcto, pero no enseña nada.
 *
 * ⛔ **Escribe datos de negocio, así que se niega a correr fuera de local.** El destino tiene que
 * ser 127.0.0.1 o localhost; contra cualquier otro host aborta. No es paranoia: el mismo comando
 * con `DATABASE_URL_NEW` apuntando a prod metería un acuerdo inventado en la base de la empresa.
 *
 * NO es una migración ni un importer: es andamio de desarrollo. La regla ⭐ de cero importers
 * habla de datos que la app publica; esto existe para poder MIRAR la pantalla.
 *
 * Uso:  node database/scripts/dev-seed-promo-sellout.js
 *       node database/scripts/dev-seed-promo-sellout.js --limpiar   (borra sólo lo que sembró)
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const url = (process.env.DATABASE_URL_NEW || '').replace('localhost', '127.0.0.1');
if (!url) {
  console.error('Falta DATABASE_URL_NEW en el .env.');
  process.exit(1);
}
const host = new URL(url).hostname;
if (host !== '127.0.0.1' && host !== 'localhost') {
  console.error(`⛔ Este script sólo corre contra local. Destino: ${host}. Abortado.`);
  process.exit(1);
}

const knex = require('knex')({ client: 'pg', connection: { connectionString: url }, pool: { min: 1, max: 3 } });
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const FOLIO_DEMO = 'MK-DEMO-SELLOUT';
const limpiar = process.argv.includes('--limpiar');

(async () => {
  try {
    const hay = await knex.schema.withSchema('commercial').hasTable('promo_agreement_channels');
    if (!hay) {
      console.error('No existen las tablas de [MKT.1]: correr antes 20260928120000.');
      process.exit(2);
    }

    if (limpiar) {
      const n = await knex('commercial.promo_agreements').where({ tenant_id: T, folio: FOLIO_DEMO }).del();
      console.log(`  acuerdo de demostración borrado (${n}). Las ligas de product_id NO se revierten:`);
      console.log('  son correctas por sí mismas y es lo que el flujo de captura debería dejar.');
      await knex.destroy();
      return;
    }

    // ── 1. Ligar los códigos que resuelven exacto por SKU ────────────────────────────────────
    const ligados = await knex.raw(
      `UPDATE commercial.promo_agreement_codes k
          SET product_id = p.id
         FROM catalog.products p
        WHERE k.tenant_id = ?
          AND k.product_id IS NULL
          AND p.tenant_id = k.tenant_id
          AND p.deleted_at IS NULL
          AND btrim(p.sku) = btrim(k.code)`,
      [T],
    );
    console.log(`  1. códigos ligados por SKU: ${ligados.rowCount}`);

    // ── 2. Un acuerdo cuya vigencia cae donde SÍ hay sell-out ────────────────────────────────
    const ya = await knex('commercial.promo_agreements').where({ tenant_id: T, folio: FOLIO_DEMO }).first();
    if (ya) {
      console.log('  2. el acuerdo de demostración ya existe (idempotente).');
    } else {
      // El mejor par (plaza, producto) con historia densa y un solo peldaño: el mismo criterio
      // que usa el smoke, para que los dos miren el mismo hecho.
      const { rows: cand } = await knex.raw(
        `SELECT s.warehouse_code, s.product_id, min(s.sku) AS sku,
                min(s.business_date) AS d0, max(s.business_date) AS d1
           FROM analytics.v_sellout_daily s
           JOIN commercial.warehouses w
             ON w.tenant_id = s.tenant_id AND w.code = s.warehouse_code AND w.deleted_at IS NULL
          WHERE s.tenant_id = ?
          GROUP BY 1, 2
         HAVING count(*) >= 40 AND count(DISTINCT s.unit_kind) = 1
          ORDER BY count(*) DESC
          LIMIT 3`,
        [T],
      );
      if (!cand.length) {
        console.log('  2. ⚠️  no hay (plaza, producto) con >=40 días de sell-out: no se siembra nada.');
        await knex.destroy();
        return;
      }

      const iso = (d) => new Date(d).toISOString().slice(0, 10);
      // Ventana de 14 días que termina 7 días antes del final de los datos, para que la línea
      // base (los 14 anteriores) también caiga dentro del rango.
      const fin = new Date(cand[0].d1); fin.setDate(fin.getDate() - 7);
      const ini = new Date(fin); ini.setDate(ini.getDate() - 13);

      const [ag] = await knex('commercial.promo_agreements').insert({
        tenant_id: T,
        folio: FOLIO_DEMO,
        empresa: 'MEGA DULCES',
        proveedor: 'PROVEEDOR DEMO (sembrado para ver la pantalla)',
        fecha_negociacion: iso(ini),
        vigencia_desde: iso(ini),
        vigencia_hasta: iso(fin),
        mecanica: 'Exhibición en piso de venta durante 14 días',
        oferta_negociada: 'Demostración de [MKT.6]: vigencia dentro del rango con sell-out real.',
        recurso: 'cedis_nota_credito',
        monto: 25000,
        status: 'vigente',
        authorized_at: knex.fn.now(),
        authorized_by: T,
        authorized_by_username: 'seed-dev',
      }).returning('id');
      const agreementId = ag.id || ag;

      // Un código por candidato: así el acuerdo cubre varios SKUs, como uno real.
      let pos = 0;
      for (const c of cand) {
        pos += 1;
        await knex('commercial.promo_agreement_codes').insert({
          tenant_id: T, agreement_id: agreementId, position: pos,
          code: c.sku, descripcion: `SKU ${c.sku}`, product_id: c.product_id,
        });
      }

      // Un canal por plaza distinta de los candidatos.
      const plazas = [...new Set(cand.map((c) => c.warehouse_code))];
      for (const code of plazas) {
        const wh = await knex('commercial.warehouses')
          .select('id', 'name').where({ tenant_id: T, code }).whereNull('deleted_at').first();
        if (!wh) continue;
        await knex('commercial.promo_agreement_channels').insert({
          tenant_id: T, agreement_id: agreementId,
          warehouse_id: wh.id, warehouse_code: code, warehouse_name: wh.name,
          evidence_required: 2, evidence_count: 0,
        });
      }
      console.log(`  2. acuerdo ${FOLIO_DEMO} sembrado: ${iso(ini)} → ${iso(fin)}, ` +
        `${cand.length} código(s), ${plazas.length} plaza(s).`);
    }

    // ── 3. Qué se ve ahora ───────────────────────────────────────────────────────────────────
    const { rows: est } = await knex.raw(
      `SELECT medicion, count(*)::int AS n FROM commercial.v_promo_agreement_sellout
        WHERE tenant_id = ? GROUP BY 1 ORDER BY 2 DESC`, [T],
    );
    console.log('\n  Estado de la medición:');
    for (const r of est) console.log(`    ${String(r.medicion).padEnd(14)} ${r.n}`);
  } catch (e) {
    console.error('  ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
