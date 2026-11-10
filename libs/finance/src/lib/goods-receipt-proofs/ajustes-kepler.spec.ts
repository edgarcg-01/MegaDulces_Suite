import { AJUSTES_KEPLER_POR_ENTRADA_SQL, AJUSTES_KEPLER_SQL, NOTAS_KEPLER_DOC_SQL, OPERATIVAS_CATS, categoriaAjusteSql, grupoAjusteSql } from './ajustes-kepler';
import { COMERCIAL_CATS } from './receipt-match';

/**
 * `[RE.64]` Lo que se puede probar sin base de los textos SQL del primitivo. Lo demás (que el clasificador
 * dé lo mismo que el del importer, documento por documento) se midió contra prod: un doble no ejecuta SQL.
 */
const sinSignoDeInterrogacion = (sql: string) => !sql.includes('?');

describe('[RE.64] ajustes-kepler: los textos que pasan por trx.raw', () => {
  it('ningún texto trae «?»: trx.raw lo toma por parámetro y cambia el regex sin dar error', () => {
    // Medido 2026-11-10: con `DIF\.?` y `\s?` el clasificador difería del importer en 107 documentos.
    expect(sinSignoDeInterrogacion(categoriaAjusteSql('m.c24'))).toBe(true);
    expect(sinSignoDeInterrogacion(grupoAjusteSql('t', 'c'))).toBe(true);
    expect(sinSignoDeInterrogacion(AJUSTES_KEPLER_SQL)).toBe(true);
    expect(sinSignoDeInterrogacion(AJUSTES_KEPLER_POR_ENTRADA_SQL)).toBe(true);
  });
  it('NEGATIVA: el detector sí ve un «?» (el cuantificador viejo)', () => {
    expect(sinSignoDeInterrogacion(`upper(x) ~ 'DIF\\.? (MONTO|PRECIO)'`)).toBe(false);
  });
  it('operativas y comerciales no se pisan; las canceladas se excluyen; las dos ligas están', () => {
    expect(OPERATIVAS_CATS.filter((c) => COMERCIAL_CATS.includes(c))).toEqual([]);
    expect(AJUSTES_KEPLER_SQL).toContain(`m.c43 IS DISTINCT FROM 'C'`);
    expect(AJUSTES_KEPLER_SQL).toContain(`'kdxf'::text AS liga`);
    expect(AJUSTES_KEPLER_SQL).toContain(`'c39'::text AS liga`);
  });
});

describe('[RE.66] el traslado al CEDIS no es rebaja', () => {
  it('la nota que cubre la entrada y tiene copia en el CEDIS (o dice blanqueo) es «traslado» y no suma al ajuste', () => {
    expect(AJUSTES_KEPLER_SQL).toContain(`'traslado'`);
    expect(AJUSTES_KEPLER_SQL).toContain('analytics.erp_goods_receipt_dedup');
    expect(AJUSTES_KEPLER_SQL).toMatch(/upper\(coalesce\(cat\.motivo, ''\)\) ~ 'BLANQ'/);
    expect(AJUSTES_KEPLER_POR_ENTRADA_SQL).toContain(`WHERE n.grupo <> 'traslado'`);
  });
  it('NEGATIVA: una nota del CEDIS (00) nunca es traslado — ahí se paga', () => {
    expect(AJUSTES_KEPLER_SQL).toContain(`cat.sucursal <> '00'`);
  });
  it('las notas de la copia del CEDIS se atribuyen a la entrada original de sucursal', () => {
    expect(AJUSTES_KEPLER_SQL).toMatch(/COALESCE\(c\.dup_of_sucursal, cls\.sucursal\) AS sucursal/);
    expect(AJUSTES_KEPLER_SQL).toMatch(/LEFT JOIN copia c ON cls\.sucursal = '00' AND c\.cedis_folio = cls\.folio/);
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
