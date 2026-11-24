/**
 * `[RE.87]` La regla de la entrada INTERNA (`esEntradaInternaSql`) contra Postgres real, como `app_runtime`, en una
 * transacción revertida: el «proveedor» de la entrada es la propia empresa (el RFC de `fiscal.issuer_config`, sin
 * importar mayúsculas ni espacios) o un proveedor marcado `is_internal` en el catálogo. Datos SINTÉTICOS con la forma
 * real (Canindo, clave CL005, «COMPRA DE ENTRADA A CODIGOS DE PROMOCION»).
 *
 * ⛔ Sólo corre con `TP_IT_DB` LOCAL que no sea prod (se compara el `system_identifier`).
 */
import knexFactory, { type Knex } from 'knex';
import { esEntradaInternaSql } from './entrada-interna';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const T = '00000000-0000-0000-0000-00000000d01c';
const RFC_EMPRESA = 'LOGL851014AQ5';

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[RE.87] NO MEDIDO: sin TP_IT_DB la prueba de la entrada interna no corre.');

suite('[RE.87] la entrada interna, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  const interna = async (folio: string, conCatalogo = true) =>
    (await trx.raw(`SELECT ${esEntradaInternaSql(conCatalogo)} AS ok FROM analytics.erp_goods_receipts c WHERE c.sucursal = '96' AND c.folio = ?`, [folio])).rows[0]?.ok as boolean;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
    await trx('fiscal.issuer_config').insert({ tenant_id: T, rfc: RFC_EMPRESA.toLowerCase(), tax_name: 'EMPRESA DE PRUEBA', regimen_fiscal: '612', cp: '00000', pac_provider: 'prueba', is_default: true, active: true });
    const ap = (folio: string, prov: string, rfc: string, concepto: string) =>
      trx.raw(`INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c9, c10, c16, c22, c24, c32, c43)
               VALUES ('96', '96', 'X', 'A', 20, 1, ?, '2026-11-21'::timestamp, ?, 0.24, ?, ?, 'PRUEBA', 'N')`, [folio, prov, rfc, concepto]);
    await ap('0000328', 'CL005', RFC_EMPRESA, 'COMPRA DE ENTRADA A CODIGOS DE PROMOCION');
    await ap('0000329', 'CL005', ` ${RFC_EMPRESA.toLowerCase()} `, 'mismo RFC con espacios y minúsculas');
    await ap('0000330', 'CP050', 'PAD000101AAA', 'un proveedor de verdad');
    await ap('0000331', 'ZZ001', 'ZZZ000101ZZZ', 'proveedor marcado interno en el catálogo');
    await trx('catalog.suppliers').insert({ tenant_id: T, code: 'ZZ001', name: 'TRASPASO INTERNO DE PRUEBA', activo: true, is_internal: true, internal_reason: 'Prueba: clave de traspaso interno' });
    await trx.raw('SET LOCAL ROLE app_runtime');
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('el proveedor con el RFC de la empresa es interna, aunque venga con espacios o en minúsculas (y el de la empresa, en minúsculas)', async () => {
    expect(await interna('0000328')).toBe(true);
    expect(await interna('0000329')).toBe(true);
  });

  it('NEGATIVA: un proveedor real no es interna', async () => {
    expect(await interna('0000330')).toBe(false);
  });

  it('un proveedor marcado interno en el catálogo también; sin la columna del catálogo, sólo cuenta el RFC', async () => {
    expect(await interna('0000331', true)).toBe(true);
    expect(await interna('0000331', false)).toBe(false);
    expect(await interna('0000328', false)).toBe(true);
  });
});
