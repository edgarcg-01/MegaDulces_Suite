// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver requisicion-oc.spec.ts).
import { readFileSync } from 'fs';
import { join } from 'path';
import { bajoReorden, cumplimientoSoloCompra, segunReorden } from './faltante';

/**
 * `[PQ.44]` D33: la mesa y `/compras/pedido` piden con la MISMA regla de reorden. Medido el
 * 2026-11-04 con los dos servicios contra prod (sólo lectura): «Pedido lo pide y la mesa no» pasó
 * de 681 renglones a 2 y las otras diferencias no se movieron.
 */
const SVC = readFileSync(join(__dirname, 'commercial-replenishment.service.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

describe('[PQ.44] la regla de reorden (D33)', () => {
  it('en o bajo el reorden, con la existencia a la izquierda', () => {
    expect(bajoReorden('x', 'r')).toBe('(x <= r)');
  });

  it('sin reorden (sin política) no frena; arriba del reorden pide 0', () => {
    expect(segunReorden('x', 'r', 'q')).toBe('(CASE WHEN r IS NULL OR (x <= r) THEN q ELSE 0 END)');
  });

  it('⛔ la mesa (criticalStock) usa el primitivo, no una comparación propia', () => {
    expect(SVC).toContain(`b.andWhereRaw(bajoReorden(oh, 'rp.reorder_point'))`);
    expect(SVC).not.toMatch(/\$\{oh\} <= rp\.reorder_point`\)/);
  });

  it('[D26] el cumplimiento se aplica sólo si NO es traspaso', () => {
    expect(cumplimientoSoloCompra('t', 'f')).toBe('(CASE WHEN t THEN 1.0 ELSE f END)');
  });

  it('⛔ [D26] Pedido multiplica por el cumplimiento a través del primitivo, y la celda dice si fue traspaso', () => {
    expect(SVC).toContain('* ${cumplimientoSoloCompra(TRASPASO, FILLF)})::numeric, 1)');
    expect(SVC).not.toMatch(/\) \* \$\{FILLF\}\)::numeric, 1\)/);
    expect(SVC).toContain(`const TRASPASO = \`bool_and(COALESCE(b.canal_via, '') = 'transfer')\`;`);
    expect(SVC).toContain('LEFT JOIN commercial.replenishment_channel rcw ON rcw.tenant_id = pr.tenant_id AND rcw.warehouse_id = rp.warehouse_id AND rcw.supplier_id = pr.supplier_id');
    expect(SVC).toContain(`'trf', CASE WHEN traspaso THEN true END`);
  });

  it('⛔ [D25] la cobertura de cada almacén es la de la mesa y multiplica ANTES de sumar', () => {
    // Medido el 2026-11-04: en las 8 sucursales, el modo 'sucursal' da EXACTAMENTE lo que fijar a
    // mano la cobertura de la mesa (0 diferencias en 25,296 renglones).
    expect(SVC).toContain(`const COV_ROW = porSucursal ? coberturaAutoabastoSql('w.code') : ':cov::numeric';`);
    expect(SVC).toContain('${COV_ROW} AS cov_dias,');
    expect(SVC).toContain('COALESCE(sum(b.daily_pieces * b.cov_dias),0) * COALESCE(max(b.season_ratio),1) / (');
    expect(SVC).not.toContain('COALESCE(sum(b.daily_pieces),0) * COALESCE(max(b.season_ratio),1) * :cov');
  });

  it('⛔ Pedido (workbook y su detalle) frena arriba del reorden con el MISMO primitivo', () => {
    expect(SVC).toContain(`segunReorden('COALESCE(sum(b.stock_pz),0)', 'sum(b.rop_reorder)',`);
    expect(SVC).toContain(`segunReorden('rp.stock_pz', 'rop.reorder_point',`);
    expect(SVC).toContain('LEFT JOIN commercial.reorder_policy rop ON rop.tenant_id = rp.tenant_id AND rop.product_id = rp.product_id AND rop.warehouse_id = rp.warehouse_id');
  });
});
