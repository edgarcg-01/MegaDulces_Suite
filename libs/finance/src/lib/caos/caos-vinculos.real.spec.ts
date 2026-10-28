import knexFactory, { Knex } from 'knex';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CaosService } from './caos.service';

/**
 * `[CGA-A.58]` Corregir un vínculo CAOS ↔ Caja General: sólo superadmin, con motivo, y lo libre
 * vuelve. Las negativas de permiso y de motivo corren SIEMPRE (no tocan la base); el camino entero
 * corre contra una base REAL (regla 13: un endpoint que escribe no está probado sin ella).
 *
 *     CAJA_TEST_DB_URL=<la URL de la base de prueba, como app_runtime> \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/caos/caos-vinculos.real.spec.ts
 *
 * ⚠️ Sin `CAJA_TEST_DB_URL` la parte de base se SALTA y lo dice. Escribe y no deshace: sólo contra
 *    una base de prueba. Cada corrida usa su propio equipo de CAOS y fechas de 2098.
 */
const URL = process.env['CAJA_TEST_DB_URL'];
const T = '00000000-0000-0000-0000-00000000d01c';
const SUPER = '00000000-0000-0000-0000-0000000000a1';
const CORRIDA = Date.now().toString(36);
const DEV = `A58-${CORRIDA}`;
const DIA = '2098-04-01';

const sinBase = () => {
  const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
  const tk = { run: () => { throw new Error('no debía tocar la base'); } } as unknown as TenantKnexService;
  return new CaosService(tk, ctx);
};

