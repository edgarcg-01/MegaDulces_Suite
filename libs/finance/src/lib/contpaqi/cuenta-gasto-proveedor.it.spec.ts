/**
 * `[PGP.111c]` — **Firmar la cuenta de gasto de un proveedor, contra Postgres real** (regla 13: un endpoint que escribe
 * no está probado hasta que una prueba lo ejerce contra una base real). Corre el servicio de verdad
 * (`ContpaqiArmadoService`) dentro de UNA transacción que se revierte: no deja nada.
 *
 * Lo que se prueba, con el mismo cuerpo que manda la pantalla (`rfc`, `cuenta`, autor):
 *   · ⛔ los rechazos: cuenta de banco, de gasto dada de baja, inexistente, RFC inválido, sin autor;
 *   · firmar → el Calendario la lee como `firmada` (le gana a la derivada) y la póliza también (misma tabla);
 *   · re-firmar → UNA sola activa, y la anterior queda desactivada (historial de quién cambió qué);
 *   · quitar → vuelve a «sin historia»; quitar otra vez se rechaza.
 * NO MEDIDO aquí: el RLS (la base de prueba corre como superusuario, que no lo aplica); la migración lo verifica al
 * aplicarse (RLS forzada + política, o aborta).
 *
 * Sólo corre con `TP_IT_DB` apuntando a una base LOCAL (el job de integración del CI la fija); nunca contra prod.
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';
import { ContpaqiArmadoService, FirmaRechazada } from './contpaqi-armado.service';
import { leerCuentasGasto } from '../payment-calendar/cuenta-gasto.sql';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const RFC = 'CGP111110AB1';
const GASTO = '5299911101';
const GASTO2 = '5299911102';
const BAJA = '5299911103';
const BANCO = '1029911101';
const MIG = '../../../../../database/migrations-newdb/20261110102907_pgp111c_cuenta_gasto_por_proveedor.js';

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[PGP.111c] NO MEDIDO: sin TP_IT_DB la prueba de integración no corre.');

suite('[PGP.111c] firmar la cuenta de gasto de un proveedor (Postgres real, transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  let svc: ContpaqiArmadoService;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    const m = createRequire(__filename)(resolvePath(__dirname, MIG)) as { up: (k: Knex) => Promise<void> };
    await m.up(trx);
    await trx('analytics.contpaqi_accounts').insert([
      { tenant_id: M, codigo: GASTO, nombre: 'GASTO CANDADO 1', tipo: 'G', es_baja: false, afectable: 1 },
      { tenant_id: M, codigo: GASTO2, nombre: 'GASTO CANDADO 2', tipo: 'G', es_baja: false, afectable: 1 },
      { tenant_id: M, codigo: BAJA, nombre: 'GASTO DADO DE BAJA', tipo: 'G', es_baja: true, afectable: 1 },
      { tenant_id: M, codigo: BANCO, nombre: 'BANCO CANDADO', tipo: 'A', es_baja: false, afectable: 1 },
    ]);
    // La transacción de prueba hace de pool: `conTenant` abre un SAVEPOINT dentro y todo se revierte al final.
    svc = new ContpaqiArmadoService(trx as unknown as Knex);
    (svc as unknown as { log: unknown }).log = { log() {}, warn() {}, error() {}, debug() {} };
  }, 60_000);

  afterAll(async () => {
    await trx?.rollback().catch(() => undefined);
    await knex?.destroy();
  });

  it('⛔ rechaza lo que no es una cuenta de gasto vigente, un RFC inválido o una firma sin autor', async () => {
    await expect(svc.firmarCuentaGastoProveedor(RFC, BANCO, 'contadora')).rejects.toBeInstanceOf(FirmaRechazada);
    await expect(svc.firmarCuentaGastoProveedor(RFC, BAJA, 'contadora')).rejects.toThrow(/afectable y vigente/);
    await expect(svc.firmarCuentaGastoProveedor(RFC, '5299999999', 'contadora')).rejects.toThrow(/catálogo/);
    await expect(svc.firmarCuentaGastoProveedor('NO ES RFC', GASTO, 'contadora')).rejects.toThrow(/RFC válido/);
    await expect(svc.firmarCuentaGastoProveedor(RFC, GASTO, '')).rejects.toThrow(/sin autor/);
    expect(Number((await trx('contpaqi.supplier_expense_accounts').where({ tenant_id: M, rfc: RFC }).count({ n: '*' }).first())!.n)).toBe(0);
  });

  it('⭐ firmar: el Calendario la lee como firmada, con quién firmó', async () => {
    const r = await svc.firmarCuentaGastoProveedor(` ${RFC.toLowerCase()} `, GASTO, 'contadora');
    expect(r.cuenta).toMatchObject({ estado: 'firmada', cuenta: GASTO, firmada_por: 'contadora' });
    expect((await leerCuentasGasto(trx, M, [RFC])).get(RFC)).toMatchObject({ estado: 'firmada', cuenta: GASTO, nombre: 'GASTO CANDADO 1' });
  });

  it('⭐ re-firmar deja UNA activa y la anterior desactivada (historial)', async () => {
    await svc.firmarCuentaGastoProveedor(RFC, GASTO2, 'contadora2');
    const filas = await trx('contpaqi.supplier_expense_accounts').where({ tenant_id: M, rfc: RFC }).orderBy('created_at').select('cuenta', 'active', 'updated_by');
    expect(filas.filter((f) => f.active).map((f) => f.cuenta)).toEqual([GASTO2]);
    expect(filas).toHaveLength(2);
    expect(filas.find((f) => f.cuenta === GASTO)).toMatchObject({ active: false, updated_by: 'contadora2' });
    expect((await leerCuentasGasto(trx, M, [RFC])).get(RFC)).toMatchObject({ estado: 'firmada', cuenta: GASTO2 });
  });

  it('quitar la firma vuelve a «sin historia»; quitarla otra vez se rechaza', async () => {
    const r = await svc.quitarFirmaCuentaGasto(RFC, 'contadora');
    expect(r.cuenta.estado).toBe('sin_historia');
    expect(r.necesita_firma).toBe(true);
    await expect(svc.quitarFirmaCuentaGasto(RFC, 'contadora')).rejects.toBeInstanceOf(FirmaRechazada);
  });
});
