import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, todayMx } from '@megadulces/platform-core';

import { CommercialQuotesService } from './commercial-quotes.service';
import { QuotePricingService } from './quote-pricing.service';
import { KeplerPedidoTlmkSinkAdapter, type PedidoTlmkResultado } from './kepler-pedido-tlmk-sink.adapter';
import type { QuienCotiza } from './quote-scope';
import { LARGO_OBSERVACIONES, normalizarObservaciones, type RenglonCotizacion } from './kepler-pedido-tlmk';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Cuánto vale un reclamo sin terminar antes de darlo por caído (un envío normal tarda segundos). */
const RECLAMO_VENCE = "interval '3 minutes'";

export interface EnvioKepler {
  ya_estaba: boolean;
  kepler: { sucursal: string; folio: string; renglones?: number; total?: number };
}

/**
 * `[COT.26]` Un domicilio de entrega del cliente en Kepler (`kdudent`, pantalla «Direcciones de
 * entrega»). `key` es el número que el pedido guarda en «Dir. envío» (`kdm1.c85`) y de él sale la
 * ruta de la parada (`c13`, ERP_KEPLER §3.y.1). `kdudent` viene replicado igual en las 9 sucursales:
 * se lee el de la sucursal de la cotización.
 */
export interface DireccionEntrega { key: string; calle: string; ciudad: string; telefono: string; ruta: string }

export interface DireccionesCotizacion {
  direcciones: DireccionEntrega[];
  elegida: string | null;
  /** false con folio de Kepler o fuera de borrador/enviada: ahí se cambia en el pedido de Kepler. */
  editable: boolean;
}

interface CabeceraEnvio {
  id: string; code: string; status: string; vencida: boolean; source_branch: string | null;
  erp_customer_code: string | null; salesperson_code: string | null; terms_discount_pct: string | null;
  delivery_address_key: string | null; kepler_sucursal: string | null; kepler_folio: string | null;
  /** COT.28. Por `to_jsonb`: la columna puede no existir si se desplegó antes de migrar. */
  order_notes?: string | null;
}

/**
 * `[COT.7.4]` — **Aceptar la cotización y armar el «Pedido Telemarketing» en Kepler.**
 *
 * ADR-113. El transporte es `KeplerPedidoTlmkSinkAdapter`; aquí viven los frenos de negocio
 * (D1–D5 del anexo COT.7) y la idempotencia, en el mismo orden que `pushToKepler` de KR:
 * **leer → frenar → reclamar → empujar (fuera de la transacción de la Suite) → anotar.** El ERP no
 * participa de nuestro rollback: si el sink se llamara adentro y lo nuestro cayera después,
 * quedaría un pedido huérfano en Kepler.
 *
 * Proveedor aparte a propósito: no cambia la firma inyectada de `CommercialQuotesService` ni la
 * del controlador que ya está en producción.
 */
@Injectable()
export class QuoteKeplerService {
  private readonly logger = new Logger(QuoteKeplerService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly quotes: CommercialQuotesService,
    private readonly pricing: QuotePricingService,
    private readonly sink: KeplerPedidoTlmkSinkAdapter,
  ) {}

