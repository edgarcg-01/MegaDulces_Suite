/**
 * `[PGP.90]` Prueba de INTEGRACIÓN — **la referencia fija de la cuenta de pago**, con el código
 * real de `SupplierPaymentAccountsService` contra un Postgres de verdad y el payload que manda
 * «Finanzas › Cuentas de pago». Regla 13: un endpoint que escribe no está probado hasta que una
 * prueba lo ejerció contra base real (aquí: `POST solicitudes` y `POST solicitudes/:id/aprobar`).
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el
 * `system_identifier`). Sin la variable se salta y lo DICE (no se pinta verde). En el CI la fija
 * el job `pruebas-db`.
 * ⭐ TODO corre dentro de UNA transacción que se revierte al final, incluida la migración
 * `pgp90` (idempotente): la base queda exactamente como estaba. Datos de PRUEBA (`PGP90-IT`).
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';
import { SupplierPaymentAccountsService, type CreateAccountChangeRequestDto } from './supplier-payment-accounts.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const MIG = '../../../../../database/migrations-newdb/20261106172407_pgp90_referencia_fija_de_la_cuenta_de_pago.js';

/** Las migraciones son CommonJS (`exports.up`): según el cargador llegan como `up` o `default.up`. */
async function migUp(rel: string, trx: Knex.Transaction): Promise<void> {
  const m = createRequire(__filename)(resolvePath(__dirname, rel)) as { up: (k: Knex) => Promise<void> };
  await m.up(trx);
}

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[PGP.90] NO MEDIDO: sin TP_IT_DB la prueba de integración no corre.');
else if (!local) console.log('[PGP.90] NO MEDIDO: TP_IT_DB no es una base local; me niego a escribir ahí.');

suite('[PGP.90] referencia fija de la cuenta de pago contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let svc: SupplierPaymentAccountsService;
  let supplierId = '';

  /** El cuerpo que arma `enviar()` de la pantalla, campo por campo. */
  const payload = (over: Partial<CreateAccountChangeRequestDto>): CreateAccountChangeRequestDto => ({
    supplier_id: supplierId, account_id: null, deactivate: false,
    proposed_bank_name: 'BBVA', proposed_account_number: null, proposed_clabe: '012180001234567890',
    proposed_alias: 'Principal', proposed_payment_reference: null,
    proposed_es_favorita: true, proposed_attachment_url: null, proposed_attachment_kind: null,
    reason: 'prueba PGP.90', ...over,
  });
  const cuenta = async () => {
    const rows = await svc.listAccounts(supplierId);
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    await migUp(MIG, trx);

    const tk = { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => fn(trx) };
    const ctx = { requireTenantId: () => M };
    svc = new SupplierPaymentAccountsService(tk as never, ctx as never, {} as never);
    const [sup] = await trx('catalog.suppliers').insert({ tenant_id: M, code: 'PGP90-IT', name: 'PGP90 PROVEEDOR DE PRUEBA', activo: true }).returning('id');
    supplierId = sup.id;
  });

  afterAll(async () => {
    await trx?.rollback();
    await knex?.destroy();
  });

  it('alta con referencia: la solicitud la guarda recortada y al aprobar queda en la cuenta', async () => {
    const req = await svc.createRequest(payload({ proposed_payment_reference: '  7001234  ' }), 'pgp90_solicita');
    expect(req.proposed_payment_reference).toBe('7001234');
    // Mientras no se aprueba, la cuenta NO existe: la referencia pasa por la misma firma que la CLABE.
    expect(await svc.listAccounts(supplierId)).toHaveLength(0);
    await svc.approveRequest(req.id, 'pgp90_autoriza', undefined);
    expect((await cuenta()).payment_reference).toBe('7001234');
  });

  it('cambio SIN el campo (un cliente que no lo conoce): se conserva la referencia vigente', async () => {
    const acc = await cuenta();
    const sinCampo = payload({ account_id: acc.id, proposed_alias: 'Principal (renombrada)' });
    delete (sinCampo as Partial<CreateAccountChangeRequestDto>).proposed_payment_reference;
    const req = await svc.createRequest(sinCampo, 'pgp90_solicita');
    expect(req.proposed_payment_reference).toBe('7001234');
    await svc.approveRequest(req.id, 'pgp90_autoriza', undefined);
    const despues = await cuenta();
    expect(despues.alias).toBe('Principal (renombrada)');
    expect(despues.payment_reference).toBe('7001234');
  });

  it('cambio con otra referencia: la reemplaza al aprobar', async () => {
    const acc = await cuenta();
    const req = await svc.createRequest(payload({ account_id: acc.id, proposed_payment_reference: 'CONV-88' }), 'pgp90_solicita');
    await svc.approveRequest(req.id, 'pgp90_autoriza', undefined);
    expect((await cuenta()).payment_reference).toBe('CONV-88');
  });

  it('cambio con la referencia en blanco: la QUITA (un espacio no es una referencia)', async () => {
    const acc = await cuenta();
    const req = await svc.createRequest(payload({ account_id: acc.id, proposed_payment_reference: '   ' }), 'pgp90_solicita');
    expect(req.proposed_payment_reference).toBeNull();
    await svc.approveRequest(req.id, 'pgp90_autoriza', undefined);
    expect((await cuenta()).payment_reference).toBeNull();
  });

  it('una solicitud RECHAZADA no toca la referencia de la cuenta', async () => {
    const acc = await cuenta();
    const req = await svc.createRequest(payload({ account_id: acc.id, proposed_payment_reference: 'NO-DEBE-QUEDAR' }), 'pgp90_solicita');
    await svc.rejectRequest(req.id, 'pgp90_autoriza', 'prueba');
    expect((await cuenta()).payment_reference).toBeNull();
  });
});
