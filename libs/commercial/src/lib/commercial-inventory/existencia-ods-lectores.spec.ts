import { readFileSync } from 'fs';
import { join } from 'path';
import knexFactory from 'knex';
import { EXISTENCIA_ODS_SQL, existenciaOds } from './stock-state';

/**
 * `[CANON.7.2]` Los reportes leen la existencia del ODS, no la copia `commercial.stock` del importer
 * `import-branch-stock-live`. La copia traía el CEDIS congelado desde el 16-oct (205 filas contra el CEDIS
 * entero de Kepler) y `MD-32`, un almacén borrado; en las 8 sucursales era idéntica al renglón (medido el
 * 2026-11-19). Lo que este archivo existe para que no vuelva: que un lector de la lista regrese a la copia.
 */
const LIB = join(__dirname, '..');

/** Las líneas de CÓDIGO que leen la copia (no comentarios, no `commercial.stock_lots` ni otras tablas). */
export function lecturasDeLaCopia(texto: string): string[] {
  return texto.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l))
    .map((l) => l.replace(/\s\/\/.*$/, '').replace(/\s--\s.*$/, ''))
    .filter((l) => /commercial\.stock(?![_a-z])/.test(l));
}

/**
 * Los lectores clase A del anexo CANON.7 §3, por archivo, y cuántas lecturas de la copia les QUEDAN a
 * propósito. ⚠️ Un número distinto de 0 es deuda con nombre, no un permiso.
 *
 * A6 y A13 leen dentro de un endpoint que ESCRIBE (el conteo de Monitoreo y la bandeja del scanner): por la
 * regla 13 no cambian sin una prueba contra base real con el ODS sembrado, y la que existe
 * (`test-newdb-inventory-monitoring.js`) siembra la copia. Van con los escritores, en `[CANON.7.4]`.
 */
const LECTORES_A: Array<[archivo: string, quedan: number, porque: string]> = [
  ['commercial-analytics/commercial-analytics.service.ts', 1,
    'A1 deadStock · A2 lowStock · A3 sellOut · A4 salidas. Queda rankingOutOfStock (B8): decide «agotado», va en [CANON.7.3]'],
  ['commercial-intelligence/thot-chat/thot-tools.service.ts', 0, 'A5 reorderPolicy'],
  ['commercial-inventory/inventory-monitoring.service.ts', 1, 'A6 recordCount: escribe el conteo → [CANON.7.4]'],
  ['commercial-products/commercial-products.service.ts', 0, 'A7 findById (total de la red)'],
  ['commercial-profitability/commercial-profitability.service.ts', 0, 'A8 overview · A9 breakdown'],
  ['commercial-replenishment/commercial-replenishment.service.ts', 0, 'A10 networkSurplus · A11 criticalStock · A12 summary'],
  ['commercial-replenishment/replenishment-scanner.service.ts', 2, 'A13 scanTenant: escribe la bandeja → [CANON.7.4]'],
];

describe('[CANON.7.2] la existencia del ODS con la forma de la copia', () => {
  it('lee SÓLO la vista canónica y da las cinco columnas que leían de la copia', () => {
    expect(EXISTENCIA_ODS_SQL).toContain('FROM analytics.v_erp_stock_on_hand e');
    expect(EXISTENCIA_ODS_SQL).not.toMatch(/commercial\.stock(?![_a-z])/);
    for (const col of ['e.tenant_id', 'e.warehouse_id', 'e.product_id', 'e.qty_stock_units AS quantity']) {
      expect(EXISTENCIA_ODS_SQL).toContain(col);
    }
  });

  it('⚠️ los apartados son 0 y lo dice: la vista no los tiene (misma regla que leerExistencia)', () => {
    expect(EXISTENCIA_ODS_SQL).toContain('0::numeric AS reserved_quantity');
  });

  it('existenciaOds pone el alias y truena con uno que se pudiera inyectar (se interpola en SQL)', () => {
    const k = knexFactory({ client: 'pg' });
    expect(existenciaOds(k, 's').toString()).toBe(`${EXISTENCIA_ODS_SQL} AS s`);
    expect(k.from(existenciaOds(k, 'st')).where('st.product_id', 'x').toString())
      .toMatch(/^select \* from \(SELECT e\.tenant_id[\s\S]+\) AS st where "st"\."product_id" = 'x'$/);
    expect(() => existenciaOds(k, 's; DROP TABLE x')).toThrow(/alias inválido/);
    expect(() => existenciaOds(k, 'S')).toThrow(/alias inválido/);
  });
});

describe('[CANON.7.2] el detector de lecturas de la copia (control: tiene que ver las formas reales)', () => {
  it('ve las cuatro formas en que se leía la copia', () => {
    const viejo = [
      `const base = trx('commercial.stock as s')`,
      `        .leftJoin('commercial.stock as s', (j) =>`,
      `        .from({ st: 'commercial.stock' })`,
      `               FROM commercial.stock st`,
    ].join('\n');
    expect(lecturasDeLaCopia(viejo)).toHaveLength(4);
  });

  it('no cuenta comentarios, ni otras tablas del mismo prefijo', () => {
    const ok = [
      `   * Productos en el top del ERP pero con stock=0 en commercial.stock.`,
      `      // [RA.VA.2] commercial.stock ya NO se une acá`,
      `                -- [RA.VA.2] commercial.stock ya NO se une acá: la existencia sale de rpl.`,
      `      const lot = await trx('commercial.stock_lots').where({ id })`,
      `      const x = trx.from(existenciaOds(trx, 's')) // antes: commercial.stock`,
    ].join('\n');
    expect(lecturasDeLaCopia(ok)).toEqual([]);
  });
});

describe('[CANON.7.2] los 13 lectores clase A ya no leen la copia', () => {
  it.each(LECTORES_A)('%s', (archivo, quedan, porque) => {
    const lecturas = lecturasDeLaCopia(readFileSync(join(LIB, archivo), 'utf8'));
    expect(lecturas.map((l) => l.trim()), porque).toHaveLength(quedan);
  });
});
