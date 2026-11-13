import { readFileSync } from 'fs';
import { join } from 'path';
import { declararFechado } from './por-vencer';

/**
 * `[CE.1.4] · [CE.1.7]` Por vencer declara cuando un lote fechado puede estar ya vendido. Lo sin fecha
 * = existencia de Kepler del ODS − lo fechado de la celda (ya no el lote NA de la copia del importer).
 */
describe('[CE.1.7] declararFechado', () => {
  it('⭐ con existencia sin fecha (> 0) el lote fechado puede estar ya vendido', () => {
    expect(declararFechado('1300', '50')).toEqual({ stock_erp: 1300, dated_qty: 50, na_qty: 1250, dated_may_be_stale: true });
  });

  it('⭐ lo fechado excede la existencia de Kepler: parte YA se vendió (negativo, se declara)', () => {
    expect(declararFechado(10, '40')).toEqual({ stock_erp: 10, dated_qty: 40, na_qty: -30, dated_may_be_stale: true });
  });

  it('existencia = lo fechado: la cantidad se puede creer', () => {
    expect(declararFechado('24.0000', 24)).toEqual({ stock_erp: 24, dated_qty: 24, na_qty: 0, dated_may_be_stale: false });
  });

  it('el double de Kepler no inventa un sobrante de 0.0000001', () => {
    expect(declararFechado(0.1 + 0.2, 0.3).dated_may_be_stale).toBe(false);
  });

  it('⛔ sin existencia del ODS (sin renglón o almacén no Kepler) se declara NULL, nunca «cierto»', () => {
    expect(declararFechado(null, 24)).toEqual({ stock_erp: null, dated_qty: 24, na_qty: null, dated_may_be_stale: null });
    expect(declararFechado(undefined, 24).dated_may_be_stale).toBeNull();
    expect(declararFechado('no-numero', 24).dated_may_be_stale).toBeNull();
  });
});

describe('[CE.1.7] la consulta de Por vencer deriva lo sin fecha del ODS', () => {
  const FUENTE = readFileSync(join(__dirname, 'commercial-inventory.service.ts'), 'utf8');
  const bloque = FUENTE.slice(FUENTE.indexOf('async listExpiring('), FUENTE.indexOf('async listLotMovements('));

  it('lo sin fecha sale del ODS (existencia Kepler de la celda) y lo fechado de la MISMA celda', () => {
    expect(bloque).toContain('FROM analytics.v_erp_stock_on_hand e');
    expect(bloque).toMatch(/e.warehouse_id = l.warehouse_id AND e.product_id = l.product_id AND e.source = 'kepler_ods'/);
    expect(bloque).toMatch(/d.tenant_id = l.tenant_id AND d.warehouse_id = l.warehouse_id AND d.product_id = l.product_id/);
    expect(bloque).toMatch(/d.expiry_date IS NOT NULL AND d.quantity > 0/);
    // ⛔ ni el lote NA (lo cuadra un trigger contra la copia del importer) ni la copia misma
    expect(bloque).not.toContain("lot_code = 'NA'");
    expect(bloque).not.toContain('commercial.stock ');
    expect(bloque).not.toContain("'commercial.stock'");
  });

  it('[CE.1.6] el costo es el resolvedor VIVO, celda por celda (sin enumerar la vista, sin copia ni refresco)', () => {
    expect(bloque).toContain(".withMaterialized('lotes', lotes)");
    expect(bloque).toMatch(/LEFT JOIN LATERAL analytics\.erp_unit_cost_at\(l\.warehouse_id, l\.product_id\) uc ON uc\.tenant_id = l\.tenant_id/);
    // ⛔ ni el JOIN directo a la vista (31 s: la recalcula por lote), ni enumerarla (1.4 s), ni la copia con cron
    expect(bloque).not.toContain('analytics.v_erp_unit_cost');
    expect(bloque).not.toContain('mv_erp_unit_cost');
  });

  it('cada renglón sale con su declaración y con la sucursal de Kepler (para casar el juicio)', () => {
    expect(bloque).toContain('declararFechado(r.stock_erp, r.dated_qty)');
    expect(bloque).toContain("'w.kepler_code as plaza'");
  });
});
