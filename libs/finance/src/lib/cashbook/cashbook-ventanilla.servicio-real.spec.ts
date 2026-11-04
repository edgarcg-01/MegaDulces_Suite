import { randomUUID } from 'node:crypto';
import knexFactory, { Knex } from 'knex';
import { HttpException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { PagoEnVentanilla } from '@megadulces/contracts';
import { CashbookService } from './cashbook.service';
import {
  CashbookVentanillaService, type FilaDocumento, type FilaDocumentoLote, type FilaRespaldoCompra, type FilaRespaldoGasto, type FilaVale,
} from './cashbook-ventanilla.service';

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
});
