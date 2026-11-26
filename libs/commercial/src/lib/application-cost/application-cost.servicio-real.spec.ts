import knexFactory, { Knex } from 'knex';
import { ForbiddenException } from '@nestjs/common';
import type { GuardarDecisionCostoDto } from '@megadulces/contracts/http/application-cost';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { ApplicationCostService } from './application-cost.service';

/**
 * `[PQ.157]` C2 — `GET compras/costo-aplicado/aplicaciones/:sucursal/:folio` y `POST compras/costo-aplicado/decisiones`
 * contra Postgres REAL, con el payload que mandará la pantalla. Regla 13: un endpoint que escribe no está probado
 * hasta que una prueba lo ejerció contra base real. Lo que un doble de Knex no ve: que la vista C0 encadene lo
 * sembrado en el ODS (aplicación → orden de entrada → vale → OC, y la caja de la ficha), la RLS forzada, los CHECK, el
 * índice único de la decisión viva y dos personas decidiendo el mismo renglón a la vez.
 *
 *     COSTO_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform \
 *     COSTO_TEST_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform \
 *       npx vitest run --config libs/commercial/vitest.config.ts \
 *       libs/commercial/src/lib/application-cost/application-cost.servicio-real.spec.ts
 *
 * La URL admin sólo siembra y limpia la sucursal `87` (no existe en ninguna base real ni la usa otra prueba).
 * Requiere las migraciones 20261125214023 (la vista) y 20261126001925 (la tabla) aplicadas.
 * ⚠️ Sin las dos variables se SALTA y lo dice. Nunca contra prod.
 */
const URL = process.env.COSTO_TEST_DB_URL;
const ADMIN = process.env.COSTO_TEST_ADMIN_URL;
const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO_T = '00000000-0000-0000-0000-0000000000aa';
const SUC = '87';
const PRV = 'PQ157PRV';
const sufijo = Date.now().toString(36).toUpperCase().slice(-6);
const AP = `A${sufijo}`;
const AP2 = `B${sufijo}`;

if (!URL || !ADMIN) {
  console.warn('[PQ.157] NO MEDIDO: faltan COSTO_TEST_DB_URL y/o COSTO_TEST_ADMIN_URL.');
}

