import { randomUUID } from 'crypto';
import knexFactory, { Knex } from 'knex';
import { sinLlaveDeCaja } from './caja-candado.query';
import { fraseDeErrorDeCaja } from './caja-errores';

/**
 * ⛔ `[LE.0.9]` La pregunta previa de la llave contra una base REAL: tiene que contestar lo mismo
 * que el disparador `caja_exige_llave_chk`, porque es lo que decide si pagar una hoja de gastos la
 * marca pagada. HG-5 (2026-11-03): la pagó un superadmin, `RolesGuard` lo dejó pasar, la hoja quedó
 * pagada y la base rechazó sus 14 pagos.
 *
 *     CAJA_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/caja/caja-candado.llave-real.spec.ts
 *
 * Todo dentro de una transacción que se deshace.
 */
const URL = process.env['CAJA_TEST_DB_URL'];
if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[LE.0.9] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual preguntar por la llave.');
}

describe.skipIf(!URL)('[LE.0.9] la llave de la caja, preguntada antes de escribir', () => {
  let knex: Knex;
  beforeAll(() => { knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 2 } }); });
  afterAll(async () => { await knex?.destroy(); });

  it('dice lo mismo que el disparador: el superadmin no, quien opera sí, el desconocido no decide', async () => {
    const hay = (await knex.raw(`SELECT to_regprocedure('finance.caja_llave(uuid, uuid, text)') IS NOT NULL AS t`)).rows[0].t;
    if (!hay) { console.warn('[LE.0.9] NO MEDIDO: la base de prueba no tiene la llave (20261031135300)'); return; }
    await knex.transaction(async (trx) => {
      const T = randomUUID();
      const [DIOS, OPERA, NADIE] = [randomUUID(), randomUUID(), randomUUID()];
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      await trx.raw(`INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
        VALUES (?, 'le09_opera', '{"FINANCE_CAJA_GESTIONAR": true}'::jsonb), (?, 'superadmin', '{"FINANCE_CAJA_GESTIONAR": true}'::jsonb)`, [T, T]);
      for (const [id, rol] of [[DIOS, 'superadmin'], [OPERA, 'le09_opera']]) {
        await trx.raw(`INSERT INTO identity.users (id, tenant_id, username, role_name, activo, password_hash)
          VALUES (?, ?, ?, ?, true, 'prueba-sin-login')`, [id, T, `le09h_${id.slice(-4)}`, rol]);
      }

      expect(await sinLlaveDeCaja(trx, T, DIOS)).toBe(true);
      expect(await sinLlaveDeCaja(trx, T, OPERA)).toBe(false);
      expect(await sinLlaveDeCaja(trx, T, NADIE)).toBe(false);

      // El disparador, con las mismas tres personas: si la pregunta y la base discrepan, esto lo dice.
      const mov = (quien: string) => ({
        tenant_id: T, folio: `LE09H-${randomUUID().slice(0, 8)}`, tipo: 'gasto', fecha: '1999-01-04', sucursal: 'S1',
        kepler_cuenta: '601-001', kepler_concepto: 'PRUEBA', glosa: 'Movimiento de prueba LE.0.9', monto: 100,
        created_by: quien, created_by_username: 'le09_prueba',
      });
      const intento = async (quien: string): Promise<unknown> => {
        await trx.raw('SAVEPOINT sp');
        try { await trx('finance.cash_ledger').insert(mov(quien)); await trx.raw('RELEASE SAVEPOINT sp'); return null; }
        catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT sp'); return e; }
      };
      const e = await intento(DIOS);
      expect(e).toMatchObject({ constraint: 'caja_exige_llave_chk' });
      // Y la fila del lote lleva la frase, no el SQL.
      expect(fraseDeErrorDeCaja(e)).toContain('no tiene la llave');
      expect(await intento(OPERA)).toBeNull();
      expect(await intento(NADIE)).toBeNull();

      throw new Error('__rollback__');
    }).catch((e: Error) => { if (e.message !== '__rollback__') throw e; });
  });
});