  async enviar(id: string, quien?: QuienCotiza | null): Promise<EnvioKepler> {
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;
    if (!UUID_RX.test(id)) throw new BadRequestException('id inválido');
    // COT.21: la de otra persona no se abre, y mucho menos se manda al ERP.
    await this.quotes.assertPuedeAbrir(id, quien);

    // 1. Leer. `to_jsonb(q)`: las columnas de Kepler pueden no existir si se desplegó antes de migrar.
    const cab = (await this.tk.run((k) => k.raw(
      `SELECT q.id, q.code, q.status, (q.valid_until < CURRENT_DATE) AS vencida, q.source_branch,
              q.erp_customer_code, q.salesperson_code, q.terms_discount_pct::text AS terms_discount_pct,
              q.delivery_address_key,
              to_jsonb(q) ->> 'kepler_sucursal' AS kepler_sucursal, to_jsonb(q) ->> 'kepler_folio' AS kepler_folio,
              to_jsonb(q) ->> 'order_notes' AS order_notes
         FROM commercial.quotes q
        WHERE q.tenant_id = :t AND q.id = :id AND q.deleted_at IS NULL`, { t: tenantId, id }))).rows[0] as CabeceraEnvio | undefined;
    if (!cab) throw new NotFoundException('Cotización no encontrada');

    // 2. Idempotencia: con folio, ya salió.
    if (cab.kepler_folio) return { ya_estaba: true, kepler: { sucursal: cab.kepler_sucursal ?? '', folio: cab.kepler_folio } };

    // 3. Frenos. Cada uno existe porque su ausencia escribe en el ERP un pedido que no debía existir.
    if (cab.status !== 'draft' && cab.status !== 'sent') {
      throw new BadRequestException(`La cotización está ${cab.status}: sólo una en borrador o enviada se acepta como pedido.`);
    }
    if (cab.vencida) throw new BadRequestException('La cotización ya venció: re-cotízala con los precios de hoy antes de aceptarla.');
    if (!cab.source_branch) throw new BadRequestException('La cotización no tiene sucursal: no se sabe en qué Kepler crear el pedido.');
    await this.quotes.assertEscribeSucursal(cab.source_branch);
    // D3: sin clave del ERP no hay pedido. La Suite no da de alta clientes en Kepler.
    if (!cab.erp_customer_code?.trim()) {
      throw new BadRequestException('La cotización no tiene un cliente de Kepler. Elige al cliente del padrón (o CONTADO) antes de aceptarla.');
    }
    // D5: el vendedor del pedido es el de la cotización, obligatorio.
    if (!cab.salesperson_code?.trim()) throw new BadRequestException('La cotización no tiene vendedor de Kepler: elígelo antes de aceptarla.');
    // COT.26: la dirección decide la ruta que lo entrega. Con varias, no se adivina: vacía, Kepler
    // la toma como la 1 y el pedido sale a la ruta de otro domicilio.
    const direcciones = await this.leerDirecciones(cab.source_branch, cab.erp_customer_code);
    let direccion = cab.delivery_address_key?.trim() || null;
    if (direccion && !direcciones.some((d) => d.key === direccion)) {
      throw new BadRequestException(`La dirección de entrega ${direccion} ya no está en Kepler para este cliente: elige otra antes de aceptar.`);
    }
    if (!direccion && direcciones.length > 1) {
      throw new BadRequestException(`El cliente tiene ${direcciones.length} direcciones de entrega: elige a cuál va el pedido antes de aceptarlo.`);
    }
    if (!direccion && direcciones.length === 1) direccion = direcciones[0].key;

    const lineas = (await this.tk.run((k) => k.raw(
      `SELECT ql.line_number, ql.parent_line_number, ql.quantity::float8 AS quantity, ql.unit_price::float8 AS unit_price,
              ql.list_price::float8 AS list_price, ql.line_total::float8 AS line_total, ql.qty_unit, ql.qty_factor::float8 AS qty_factor,
              ql.requested_text, btrim(p.sku) AS sku
         FROM commercial.quote_lines ql
         LEFT JOIN catalog.products p ON p.tenant_id = ql.tenant_id AND p.id = ql.product_id
        WHERE ql.tenant_id = :t AND ql.quote_id = :id
        ORDER BY ql.line_number`, { t: tenantId, id }))).rows as Array<{
      line_number: number; parent_line_number: number | null; quantity: number; unit_price: number | null; list_price: number | null;
      line_total: number; qty_unit: string | null; qty_factor: number | null; requested_text: string | null; sku: string | null;
    }>;
    if (!lineas.length) throw new BadRequestException('La cotización no tiene renglones.');
    const sinCatalogo = lineas.filter((l) => !l.sku);
    if (sinCatalogo.length) {
      throw new BadRequestException(`${sinCatalogo.length} renglón(es) no casaron con el catálogo (${sinCatalogo.slice(0, 3).map((l) => `«${l.requested_text ?? '?'}»`).join(', ')}): quítalos o cámbialos por un producto antes de aceptar.`);
    }
    // Los regalos del ERP (renglón hijo a precio cero) no se escriben todavía: cómo los guarda el
    // pedido TELEMARK no se midió. Falla cerrada en vez de adivinar.
    if (lineas.some((l) => l.parent_line_number !== null)) {
      throw new BadRequestException('La cotización trae producto de regalo: el pedido con regalos todavía no se arma desde la Suite. Captúralo en Kepler.');
    }
    const sinPrecio = lineas.filter((l) => !(Number(l.unit_price) > 0));
    if (sinPrecio.length) throw new BadRequestException(`${sinPrecio.length} renglón(es) sin precio: ${sinPrecio.slice(0, 5).map((l) => l.sku).join(', ')}.`);

    // D2: el precio que se escribe es el que se factura. Si Kepler cambió algún precio desde que se
    // cotizó, primero se re-cotiza (el botón ya existe) y el cliente acepta el de hoy.
    const chk = await this.pricing.checkQuote(id);
    if (chk.price_changed > 0) {
      throw new BadRequestException(`El precio de ${chk.price_changed} renglón(es) cambió en Kepler desde que se cotizó. Re-cotiza y confirma el total con el cliente antes de aceptar.`);
    }

    // El interruptor de la Suite, leído en CADA envío: apagar vale al instante (PQ.20).
    const sw = await this.interruptor(tenantId, cab.source_branch);
    if (!sw.encendida) {
      const motivo = `La escritura de pedidos TELEMARK a Kepler de la sucursal ${cab.source_branch} está apagada desde la Suite.`;
      await this.anotarError(tenantId, id, motivo);
      throw new BadRequestException(motivo);
    }

    // 4. Reclamar: un solo envío a la vez por cotización. Sin esto, dos clics escriben dos pedidos.
    const reclamo = await this.tk.run((k) => k.raw(
      `UPDATE commercial.quotes SET kepler_sending_at = now()
        WHERE tenant_id = :t AND id = :id AND kepler_folio IS NULL
          AND (kepler_sending_at IS NULL OR kepler_sending_at < now() - ${RECLAMO_VENCE})
        RETURNING id`, { t: tenantId, id }));
    if (!reclamo.rows.length) throw new ConflictException('Esta cotización ya se está enviando a Kepler. Espera unos segundos y vuelve a abrirla.');

    // 5. Empujar, fuera de la transacción de la Suite.
    const renglones: RenglonCotizacion[] = lineas.map((l) => ({
      sku: l.sku as string, cantidad: Number(l.quantity),
      presentacion: l.qty_unit, factor: l.qty_factor && l.qty_factor > 0 ? Number(l.qty_factor) : null,
      precio: Number(l.unit_price), lista: l.list_price === null ? null : Number(l.list_price), importe: Number(l.line_total),
    }));
    const pct = cab.terms_discount_pct === null ? null : Number(cab.terms_discount_pct);
    let res: PedidoTlmkResultado;
    try {
      res = await this.sink.entregar({
        cotizacion_id: cab.id, folio_suite: cab.code, sucursal: cab.source_branch,
        cliente: cab.erp_customer_code, vendedor: cab.salesperson_code,
        fecha: todayMx(), pct_cliente: pct, direccion_envio: direccion, observaciones: cab.order_notes ?? null,
        renglones, tope_dia: sw.tope_dia,
      });
    } catch (err) {
      res = { estado: 'rechazado', motivo: (err as Error).message };
    }

    // 6. Anotar, y soltar el reclamo.
    if (res.estado !== 'entregado') {
      const motivo = res.motivos?.length ? `${res.motivo}: ${res.motivos.join(' · ')}` : res.motivo;
      await this.anotarError(tenantId, id, motivo);
      throw new BadRequestException({ message: `Kepler no aceptó el pedido: ${res.motivo}`, motivos: res.motivos ?? [] });
    }
    await this.tk.run((k) => k.raw(
      `UPDATE commercial.quotes
          SET kepler_sucursal = :suc, kepler_folio = :folio, kepler_sent_at = now(), kepler_sent_by = :u,
              kepler_error = NULL, kepler_sending_at = NULL,
              status = CASE WHEN status IN ('draft','sent') THEN 'accepted' ELSE status END,
              accepted_at = CASE WHEN status IN ('draft','sent') THEN now() ELSE accepted_at END,
              updated_at = now(), updated_by = :u
        WHERE tenant_id = :t AND id = :id`,
      { suc: res.kepler.sucursal, folio: res.kepler.folio, u: userId, t: tenantId, id }));
    this.logger.log(`Cotización ${cab.code} aceptada → Pedido TELEMARK Kepler ${res.kepler.sucursal}/${res.kepler.folio} por ${userId ?? 'system'}`);
    return { ya_estaba: !!res.ya_estaba, kepler: res.kepler };
  }

