import { randomUUID } from 'node:crypto';
import knexFactory, { Knex } from 'knex';
import { HttpException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { PagoEnVentanilla, ZonaHojaGastos } from '@megadulces/contracts';
import type { DepositoBancoHoja, PagoDeZona } from '../caja/hoja-gastos.engine';
import { CashbookService } from './cashbook.service';
import {
  CashbookVentanillaService, type FilaDocumento, type FilaDocumentoLote, type FilaRespaldoCompra, type FilaRespaldoGasto, type FilaVale,
} from './cashbook-ventanilla.service';
import type { FilaCobroRuta, FilaCobroSucursal } from './cobro-en-ventanilla';
import { esSinRegla, movimientoCaos } from './reglas';

/**
 * `[LE.4.10]` — La Ventanilla contra Postgres, con el payload de la pantalla (regla 13): pagar con
 * vale aprobado (sale el código y lo del cajón queda asentado con su redondeo), sin vale (queda por
 * firmar y no se mueve un peso hasta la firma), rechazar, pagar todo del cajón, y cada rechazo con su
 * código HTTP y su `codigo`.
 *
 * Las dos lecturas de fuera del libro (`analytics.bank_movement_legs`, `finance.expense_proofs`) se
 * sustituyen con filas de prueba: esas tablas no existen en la base de prueba. Su SQL es una
 * constante (`SQL_DOCUMENTO`, `SQL_VALE`) que se midió TAL CUAL contra prod en sólo lectura el
 * 2026-11-02 (X-D-26 0023782 → $796.73, NOMINA, 5 ms). La ESCRITURA —órdenes, firma, asientos— es la real.
 *
 * Tenant al azar por corrida: el libro es inmutable y lo registrado se queda en la base de prueba.
 */
const URL = process.env['CAJA_TEST_DB_URL'];
const T = randomUUID();
const CAJERA = { id: randomUUID(), username: 'cajera_ventanilla' };
const TESORERIA = { id: randomUUID(), username: 'tesoreria_ventanilla' };
const HOY = `${2100 + Math.floor(Math.random() * 800)}-08-01`;

if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[LE.4.10] NO MEDIDO: sin CAJA_TEST_DB_URL no se ejerce la Ventanilla contra una base real.');
}

class VentanillaConFilas extends CashbookVentanillaService {
  docs = new Map<string, FilaDocumento>();
  vales = new Map<string, FilaVale>();
  protected override async filasDelDocumento(_trx: Knex.Transaction, p: string[]): Promise<FilaDocumento[]> {
    const d = this.docs.get(p.slice(1).join('|'));
    return d ? [d] : [];
  }
  protected override async filaDelVale(_trx: Knex.Transaction, _t: string, id: string): Promise<FilaVale | undefined> {
    return this.vales.get(id);
  }
  /**
   * `[LE.2.13]` Las filas que el SQL por lote devolvería (`sucursal|folio` → sus gastos o entradas).
   * Ningún par sembrado = sin ODS (lo que pasa en la base de prueba): el respaldo es «no medido».
   */
  respaldos = new Map<string, { gastos: Array<Omit<FilaRespaldoGasto, 'sucursal' | 'folio'>>; compras: Array<Omit<FilaRespaldoCompra, 'sucursal' | 'folio'>> }>();
  protected override async filasDelRespaldo(_trx: Knex.Transaction, _t: string, pares: ReadonlyArray<[string, string]>)
    : Promise<{ gastos: FilaRespaldoGasto[]; compras: FilaRespaldoCompra[] } | null> {
    const sembrados = pares.filter(([s, f]) => this.respaldos.has(`${s}|${f}`));
    if (!sembrados.length) return null;
    return {
      gastos: sembrados.flatMap(([sucursal, folio]) => this.respaldos.get(`${sucursal}|${folio}`)!.gastos.map((g) => ({ sucursal, folio, ...g }))),
      compras: sembrados.flatMap(([sucursal, folio]) => this.respaldos.get(`${sucursal}|${folio}`)!.compras.map((c) => ({ sucursal, folio, ...c }))),
    };
  }
  /** `[LE.6.8]` Los depósitos a la cuenta de cada zona (`null` = cuenta no medida). */
  depositos = new Map<string, DepositoBancoHoja[] | null>();
  protected override async depositosDelBanco(_trx: Knex.Transaction, _t: string, zona: ZonaHojaGastos): Promise<DepositoBancoHoja[] | null> {
    return this.depositos.has(zona.clave) ? this.depositos.get(zona.clave) ?? null : [];
  }
  /** `[LE.6.8]` Los pagos de cada zona que devolvería la consulta de la hoja. */
  pagosZona = new Map<string, PagoDeZona[]>();
  protected override async pagosDeZona(_trx: Knex.Transaction, _t: string, zona: ZonaHojaGastos): Promise<PagoDeZona[]> {
    return this.pagosZona.get(zona.clave) ?? [];
  }
  /** `[LE.6.7]` Los cobros que las dos fuentes devolverían (`almacen|folio` → su fila). */
  cobrosRuta = new Map<string, Omit<FilaCobroRuta, 'almacen' | 'folio'>>();
  cobrosSucursal = new Map<string, Omit<FilaCobroSucursal, 'sucursal' | 'folio'>>();
  protected override async filasDeCobros(_trx: Knex.Transaction, _t: string, pares: ReadonlyArray<[string, string]>)
    : Promise<{ ruta: FilaCobroRuta[]; sucursal: FilaCobroSucursal[] }> {
    return {
      ruta: pares.flatMap(([almacen, folio]) => { const r = this.cobrosRuta.get(`${almacen}|${folio}`); return r ? [{ almacen, folio, ...r }] : []; }),
      sucursal: pares.flatMap(([sucursal, folio]) => { const r = this.cobrosSucursal.get(`${sucursal}|${folio}`); return r ? [{ sucursal, folio, ...r }] : []; }),
    };
  }
  protected override async filasDeDocumentos(_trx: Knex.Transaction, _t: string, pares: ReadonlyArray<[string, string]>): Promise<FilaDocumentoLote[]> {
    return pares.flatMap(([sucursal, folio]) => {
      const d = this.docs.get(`${sucursal}|X-D-26|${folio}|0011`);
      return d ? [{ sucursal, ...d }] : [];
    });
  }
}

async function rechazo(p: Promise<unknown>): Promise<{ status: number; codigo: string }> {
  try { await p; } catch (e) {
    if (e instanceof HttpException) return { status: e.getStatus(), codigo: (e.getResponse() as { codigo: string }).codigo };
    throw e;
  }
  return { status: 200, codigo: 'sin error' };
}

