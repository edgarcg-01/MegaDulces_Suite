import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AJUSTES_KEPLER_POR_ENTRADA_SQL, AJUSTES_KEPLER_SQL, NOTAS_KEPLER_DOC_SQL, OPERATIVAS_CATS, VISTA_AJUSTES } from './ajustes-kepler';
import { COMERCIAL_CATS } from './receipt-match';

/**
 * `[RE.64]` Lo que se puede probar sin base de los textos SQL del primitivo. Lo demás (que el clasificador
 * dé lo mismo que el del importer, documento por documento) se midió contra prod: un doble no ejecuta SQL.
 *
 * `[RE.68]` El clasificador y la regla del traslado viven en la vista `analytics.v_purchase_adjustments`
 * (migración). Este spec lee el TEXTO de esa migración: es el único lugar donde están.
 */
const MIGRACION = resolve(__dirname, '../../../../../database/migrations-newdb/20261110160453_re68_v_purchase_adjustments.js');
const VISTA = (() => {
  const m = readFileSync(MIGRACION, 'utf8').match(/const VISTA = String\.raw`([\s\S]*?)`;/);
  if (!m) throw new Error('no encontré `const VISTA = String.raw`…`` en la migración de RE.68');
  return m[1];
})();
const sinSignoDeInterrogacion = (sql: string) => !sql.includes('?');

describe('[RE.64] ajustes-kepler: los textos que pasan por trx.raw / knex.raw', () => {
  it('ningún texto trae «?»: knex lo toma por parámetro y cambia el regex sin dar error', () => {
    // Medido 2026-11-10: con `DIF\.?` y `\s?` el clasificador difería del importer en 107 documentos.
    expect(sinSignoDeInterrogacion(VISTA)).toBe(true);
    expect(sinSignoDeInterrogacion(AJUSTES_KEPLER_SQL)).toBe(true);
    expect(sinSignoDeInterrogacion(AJUSTES_KEPLER_POR_ENTRADA_SQL)).toBe(true);
    expect(sinSignoDeInterrogacion(NOTAS_KEPLER_DOC_SQL)).toBe(true);
  });
  it('NEGATIVA: el detector sí ve un «?» (el cuantificador viejo)', () => {
    expect(sinSignoDeInterrogacion(`upper(x) ~ 'DIF\\.? (MONTO|PRECIO)'`)).toBe(false);
  });
  it('los regex de la vista conservan sus «\\» (String.raw): sin ellas `\\y` sería una «y» literal', () => {
    expect(VISTA).toContain(String.raw`\yPP\y`);
    expect(VISTA).toContain(String.raw`'\s+'`);
  });
  it('operativas y comerciales no se pisan; las canceladas y las réplicas se excluyen', () => {
    expect(OPERATIVAS_CATS.filter((c) => COMERCIAL_CATS.includes(c))).toEqual([]);
    expect(VISTA).toContain(`m.c43 IS DISTINCT FROM 'C'`);
    expect(VISTA).toContain(`btrim(m.c1) = m.sucursal`);
  });
  it('las dos ligas a la entrada están (kdxf y c39)', () => {
    expect(AJUSTES_KEPLER_SQL).toContain(`'kdxf'::text AS liga`);
    expect(AJUSTES_KEPLER_SQL).toContain(`'c39'::text AS liga`);
  });
});

describe('[RE.68] una sola fuente: la vista', () => {
  it('el primitivo lee la vista, no kdm1 directo (si leyera kdm1, el clasificador estaría dos veces)', () => {
    expect(AJUSTES_KEPLER_SQL).toContain(`FROM ${VISTA_AJUSTES} v`);
    expect(NOTAS_KEPLER_DOC_SQL).toContain(`FROM ${VISTA_AJUSTES} v`);
    expect(AJUSTES_KEPLER_SQL).not.toContain('kepler_ods.kdm1');
    expect(NOTAS_KEPLER_DOC_SQL).not.toContain('kepler_ods.kdm1');
    expect(AJUSTES_KEPLER_SQL).not.toMatch(/upper\(.*\) ~ /);
  });
  it('las categorías comerciales y operativas de la vista son las de contracts', () => {
    for (const c of COMERCIAL_CATS) expect(VISTA).toMatch(new RegExp(`IN \\([^)]*'${c}'[^)]*\\) THEN 'comercial'`));
    for (const c of OPERATIVAS_CATS) expect(VISTA).toMatch(new RegExp(`IN \\([^)]*'${c}'[^)]*\\) OR c\\.c4 = 40 THEN 'operativo'`));
  });
  it('NEGATIVA: una nota sin motivo NO es comercial — el importer la inventaba como «descuento_comercial»', () => {
    expect(VISTA).toMatch(/WHEN btrim\(coalesce\(d\.motivo, ''\)\) = '' THEN NULL/);
    expect(VISTA).toMatch(/ELSE 'sin_clasificar' END AS grupo/);
    expect(VISTA).not.toMatch(/IS NULL THEN 'comercial'/);
    expect(VISTA).not.toContain('doctype_default');
  });
});

describe('[RE.66] el traslado al CEDIS no es rebaja', () => {
  it('lo decide la vista: nota de sucursal que cubre la entrada y tiene copia en el CEDIS (o dice blanqueo)', () => {
    expect(VISTA).toContain(`THEN 'traslado'`);
    expect(VISTA).toContain('analytics.erp_goods_receipt_dedup');
    expect(VISTA).toMatch(/~ 'BLANQ'/);
    expect(VISTA).toContain('0.95 * e.importe');
    expect(AJUSTES_KEPLER_POR_ENTRADA_SQL).toContain(`WHERE n.grupo <> 'traslado'`);
  });
  it('NEGATIVA: una nota del CEDIS (00) nunca es traslado — ahí se paga', () => {
    expect(VISTA).toContain(`u.sucursal <> '00'`);
  });
  it('las notas de la copia del CEDIS se atribuyen a la entrada original de sucursal', () => {
    expect(AJUSTES_KEPLER_SQL).toMatch(/COALESCE\(c\.dup_of_sucursal, u\.sucursal\) AS sucursal/);
    expect(AJUSTES_KEPLER_SQL).toMatch(/LEFT JOIN copia c ON u\.sucursal = '00' AND c\.cedis_folio = u\.folio/);
  });
});

describe('[RE.67] NOTAS_KEPLER_DOC_SQL: una fila por nota, para Costo por proveedor', () => {
  it('no trae «?»: comercial le agrega parámetros de fecha por trx.raw y un «?» interno los correría', () => {
    expect(sinSignoDeInterrogacion(NOTAS_KEPLER_DOC_SQL)).toBe(true);
  });
  it('el traslado sale del mismo primitivo que la columna Ajuste (no de un segundo criterio)', () => {
    expect(NOTAS_KEPLER_DOC_SQL).toContain(AJUSTES_KEPLER_SQL);
    expect(NOTAS_KEPLER_DOC_SQL).toContain(`WHERE grupo = 'traslado'`);
    expect(NOTAS_KEPLER_DOC_SQL).toContain(`m.c43 IS DISTINCT FROM 'C'`);
  });
  it('NEGATIVA: una nota sin motivo NO es comercial — el importer la inventaba como «descuento_comercial»', () => {
    // grupoAjusteSql: categoría nula de una 55 cae al ELSE, que es sin_clasificar, nunca comercial.
    const g = grupoAjusteSql('c.tipo', 'c.categoria');
    expect(g).toMatch(/ELSE 'sin_clasificar'/);
    expect(g).not.toMatch(/IS NULL THEN 'comercial'/);
  });
});
