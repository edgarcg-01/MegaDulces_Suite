import { randomUUID } from 'node:crypto';
import knexFactory, { Knex } from 'knex';
import { EVENTOS_SIEMPRE_AUTORIZADOS, type AsientoPropuesto } from '@megadulces/contracts';
import {
  CUENTAS_FIJAS, apertura, clasificarSuspenso, cobranzaRuta, cobroEnDolares, entregaRuta, esSinRegla, faltante, gasto, movimientoCaos,
  type Contexto, type Propuesta,
} from './reglas';

/**
 * `[LE.2.3]` — Las DOS implementaciones cruzadas: lo que producen las reglas de TypeScript entra al
 * libro de SQL (`cashbook.post_entry` / `authorize_request`) sin un solo rechazo, y el día del PM
 * termina con cada saldo donde debe. Si TS y SQL discrepan en una regla, se ve aquí.
 *
 * Corre como `app_runtime` (el rol de prod) contra la base de prueba de caja, en UNA transacción
 * con rollback. Sin `CAJA_TEST_DB_URL` se DECLARA no medido.
 */
const URL = process.env['CAJA_TEST_DB_URL'];
const U1 = randomUUID();
const U2 = randomUUID();
const CAJERA: Contexto = { actor: { kind: 'persona', user_id: U1, employee_id: randomUUID() }, valueAt: '2026-10-26T12:00:00-06:00' };
const FEED: Contexto = { actor: { kind: 'servicio', service: 'feed-caos' }, valueAt: '2026-10-26T12:00:00-06:00' };

async function registrar(trx: Knex.Transaction, p: Propuesta): Promise<string> {
  for (const c of p.cuentas) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify({ ...c, user_id: U1 })]);
  if ((EVENTOS_SIEMPRE_AUTORIZADOS as readonly string[]).includes(p.asiento.event_kind)) {
    const req = (await trx.raw(`SELECT cashbook.create_request(?::jsonb, clock_timestamp() + interval '1 hour') AS id`,
      [JSON.stringify({ ...p.asiento, request_id: randomUUID() })])).rows[0].id as string;
    return (await trx.raw('SELECT cashbook.authorize_request(?, ?, NULL) AS id', [req, U2])).rows[0].id as string;
  }
  return (await trx.raw('SELECT cashbook.post_entry(?::jsonb) AS id', [JSON.stringify(p.asiento)])).rows[0].id as string;
}
const saldo = async (trx: Knex.Transaction, code: string): Promise<number> =>
  Number(((await trx.raw('SELECT balance_minor FROM cashbook.v_saldos WHERE code = ?', [code])).rows[0] ?? { balance_minor: 'NaN' }).balance_minor);
const piezas = async (trx: Knex.Transaction, code: string, k: string): Promise<number> =>
  Number(((await trx.raw('SELECT pieces FROM cashbook.v_saldos_piezas WHERE code = ? AND denom_key = ?', [code, k])).rows[0] ?? { pieces: 0 }).pieces);

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[LE.2.3] NO MEDIDO: sin CAJA_TEST_DB_URL no se cruzan las reglas con el libro real.');
}

