import knexLib from 'knex';
import { SQL_RANGO, SQL_FALTANTES } from './supplier-payment-accounts.service';

/**
 * `[PGP.22]` **El SQL de este módulo se ata con `?`, nunca con `$1`.**
 *
 * ⛔ Por qué existe esta prueba, medido el 2026-10-27: `GET /finance/supplier-payment-accounts/
 *    faltantes` devolvía **500 — `Expected 1 bindings, saw 0`** desde siempre. El SQL estaba
 *    escrito con marcadores de Postgres (`$1`, `$2`) y se pasaba por `knex.raw(sql, [...])`,
 *    que cuenta `?`. Knex veía 1 binding y 0 marcadores y abortaba ANTES de tocar la base.
 *
 * ⭐ Y el costo real no fue el 500: fue que `commercial.supplier_payment_accounts` tenía 0 filas
 *    y eso se leyó como «nadie usa la pantalla». No era desuso: **nadie podía ver la lista**.
 *    Al arreglarlo, la consulta devuelve **172 proveedores pagados por banco en 120 días por
 *    $136,912,739, ninguno con cuenta registrada**. Es la misma lección que el arqueo de caja:
 *    cero filas por un defecto es indistinguible de cero filas por desuso — se descarta el
 *    defecto ANTES de culpar a la gente.
 *
 * El `toSQL()` de knex es el mismo paso que reventaba, así que esta prueba NO necesita base de
 * datos: ejerce el formateador exacto que fallaba.
 */
describe('[PGP.22] los marcadores del SQL son los que knex entiende', () => {
  const knex = knexLib({ client: 'pg' });

  it('SQL_RANGO formatea con su único binding', () => {
    const out = knex.raw(SQL_RANGO, [120]).toSQL();
    expect(out.bindings).toHaveLength(1);
  });

  it('SQL_FALTANTES formatea con sus dos bindings, en orden', () => {
    const out = knex.raw(SQL_FALTANTES, [120, '00000000-0000-0000-0000-00000000d01c']).toSQL();
    expect(out.bindings).toEqual([120, '00000000-0000-0000-0000-00000000d01c']);
  });

  it('ninguno de los dos conserva marcadores $n de Postgres', () => {
    for (const sql of [SQL_RANGO, SQL_FALTANTES]) {
      // Un `$` seguido de dígito es el marcador que knex NO cuenta. (`$52.26M` de un comentario
      // vive fuera de estas constantes, así que acá no hay falsos positivos.)
      expect(sql).not.toMatch(/\$\d/);
    }
  });

  /**
   * ⛔ **La prueba negativa**: sin ella esto sería una intención, no una compuerta. Reproduce el
   * defecto exacto que se arregló y exige que siga fallando — si algún día deja de fallar, es
   * que knex cambió y hay que volver a medir, no que el problema se arregló solo.
   */
  it('PRUEBA NEGATIVA: con $1 vuelve a reventar con el mensaje del incidente', () => {
    const roto = SQL_RANGO.split('?').join('$1');
    expect(() => knex.raw(roto, [120]).toSQL()).toThrow(/Expected 1 bindings, saw 0/);
  });
});
