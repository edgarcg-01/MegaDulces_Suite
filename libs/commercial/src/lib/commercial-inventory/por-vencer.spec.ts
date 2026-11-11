import { readFileSync } from 'fs';
import { join } from 'path';
import { declararFechado } from './por-vencer';

/**
 * `[CE.1.4]` Por vencer declara cuando un lote fechado puede estar ya vendido: el trigger
 * `fn_rebalance_stock_lots` descuenta primero lo sin fecha (lote `NA`) del mismo almacén × producto.
 */
describe('[CE.1.4] declararFechado', () => {
  it('⭐ con NA > 0 el lote fechado puede estar ya vendido (caso NA mayor que lo fechado)', () => {
    expect(declararFechado('1250.000')).toEqual({ na_qty: 1250, dated_may_be_stale: true });
    expect(declararFechado(0.5)).toEqual({ na_qty: 0.5, dated_may_be_stale: true });
  });

  it('sin NA, el lote sí baja con la venta: no se marca', () => {
    expect(declararFechado('0')).toEqual({ na_qty: 0, dated_may_be_stale: false });
    expect(declararFechado(0)).toEqual({ na_qty: 0, dated_may_be_stale: false });
  });

  it('⛔ si no se pudo leer el NA se declara NULL, nunca «cierto» (false)', () => {
    expect(declararFechado(null)).toEqual({ na_qty: null, dated_may_be_stale: null });
    expect(declararFechado(undefined)).toEqual({ na_qty: null, dated_may_be_stale: null });
    expect(declararFechado('no-numero')).toEqual({ na_qty: null, dated_may_be_stale: null });
  });
});

describe('[CE.1.4] la consulta de Por vencer lee el NA correcto', () => {
  const FUENTE = readFileSync(join(__dirname, 'commercial-inventory.service.ts'), 'utf8');
  const bloque = FUENTE.slice(FUENTE.indexOf('async listExpiring('), FUENTE.indexOf('async listLotMovements('));

  it('el NA es el del MISMO tenant × almacén × producto, lote NA sin fecha (el que mueve el trigger)', () => {
    expect(bloque).toMatch(/n\.tenant_id = l\.tenant_id AND n\.warehouse_id = l\.warehouse_id AND n\.product_id = l\.product_id/);
    expect(bloque).toMatch(/n\.lot_code = 'NA' AND n\.expiry_date IS NULL/);
  });

  it('cada renglón sale con su declaración y con la sucursal de Kepler (para casar el juicio)', () => {
    expect(bloque).toContain('declararFechado(r.na_qty)');
    expect(bloque).toContain("'w.kepler_code as plaza'");
  });
});