describe.skipIf(!URL)('[LE.2.3] las reglas de TypeScript contra el libro de SQL', () => {
  let db: Knex;
  beforeAll(() => { db = knexFactory({ client: 'pg', connection: URL, pool: { min: 0, max: 2 } }); });
  afterAll(async () => { await db?.destroy(); });

  it('el día del PM: Kepler cobra 21 mil, 19 a la máquina, 2 al cajón → la ruta queda en cero', async () => {
    const hay = (await db.raw(`SELECT to_regprocedure('cashbook.post_entry(jsonb)') IS NOT NULL AS ok`)).rows[0].ok;
    if (!hay) { console.warn('[LE.2.3] NO MEDIDO: la base de prueba no tiene el libro (20261027111930)'); return; }
    await db.transaction(async (trx) => {
      const T = randomUUID();
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      // `[LE.4.9]` U2 autoriza: en la caja firma un puesto (Jefe de Tesorería). Se deshace con la transacción.
      if ((await trx.raw(`SELECT to_regprocedure('cashbook._firma_de_caja(uuid, uuid)') IS NOT NULL AS ok`)).rows[0].ok) {
        await trx.raw(`INSERT INTO identity.users (id, tenant_id, username, role_name, activo, kind, position_code, created_at, updated_at)
          VALUES (?, ?, 'firma_prueba', 'tesoreria', true, 'interno', 'tesoreria', now(), now())`, [U2, T]);
        await trx.raw(`INSERT INTO identity.position_responsibilities (id, tenant_id, position_code, responsibility_key, es_principal, created_at, updated_at)
          VALUES (gen_random_uuid(), ?, 'tesoreria', 'finanzas.caja_firma', true, now(), now())`, [T]);
      }
      for (const c of Object.values(CUENTAS_FIJAS)) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify(c)]);
      await trx.raw('SELECT cashbook.open_day(?, ?)', ['2099-05-04', U1]);

      await registrar(trx, apertura({ moneda: 'MXN', fecha: '2099-05-04', conteos: [
        { cuenta: 'BOVEDA_CAOS', piezas: { 500: '200' } }, { cuenta: 'CAJA_MXN', piezas: { 100: '10' } }] }, CAJERA));
      await registrar(trx, cobranzaRuta({ ruta: '27', origenRef: '01-005|U-A-5|0000024|0011', monto: '2100000', fecha: '2026-10-26' }, FEED));
      const dep = movimientoCaos({ device: 'AST700-T', external_id: 1723, type_id: 0, type_label: 'Deposito', occurred_at: '2026-10-26T18:00:00-06:00',
        total: '19000.00', ref: 'ruta 27 261026', user_external: 'Vendedor (006) - VENTAS',
        piezas: [{ denom: '500.00', pieza_tipo: 'B', quantity: '30' }, { denom: '200.00', pieza_tipo: 'B', quantity: '20' }] }, FEED);
      if (esSinRegla(dep)) throw new Error(dep.motivo);
      await registrar(trx, dep);
      await registrar(trx, entregaRuta({ ruta: '27', piezas: { 1000: '1', 500: '2' } }, CAJERA));
      expect(await saldo(trx, 'POR_RENDIR:RUTA:27')).toBe(0);

      // Un retiro sin clasificar: la bóveda baja igual que la máquina y el dinero espera en Suspenso.
      const ret = movimientoCaos({ device: 'AST700-T', external_id: 1724, type_id: 4, type_label: 'Dispensar', occurred_at: '2026-10-27T09:00:00-06:00',
        total: '25000.00', ref: 'pagos', user_external: 'Cajera (003)', piezas: [{ denom: '500.00', pieza_tipo: 'B', quantity: '50' }] }, FEED);
      if (esSinRegla(ret)) throw new Error(ret.motivo);
      await registrar(trx, ret);
      expect(await saldo(trx, 'SUSPENSO_MXN')).toBe(2500000);
      await registrar(trx, clasificarSuspenso({ eventRefOriginal: 'caos:AST700-T:1724', monto: '2500000', estaEn: 'debe', hacia: CUENTAS_FIJAS.CAJA_MXN, piezas: { 500: '50' } }, CAJERA));
      expect(await saldo(trx, 'SUSPENSO_MXN')).toBe(0);

      await registrar(trx, gasto({ concepto: 'Papelería', desde: { tipo: 'cajon', piezas: { 100: '3' } } }, CAJERA));
      await registrar(trx, cobroEnDolares({ ruta: '28', piezasUsd: { 100: '1' }, tipoDeCambio: '18.25', fuente: 'DOF', fijadoPor: U2 }, CAJERA));
      await registrar(trx, faltante({ de: { tipo: 'ruta', ruta: '28', monto: '10000' }, empleado: 'e-v28', nombre: 'Vendedor 28' }, CAJERA));

      // La bóveda: 200×500 + 30×500 + 20×200 − 50×500 = $94,000 en 180×500 y 20×200.
      expect(await saldo(trx, 'BOVEDA_CAOS')).toBe(9400000);
      expect(await piezas(trx, 'BOVEDA_CAOS', '500')).toBe(180);
      expect(await piezas(trx, 'BOVEDA_CAOS', '200')).toBe(20);
      // El cajón: 10×100 + 1×1000 + 2×500 + 50×500 − 3×100 = $27,700.
      expect(await saldo(trx, 'CAJA_MXN')).toBe(2770000);
      expect(await saldo(trx, 'CAJA_USD')).toBe(10000);
      expect(await saldo(trx, 'FALTANTE:E-V28')).toBe(10000);
      expect((await trx.raw('SELECT * FROM cashbook.verify_chain()')).rows).toEqual([]);
      expect((await trx.raw('SELECT * FROM cashbook.v_descuadre_interno')).rows).toEqual([]);

      // El mismo depósito otra vez (el feed lo relee): no hay segundo asiento.
      await registrar(trx, dep);
      expect(await saldo(trx, 'BOVEDA_CAOS')).toBe(9400000);

      // Un asiento de TS alterado a mano lo rechaza la base con el MISMO nombre que la regla.
      const roto = entregaRuta({ ruta: '27', piezas: { 500: '1' } }, CAJERA);
      const malo: AsientoPropuesto = { ...roto.asiento, lines: roto.asiento.lines.map((l) => (l.pieces ? { ...l, pieces: { 500: '2' } } : l)) };
      await trx.raw('SAVEPOINT sp');
      await expect(trx.raw('SELECT cashbook.post_entry(?::jsonb)', [JSON.stringify(malo)])).rejects.toMatchObject({ constraint: 'cashbook_piezas_no_suman' });
      await trx.raw('ROLLBACK TO SAVEPOINT sp');

      throw new Error('__rollback__');
    }).catch((e: Error) => { if (e.message !== '__rollback__') throw e; });
  });
});
