import { AJUSTES_KEPLER_POR_ENTRADA_SQL, AJUSTES_KEPLER_SQL, OPERATIVAS_CATS, categoriaAjusteSql, grupoAjusteSql } from './ajustes-kepler';
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