describe('[CGA-A.58] corregir vínculos: el candado de superadmin y el motivo', () => {
  it('NEGATIVA: admin (god-mode del guard) NO corrige — se exige superadmin exacto, antes de tocar la base', async () => {
    const svc = sinBase();
    const admin = { id: SUPER, roles_frescos: ['admin'] };
    await expect(svc.quitarVinculo('x', 'motivo suficientemente largo', admin)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.vincular('x', { folio: 'CI-1', monto: 10 }, admin)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.vincular('x', { folio: 'CI-1', monto: 10 }, { id: SUPER })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('NEGATIVA: superadmin sin motivo (o con menos de 10 caracteres) no quita nada', async () => {
    const svc = sinBase();
    const sa = { id: SUPER, roles_frescos: ['superadmin'] };
    await expect(svc.quitarVinculo('x', '   ', sa)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.quitarVinculo('x', 'error', sa)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('NEGATIVA: superadmin sin folio o con monto ≤ 0 no vincula', async () => {
    const svc = sinBase();
    const sa = { id: SUPER, roles_frescos: ['SuperAdmin'] };
    await expect(svc.vincular('x', { folio: ' ', monto: 10 }, sa)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.vincular('x', { folio: 'CI-1', monto: 0 }, sa)).rejects.toBeInstanceOf(BadRequestException);
  });
});

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CGA-A.58] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual probar quitar y volver a vincular.');
}

describe.skipIf(!URL)('[CGA-A.58] quitar y volver a vincular — base real', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let svc: CaosService;
  const sa = { id: SUPER, username: 'prueba_super', roles_frescos: ['superadmin'] };

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 2 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    svc = new CaosService(tk, ctx);
  });
  afterAll(async () => { await knex?.destroy(); });

  it('un depósito de $1,000 con un ingreso de $600 vinculado: se quita con motivo, vuelve libre y se re-vincula', async () => {
    const { movId, folio, linkId } = await tk.run(async (trx) => {
      const [m] = await trx('analytics.caos_cash_movements').insert({
        tenant_id: T, device: DEV, external_id: 1, type_id: 0, type_label: 'Deposito',
        occurred_at: `${DIA}T12:00:00-06:00`, accounting_date: DIA, user_external: 'Prueba (001)',
        total: 1000, ref: 'a58 prueba', _row_hash: `a58-${CORRIDA}`,
      }).returning('id');
      const f = `A58-${CORRIDA}`;
      const [l] = await trx('finance.cash_ledger').insert({
        tenant_id: T, folio: f, tipo: 'ingreso', fecha: DIA, sucursal: `A58-${CORRIDA}`,
        kepler_cuenta: '101-001', kepler_concepto: '001', glosa: 'cobro de prueba', monto: 600,
        origen_tipo: 'cobro', origen_ref: `06-001|U-A-5|${CORRIDA}|0011`, created_by: SUPER,
      }).returning('id');
      const [k] = await trx('finance.caos_cash_links').insert({
        tenant_id: T, cash_ledger_id: l.id ?? l, caos_device: DEV, caos_external_id: 1, monto_enlazado: 600, confirmed_by: SUPER,
      }).returning('id');
      return { movId: m.id ?? m, folio: f, linkId: k.id ?? k };
    });

    const antes = await svc.vinculos(movId);
    expect(antes?.libre).toBe(400);
    expect(antes?.filas.map((x) => x.folio)).toEqual([folio]);

    await svc.quitarVinculo(linkId, 'se vinculó al depósito equivocado', sa);
    const baja = await tk.run((trx) => trx('finance.caos_cash_links').where({ id: linkId }).first('deleted_at', 'deleted_by', 'motivo_baja'));
    expect(baja.deleted_at).not.toBeNull();
    expect(baja.deleted_by).toBe(SUPER);
    expect(baja.motivo_baja).toBe('se vinculó al depósito equivocado');
    expect((await svc.vinculos(movId))?.libre).toBe(1000);
    // NEGATIVA: quitarlo otra vez no hace una segunda baja.
    await expect(svc.quitarVinculo(linkId, 'se vinculó al depósito equivocado', sa)).rejects.toBeInstanceOf(ConflictException);

    // Re-vincular con el folio, como lo manda la pantalla.
    await svc.vincular(movId, { folio: folio.toLowerCase(), monto: 600 }, sa);
    const despues = await svc.vinculos(movId);
    expect(despues?.vinculado).toBe(600);
    expect(despues?.libre).toBe(400);
    // NEGATIVA: el folio ya está explicado entero — un peso más se rechaza con su frase.
    await expect(svc.vincular(movId, { folio, monto: 1 }, sa)).rejects.toThrow(/sólo le faltan \$0\.00/);
  });

  it('NEGATIVA: la base rechaza una baja sin quién ni motivo aunque alguien se salte el servicio', async () => {
    await expect(tk.run(async (trx) => {
      const [m] = await trx('analytics.caos_cash_movements').insert({
        tenant_id: T, device: DEV, external_id: 2, type_id: 0, type_label: 'Deposito',
        occurred_at: `${DIA}T13:00:00-06:00`, accounting_date: DIA, user_external: 'Prueba (001)',
        total: 500, ref: 'a58 prueba 2', _row_hash: `a58-${CORRIDA}-2`,
      }).returning('id');
      void m;
      const [l] = await trx('finance.cash_ledger').insert({
        tenant_id: T, folio: `A58B-${CORRIDA}`, tipo: 'ingreso', fecha: DIA, sucursal: `A58-${CORRIDA}`,
        kepler_cuenta: '101-001', kepler_concepto: '001', glosa: 'cobro de prueba 2', monto: 500,
        origen_tipo: 'cobro', origen_ref: `06-001|U-A-5|${CORRIDA}-2|0011`, created_by: SUPER,
      }).returning('id');
      const [k] = await trx('finance.caos_cash_links').insert({
        tenant_id: T, cash_ledger_id: l.id ?? l, caos_device: DEV, caos_external_id: 2, monto_enlazado: 500, confirmed_by: SUPER,
      }).returning('id');
      await trx('finance.caos_cash_links').where({ id: k.id ?? k }).update({ deleted_at: trx.fn.now() });
    })).rejects.toThrow(/caos_link_baja_con_motivo/);
  });
});
