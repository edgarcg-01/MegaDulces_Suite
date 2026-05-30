/**
 * Seed: promociones de muestra para Mega Dulces.
 *
 * Crea 1 promo por cada uno de los 6 tipos soportados, usando productos
 * REALES del catálogo (resuelve product_ids on-the-fly). Si el catálogo
 * no tiene suficientes productos, salta los tipos que no puede armar.
 *
 * Idempotente: onConflict por (tenant_id, code).
 *
 * Tipos cubiertos:
 *   - percent_off_basket    : 10% off canasta entera (no requiere productos)
 *   - percent_off_product   : 15% off de UN producto top
 *   - nxm                   : 3x2 en otro producto
 *   - volume_discount       : 5%/10%/15% escalonado por volumen
 *   - bundle_fixed_price    : 2 productos a precio fijo
 *   - cross_sell_discount   : compra X, lleva Y con 20% off
 *
 * @param { import("knex").Knex } knex
 */
exports.seed = async function (knex) {
  const TENANT_ID = '00000000-0000-0000-0000-00000000d01c';

  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT_ID}'`);

    // CRÍTICO: solo elegimos productos que TENGAN precio en la price_list
    // default del tenant. Si pickeamos productos sin precio, el portal los
    // filtra con "Los productos de esta promo no están en tu lista de precios"
    // y la promo es inservible.
    const defaultPriceList = await trx('commercial.price_lists')
      .where({ tenant_id: TENANT_ID, is_default: true })
      .whereNull('deleted_at')
      .first('id', 'code');

    if (!defaultPriceList) {
      console.warn(`[07_promotions] sin default price_list — saltando seed.`);
      return;
    }

    const products = await trx('public.products as p')
      .join('commercial.product_prices as pp', function () {
        this.on('pp.product_id', '=', 'p.id').andOn('pp.tenant_id', '=', 'p.tenant_id');
      })
      .where('p.tenant_id', TENANT_ID)
      .where('p.activo', true)
      .whereNull('p.deleted_at')
      .where('pp.price_list_id', defaultPriceList.id)
      .whereNull('pp.deleted_at')
      .orderBy('p.nombre', 'asc')
      .limit(6)
      .select('p.id', 'p.nombre');

    if (products.length < 6) {
      console.warn(
        `[07_promotions] solo hay ${products.length} productos con precio en '${defaultPriceList.code}'. ` +
          `Promos product-specific se skippean. Cargá más precios y re-corré el seed.`,
      );
    }

    const get = (i) => (products[i] ? products[i].id : null);
    const now = new Date();
    const inDays = (d) => new Date(now.getTime() + d * 86400000);

    const promos = [
      {
        code: 'BASKET-10',
        name: '10% off en tu pedido',
        description: 'Descuento del 10% al total del pedido cuando supera $500.',
        promotion_type: 'percent_off_basket',
        rules: { percent: 0.1 },
        priority: 100,
        min_order_amount: 500,
        ends_at: inDays(60),
        active: true,
      },
      get(0) && {
        code: 'OFF-15-A',
        name: `15% off en ${products[0].nombre}`,
        description: 'Descuento directo de 15% al precio unitario.',
        promotion_type: 'percent_off_product',
        rules: { product_id: get(0), percent: 0.15 },
        priority: 50,
        ends_at: inDays(30),
        active: true,
      },
      get(1) && {
        code: '3X2-B',
        name: `3x2 en ${products[1].nombre}`,
        description: 'Compra 3, pagás 2. La unidad más barata gratis.',
        promotion_type: 'nxm',
        rules: { product_id: get(1), n_buy: 3, m_pay: 2 },
        priority: 50,
        ends_at: inDays(45),
        active: true,
      },
      get(2) && {
        code: 'VOL-C',
        name: `Descuento por volumen en ${products[2].nombre}`,
        description: 'Más unidades, mejor precio: 5/10/15% a partir de 12/24/48 piezas.',
        promotion_type: 'volume_discount',
        rules: {
          product_id: get(2),
          tiers: [
            { min_qty: 12, percent: 0.05 },
            { min_qty: 24, percent: 0.1 },
            { min_qty: 48, percent: 0.15 },
          ],
        },
        priority: 60,
        ends_at: inDays(90),
        active: true,
      },
      get(3) && get(4) && {
        code: 'BUNDLE-DE',
        name: 'Combo dulce',
        description: '2 productos seleccionados a precio fijo.',
        promotion_type: 'bundle_fixed_price',
        rules: {
          items: [
            { product_id: get(3), quantity: 1 },
            { product_id: get(4), quantity: 1 },
          ],
          price: 199.99,
        },
        priority: 70,
        ends_at: inDays(30),
        active: true,
      },
      get(0) && get(5) && {
        code: 'CROSS-AF',
        name: 'Llevátelo también',
        description: 'Comprá el primero y obtené 20% off en el segundo.',
        promotion_type: 'cross_sell_discount',
        rules: {
          trigger_product_id: get(0),
          target_product_id: get(5),
          percent: 0.2,
        },
        priority: 80,
        ends_at: inDays(45),
        active: true,
      },
    ].filter(Boolean);

    if (promos.length === 0) {
      console.warn(`[07_promotions] sin productos suficientes — no se crearon promos.`);
      return;
    }

    let inserted = 0;
    let updated = 0;
    for (const p of promos) {
      const row = {
        tenant_id: TENANT_ID,
        code: p.code,
        name: p.name,
        description: p.description,
        promotion_type: p.promotion_type,
        rules: JSON.stringify(p.rules),
        priority: p.priority,
        starts_at: null,
        ends_at: p.ends_at,
        usage_limit: null,
        usage_count: 0,
        min_order_amount: p.min_order_amount ?? null,
        applies_to: 'all_customers',
        applies_to_customer_ids: null,
        active: p.active,
      };

      const existing = await trx('commercial.promotions')
        .where({ tenant_id: TENANT_ID, code: p.code })
        .first('id');

      if (existing) {
        await trx('commercial.promotions')
          .where({ id: existing.id })
          .update({
            name: row.name,
            description: row.description,
            promotion_type: row.promotion_type,
            rules: row.rules,
            priority: row.priority,
            ends_at: row.ends_at,
            min_order_amount: row.min_order_amount,
            active: row.active,
            updated_at: trx.fn.now(),
          });
        updated++;
      } else {
        await trx('commercial.promotions').insert(row);
        inserted++;
      }
    }

    console.log(
      `[07_promotions] ${inserted} insertadas, ${updated} actualizadas — total ${promos.length} promos activas.`,
    );
  });
};