  /** `[COT.26]` Las direcciones de entrega del cliente de la cotización, y cuál tiene elegida. */
  async direcciones(id: string, quien?: QuienCotiza | null): Promise<DireccionesCotizacion> {
    const cab = await this.cabeceraDireccion(id, quien);
    return {
      direcciones: await this.leerDirecciones(cab.source_branch, cab.erp_customer_code),
      elegida: cab.delivery_address_key?.trim() || null,
      editable: !cab.kepler_folio && (cab.status === 'draft' || cab.status === 'sent'),
    };
  }

  /** `[COT.26]` Las direcciones de un cliente ANTES de que exista la cotización (pantalla de alta). */
  async direccionesDeCliente(sucursal: string, cliente: string): Promise<DireccionEntrega[]> {
    const suc = (sucursal || '').trim();
    if (!suc || !(cliente || '').trim()) throw new BadRequestException('Faltan la sucursal y el cliente.');
    await this.quotes.assertEscribeSucursal(suc);
    return this.leerDirecciones(suc, cliente.trim().toUpperCase());
  }

  /** `[COT.28]` Observaciones del pedido (van a «Comentarios» de Kepler). Sólo antes del folio. */
  async fijarObservaciones(id: string, texto: string | null, quien?: QuienCotiza | null): Promise<{ order_notes: string | null }> {
    const cab = await this.cabeceraDireccion(id, quien);
    if (cab.kepler_folio) {
      throw new BadRequestException(`El pedido ya está en Kepler (folio ${cab.kepler_folio}): las observaciones se cambian ahí, en «Comentarios».`);
    }
    if (cab.status !== 'draft' && cab.status !== 'sent') throw new BadRequestException(`La cotización está ${cab.status}: ya no se edita.`);
    if (!cab.source_branch) throw new BadRequestException('La cotización no tiene sucursal.');
    await this.quotes.assertEscribeSucursal(cab.source_branch);
    const limpia = normalizarObservaciones(texto);
    if (limpia && limpia.length > LARGO_OBSERVACIONES) {
      throw new BadRequestException(
        `Las observaciones caben en ${LARGO_OBSERVACIONES} caracteres (dos renglones de Comentarios en Kepler); llevan ${limpia.length}.`,
      );
    }
    await this.tk.run((k) => k.raw(
      `UPDATE commercial.quotes SET order_notes = :o, updated_at = now(), updated_by = :u
        WHERE tenant_id = :t AND id = :id`,
      { o: limpia, u: this.tenantCtx.get()?.userId ?? null, t: this.tenantCtx.requireTenantId(), id }));
    return { order_notes: limpia };
  }

