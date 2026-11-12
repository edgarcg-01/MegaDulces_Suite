import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * `[AUD-DAT.31]` El costo sale TODO del ODS: `kdik` y, sin `kdik`, la ficha de Kepler de esa sucursal
 * (`kdii.c77`). El catálogo (lo escriben importers) ya no valúa nada, y Wincaja (ya no existe) sale del
 * resolvedor. Lo medido (unidad, cobertura, antes/después) está en la cabecera de la migración.
 */
const RAIZ = join(__dirname, '../../../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MIG = require(join(RAIZ, 'database/migrations-newdb/20261112165701_dat31_costo_kepler_de_la_ficha.js'));

describe('[AUD-DAT.31] el resolvedor de costo: sólo Kepler, sólo del ODS', () => {
  const { FICHA, RESOLVE, ERP_COMPLETA, POR_CELDA } = MIG.SQL as Record<string, string>;

  it('⭐ el costo es kdik y luego la ficha; NUNCA el catálogo', () => {
    expect(RESOLVE).toContain('COALESCE(x.e, x.ficha),');
    expect(RESOLVE).not.toContain('COALESCE(x.e, x.ciego)');
    expect(RESOLVE).toMatch(/WHEN x\.e > 0::numeric THEN 'kepler_kdik'/);
    expect(RESOLVE).toMatch(/WHEN x\.ficha IS NOT NULL THEN 'kepler_ficha'/);
    expect(RESOLVE).toMatch(/ELSE 'sin_costo'::text\s+END,/);
    expect(RESOLVE).not.toContain("'catalogo_neto'");
  });

  it('el testigo sigue siendo kdik: la ficha es procedencia, no testigo', () => {
    expect(RESOLVE).toContain('x.e > 0::numeric,');
    expect(RESOLVE).toContain('SELECT p_costo_kepler AS e,');
  });

  it('⛔ Wincaja ya no existe: ni su copia ni sus almacenes', () => {
    for (const s of [RESOLVE, ERP_COMPLETA, POR_CELDA]) expect(s).not.toMatch(/wincaja/i);
    for (const s of [ERP_COMPLETA, POR_CELDA]) expect(s).toContain('w.deleted_at IS NULL AND w.kepler_code IS NOT NULL');
  });

  it('el decode de la ficha no tumba la vista con un texto raro', () => {
    expect(FICHA).toContain('FROM kepler_ods.kdii k');
    expect(FICHA).toMatch(/CASE WHEN btrim\(k\.c77\) ~ '\^\[0-9\]\*\\\.\?\[0-9\]\+\$' THEN btrim\(k\.c77\)::numeric ELSE NULL::numeric END/);
  });

  it('la vista completa y la búsqueda por celda pasan la ficha de la MISMA sucursal', () => {
    expect(ERP_COMPLETA).toMatch(/kf\.kepler_code = w\.kepler_code AND kf\.sku = p\.sku::text/);
    expect(ERP_COMPLETA).toContain('kf AS MATERIALIZED');
    // ⛔ kc por (sucursal, código), no por (almacén, producto): con esa forma el planificador estimó 11
    // renglones, eligió un merge join por almacén y la vista pasó de 1.3 s a 40 s (ensayado en prod).
    expect(ERP_COMPLETA).toContain('LEFT JOIN kc ON kc.kepler_code = w.kepler_code AND kc.sku = p.sku::text');
    expect(ERP_COMPLETA).not.toContain('v_kepler_unit_cost');
    expect(POR_CELDA).toMatch(/f\.kepler_code = w\.kepler_code AND f\.sku = p\.sku::text/);
    for (const s of [ERP_COMPLETA, POR_CELDA]) expect(s).toContain('kc.costo_unitario, p.cost_base, p.cost_with_tax, kf.costo_ficha) r');
  });
});

describe('[AUD-DAT.31] Existencia y Reabasto valúan sin catálogo', () => {
  it('Existencia: kdik, luego la ficha de esa sucursal; sin ninguno, sin_costo declarado', () => {
    const f = readFileSync(join(__dirname, 'existencia.service.ts'), 'utf8');
    expect(f).toContain('COALESCE(kc.costo_unitario, NULLIF(lad.costo1, 0), 0)::float8 AS cu');
    expect(f).toMatch(/WHEN lad\.costo1 > 0\s+THEN 'kepler_ficha'/);
    expect(f).not.toContain("'catalogo_neto'");
    expect(f).not.toContain("'catalogo' END AS cu_source");
  });

  it('Reabasto: el costo es el del resolvedor, sin la rama Wincaja que valuaba con el catálogo', () => {
    const f = readFileSync(join(__dirname, '../commercial-replenishment/commercial-replenishment.service.ts'), 'utf8');
    expect(f).toContain('return `euc.costo_unitario`;');
    expect(f).not.toContain("euc.costo_source = 'wincaja_costo_promedio'");
  });
});
