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

// ── `[CGA-A.61]` La propuesta de la reposición (lote) y «cambiar de retiro» ──────────────────

describe('[CGA-A.61] lote y cambiar de retiro: superadmin, motivo y forma — sin base', () => {
  it('NEGATIVA: admin no confirma un lote ni cambia de retiro (superadmin exacto, antes de la base)', async () => {
    const svc = sinBase();
    const admin = { id: SUPER, roles_frescos: ['admin'] };
    await expect(svc.vincularLote({ asignaciones: [{ ledger_id: 'l', device: 'd', external_id: 1, monto: 1 }] }, admin))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.moverVinculo('x', { device: 'd', external_id: 2, motivo: 'motivo suficientemente largo' }, admin))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('NEGATIVA: un lote vacío, o con un monto ≤ 0, no llega a la base', async () => {
    const svc = sinBase();
    const sa = { id: SUPER, roles_frescos: ['superadmin'] };
    await expect(svc.vincularLote({ asignaciones: [] }, sa)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.vincularLote({ asignaciones: [{ ledger_id: 'l', device: 'd', external_id: 1, monto: 0 }] }, sa))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('NEGATIVA: cambiar de retiro sin motivo, o sin destino, no llega a la base', async () => {
    const svc = sinBase();
    const sa = { id: SUPER, roles_frescos: ['superadmin'] };
    await expect(svc.moverVinculo('x', { device: 'd', external_id: 2, motivo: 'corto' }, sa)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.moverVinculo('x', { device: '', external_id: 2, motivo: 'motivo suficientemente largo' }, sa))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CGA-A.61] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual probar el lote de vínculos ni cambiar de retiro.');
}

describe.skipIf(!URL)('[CGA-A.61] lote de vínculos y cambiar de retiro — base real', () => {
  let knex: Knex;
  let tk: TenantKnexService;
  let svc: CaosService;
  const sa = { id: SUPER, username: 'prueba_super', roles_frescos: ['superadmin'] };
  const DEV61 = `A61-${CORRIDA}`;

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 2 } });
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    tk = new TenantKnexService(knex, ctx);
    svc = new CaosService(tk, ctx);
  });
  afterAll(async () => { await knex?.destroy(); });

  /** Un retiro (type 4) y egresos de sucursal sin vincular, como los de Canindo del 27/10. */
  const sembrar = (ext: number, total: number, egresos: number[]) => tk.run(async (trx) => {
    await trx('analytics.caos_cash_movements').insert({
      tenant_id: T, device: DEV61, external_id: ext, type_id: 4, type_label: 'Dispensar',
      occurred_at: `${DIA}T11:00:00-06:00`, accounting_date: DIA, user_external: 'Prueba (001)',
      total: -total, ref: `gastos canindo a61 ${ext}`, _row_hash: `a61-${CORRIDA}-${ext}`,
    });
    const ids: string[] = [];
    for (const [i, monto] of egresos.entries()) {
      const [l] = await trx('finance.cash_ledger').insert({
        tenant_id: T, folio: `A61-${CORRIDA}-${ext}-${i}`, tipo: 'gasto', fecha: DIA, sucursal: '06',
        kepler_cuenta: '601-001', kepler_concepto: '001', glosa: 'gasto de prueba a61', monto,
        origen_tipo: 'pago_proveedor', origen_ref: `06|X-D-26|A61${CORRIDA}${ext}${i}|0011`, created_by: SUPER,
      }).returning('id');
      ids.push(l.id ?? l);
    }
    return ids;
  });
  const libre = (ext: number) => tk.run(async (trx) => {
    const r = await trx('finance.caos_cash_links').where({ tenant_id: T, caos_device: DEV61, caos_external_id: ext })
      .whereNull('deleted_at').sum({ s: 'monto_enlazado' }).first();
    const m = await trx('analytics.caos_cash_movements').where({ tenant_id: T, device: DEV61, external_id: ext }).first('total');
    return Math.abs(Number(m.total)) - Number(r?.s ?? 0);
  });

  it('la propuesta entra entera, y si un vínculo no cabe NO entra ninguno (todo o nada)', async () => {
    const [a, b] = await sembrar(11, 1000, [600, 500]);
    await svc.vincularLote({ asignaciones: [
      { ledger_id: a, device: DEV61, external_id: 11, monto: 600 },
      { ledger_id: b, device: DEV61, external_id: 11, monto: 400 },
    ] }, sa);
    expect(await libre(11)).toBe(0);
    // NEGATIVA: $100 más del mismo retiro ya no caben → error con folio, y lo bueno del lote tampoco entra.
    const [c] = await sembrar(12, 300, [300]);
    await expect(svc.vincularLote({ asignaciones: [
      { ledger_id: c, device: DEV61, external_id: 12, monto: 300 },
      { ledger_id: b, device: DEV61, external_id: 11, monto: 100 },
    ] }, sa)).rejects.toBeInstanceOf(ConflictException);
    expect(await libre(12)).toBe(300);
  });

  it('ampliar: el egreso que YA tenía vínculo con ese retiro da de baja el viejo (con motivo) y queda uno por la suma', async () => {
    const [a] = await sembrar(21, 1000, [700]);
    await svc.vincularLote({ asignaciones: [{ ledger_id: a, device: DEV61, external_id: 21, monto: 300 }] }, sa);
    await svc.vincularLote({ asignaciones: [{ ledger_id: a, device: DEV61, external_id: 21, monto: 100 }] }, sa);
    const filas = await tk.run((trx) => trx('finance.caos_cash_links').where({ tenant_id: T, cash_ledger_id: a })
      .orderBy('created_at').select('monto_enlazado', 'deleted_at', 'motivo_baja'));
    expect(filas.map((f: { monto_enlazado: string }) => Number(f.monto_enlazado))).toEqual([300, 400]);
    expect(filas[0].deleted_at).not.toBeNull();
    expect(filas[0].motivo_baja).toMatch(/se amplía de \$300\.00 a \$400\.00/);
    expect(filas[1].deleted_at).toBeNull();
  });

  it('cambiar de retiro: baja con motivo + alta en el destino; a un destino lleno no pasa NADA', async () => {
    const [a] = await sembrar(31, 600, [600]);
    await sembrar(32, 250, []);
    await svc.vincularLote({ asignaciones: [{ ledger_id: a, device: DEV61, external_id: 31, monto: 600 }] }, sa);
    const vivo = () => tk.run((trx) => trx('finance.caos_cash_links').where({ tenant_id: T, cash_ledger_id: a })
      .whereNull('deleted_at').first('id', 'caos_external_id', 'monto_enlazado'));
    // El destino tiene $250: toma lo que alcanza y lo demás se dice.
    const r = await svc.moverVinculo((await vivo()).id, { device: DEV61, external_id: 32, motivo: 'salió del retiro de Canindo' }, sa);
    expect(r).toMatchObject({ monto: 250, queda: 350 });
    expect(await libre(31)).toBe(600);
    expect(await libre(32)).toBe(0);
    // NEGATIVA: de vuelta a un destino sin libre... el 31 tiene 600: se mueve; al 32 (lleno) NO, y la baja se revierte.
    const antes = await vivo();
    await expect(svc.moverVinculo(antes.id, { device: DEV61, external_id: 32, motivo: 'otra vez al lleno' }, sa))
      .rejects.toThrow(/ya es de ese retiro|no tiene dinero libre/);
    expect((await vivo()).id).toBe(antes.id);
  });
});