  /** `[COT.26]` Elige la dirección de entrega. Sólo antes de que el pedido exista en Kepler. */
  async fijarDireccion(id: string, key: string | null, quien?: QuienCotiza | null): Promise<DireccionesCotizacion> {
    const cab = await this.cabeceraDireccion(id, quien);
    if (cab.kepler_folio) {
      throw new BadRequestException(`El pedido ya está en Kepler (folio ${cab.kepler_folio}): la dirección se cambia ahí, en «Dir. envío».`);
    }
    if (cab.status !== 'draft' && cab.status !== 'sent') throw new BadRequestException(`La cotización está ${cab.status}: ya no se edita.`);
    if (!cab.source_branch) throw new BadRequestException('La cotización no tiene sucursal.');
    await this.quotes.assertEscribeSucursal(cab.source_branch);
    const limpia = key?.trim() || null;
    const direcciones = await this.leerDirecciones(cab.source_branch, cab.erp_customer_code);
    if (limpia && !direcciones.some((d) => d.key === limpia)) {
      throw new BadRequestException(`La dirección ${limpia} no es del cliente en Kepler.`);
    }
    const tenantId = this.tenantCtx.requireTenantId();
    await this.tk.run((k) => k.raw(
      `UPDATE commercial.quotes SET delivery_address_key = :key, updated_at = now(), updated_by = :u
        WHERE tenant_id = :t AND id = :id`,
      { key: limpia, u: this.tenantCtx.get()?.userId ?? null, t: tenantId, id }));
    return { direcciones, elegida: limpia, editable: true };
  }

