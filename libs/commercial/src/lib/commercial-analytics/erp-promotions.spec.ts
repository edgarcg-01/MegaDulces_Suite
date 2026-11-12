import { CommercialAnalyticsService } from './commercial-analytics.service';
import { ERP_PROMOTIONS_SQL, MECANISMO_A_PROMO_TYPE, toErpPromoRow } from './erp-promotions';

/**
 * `[MKT.7]` «Promos ERP» salía vacía con 328 reglas vigentes en Kepler: leía una vista clavada en
 * la sucursal 03 (0 vigentes). Estas pruebas fijan de DÓNDE lee y CÓMO dice el beneficio.
 */
describe('MKT.7 · Promos ERP', () => {
  describe('fuente', () => {
    it('lee v_erp_discount_rules (todas las tiendas), no la vieja erp_promotions clavada en la 03', () => {
      expect(ERP_PROMOTIONS_SQL).toContain('analytics.v_erp_discount_rules');
      expect(ERP_PROMOTIONS_SQL).not.toMatch(/analytics\.erp_promotions\b/);
      expect(ERP_PROMOTIONS_SQL).not.toMatch(/sucursal\s*=\s*'03'/);
    });

    it('acota por tenant con un parámetro, no con el UUID incrustado', () => {
      expect(ERP_PROMOTIONS_SQL).toContain('p.tenant_id = ?');
      expect(ERP_PROMOTIONS_SQL).not.toContain('00000000-0000-0000-0000-00000000d01c');
    });

    it('el servicio corre ESE SQL con el tenant y mapea cada renglón', async () => {
      const llamadas: Array<{ sql: string; binds: unknown[] }> = [];
      const trx = {
        raw: async (sql: string, binds: unknown[]) => {
          llamadas.push({ sql, binds });
          return { rows: [{ sku: '88219', product_name: 'GALLETA', mecanismo: 'descuento_cantidad', unit: 'PAQ', threshold: '1.00', threshold_verified: true, pct: '50.00', free_qty: null, valid_from: '2026-10-13', valid_to: '2026-11-13', warehouse_code: 'Morelia Madero' }] };
        },
      };
      const svc = Object.create(CommercialAnalyticsService.prototype) as CommercialAnalyticsService;
      Object.assign(svc, {
        tenantCtx: { requireTenantId: () => 't-1' },
        tk: { run: (fn: (t: unknown) => unknown) => fn(trx) },
      });
      const filas = await svc.erpPromotions();
      expect(llamadas).toHaveLength(1);
      expect(llamadas[0].sql).toBe(ERP_PROMOTIONS_SQL);
      expect(llamadas[0].binds).toEqual(['t-1']);
      expect(filas[0]).toMatchObject({ sku: '88219', promo_type: 'descuento_qty', benefit_kind: 'pct', benefit: 50, threshold: 1, unit: 'PAQ' });
    });

    it('sin reglas vigentes devuelve lista vacía, no revienta', async () => {
      const svc = Object.create(CommercialAnalyticsService.prototype) as CommercialAnalyticsService;
      Object.assign(svc, {
        tenantCtx: { requireTenantId: () => 't-1' },
        tk: { run: (fn: (t: unknown) => unknown) => fn({ raw: async () => ({ rows: [] }) }) },
      });
      await expect(svc.erpPromotions()).resolves.toEqual([]);
    });
  });

  describe('toErpPromoRow', () => {
    it('los cuatro mecanismos conservan el promo_type que ya hablaban la pantalla y Thot', () => {
      expect(MECANISMO_A_PROMO_TYPE).toEqual({
        descuento_cantidad: 'descuento_qty',
        gratis_cantidad: 'gratis_qty',
        descuento_monto: 'descuento_monto',
        gratis_monto: 'gratis_monto',
      });
    });

    it('un descuento es PORCENTAJE (c6), no pesos', () => {
      const r = toErpPromoRow({ mecanismo: 'descuento_cantidad', pct: '33.00', free_qty: '9', free_product_name: 'X' });
      expect(r.benefit_kind).toBe('pct');
      expect(r.benefit).toBe(33);
      // Un descuento no regala nada: el nombre del gratis no se cuela aunque venga.
      expect(r.free_product_name).toBeNull();
    });

    it('un gratis es CANTIDAD regalada, con su producto y su presentación', () => {
      const r = toErpPromoRow({ mecanismo: 'gratis_cantidad', pct: null, free_qty: '1.00', free_product_name: 'LECHE 1 LT', free_unit: 'PZA' });
      expect(r).toMatchObject({ promo_type: 'gratis_qty', benefit_kind: 'free_qty', benefit: 1, free_product_name: 'LECHE 1 LT', free_unit: 'PZA' });
    });

    it('nulos y vacíos se quedan nulos — no se dibujan como cero', () => {
      const r = toErpPromoRow({ mecanismo: 'descuento_cantidad', pct: null, threshold: '', valid_from: null });
      expect(r.benefit).toBeNull();
      expect(r.threshold).toBeNull();
      expect(r.valid_from).toBeNull();
    });

    it('un número ilegible no se vuelve NaN', () => {
      expect(toErpPromoRow({ mecanismo: 'descuento_cantidad', pct: 'abc' }).benefit).toBeNull();
    });

    it('el umbral por MONTO sale no verificado; sólo true literal lo verifica', () => {
      expect(toErpPromoRow({ mecanismo: 'descuento_monto', threshold_verified: false }).threshold_verified).toBe(false);
      expect(toErpPromoRow({ mecanismo: 'descuento_monto', threshold_verified: 'true' }).threshold_verified).toBe(false);
    });

    it('la fecha sale como YYYY-MM-DD, venga como Date o como texto', () => {
      expect(toErpPromoRow({ mecanismo: 'gratis_monto', valid_to: '2026-12-30T00:00:00' }).valid_to).toBe('2026-12-30');
      expect(toErpPromoRow({ mecanismo: 'gratis_monto', valid_to: new Date(Date.UTC(2026, 11, 30, 6)) }).valid_to).toBe('2026-12-30');
    });

    it('un mecanismo desconocido no se pierde: pasa tal cual', () => {
      expect(toErpPromoRow({ mecanismo: 'otro' }).promo_type).toBe('otro');
    });
  });
});
