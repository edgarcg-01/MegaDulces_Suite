// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver requisicion-oc.spec.ts).
import { readFileSync } from 'fs';
import { join } from 'path';
import { CommercialReplenishmentService } from './commercial-replenishment.service';

/**
 * `[PQ.10]` Los rótulos de la escalera de Kepler y la etiquetera se leen para los renglones
 * devueltos, no dentro de la consulta del workbook. Medido el 2026-11-04 con las dos versiones contra
 * prod (sólo lectura): 10 escenarios con la respuesta idéntica; la red de 2.7 s a 2.2 s, con
 * proveedor de 1.5 s a 1.0 s, una sucursal de 1.4 s a 0.8 s.
 */
const SVC = readFileSync(join(__dirname, 'commercial-replenishment.service.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

type Fila = Record<string, unknown>;
const rotulos = (svc: CommercialReplenishmentService) =>
  (svc as unknown as { rotulosDePagina: (trx: unknown, t: string, f: Fila[]) => Promise<void> }).rotulosDePagina.bind(svc);

const armar = (lad: Fila[], lp: Fila[]) => {
  const consultas: Array<{ sql: string; b: unknown[] }> = [];
  const trx = {
    raw: async (sql: string, b: unknown[]) => {
      consultas.push({ sql, b });
      return { rows: sql.includes('v_supplier_cost_ladder') ? lad : lp };
    },
  };
  const svc = new CommercialReplenishmentService({} as never, {} as never, {} as never, {} as never);
  return { svc, trx, consultas };
};

describe('[PQ.10] rótulos de la página', () => {
  it('pega escalera y etiquetera a su renglón, y NULL donde no hay dato (no inventa)', async () => {
    const { svc, trx } = armar(
      [{ sku: '100', u1_label: 'PZA', u2_label: 'PAQ', u3_label: 'CJA', u2_factor: '6.0000', u3_factor: '24.0000' }],
      [{ product_id: 'p1', box_size: 24, pack_size: 6, packs_per_box: 4 }],
    );
    const filas: Fila[] = [{ product_id: 'p1', sku: '100' }, { product_id: 'p2', sku: '200' }];
    await rotulos(svc)(trx, 't', filas);
    expect(filas[0]).toMatchObject({ unidad_base: 'PZA', unidad_u2: 'PAQ', unidad_u3: 'CJA', unidad_f2: '6.0000', unidad_f3: '24.0000', box_size: 24, pack_size: 6, packs_per_box: 4 });
    expect(filas[1]).toMatchObject({ unidad_base: null, unidad_u2: null, unidad_u3: null, unidad_f2: null, unidad_f3: null, box_size: null, pack_size: null, packs_per_box: null });
  });

  it('pregunta SÓLO por los productos de la página, sin repetidos', async () => {
    const { svc, trx, consultas } = armar([], []);
    await rotulos(svc)(trx, 't', [{ product_id: 'p1', sku: '100' }, { product_id: 'p1', sku: '100' }, { product_id: 'p2', sku: '200' }]);
    expect(consultas).toHaveLength(2);
    expect(consultas[0].b).toEqual([['100', '200']]);
    expect(consultas[1].b).toEqual(['t', ['p1', 'p2']]);
  });

  it('página vacía: ni una consulta', async () => {
    const { svc, trx, consultas } = armar([], []);
    await rotulos(svc)(trx, 't', []);
    expect(consultas).toHaveLength(0);
  });

  it('⛔ la consulta del workbook ya no arma escalera ni etiquetera sobre todo el catálogo', () => {
    expect(SVC).not.toContain('LEFT JOIN lad ON lad.sku = pr.sku');
    expect(SVC).not.toMatch(/v_product_label_prices WHERE tenant_id = :t GROUP BY product_id\) lp/);
    expect(SVC).toContain('await this.rotulosDePagina(trx, tenantId, filas);');
  });

  it('⛔ con la copia materializada, el factor de caja se une directo (tabla con índice único)', () => {
    expect(SVC).toContain("LEFT JOIN ${vbfEsTabla ? `${vbfSrc} vbf` : 'vbf'}");
  });
});