  private async cabeceraDireccion(id: string, quien?: QuienCotiza | null) {
    if (!UUID_RX.test(id)) throw new BadRequestException('id inválido');
    await this.quotes.assertPuedeAbrir(id, quien);
    const cab = (await this.tk.run((k) => k.raw(
      `SELECT q.status, q.source_branch, q.erp_customer_code, q.delivery_address_key,
              to_jsonb(q) ->> 'kepler_folio' AS kepler_folio
         FROM commercial.quotes q
        WHERE q.tenant_id = :t AND q.id = :id AND q.deleted_at IS NULL`,
      { t: this.tenantCtx.requireTenantId(), id }))).rows[0] as
      | { status: string; source_branch: string | null; erp_customer_code: string | null; delivery_address_key: string | null; kepler_folio: string | null }
      | undefined;
    if (!cab) throw new NotFoundException('Cotización no encontrada');
    return cab;
  }

  private async leerDirecciones(sucursal: string | null, cliente: string | null): Promise<DireccionEntrega[]> {
    if (!sucursal || !cliente?.trim()) return [];
    const r = await this.tk.run((k) => k.raw(
      `SELECT btrim(c2) AS key, btrim(coalesce(c3, '')) AS calle, btrim(coalesce(c5, '')) AS ciudad,
              btrim(coalesce(c6, '')) AS telefono, btrim(coalesce(c13, '')) AS ruta
         FROM kepler_ods.kdudent
        WHERE sucursal = :s AND btrim(c1) = :c AND btrim(coalesce(c2, '')) <> ''
        ORDER BY length(btrim(c2)), btrim(c2)`,
      { s: sucursal, c: cliente.trim() }));
    return r.rows as DireccionEntrega[];
  }

  /** El renglón (sucursal, telemarketing). Sin renglón o sin tabla = APAGADA (falla cerrada). */
  private async interruptor(tenantId: string, sucursal: string): Promise<{ encendida: boolean; tope_dia: number | null }> {
    try {
      const r = await this.tk.run((k) => k('commercial.kepler_push_switch')
        .where({ tenant_id: tenantId, sucursal, tipo: 'telemarketing' }).first('encendida', 'tope_dia'));
      return r ? { encendida: !!r.encendida, tope_dia: r.tope_dia === null ? null : Number(r.tope_dia) } : { encendida: false, tope_dia: 1 };
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === '42P01') return { encendida: false, tope_dia: 1 };
      throw e;
    }
  }

  private async anotarError(tenantId: string, id: string, motivo: string): Promise<void> {
    await this.tk.run((k) => k.raw(
      `UPDATE commercial.quotes SET kepler_error = :m, kepler_sending_at = NULL WHERE tenant_id = :t AND id = :id`,
      { m: motivo.slice(0, 2000), t: tenantId, id }));
  }
}