describe.skipIf(!URL || !ADMIN)('[PQ.157] la decisión de costo por renglón (Postgres real)', () => {
  let knex: Knex;
  let admin: Knex;
  let svc: ApplicationCostService;
  let svcOtroTenant: ApplicationCostService;
  const yo = { userId: 'u-prueba', username: 'prueba_costo' };

  /** El payload de la pantalla: la llave del renglón y la decisión. */
  const pedido = (o: Partial<GuardarDecisionCostoDto> = {}): GuardarDecisionCostoDto => ({
    sucursal: SUC, subtipo: '1', folio: AP, renglon: 1, decision: 'accept', reason: 'El proveedor subió su lista el 1-nov', ...o,
  });
  const decisiones = (folio: string, renglon: number) =>
    admin('commercial.application_cost_decisions').where({ sucursal: SUC, folio, renglon }).orderBy('created_at');

  /**
   * Una cadena OC (35) → vale (37) → orden de entrada (40) → aplicación (20), un renglón por producto.
   * `ocPrecio` en la unidad de la OC; con `caja`, la ficha de la sucursal dice cuántas piezas trae (kdii.c81).
   */
  async function sembrar(folio: string, renglones: { r: number; sku: string; ocPrecio: number; aplicado: number; cant: number; caja?: number }[]) {
    const dia = '2026-11-20 10:00:00';
    const cab = (c4: number, c6: string, extra: Record<string, unknown> = {}) =>
      ({ sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4, c5: 1, c6, c9: dia, c10: PRV, c43: '', ...extra });
    // Folios propios de cada aplicación: si dos cadenas compartieran OC, vale u orden, la vista las cruzaría.
    const oc = `O${folio}`; const vale = `V${folio}`; const oe = `E${folio}`;
    await admin('kepler_ods.kdm1').insert([cab(35, oc, { c67: 'SUITE' }), cab(37, vale), cab(40, oe), cab(20, folio)]);
    const ren = (c4: number, c6: string, r: number, sku: string, cant: number, precio: number, liga: [number, string] | null) => ({
      sucursal: SUC, c1: SUC, c2: 'X', c3: 'A', c4, c5: 1, c6, c7: r, c8: sku, c9: cant, c11: 'PZA', c12: precio,
      c13: Math.round(cant * precio * 100) / 100,
      c20: liga ? liga[0] : 0, c21: liga ? 1 : null, c22: liga ? liga[1] : null, c23: liga ? r : null,
    });
    for (const x of renglones) {
      await admin('kepler_ods.kdm2').insert([
        ren(35, oc, x.r, x.sku, x.cant, x.ocPrecio, null),
        ren(37, vale, x.r, x.sku, x.cant, x.ocPrecio, [35, oc]),
        ren(40, oe, x.r, x.sku, x.cant, x.aplicado, [37, vale]),
        ren(20, folio, x.r, x.sku, x.cant, x.aplicado, [40, oe]),
      ]);
      if (x.caja) await admin('kepler_ods.kdii').insert({ sucursal: SUC, c1: x.sku, c81: x.caja, c84: null });
    }
  }

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    admin = knexFactory({ client: 'pg', connection: ADMIN as string, pool: { min: 0, max: 2 } });
    const ctxDe = (tenant: string) => ({ requireTenantId: () => tenant, get: () => ({ tenantId: tenant, userId: null, username: 'prueba_costo' }) }) as unknown as TenantContextService;
    // Alcance: sólo la sucursal de prueba, para lectura y escritura.
    const scope = {
      assertCanRead: async (_d: string, v: string) => { if (v !== SUC) throw new ForbiddenException(`warehouse ${v} fuera de tu alcance`); },
      assertCanWrite: async (_d: string, v: string) => { if (v !== SUC) throw new ForbiddenException(`warehouse ${v} fuera de tu alcance`); },
    } as unknown as ScopeService;
    svc = new ApplicationCostService(new TenantKnexService(knex, ctxDe(T)), ctxDe(T), scope);
    svcOtroTenant = new ApplicationCostService(new TenantKnexService(knex, ctxDe(OTRO_T)), ctxDe(OTRO_T), scope);

    const falta = (await admin.raw(`SELECT to_regclass('commercial.v_application_line_cost') IS NULL
                                        OR to_regclass('commercial.application_cost_decisions') IS NULL AS falta`)).rows[0].falta;
    if (falta) throw new Error('Faltan las migraciones 20261125214023 y/o 20261126001925 en esta base.');
    const ocupado = await admin('kepler_ods.kdm1').where({ sucursal: SUC }).first();
    if (ocupado) throw new Error(`La base ya tiene datos de la sucursal ${SUC}: esta prueba necesita ese código libre.`);

    await sembrar(AP, [
      { r: 1, sku: 'PQ157-A', ocPrecio: 21.6, aplicado: 23, cant: 24 },              // sube: 33.60 de diferencia
      { r: 2, sku: 'PQ157-B', ocPrecio: 26.1, aplicado: 25, cant: 15 },              // baja
      { r: 3, sku: 'PQ157-C', ocPrecio: 10, aplicado: 10, cant: 5 },                 // igual
      { r: 4, sku: 'PQ157-D', ocPrecio: 264, aplicado: 23.1, cant: 36, caja: 12 },   // OC en caja de 12: 22.00 la pieza → sube 5 %
    ]);
    await sembrar(AP2, [
      { r: 1, sku: 'PQ157-B', ocPrecio: 26.1, aplicado: 25, cant: 10 },              // el mismo costo que AP/2
      { r: 2, sku: 'PQ157-B', ocPrecio: 26.1, aplicado: 24, cant: 10 },              // CONTROL: otro costo
    ]);
  });

  afterAll(async () => {
    if (admin) {
      await admin('commercial.application_cost_decisions').where({ sucursal: SUC }).del();
      await admin('kepler_ods.kdm2').where({ sucursal: SUC }).del();
      await admin('kepler_ods.kdm1').where({ sucursal: SUC }).del();
      await admin('kepler_ods.kdii').where({ sucursal: SUC }).del();
      await admin.destroy();
    }
    if (knex) await knex.destroy();
  });

  it('la aplicación llega con su cadena, su estado por renglón y la OC en la unidad de la aplicación', async () => {
    const a = await svc.aplicacion(SUC, AP);
    expect(a.renglones.map((r) => [r.renglon, r.cost_state])).toEqual([[1, 'sube'], [2, 'baja'], [3, 'igual'], [4, 'sube']]);
    const [r1, , r3, r4] = a.renglones;
    expect(r1).toMatchObject({ oc_price: 21.6, applied_price: 23, quantity: 24, maximo_reclamable: 33.6, decision: null, antecedente: null,
      oe_folio: `E${AP}`, vale_folio: `V${AP}`, oc_folio: `O${AP}`, oc_de_la_suite: true, supplier_code: PRV });
    expect(r3.maximo_reclamable).toBe(0);
    // La caja de 12 de la ficha: 264 ÷ 12 = 22.00 la pieza; la OC tal cual sigue a la vista.
    expect(r4).toMatchObject({ oc_price: 22, oc_price_original: 264, escala: 'oc_en_unidad_mayor', factor_escala: 12 });
    expect(a.por_decidir).toBe(3);
  });

  it('decidir guarda la FOTO de la vista, no lo que mande la pantalla, con quién y por qué', async () => {
    const d = await svc.decidir(yo, { ...pedido(), applied_price: 1, oc_price: 1 } as GuardarDecisionCostoDto);
    expect(d).toMatchObject({ decision: 'accept', applied_price: 23, oc_price: 21.6, quantity: 24, cost_state: 'sube', created_by: 'prueba_costo',
      claim_amount: null, valid_until: null, superseded_at: null });
    const a = await svc.aplicacion(SUC, AP);
    expect(a.renglones[0].decision?.id).toBe(d.id);
    expect(a.por_decidir).toBe(2);
  });

  it('cambiar de opinión reemplaza la decisión viva y conserva la anterior (nada se borra)', async () => {
    const d = await svc.decidir(yo, pedido({ decision: 'claim', claim_amount: 33.6, reason: 'Facturó arriba de lo pactado en la OC' }));
    expect(d).toMatchObject({ decision: 'claim', claim_amount: 33.6 });
    const filas = await decisiones(AP, 1);
    expect(filas).toHaveLength(2);
    expect(filas.filter((f) => f.superseded_at == null)).toHaveLength(1);
    expect(filas[0]).toMatchObject({ decision: 'accept', superseded_by: 'prueba_costo' });
  });

  it('una promoción lleva su fecha de fin', async () => {
    const d = await svc.decidir(yo, pedido({ renglon: 4, decision: 'promotion', valid_until: '2026-12-31', reason: 'Promoción de fin de año del proveedor' }));
    expect(d).toMatchObject({ decision: 'promotion', valid_until: '2026-12-31', oc_price: 22 });
  });

  it('PRUEBAS NEGATIVAS: lo que la regla no deja, rebota con 400 y su motivo; nada se guarda', async () => {
    const antes = await admin('commercial.application_cost_decisions').where({ sucursal: SUC }).count<{ count: string }[]>('* as count');
    const casos: [Partial<GuardarDecisionCostoDto>, RegExp][] = [
      [{ decision: 'claim', claim_amount: 33.62 }, /más que la diferencia/],
      [{ renglon: 2, decision: 'claim', claim_amount: 5 }, /Sólo se reclama cuando el costo sube/],
      [{ renglon: 3 }, /no hay nada que decidir/],
      [{ renglon: 2, decision: 'promotion' }, /hasta cuándo/],
      [{ renglon: 2, reason: 'corto' }, /al menos 10 letras/],
      [{ renglon: 2, decision: 'accept', valid_until: '2026-12-31' }, /sólo va en una promoción/],
    ];
    for (const [o, msg] of casos) {
      await expect(svc.decidir(yo, pedido(o))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(msg) });
    }
    const despues = await admin('commercial.application_cost_decisions').where({ sucursal: SUC }).count<{ count: string }[]>('* as count');
    expect(despues[0].count).toBe(antes[0].count);
  });

  it('lo que no existe es 404; fuera de alcance, 403', async () => {
    await expect(svc.decidir(yo, pedido({ renglon: 99 }))).rejects.toMatchObject({ status: 404 });
    await expect(svc.aplicacion(SUC, 'NOEXISTE')).rejects.toMatchObject({ status: 404 });
    await expect(svc.aplicacion('03', AP)).rejects.toMatchObject({ status: 403 });
    await expect(svc.decidir(yo, pedido({ sucursal: '03' }))).rejects.toMatchObject({ status: 403 });
  });

  it('«ya se aceptó antes»: el mismo costo aceptado en otro renglón aparece como antecedente; otro costo, no (CONTROL)', async () => {
    const acept = await svc.decidir(yo, pedido({ renglon: 2, decision: 'accept', reason: 'Bajó su precio de lista este mes' }));
    const a2 = await svc.aplicacion(SUC, AP2);
    expect(a2.renglones[0].antecedente?.id).toBe(acept.id);
    expect(a2.renglones[1].antecedente).toBeNull();
  });

  it('dos personas decidiendo el mismo renglón a la vez: la segunda recibe 409 y no hay dos vivas', async () => {
    // La carrera, forzada: la otra persona insertó su decisión y aún no confirma. El FOR UPDATE de la segunda no la ve
    // (no existe para ella), su INSERT queda esperando el índice único y, al confirmar la primera, choca (23505).
    const otra = await admin.transaction();
    await otra('commercial.application_cost_decisions').insert({
      tenant_id: T, sucursal: SUC, subtipo: '1', folio: AP2, renglon: 1, supplier_code: PRV, sku: 'PQ157-B', unit: 'PZA',
      quantity: 10, applied_price: 25, oc_price: 26.1, cost_state: 'baja', decision: 'accept',
      reason: 'La otra persona decidió primero', created_by: 'otra_persona', updated_by: 'otra_persona',
    });
    const segunda = svc.decidir(yo, pedido({ folio: AP2, renglon: 1, reason: 'Segunda persona que decide' }));
    const resultado = segunda.then(() => 'guardó', (e) => e);
    await new Promise((r) => setTimeout(r, 700));
    await otra.commit();
    expect(await resultado).toMatchObject({ status: 409, message: expect.stringMatching(/Otra persona acaba de decidir/) });
    const vivas = (await decisiones(AP2, 1)).filter((f) => f.superseded_at == null);
    expect(vivas).toHaveLength(1);
    expect(vivas[0].created_by).toBe('otra_persona');
  });

  it('otro tenant no ve la aplicación ni sus decisiones (RLS y el tenant de la vista)', async () => {
    await expect(svcOtroTenant.aplicacion(SUC, AP)).rejects.toMatchObject({ status: 404 });
  });
});
