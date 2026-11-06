import { randomUUID } from 'node:crypto';
import knexFactory, { Knex } from 'knex';
import { HttpException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { PagarHojaAbiertaInput, ZonaHojaGastos } from '@megadulces/contracts';
import type { FilaRespaldoCompra, FilaRespaldoGasto } from '../cashbook/cashbook-ventanilla.service';
import type { CashLedgerService } from './cash-ledger.service';
import type { BancoDeZona, PagoDeZona } from './hoja-gastos.engine';
import { HojaGastosService } from './hoja-gastos.service';

/**
 * ⛔ `[LE.6.19]` `[LE.6.20]` — Pagar la reposición de una zona en UN acto, contra Postgres y con el payload
 * de la pantalla (regla 13): `POST finance/hoja-gastos/abierta/:zona/pagar` con `{ origen_refs, client_key,
 * pago }`, tal como lo arma `CajaReposicionComponent.enviarPagoAbierta`.
 *
 * Lo que se ejerce de verdad: la hoja y sus renglones, el disparador `expense_sheets_transicion` de la
 * migración `20261106102659` (cerrada → pagada sin aprobación, conteo exigido si sale algo del cajón), la
 * validación del retiro de CAOS, la llave y el candado de la caja, la idempotencia por `client_key`.
 *
 * Lo que se sustituye con filas (esas tablas no existen en la base de prueba): los pagos de la zona
 * (`pagosDeZona`, la consulta del ODS), lo que Kepler dice que paga cada X-D-26 (`filasDelRespaldo`) y la
 * cuenta de la zona (`bancoDeZona`). El lote que captura los pagos al libro (`CashLedgerService.crearLote`)
 * se sustituye por uno que no guarda nada: tiene sus propias pruebas y aquí lo que se mide es el pago.
 *
 *     CAJA_TEST_DB_URL=postgresql://app_runtime:app_runtime@127.0.0.1:5432/postgres_platform \
 *       npx vitest run --config libs/finance/vitest.config.ts libs/finance/src/lib/caja/hoja-gastos.servicio-real.spec.ts
 *
 * Empresa al azar por corrida: lo escrito se queda en la base de prueba.
 */
const URL = process.env['CAJA_TEST_DB_URL'];
const T = randomUUID();
const CAJA = { id: randomUUID(), username: 'le619_caja' };
const DEV = `LE619-${Date.now().toString(36)}`;

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[LE.6.19] NO MEDIDO: sin CAJA_TEST_DB_URL no se paga la reposición contra una base real.');
}

class HojaConFilas extends HojaGastosService {
  filasZona: PagoDeZona[] = [];
  compras = new Map<string, Array<Omit<FilaRespaldoCompra, 'sucursal' | 'folio'>>>();
  banco: BancoDeZona | null = null;
  protected override async pagosDeZona(_trx: Knex.Transaction, _t: string, zona: ZonaHojaGastos): Promise<PagoDeZona[]> {
    return this.filasZona.filter((p) => zona.sucursales.includes(p.sucursal));
  }
  protected override async filasDelRespaldo(_trx: Knex.Transaction, _t: string, pares: ReadonlyArray<[string, string]>)
    : Promise<{ gastos: FilaRespaldoGasto[]; compras: FilaRespaldoCompra[] } | null> {
    return {
      gastos: [],
      compras: pares.flatMap(([sucursal, folio]) => (this.compras.get(`${sucursal}|${folio}`) ?? []).map((c) => ({ sucursal, folio, ...c }))),
    };
  }
  protected override async bancoDeZona(): Promise<BancoDeZona | null> {
    return this.banco;
  }
}

/** El día de México de hoy y de hace `n` días, como los fecha Kepler. */
const diaMx = (n = 0) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