describe.skipIf(!URL)('[LE.4.10] la Ventanilla contra Postgres', () => {
  let knex: Knex;
  let libro: CashbookService;
  let v: VentanillaConFilas;
  let hay = false;

  const saldo = async (code: string): Promise<bigint> =>
    BigInt((await libro.saldos(false)).cuentas.find((c) => c.code === code)?.balance_minor ?? '0');
  const pago = (doc: string, over: Partial<PagoEnVentanilla> = {}): PagoEnVentanilla =>
    ({ origen_ref: doc, cuenta_kepler: '201', recibe: { nombre: 'Nómina CEDIS' }, ...over });

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 4 } });
    hay = (await knex.raw(`SELECT to_regprocedure('cashbook.sign_order(uuid, uuid, uuid, timestamptz)') IS NOT NULL AS ok`)).rows[0].ok;
    const ctx = { requireTenantId: () => T } as unknown as TenantContextService;
    const tk = new TenantKnexService(knex, ctx);
    libro = new CashbookService(tk, ctx);
    v = new VentanillaConFilas(tk, ctx);
    if (!hay) return;
    // Tesorería firma caja por su PUESTO (LE.4.9), como lo daría la pantalla de usuarios.
    await knex.raw(`INSERT INTO identity.users (id, tenant_id, username, role_name, activo, kind, position_code, created_at, updated_at)
      VALUES (?, ?, ?, 'tesoreria', true, 'interno', 'tesoreria', now(), now())`, [TESORERIA.id, T, TESORERIA.username]);
    await knex.raw(`INSERT INTO identity.position_responsibilities (id, tenant_id, position_code, responsibility_key, es_principal, created_at, updated_at)
      VALUES (gen_random_uuid(), ?, 'tesoreria', 'finanzas.caja_firma', true, now(), now())`, [T]);
    // El día abierto y un cajón con monedas, contadas por pieza (la apertura la autoriza Tesorería).
    await libro.abrirJornada(HOY, CAJERA);
    const ap = await libro.registrarHecho({ tipo: 'apertura', moneda: 'MXN', fecha: HOY,
      conteos: [{ cuenta: 'CAJA_MXN', piezas: { 10: '20', 5: '20', 1: '50', '0.5': '40' } }] }, CAJERA, randomUUID());
    if (ap.estado !== 'por_autorizar') throw new Error('la apertura debía pedir autorización');
    await libro.autorizar(ap.request_id, TESORERIA);

    v.docs.set('00|X-D-26|0023782|0011', { folio: '0023782', beneficiario: 'NOMINA', importe: '796.73' });
    v.docs.set('00|X-D-26|0023783|0011', { folio: '0023783', beneficiario: 'NOMINA', importe: '796.73' });
    v.docs.set('00|X-D-26|0023790|0011', { folio: '0023790', beneficiario: 'GASTOS GENERALES OFICINAS', importe: '395.00' });
    v.docs.set('00|X-D-26|0023789|0011', { folio: '0023789', beneficiario: 'GASTOS GENERALES OFICINAS', importe: '395.00' });
    v.docs.set('00|X-D-26|0023787|0011', { folio: '0023787', beneficiario: 'GASTOS GENERALES OFICINAS', importe: '15.00' });
  });
  afterAll(async () => { await knex?.destroy(); });

  it('con vale aprobado: sale el código, lo del cajón queda asentado y el egreso suma el documento al centavo', async () => {
    if (!hay) { console.warn('[LE.4.10] NO MEDIDO: la base no tiene la migración 20261102143213'); return; }
    const VALE = randomUUID();
    v.vales.set(VALE, { id: VALE, folio: '0000224', status: 'aprobada', importe: '796.73', aprobado_at: '2026-11-02 10:30:00-06' });
    const DOC = '00|X-D-26|0023782|0011';

    const plan = await v.plan(DOC, '201', VALE);
    expect(plan).toMatchObject({ importe_minor: '79673', pagable_minor: '79650', maquina_minor: '78000', cajon_minor: '1650',
      redondeo_minor: '-23', requiere_firma: false, bloqueo: null });

    const cajaAntes = await saldo('CAJA_MXN');
    const key = randomUUID();
    const body = pago(DOC, { vale_id: VALE, piezas_cajon: { 10: '1', 5: '1', 1: '1', '0.5': '1' } });
    const r = await v.pagar(body, CAJERA, key);
    expect(r.estado).toBe('pagado');
    if (r.estado !== 'pagado') return;
    expect(r.codigo).toMatch(/^[A-HJ-NP-Z2-9]{4}-\d$/);
    expect(r).toMatchObject({ maquina_minor: '78000', cajon_minor: '1650', redondeo_minor: '-23' });
    expect(r.entry_id).toBeTruthy();
    expect(cajaAntes - (await saldo('CAJA_MXN'))).toBe(1650n);
    expect(await saldo('REDONDEO_MXN')).toBe(-23n);
    expect(await saldo('EGRESO:201')).toBe(1673n);   // + los 78000 que asienta el carril al entregar la máquina = 79673

    // Un reintento con la misma llave devuelve lo mismo y no mueve un peso más.
    expect(await v.pagar(body, CAJERA, key)).toEqual(r);
    expect(cajaAntes - (await saldo('CAJA_MXN'))).toBe(1650n);

    // La máquina acepta el código por lo de la máquina, y sólo eso.
    const usar = (minor: number) => knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      return (await trx.raw('SELECT cashbook.consume_order(?, ?, now()) AS r', [r.codigo, minor])).rows[0].r as { ok: boolean; motivo?: string };
    });
    expect(await usar(78100)).toMatchObject({ ok: false, motivo: 'de_mas' });
    expect(await usar(78000)).toMatchObject({ ok: true });

    // NEGATIVAS: el documento no se paga dos veces; el vale no ampara otro pago.
    expect(await rechazo(v.pagar(body, CAJERA, randomUUID()))).toEqual({ status: 409, codigo: 'ya_ordenado' });
    expect(await rechazo(v.pagar(pago('00|X-D-26|0023783|0011', { vale_id: VALE, piezas_cajon: { 10: '1', 5: '1', 1: '1', '0.5': '1' } }),
      CAJERA, randomUUID()))).toEqual({ status: 409, codigo: 'cashbook_orden_vale_una_vez' });
    // Misma llave, otro documento.
    expect(await rechazo(v.pagar(pago('00|X-D-26|0023783|0011'), CAJERA, key))).toEqual({ status: 409, codigo: 'cashbook_peticion_reusada' });
  });

  it('sin vale: queda por firmar, no sale un peso; Tesorería firma (nunca quien la pidió) y entonces sí', async () => {
    if (!hay) return;
    const DOC = '00|X-D-26|0023790|0011';
    const cajaAntes = await saldo('CAJA_MXN');
    const r = await v.pagar(pago(DOC, { piezas_cajon: { 10: '1', 5: '1' } }), CAJERA, randomUUID());
    expect(r).toMatchObject({ estado: 'por_firmar', motivo: 'no trae vale aprobado' });
    if (r.estado !== 'por_firmar') return;
    expect(await saldo('CAJA_MXN')).toBe(cajaAntes);   // antes de la firma, nada

    const lista = await v.porFirmar();
    expect(lista.find((o) => o.id === r.orden_id)).toMatchObject({ origen_ref: DOC, maquina_minor: '38000', cajon_minor: '1500',
      recibe: 'Nómina CEDIS', motivo_firma: 'no trae vale aprobado', beneficiario: 'GASTOS GENERALES OFICINAS' });

    expect(await rechazo(v.firmar(r.orden_id, CAJERA))).toEqual({ status: 422, codigo: 'cashbook_orden_firma_otro' });
    const f = await v.firmar(r.orden_id, TESORERIA);
    expect(f.estado).toBe('pagado');
    if (f.estado !== 'pagado') return;
    expect(f.codigo).toMatch(/^[A-HJ-NP-Z2-9]{4}-\d$/);
    expect(cajaAntes - (await saldo('CAJA_MXN'))).toBe(1500n);
    // El asiento del cajón es de quien paga (la cajera), aunque lo dispare la firma de Tesorería.
    const asiento = (await libro.mayor(0, 1000)).find((l) => l['entry_id'] === f.entry_id);
    expect(asiento).toMatchObject({ event_kind: 'gasto', event_ref: `pago:${r.orden_id}`, created_by: CAJERA.id });
    expect(await rechazo(v.firmar(r.orden_id, TESORERIA))).toEqual({ status: 409, codigo: 'cashbook_orden_no_por_firmar' });
    expect((await v.porFirmar()).some((o) => o.id === r.orden_id)).toBe(false);
  });

  it('rechazar: con motivo, y el documento se puede volver a pedir', async () => {
    if (!hay) return;
    const DOC = '00|X-D-26|0023789|0011';
    const r = await v.pagar(pago(DOC, { piezas_cajon: { 10: '1', 5: '1' } }), CAJERA, randomUUID());
    if (r.estado !== 'por_firmar') throw new Error('debía quedar por firmar');
    expect(await rechazo(v.rechazar(r.orden_id, '  ', TESORERIA))).toEqual({ status: 422, codigo: 'cashbook_orden_rechazo_con_motivo' });
    await v.rechazar(r.orden_id, 'no trae comprobante', TESORERIA);
    expect((await v.porFirmar()).some((o) => o.id === r.orden_id)).toBe(false);
    const otra = await v.pagar(pago(DOC, { piezas_cajon: { 10: '1', 5: '1' } }), CAJERA, randomUUID());
    expect(otra.estado).toBe('por_firmar');
  });

  it('todo del cajón (menos de $20): no hay código que teclear, y el documento queda tomado', async () => {
    if (!hay) return;
    const VALE = randomUUID();
    v.vales.set(VALE, { id: VALE, folio: '0000230', status: 'validada', importe: '15.00', aprobado_at: '2026-11-02 11:00:00-06' });
    const DOC = '00|X-D-26|0023787|0011';
    const r = await v.pagar(pago(DOC, { vale_id: VALE, piezas_cajon: { 10: '1', 5: '1' } }), CAJERA, randomUUID());
    expect(r).toMatchObject({ estado: 'pagado', codigo: null, maquina_minor: '0', cajon_minor: '1500' });
    expect(await rechazo(v.pagar(pago(DOC, { vale_id: VALE, piezas_cajon: { 10: '1', 5: '1' } }), CAJERA, randomUUID())))
      .toEqual({ status: 409, codigo: 'ya_ordenado' });
  });

  it('NEGATIVAS de la forma: cada una con su código', async () => {
    if (!hay) return;
    const DOC = '00|X-D-26|0023783|0011';
    expect(await rechazo(v.pagar(pago(DOC), CAJERA, undefined))).toEqual({ status: 400, codigo: 'sin_idempotency_key' });
    expect(await rechazo(v.pagar(pago(DOC, { recibe: { nombre: ' ' } }), CAJERA, randomUUID()))).toEqual({ status: 400, codigo: 'sin_quien_recibe' });
    expect(await rechazo(v.pagar(pago('00|X-D-26|9999999|0011'), CAJERA, randomUUID()))).toEqual({ status: 404, codigo: 'documento_inexistente' });
    expect(await rechazo(v.pagar(pago('00|X-A-45|0023783|0011'), CAJERA, randomUUID()))).toEqual({ status: 400, codigo: 'documento_invalido' });
    expect(await rechazo(v.pagar(pago(DOC, { cuenta_kepler: '' }), CAJERA, randomUUID()))).toEqual({ status: 422, codigo: 'sin_cuenta_kepler' });
    // Del cajón salen $16.50; contar $16.00 no pasa.
    expect(await rechazo(v.pagar(pago(DOC, { piezas_cajon: { 10: '1', 5: '1', 1: '1' } }), CAJERA, randomUUID())))
      .toEqual({ status: 422, codigo: 'cajon_no_cuadra' });
    const OTRO = randomUUID();
    v.vales.set(OTRO, { id: OTRO, folio: '0000231', status: 'aprobada', importe: '500.00', aprobado_at: '2026-11-02 11:00:00-06' });
    expect(await rechazo(v.pagar(pago(DOC, { vale_id: OTRO }), CAJERA, randomUUID()))).toEqual({ status: 422, codigo: 'vale_de_otro_importe' });
    expect(await rechazo(v.pagar(pago(DOC, { vale_id: randomUUID() }), CAJERA, randomUUID()))).toEqual({ status: 404, codigo: 'vale_inexistente' });
  });

  /**
   * `[LE.2.13]` Lo que Kepler dice que paga el documento decide, con UNA autorización: la compra misma o
   * el gasto aprobado por una persona. Las filas copian lo que el SQL devolvió en prod el 2026-11-03.
   */
  it('[LE.2.13] una compra con sus entradas cuadradas sale sin firma; un gasto sin aprobar o sin expediente no sale', async () => {
    if (!hay) return;
    const entrada = (doc: string, pesos: string, total = pesos) => ({ doc, aplicado: pesos, importe_doc: pesos, aplicado_total: total });
    const gasto = (g: string, pesos: string, vale: Partial<FilaRespaldoGasto> | null) => ({
      gasto: g, aplicado: pesos, vale_id: null, vale_folio: null, vale_estado: null, vale_importe: null, vale_aprobado_at: null, ...(vale ?? {}) });

    // Un proveedor de mercancía, 08/0000699 en prod: 3 entradas por $17,230. Sin vale y sin firma.
    v.docs.set('00|X-D-26|0023795|0011', { folio: '0023795', beneficiario: 'PROVEEDOR DE BOTANA', importe: '17230.00' });
    v.respaldos.set('00|0023795', { gastos: [], compras: [entrada('0000367', '6010.00'), entrada('0000375', '6530.00'), entrada('0000380', '4690.00')] });
    const cajaAntes = await saldo('CAJA_MXN');
    const r = await v.pagar(pago('00|X-D-26|0023795|0011', { piezas_cajon: { 10: '1' } }), CAJERA, randomUUID());
    expect(r).toMatchObject({ estado: 'pagado', maquina_minor: '1722000', cajon_minor: '1000' });
    expect(cajaAntes - (await saldo('CAJA_MXN'))).toBe(1000n);

    // NEGATIVA: una entrada que otro pago ya cubrió quedaría pagada de más.
    v.docs.set('00|X-D-26|0023796|0011', { folio: '0023796', beneficiario: 'PROVEEDOR DE BOTANA', importe: '6010.00' });
    v.respaldos.set('00|0023796', { gastos: [], compras: [entrada('0000367', '6010.00', '12020.00')] });
    expect(await rechazo(v.pagar(pago('00|X-D-26|0023796|0011', { piezas_cajon: { 10: '1' } }), CAJERA, randomUUID())))
      .toEqual({ status: 422, codigo: 'compra_pagada_de_mas' });

    // NEGATIVA: validada sólo por el cierre de Kepler (sin quién aprobó) no sale, ni se manda a firmar.
    const SIN_PERSONA = randomUUID();
    v.docs.set('00|X-D-26|0023797|0011', { folio: '0023797', beneficiario: 'CAJA CHICA', importe: '600.00' });
    v.respaldos.set('00|0023797', { gastos: [gasto('0000220', '600.00', { vale_id: SIN_PERSONA, vale_folio: '0000247', vale_estado: 'validada', vale_importe: '600' })], compras: [] });
    expect(await rechazo(v.pagar(pago('00|X-D-26|0023797|0011'), CAJERA, randomUUID()))).toEqual({ status: 422, codigo: 'gasto_sin_aprobar' });
    // ...y la cajera no lo ampara con el vale de otro gasto.
    const AJENO = randomUUID();
    v.vales.set(AJENO, { id: AJENO, folio: '0000999', status: 'aprobada', importe: '600.00', aprobado_at: '2026-11-02 11:00:00-06' });
    expect(await rechazo(v.pagar(pago('00|X-D-26|0023797|0011', { vale_id: AJENO }), CAJERA, randomUUID())))
      .toEqual({ status: 400, codigo: 'vale_no_corresponde' });

    // NEGATIVA: el testigo de nómina de prod, 00/0023782, tiene su gasto sin expediente en la Suite.
    v.docs.set('00|X-D-26|0023798|0011', { folio: '0023798', beneficiario: 'NOMINA', importe: '796.73' });
    v.respaldos.set('00|0023798', { gastos: [gasto('0009593', '796.73', null)], compras: [] });
    expect(await rechazo(v.pagar(pago('00|X-D-26|0023798|0011'), CAJERA, randomUUID()))).toEqual({ status: 422, codigo: 'gasto_sin_expediente' });

    // Con su vale aprobado por una persona sí sale, y el vale lo pone Kepler, no la cajera.
    const FIRMADO = randomUUID();
    v.docs.set('00|X-D-26|0023799|0011', { folio: '0023799', beneficiario: 'CAJA CHICA', importe: '1100.00' });
    v.respaldos.set('00|0023799', { gastos: [gasto('0000276', '1100.00', { vale_id: FIRMADO, vale_folio: '0000308', vale_estado: 'validada',
      vale_importe: '1100', vale_aprobado_at: '2026-11-02 15:36:54-06' })], compras: [] });
    expect(await v.pagar(pago('00|X-D-26|0023799|0011'), CAJERA, randomUUID())).toMatchObject({ estado: 'pagado', maquina_minor: '110000', cajon_minor: '0' });
  });

  /**
   * `[LE.2.13]` La cola pide los veredictos de todos sus documentos en UN viaje, con el mismo motor
   * que `pagar`. Usa lo que dejó la prueba anterior: lo pagado sale «ya ordenado».
   */
  it('[LE.2.13] veredictos por lote: lo que sale, lo detenido con dónde se arregla, lo ya pagado y lo que no existe', async () => {
    if (!hay) return;
    v.docs.set('00|X-D-26|0023800|0011', { folio: '0023800', beneficiario: 'GASTOS GENERALES OFICINAS', importe: '250.00' });
    const r = await v.veredictos(['00|X-D-26|0023795|0011', '00|X-D-26|0023796|0011', '00|X-D-26|0023797|0011',
      '00|X-D-26|0023798|0011', '00|X-D-26|9999999|0011', '00|X-A-45|1|0011', '00|X-D-26|0023800|0011']);
    const de = (doc: string) => r.find((x) => x.origen_ref === doc);
    expect(r).toHaveLength(7);
    // Ya se pagó en la prueba anterior: sale «ya ordenado», no «se puede».
    expect(de('00|X-D-26|0023795|0011')).toMatchObject({ respaldo: 'compra', puede: false, bloqueo: 'ya_ordenado' });
    expect(de('00|X-D-26|0023795|0011')?.detalle).toEqual([
      { tipo: 'entrada', folio: '0000367', aplicado_minor: '601000', vale_folio: null, aprobado: null },
      { tipo: 'entrada', folio: '0000375', aplicado_minor: '653000', vale_folio: null, aprobado: null },
      { tipo: 'entrada', folio: '0000380', aplicado_minor: '469000', vale_folio: null, aprobado: null }]);
    expect(de('00|X-D-26|0023796|0011')).toMatchObject({ respaldo: 'compra', puede: false, bloqueo: 'compra_pagada_de_mas', arreglo: null });
    expect(de('00|X-D-26|0023797|0011')).toMatchObject({ respaldo: 'gasto', puede: false, bloqueo: 'gasto_sin_aprobar', arreglo: 'aprobacion_gastos' });
    expect(de('00|X-D-26|0023797|0011')?.detalle).toEqual([{ tipo: 'gasto', folio: '0000220', aplicado_minor: '60000', vale_folio: '0000247', aprobado: false }]);
    expect(de('00|X-D-26|0023798|0011')).toMatchObject({ respaldo: 'gasto', puede: false, bloqueo: 'gasto_sin_expediente', arreglo: 'aprobacion_gastos' });
    expect(de('00|X-D-26|9999999|0011')).toMatchObject({ puede: false, bloqueo: 'documento_inexistente' });
    expect(de('00|X-A-45|1|0011')).toMatchObject({ puede: false, bloqueo: 'documento_invalido' });
    // Con ODS, un documento del que Kepler no dice qué paga: se puede, con la firma de Tesorería.
    expect(de('00|X-D-26|0023800|0011')).toMatchObject({ respaldo: 'ninguno', puede: true, requiere_firma: true,
      motivo: 'Kepler no dice qué gasto o compra paga' });
    // Sin ODS (nada sembrado en el lote): NO MEDIDO — no se afirma qué paga; queda la regla del vale.
    expect((await v.veredictos(['00|X-D-26|0023800|0011']))[0]).toMatchObject({ respaldo: 'no_medido', puede: true, requiere_firma: true,
      motivo: 'no trae vale aprobado' });
    expect(await rechazo(v.veredictos(Array.from({ length: 201 }, (_, i) => `00|X-D-26|${i}|0011`)))).toEqual({ status: 400, codigo: 'demasiados_documentos' });
  });

  // ── `[LE.6.7]` Recibir un cobro ───────────────────────────────────────────────────────────

  const cobro = (doc: string, piezas: Record<string, string>) => ({ origen_ref: doc, piezas, entrega: { nombre: 'Chofer de la ruta' } });

  it('[LE.6.7] cobro de ruta al peso: entra al cajón por pieza y baja lo que la ruta debe rendir; una vez', async () => {
    if (!hay) return;
    const DOC = '01-002|U-A-5|0000029|0011';
    v.cobrosRuta.set('01-002|0000029', { importe: '1850.00', rutas: '22', n_rutas: 1, n_fechas: 1 });
    const cajaAntes = await saldo('CAJA_MXN');
    const key = randomUUID();
    const body = cobro(DOC, { 500: '3', 200: '1', 100: '1', 50: '1' });
    const r = await v.recibir(body, CAJERA, key);
    expect(r).toMatchObject({ estado: 'recibido', tipo: 'ruta', ruta: '22', contado_minor: '185000', esperado_minor: '185000',
      diferencia_minor: '0', es_redondeo: false });
    expect((await saldo('CAJA_MXN')) - cajaAntes).toBe(185000n);
    expect(await saldo('POR_RENDIR:RUTA:22')).toBe(-185000n);   // sin la cobranza de Kepler asentada aquí, queda «adelantada»
    const asiento = (await libro.mayor(0, 1000)).find((l) => r.estado === 'recibido' && l['entry_id'] === r.entry_id);
    expect(asiento).toMatchObject({ event_kind: 'entrega_ruta', event_ref: `cobro:${DOC}`, created_by: CAJERA.id });

    // Reintento con la misma llave: lo mismo, sin un peso más. NEGATIVAS: otra llave, o la misma con otro cobro.
    expect(await v.recibir(body, CAJERA, key)).toEqual(r);
    expect((await saldo('CAJA_MXN')) - cajaAntes).toBe(185000n);
    expect(await rechazo(v.recibir(body, CAJERA, randomUUID()))).toEqual({ status: 409, codigo: 'ya_recibido' });
    expect(await rechazo(v.recibir(cobro('01-003|U-A-5|0000028|0011', { 500: '1' }), CAJERA, key))).toEqual({ status: 409, codigo: 'cashbook_peticion_reusada' });
    expect((await v.estadoDeCobros([DOC]))[0]).toMatchObject({ tipo: 'ruta', ruta: '22', esperado_minor: '185000', recibido: true });
  });

  it('[LE.6.7] cobro de ruta con faltante: se recibe lo contado y la diferencia queda declarada en lo que la ruta debe', async () => {
    if (!hay) return;
    const DOC = '01-003|U-A-5|0000028|0011';
    v.cobrosRuta.set('01-003|0000028', { importe: '500.00', rutas: '23', n_rutas: 1, n_fechas: 1 });
    const r = await v.recibir(cobro(DOC, { 200: '2', 50: '1' }), CAJERA, randomUUID());
    expect(r).toMatchObject({ estado: 'recibido', ruta: '23', contado_minor: '45000', esperado_minor: '50000', diferencia_minor: '-5000', es_redondeo: false });
    expect(await saldo('POR_RENDIR:RUTA:23')).toBe(-45000n);   // con la cobranza (+50000) quedarán los 5000 que faltan
  });

  it('[LE.6.7] cobro de sucursal: otro ingreso (D17); los centavos que no se cuentan en monedas se declaran como redondeo', async () => {
    if (!hay) return;
    const DOC = '07|U-A-5|0000169|0011';
    v.cobrosSucursal.set('07|0000169', { importe: '318.24', n: 1 });
    const r = await v.recibir(cobro(DOC, { 200: '1', 100: '1', 10: '1', 5: '1', 1: '3' }), CAJERA, randomUUID());
    expect(r).toMatchObject({ estado: 'recibido', tipo: 'sucursal', ruta: null, contado_minor: '31800', esperado_minor: '31824',
      diferencia_minor: '-24', es_redondeo: true });
    const otros = (await libro.saldos(false)).cuentas.filter((c) => c.code.startsWith('OTROS_INGRESOS:'));
    expect(otros.map((c) => c.balance_minor)).toContain('-31800');
  });

  it('[LE.6.7] arriba del umbral: el dinero ya está en el cajón y el asiento espera la firma de otra persona', async () => {
    if (!hay) return;
    // El umbral lo pone el dueño de la base: `app_runtime` no escribe reglas de autorización (por diseño).
    // En el CI y en la base local el dueño es `postgres`; sin él, este camino queda NO MEDIDO.
    const ADMIN = process.env['CAJA_TEST_DB_ADMIN_URL'] ?? String(URL).replace('app_runtime:app_runtime@', 'postgres:postgres@');
    const dueno = knexFactory({ client: 'pg', connection: ADMIN, pool: { min: 0, max: 1 } });
    try {
      await dueno.raw(`INSERT INTO cashbook.authorization_rules (tenant_id, event_kind, threshold_minor) VALUES (?, 'otro_ingreso', 100000)
        ON CONFLICT (tenant_id, event_kind) DO UPDATE SET threshold_minor = 100000`, [T]);
    } catch (e) {
      console.warn(`[LE.6.7] NO MEDIDO: sin el dueño de la base no se siembra el umbral (${(e as Error).message})`);
      return;
    } finally { await dueno.destroy(); }
    const DOC = '01|U-A-5|0000261|0011';
    v.cobrosSucursal.set('01|0000261', { importe: '1500.00', n: 1 });
    const cajaAntes = await saldo('CAJA_MXN');
    const key = randomUUID();
    const body = cobro(DOC, { 500: '3' });
    const r = await v.recibir(body, CAJERA, key);
    expect(r).toMatchObject({ estado: 'por_autorizar', tipo: 'sucursal', contado_minor: '150000', diferencia_minor: '0' });
    if (r.estado !== 'por_autorizar') return;
    expect(await saldo('CAJA_MXN')).toBe(cajaAntes);   // el libro no lo da por asentado antes de la firma
    expect(await v.recibir(body, CAJERA, key)).toEqual(r);
    expect((await v.estadoDeCobros([DOC]))[0].recibido).toBe(true);   // no se recibe otra vez mientras espera
    expect(await rechazo(v.recibir(body, CAJERA, randomUUID()))).toEqual({ status: 409, codigo: 'ya_recibido' });
    await libro.autorizar(r.request_id, TESORERIA);
    expect((await saldo('CAJA_MXN')) - cajaAntes).toBe(150000n);
  });

  it('[LE.6.7] NEGATIVAS: lo detenido no se recibe, y cada falta con su código', async () => {
    if (!hay) return;
    v.cobrosRuta.set('01-004|0000028', { importe: '900.00', rutas: '26 · 27', n_rutas: 2, n_fechas: 1 });
    expect(await rechazo(v.recibir(cobro('01-004|U-A-5|0000028|0011', { 500: '1' }), CAJERA, randomUUID()))).toEqual({ status: 422, codigo: 'cobro_detenido' });
    expect(await rechazo(v.recibir(cobro('01-009|U-A-5|0000001|0011', { 500: '1' }), CAJERA, randomUUID()))).toEqual({ status: 404, codigo: 'cobro_detenido' });
    expect(await rechazo(v.recibir(cobro('00|X-D-26|0023782|0011', { 500: '1' }), CAJERA, randomUUID()))).toEqual({ status: 400, codigo: 'cobro_invalido' });
    expect(await rechazo(v.recibir({ ...cobro('01-004|U-A-5|0000028|0011', { 500: '1' }), entrega: { nombre: ' ' } }, CAJERA, randomUUID())))
      .toEqual({ status: 400, codigo: 'sin_quien_entrega' });
    expect(await rechazo(v.recibir(cobro('01-004|U-A-5|0000028|0011', {}), CAJERA, randomUUID()))).toEqual({ status: 400, codigo: 'sin_piezas' });
    expect(await rechazo(v.recibir(cobro('01-004|U-A-5|0000028|0011', { 500: '1' }), CAJERA, undefined))).toEqual({ status: 400, codigo: 'sin_idempotency_key' });
    const e = await v.estadoDeCobros(['01-004|U-A-5|0000028|0011', '00|X-D-26|0023782|0011']);
    expect(e[0]).toMatchObject({ tipo: 'detenido', esperado_minor: '90000', recibido: false });
    expect(e[0].motivo).toContain('varias rutas');
    expect(e[1]).toMatchObject({ tipo: 'detenido', esperado_minor: null });
    expect(await rechazo(v.estadoDeCobros(Array.from({ length: 201 }, (_, i) => `07|U-A-5|${i}|0011`)))).toEqual({ status: 400, codigo: 'demasiados_documentos' });
  });

  // ── `[LE.6.7]` Suspenso: explicar lo que la máquina hizo sin decir para qué ─────────────────

  const DEV = `LE67-${Date.now().toString(36)}`;
  /** Un movimiento de la máquina, sembrado en `analytics` y asentado por la regla real, como lo haría el carril. */
  const maquina = async (id: number, typeId: number, label: string, piezas: Array<[number, number]>, ref: string | null) => {
    const tk = new TenantKnexService(knex, { requireTenantId: () => T } as unknown as TenantContextService);
    const occurred = new Date(Date.now() - 600_000).toISOString();
    const total = piezas.reduce((s, [d, q]) => s + d * q, 0);
    return tk.run(async (trx) => {
      const [row] = await trx('analytics.caos_cash_movements').insert({ tenant_id: T, device: DEV, external_id: id, type_id: typeId,
        type_label: label, occurred_at: occurred, total, ref, user_external: 'vendedor7', _row_hash: `${DEV}-${id}` }).returning('id');
      for (const [d, q] of piezas) await trx('analytics.caos_cash_denominations').insert({ tenant_id: T, movement_id: row.id, denom: d, pieza_tipo: 'B', quantity: q });
      const p = movimientoCaos({ device: DEV, external_id: id, type_id: typeId, type_label: label, occurred_at: occurred, total, ref,
        user_external: 'vendedor7', piezas: piezas.map(([d, q]) => ({ denom: d, pieza_tipo: 'B', quantity: q })) },
      { actor: { kind: 'servicio', service: 'libro-caos' }, valueAt: occurred });
      if (esSinRegla(p)) throw new Error(p.motivo);
      for (const c of p.cuentas) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify(c)]);
      await trx.raw('SELECT cashbook.post_entry(?::jsonb)', [JSON.stringify(p.asiento)]);
    });
  };

  it('[LE.6.7] un depósito sin ruta queda en Suspenso; se explica a qué ruta era, y sale de Suspenso una vez', async () => {
    if (!hay) return;
    await maquina(1, 0, 'Deposito', [[500, 5]], 'deposito varios');
    const REF = `caos:${DEV}:1`;
    const p = (await v.suspenso()).find((x) => x.event_ref === REF);
    expect(p).toMatchObject({ esta_en: 'haber', monto_minor: '250000', movimiento: 'Deposito', texto: 'deposito varios', usuario_maquina: 'vendedor7' });

    const antes = await saldo('POR_RENDIR:RUTA:41');
    const key = randomUUID();
    const r = await v.explicar({ event_ref: REF, hacia: { tipo: 'ruta', ruta: '41' } }, CAJERA, key);
    expect(r.estado).toBe('asentado');
    expect(antes - (await saldo('POR_RENDIR:RUTA:41'))).toBe(250000n);   // la ruta ya rindió esos $2,500
    expect((await v.suspenso()).some((x) => x.event_ref === REF)).toBe(false);

    // Reintento con la misma llave: lo mismo. NEGATIVAS: otra llave, y la misma llave con otro movimiento.
    expect(await v.explicar({ event_ref: REF, hacia: { tipo: 'ruta', ruta: '41' } }, CAJERA, key)).toEqual(r);
    expect(await rechazo(v.explicar({ event_ref: REF, hacia: { tipo: 'ruta', ruta: '41' } }, CAJERA, randomUUID())))
      .toEqual({ status: 409, codigo: 'no_esta_en_suspenso' });
    expect(await rechazo(v.explicar({ event_ref: `caos:${DEV}:9`, hacia: { tipo: 'cajon' } }, CAJERA, key)))
      .toEqual({ status: 409, codigo: 'cashbook_peticion_reusada' });
  });

  it('[LE.6.7] un retiro sin código: no es de una ruta; si fue al cajón, entra con las piezas de la máquina', async () => {
    if (!hay) return;
    await maquina(2, 0, 'Deposito', [[500, 4]], 'ruta 41 041126');   // con ruta: NO va a Suspenso
    expect((await v.suspenso()).some((x) => x.event_ref === `caos:${DEV}:2`)).toBe(false);
    await maquina(3, 4, 'Dispensar', [[500, 2]], null);
    const REF = `caos:${DEV}:3`;
    expect((await v.suspenso()).find((x) => x.event_ref === REF)).toMatchObject({ esta_en: 'debe', monto_minor: '100000' });
    expect(await rechazo(v.explicar({ event_ref: REF, hacia: { tipo: 'ruta', ruta: '41' } }, CAJERA, randomUUID())))
      .toEqual({ status: 422, codigo: 'destino_no_corresponde' });

    const caja = (await libro.saldos(true)).cuentas.find((c) => c.code === 'CAJA_MXN');
    const r = await v.explicar({ event_ref: REF, hacia: { tipo: 'cajon' } }, CAJERA, randomUUID());
    expect(r.estado).toBe('asentado');
    expect((await saldo('CAJA_MXN')) - BigInt(caja?.balance_minor ?? '0')).toBe(100000n);
    // El cajón ganó exactamente las dos piezas de $500 que dio la máquina (V7).
    const despues = (await libro.saldos(true)).cuentas.find((c) => c.code === 'CAJA_MXN');
    expect(BigInt(despues?.piezas?.['500'] ?? '0') - BigInt(caja?.piezas?.['500'] ?? '0')).toBe(2n);
  });

  it('[LE.6.7] NEGATIVAS de Suspenso: cada falta con su código', async () => {
    if (!hay) return;
    expect(await rechazo(v.explicar({ event_ref: 'X-D-26|1', hacia: { tipo: 'cajon' } }, CAJERA, randomUUID()))).toEqual({ status: 400, codigo: 'movimiento_invalido' });
    expect(await rechazo(v.explicar({ event_ref: `caos:${DEV}:1`, hacia: { tipo: 'custodia' } as never }, CAJERA, randomUUID())))
      .toEqual({ status: 400, codigo: 'destino_invalido' });
    expect(await rechazo(v.explicar({ event_ref: `caos:${DEV}:1`, hacia: { tipo: 'ruta', ruta: 'R41' } }, CAJERA, randomUUID())))
      .toEqual({ status: 400, codigo: 'ruta_invalida' });
    expect(await rechazo(v.explicar({ event_ref: `caos:${DEV}:1`, hacia: { tipo: 'cajon' } }, CAJERA, undefined)))
      .toEqual({ status: 400, codigo: 'sin_idempotency_key' });
  });

  // ── `[LE.6.8]` La reposición: pedir → firma de Tesorería → código → custodia de quien lleva el depósito ──

  it('[LE.6.8] reposición de punta a punta: la hoja desde la apertura, una firma, un código y todo en custodia de quien lleva el depósito', async () => {
    if (!hay) return;
    // Quien lleva el depósito: una persona con la responsabilidad (la da el PM en Responsabilidades, D35).
    const LLEVA = { id: randomUUID(), username: 'lleva_deposito' };
    const ADMIN = process.env['CAJA_TEST_DB_ADMIN_URL'] ?? String(URL).replace('app_runtime:app_runtime@', 'postgres:postgres@');
    const dueno = knexFactory({ client: 'pg', connection: ADMIN, pool: { min: 0, max: 1 } });
    try {
      await dueno.raw(`INSERT INTO identity.users (id, tenant_id, username, nombre, role_name, activo, kind, created_at, updated_at)
        VALUES (?, ?, ?, 'Quien Lleva', 'finanzas_operativo', true, 'interno', now(), now())`, [LLEVA.id, T, LLEVA.username]);
      await dueno.raw(`INSERT INTO identity.user_responsibilities (id, tenant_id, user_id, responsibility_key, accion, nota, valid_from, created_at, updated_at)
        VALUES (gen_random_uuid(), ?, ?, 'finanzas.caja_deposito', 'suma', 'prueba LE.6.8', current_date, now(), now())`, [T, LLEVA.id]);
    } catch (e) {
      console.warn(`[LE.6.8] NO MEDIDO: sin el dueño de la base no se siembra quién lleva el depósito (${(e as Error).message})`);
      return;
    } finally { await dueno.destroy(); }
    expect(await v.quienLleva()).toEqual([{ usuario_id: LLEVA.id, nombre: 'Quien Lleva' }]);

    // La hoja: dos pagos del día del libro y uno de antes de la apertura (no entra; lo reconstruye E3).
    const pagoZ = (folio: string, fecha: string, importe: number) => ({ origen_ref: `07|X-D-26|${folio}|0011`, sucursal: '07', doc_tipo: 'X-D-26',
      folio, fecha_pago: fecha, fecha_captura: fecha, beneficiario: 'GASTOS GENERALES', clave: 'G001', centro: '007', referencia: null, importe,
      en_libro: null, cg_folio: null, en_hoja: false });
    v.pagosZona.set('morelia', [pagoZ('9001', '2026-10-15', 1000), pagoZ('9002', HOY, 1250.5), pagoZ('9003', HOY, 300)]);
    const hoja = (await v.reposiciones()).find((h) => h.zona === 'morelia');
    expect(hoja).toMatchObject({ total_minor: '155050', maquina_minor: '155000', cajon_minor: '50', anteriores: { n: 1, monto_minor: '100000' } });
    const docs = (hoja?.renglones ?? []).map((r) => r.origen_ref);

    // NEGATIVAS: sin quien lleva con la responsabilidad, con la hoja cambiada, con el cajón que no cuadra.
    const pedir = (over: Partial<{ documentos: string[]; lleva: string; piezas_cajon: Record<string, string> }> = {}) =>
      ({ zona: 'morelia', documentos: docs, lleva: LLEVA.id, piezas_cajon: { '0.5': '1' }, ...over });
    expect(await rechazo(v.pedirReposicion(pedir({ lleva: CAJERA.id }), CAJERA, randomUUID()))).toEqual({ status: 422, codigo: 'sin_quien_lleva' });
    expect(await rechazo(v.pedirReposicion(pedir({ documentos: docs.slice(0, 1) }), CAJERA, randomUUID()))).toEqual({ status: 409, codigo: 'hoja_cambio' });
    expect(await rechazo(v.pedirReposicion(pedir({ piezas_cajon: { 1: '1' } }), CAJERA, randomUUID()))).toEqual({ status: 422, codigo: 'cajon_no_cuadra' });

    const key = randomUUID();
    const r = await v.pedirReposicion(pedir(), CAJERA, key);
    expect(r).toMatchObject({ estado: 'por_firmar' });
    if (r.estado !== 'por_firmar') return;
    expect(await v.pedirReposicion(pedir(), CAJERA, key)).toEqual(r);                        // reintento: la misma orden
    expect((await v.reposiciones()).find((h) => h.zona === 'morelia')?.renglones).toEqual([]);   // ya pedidos: no vuelven a entrar
    expect((await v.porFirmar()).find((o) => o.id === r.orden_id)).toMatchObject({ kind: 'reposicion', maquina_minor: '155000', cajon_minor: '50', recibe: 'Quien Lleva' });

    // La firma de Tesorería es la aprobación de la hoja (D28), y nunca la de quien la pidió.
    const custodia = `CUSTODIA:${LLEVA.id.toUpperCase()}`;
    const cajaAntes = await saldo('CAJA_MXN');
    expect(await rechazo(v.firmar(r.orden_id, CAJERA))).toEqual({ status: 422, codigo: 'cashbook_orden_firma_otro' });
    const f = await v.firmar(r.orden_id, TESORERIA);
    expect(f.estado).toBe('pagado');
    if (f.estado !== 'pagado' || !f.codigo) throw new Error('debía salir el código');
    expect(cajaAntes - (await saldo('CAJA_MXN'))).toBe(50n);   // lo del cajón, por pieza, ya en su custodia
    expect(await saldo(custodia)).toBe(50n);

    // La máquina entrega con el código: el carril consume la orden y asienta el retiro a la MISMA custodia.
    // Billetes de $500 y de $50 en la bóveda: la máquina sólo entrega lo que tiene (el libro lo exige por pieza).
    await maquina(20, 0, 'Deposito', [[500, 4], [50, 2]], 'ruta 41 041126');
    const tk = new TenantKnexService(knex, { requireTenantId: () => T } as unknown as TenantContextService);
    await tk.run(async (trx) => {
      const c = (await trx.raw('SELECT cashbook.consume_order(?, ?, now()) AS r', [f.codigo, 155000])).rows[0].r as { ok: boolean; classification: unknown };
      expect(c.ok).toBe(true);
      const occurred = new Date().toISOString();
      const p = movimientoCaos({ device: DEV, external_id: 21, type_id: 4, type_label: 'Dispensar', occurred_at: occurred, total: 1550,
        ref: `${f.codigo} repo morelia`, user_external: 'cajera', piezas: [{ denom: 500, pieza_tipo: 'B', quantity: 3 }, { denom: 50, pieza_tipo: 'B', quantity: 1 }] },
      { actor: { kind: 'servicio', service: 'libro-caos' }, valueAt: occurred }, c.classification as never);
      if (esSinRegla(p)) throw new Error(p.motivo);
      for (const a of p.cuentas) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify(a)]);
      await trx.raw('SELECT cashbook.post_entry(?::jsonb)', [JSON.stringify(p.asiento)]);
    });
    expect(await saldo(custodia)).toBe(155050n);   // el total de la hoja, a nombre de quien lleva el depósito

    // El banco es el testigo: sin depósito, no se cierra; con el depósito exacto, cada pago queda como gasto y la persona, descargada.
    expect((await v.custodias()).find((c) => c.persona === LLEVA.id)?.reposiciones.map((x) => x.orden_id)).toEqual([r.orden_id]);
    expect(await rechazo(v.confirmarDeposito(r.orden_id, CAJERA))).toEqual({ status: 409, codigo: 'deposito_no_encontrado' });
    v.depositos.set('morelia', [{ id: 'dep-1', dia: (await knex.raw(`SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text AS d`)).rows[0].d, importe: 1550.5 }]);
    v.docs.set('07|X-D-26|9002|0011', { folio: '9002', beneficiario: 'GASTOS', importe: '1250.50' });
    v.docs.set('07|X-D-26|9003|0011', { folio: '9003', beneficiario: 'GASTOS', importe: '300.00' });
    const cierre = await v.confirmarDeposito(r.orden_id, CAJERA);
    expect(cierre.asientos).toHaveLength(2);
    expect(cierre.saldo_minor).toBe('0');
    expect(await saldo(custodia)).toBe(0n);
    expect((await v.custodias()).some((c) => c.persona === LLEVA.id)).toBe(false);
    expect(await v.confirmarDeposito(r.orden_id, CAJERA)).toEqual(cierre);   // reintento: lo mismo
  });

  // ── `[LE.6.5]` Custodias ───────────────────────────────────────────────────────────────

  it('[LE.6.5] custodia del cajón: se lleva monedas, rinde con un documento de Kepler y regresa lo demás; una vez', async () => {
    if (!hay) return;
    const ADMIN = process.env['CAJA_TEST_DB_ADMIN_URL'] ?? String(URL).replace('app_runtime:app_runtime@', 'postgres:postgres@');
    const dueno = knexFactory({ client: 'pg', connection: ADMIN, pool: { min: 0, max: 1 } });
    const P = randomUUID();
    try {
      await dueno.raw(`INSERT INTO identity.users (id, tenant_id, username, nombre, role_name, activo, kind, created_at, updated_at)
        VALUES (?, ?, 'compras_urgentes', 'Persona De Compras', 'compras', true, 'interno', now(), now())`, [P, T]);
    } finally { await dueno.destroy(); }
    expect((await v.personas('compras')).map((x) => x.usuario_id)).toContain(P);

    const r = await v.retiroACustodia({ persona: P, para: 'cinta y bolsas para la ruta', desde: { tipo: 'cajon', piezas: { 10: '2' } } }, CAJERA, randomUUID());
    expect(r.estado).toBe('asentado');
    const c = (await v.custodias()).find((x) => x.persona === P);
    expect(c).toMatchObject({ nombre: 'Persona De Compras', saldo_minor: '2000' });
    expect(c?.desde).toBeTruthy();

    v.docs.set('00|X-D-26|0024001|0011', { folio: '0024001', beneficiario: 'PAPELERIA', importe: '15.00' });
    const key = randomUUID();
    const body = { persona: P, documentos: [{ origen_ref: '00|X-D-26|0024001|0011', cuenta_kepler: '201' }], regresa: { 5: '1' } };
    const rd = await v.rendir(body, CAJERA, key);
    expect(rd.asientos).toHaveLength(2);
    expect(rd.saldo_minor).toBe('0');
    expect((await v.custodias()).some((x) => x.persona === P)).toBe(false);
    expect(await v.rendir(body, CAJERA, key)).toEqual(rd);                                   // reintento: lo mismo
    expect(await rechazo(v.rendir({ persona: P, documentos: body.documentos }, CAJERA, randomUUID())))
      .toEqual({ status: 409, codigo: 'documento_ya_pagado' });                             // un documento se rinde una vez
  });

  it('[LE.6.5] NEGATIVAS: no se rinde más de lo que tiene, sin para qué no sale, y sin persona no hay custodia', async () => {
    if (!hay) return;
    const ADMIN = process.env['CAJA_TEST_DB_ADMIN_URL'] ?? String(URL).replace('app_runtime:app_runtime@', 'postgres:postgres@');
    const dueno = knexFactory({ client: 'pg', connection: ADMIN, pool: { min: 0, max: 1 } });
    const P = randomUUID();
    try {
      await dueno.raw(`INSERT INTO identity.users (id, tenant_id, username, nombre, role_name, activo, kind, created_at, updated_at)
        VALUES (?, ?, 'viaje_ruta', 'Persona De Viaje', 'logistica', true, 'interno', now(), now())`, [P, T]);
    } finally { await dueno.destroy(); }
    await v.retiroACustodia({ persona: P, para: 'casetas del viaje', desde: { tipo: 'cajon', piezas: { 10: '1' } } }, CAJERA, randomUUID());
    v.docs.set('00|X-D-26|0024002|0011', { folio: '0024002', beneficiario: 'CASETAS', importe: '15.00' });
    const mas = await rechazo(v.rendir({ persona: P, documentos: [{ origen_ref: '00|X-D-26|0024002|0011', cuenta_kepler: '201' }] }, CAJERA, randomUUID()));
    expect(mas.status).not.toBe(200);                                                       // $15 contra $10: la base no deja la custodia negativa
    expect(await saldo(`CUSTODIA:${P.toUpperCase()}`)).toBe(1000n);
    expect(await rechazo(v.retiroACustodia({ persona: P, para: 'no', desde: { tipo: 'cajon', piezas: { 10: '1' } } }, CAJERA, randomUUID())))
      .toEqual({ status: 400, codigo: 'sin_para_que' });
    expect(await rechazo(v.retiroACustodia({ persona: randomUUID(), para: 'casetas del viaje', desde: { tipo: 'cajon', piezas: { 10: '1' } } }, CAJERA, randomUUID())))
      .toEqual({ status: 404, codigo: 'persona_inexistente' });
    expect(await rechazo(v.rendir({ persona: P }, CAJERA, randomUUID()))).toEqual({ status: 400, codigo: 'nada_que_rendir' });
  });

  it('[LE.6.5] custodia de la máquina: sin umbral configurado la firma Tesorería; con umbral, abajo sale el código directo; sólo billetes', async () => {
    if (!hay) return;
    const ADMIN = process.env['CAJA_TEST_DB_ADMIN_URL'] ?? String(URL).replace('app_runtime:app_runtime@', 'postgres:postgres@');
    const dueno = knexFactory({ client: 'pg', connection: ADMIN, pool: { min: 0, max: 1 } });
    const P = randomUUID();
    try {
      await dueno.raw(`INSERT INTO identity.users (id, tenant_id, username, nombre, role_name, activo, kind, created_at, updated_at)
        VALUES (?, ?, 'anticipo_flete', 'Persona Del Flete', 'logistica', true, 'interno', now(), now())`, [P, T]);
      const r1 = await v.retiroACustodia({ persona: P, para: 'anticipo de flete', desde: { tipo: 'maquina', monto_minor: '50000' } }, CAJERA, randomUUID());
      expect(r1).toMatchObject({ estado: 'por_firmar', motivo: 'no hay umbral configurado: la firma Tesorería (D3)' });
      if (r1.estado !== 'por_firmar') return;
      const f = await v.firmar(r1.orden_id, TESORERIA);
      expect(f).toMatchObject({ estado: 'pagado', maquina_minor: '50000' });
      await dueno.raw(`INSERT INTO cashbook.authorization_rules (tenant_id, event_kind, threshold_minor) VALUES (?, 'retiro_a_custodia', 1000000)
        ON CONFLICT (tenant_id, event_kind) DO UPDATE SET threshold_minor = 1000000`, [T]);
      const r2 = await v.retiroACustodia({ persona: P, para: 'anticipo de flete', desde: { tipo: 'maquina', monto_minor: '50000' } }, CAJERA, randomUUID());
      expect(r2).toMatchObject({ estado: 'pagado', maquina_minor: '50000' });                // abajo de $10,000: código directo
      expect(r2.estado === 'pagado' ? r2.codigo : null).toMatch(/^[A-HJ-NP-Z2-9]{4}-\d$/);
      expect(await rechazo(v.retiroACustodia({ persona: P, para: 'anticipo de flete', desde: { tipo: 'maquina', monto_minor: '50050' } }, CAJERA, randomUUID())))
        .toEqual({ status: 422, codigo: 'monto_no_es_de_billetes' });
    } finally { await dueno.destroy(); }
  });
});