describe.skipIf(!URL)('[LE.6.19] pagar la reposición de una zona en un acto, contra una base real', () => {
  let knex: Knex;
  let svc: HojaConFilas;
  let listo = false;

  /** Un pago X-D-26 de Morelia (Abastos), respaldado por su entrada de Kepler: así trae su autorización. */
  const pago = (folio: string, importe: string, dia = diaMx()): PagoDeZona => {
    svc.compras.set(`08|${folio}`, [{ doc: `E${folio}`, aplicado: importe, importe_doc: importe, aplicado_total: importe }]);
    return {
      origen_ref: `08|X-D-26|${folio}|0011`, sucursal: '08', doc_tipo: 'X-D-26', folio, fecha_pago: dia, fecha_captura: dia,
      beneficiario: 'PROVEEDOR DE PRUEBA', clave: 'GG015', centro: '007', referencia: null, importe,
      en_libro: null, cg_folio: null, en_hoja: false,
    };
  };
  /** Un retiro de CAOS (Dispensar) libre, como lo deja el carril de la máquina. */
  const retiro = async (external_id: number, total: number, ref = 'gnf morelia') => {
    const tk = new TenantKnexService(knex, { requireTenantId: () => T } as unknown as TenantContextService);
    await tk.run(async (trx) => {
      await trx('analytics.caos_cash_movements').insert({ tenant_id: T, device: DEV, external_id, type_id: 4, type_label: 'Dispensar',
        occurred_at: new Date(Date.now() - 600_000).toISOString(), total, ref, user_external: 'cajera', _row_hash: `${DEV}-${external_id}` });
    });
  };
  /** La fila como quedó en la base (numeric y bigint llegan como texto). */
  const hoja = (id: string): Promise<Record<string, unknown>> => knex.transaction(async (trx): Promise<Record<string, unknown>> => {
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
    return trx('finance.expense_sheets').where({ tenant_id: T, id }).first('estado', 'medio', 'cajon', 'conteo', 'conteo_morralla',
      'aprobada_por', 'cerrada_por', 'pagada_por', 'caos_external_id', 'renglones', 'total');
  });
  const hojasDeLaLlave = (client_key: string) => knex.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
    return Number((await trx('finance.expense_sheets').where({ tenant_id: T, client_key }).count({ n: '*' }).first())?.n ?? 0);
  });
  const rechazo = async (p: Promise<unknown>): Promise<{ status: number; texto: string }> => {
    try { await p; } catch (e) {
      if (e instanceof HttpException) {
        const r = e.getResponse();
        return { status: e.getStatus(), texto: typeof r === 'string' ? r : String((r as { message?: unknown }).message ?? '') };
      }
      throw e;
    }
    throw new Error('se esperaba un rechazo y se pagó');
  };

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    // La migración del acto único, por el disparador que deja (`app_runtime` no lee `knex_migrations`).
    const r = (await knex.raw(`SELECT to_regclass('finance.expense_sheets') IS NOT NULL AS hojas,
        to_regprocedure('finance.expense_sheets_transicion()') IS NOT NULL
          AND pg_get_functiondef('finance.expense_sheets_transicion()'::regprocedure) LIKE '%[LE.6.19]%' AS un_acto`)).rows[0];
    listo = r.hojas === true && r.un_acto === true;
    if (!listo) {
      // eslint-disable-next-line no-console
      console.warn('[LE.6.19] NO MEDIDO: la base de prueba no tiene la migración 20261106102659 (la hoja en un acto).');
      return;
    }
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    const ledger = { crearLote: async () => ({ guardados: 0, filas: [] }) } as unknown as CashLedgerService;
    svc = new HojaConFilas(new TenantKnexService(knex, ctx), ctx, ledger);
    // Quien paga tiene la llave de la caja por su rol (no superadmin: la base se la niega, LE.0.9).
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      await trx.raw(`INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
        VALUES (?, 'le619_caja', '{"FINANCE_CAJA_GESTIONAR": true}'::jsonb)`, [T]);
      await trx.raw(`INSERT INTO identity.users (id, tenant_id, username, role_name, activo, password_hash)
        VALUES (?, ?, ?, 'le619_caja', true, 'prueba-sin-login')`, [CAJA.id, T, CAJA.username]);
    });
  });
  afterAll(async () => { await knex?.destroy(); });

  it('⭐ con el retiro y el pico del cajón CONTADO: queda pagada sin aprobación, con su conteo; el doble clic no paga otra', async () => {
    if (!listo) return;
    svc.filasZona = [pago('0091001', '600.00'), pago('0091002', '400.89')];
    await retiro(91001, 1000);
    // El payload de la pantalla: los pagos de la abierta, la llave de la pantalla y el retiro con el arqueo del pico.
    const body: PagarHojaAbiertaInput = {
      origen_refs: svc.filasZona.map((p) => p.origen_ref), client_key: randomUUID(),
      pago: { medio: 'caos', device: DEV, external_id: 91001, conteo: { piezas: { '0.5': 1 }, morralla: 0.39 } },
    };
    const r = await svc.pagarAbierta('morelia', body, CAJA);
    expect(r.hoja.estado).toBe('pagada');
    expect(r.sin_capturar).toHaveLength(2); // el lote sustituido no guarda: lo que falta se dice
    const h = await hoja(r.hoja.id);
    expect(h).toMatchObject({ estado: 'pagada', medio: 'caos', aprobada_por: null, cerrada_por: CAJA.id, pagada_por: CAJA.id,
      renglones: 2 });
    expect(Number(h.caos_external_id)).toBe(91001); // bigint: pg lo devuelve como texto
    expect(Number(h.cajon)).toBeCloseTo(0.89, 2);
    expect(Number(h.total)).toBeCloseTo(1000.89, 2);
    expect(h.conteo).toEqual({ '0.5': 1 });
    expect(Number(h.conteo_morralla)).toBeCloseTo(0.39, 2);

    // El mismo clic otra vez (la red se cayó a media respuesta): la misma hoja, ninguna nueva.
    const otra = await svc.pagarAbierta('morelia', body, CAJA);
    expect(otra.hoja.id).toBe(r.hoja.id);
    expect(await hojasDeLaLlave(body.client_key)).toBe(1);
  });

  it('⛔ sin contar el pico del cajón no se paga, y no queda hoja a medias', async () => {
    if (!listo) return;
    svc.filasZona = [pago('0092001', '500.50')];
    await retiro(92001, 500);
    const client_key = randomUUID();
    const r = await rechazo(svc.pagarAbierta('morelia',
      { origen_refs: ['08|X-D-26|0092001|0011'], client_key, pago: { medio: 'caos', device: DEV, external_id: 92001 } }, CAJA));
    expect(r.status).toBe(400);
    expect(r.texto).toContain('hay que contar lo que sale del cajón');
    expect(await hojasDeLaLlave(client_key)).toBe(0);
  });

  it('el retiro que la cubre entera no pide arqueo: pagada con cajón 0 y sin conteo', async () => {
    if (!listo) return;
    svc.filasZona = [pago('0093001', '700.00')];
    await retiro(93001, 700);
    const r = await svc.pagarAbierta('morelia', { origen_refs: ['08|X-D-26|0093001|0011'], client_key: randomUUID(),
      pago: { medio: 'caos', device: DEV, external_id: 93001 } }, CAJA);
    const h = await hoja(r.hoja.id);
    expect(h).toMatchObject({ estado: 'pagada', conteo: null });
    expect(Number(h.cajon)).toBe(0);
  });

  it('⛔ [LE.6.20] lo que su depósito ya repuso no se paga otra vez: la reposición cambió', async () => {
    if (!listo) return;
    const viejo = pago('0094001', '1234.56', diaMx(20));
    svc.filasZona = [viejo];
    svc.banco = { cuenta: '1604', cargado_hasta: diaMx(1), depositos: [{ id: 'd1', dia: diaMx(19), importe: 1234.5 }] };
    await retiro(94001, 1200);
    const client_key = randomUUID();
    const r = await rechazo(svc.pagarAbierta('morelia', { origen_refs: [viejo.origen_ref], client_key,
      pago: { medio: 'caos', device: DEV, external_id: 94001, conteo: { piezas: { '20': 1, '10': 1, '2': 2 }, morralla: 0.56 } } }, CAJA));
    expect(r.status).toBe(409);
    expect(r.texto).toContain('La reposición cambió');
    expect(await hojasDeLaLlave(client_key)).toBe(0);
    svc.banco = null;
  });

  it('⛔ un pago sin su autorización (Kepler no dice qué paga) no se paga por este carril', async () => {
    if (!listo) return;
    const sin = pago('0095001', '300.00');
    svc.compras.delete('08|0095001');
    svc.filasZona = [sin];
    await retiro(95001, 300);
    const r = await rechazo(svc.pagarAbierta('morelia', { origen_refs: [sin.origen_ref], client_key: randomUUID(),
      pago: { medio: 'caos', device: DEV, external_id: 95001 } }, CAJA));
    expect(r.status).toBe(409);
  });
});
