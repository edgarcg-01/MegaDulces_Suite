import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';

import { CommercialQuotesService, type CreateQuoteLine } from './commercial-quotes.service';
import { QuotePricingService, rungDeRotulo, type Ladder, type LadderParaRotulo } from './quote-pricing.service';
import { QuoteKeplerService } from './quote-kepler.service';
import { LARGO_OBSERVACIONES } from './kepler-pedido-tlmk';
import {
  CLIENTE_TIENDA,
  MARCA_CANAL,
  NoSeConvierte,
  SUCURSAL_TIENDA,
  pedidoTiendaACotizacion,
  type FichaTienda,
  type PedidoTienda,
} from './pedido-tienda-a-cotizacion';

/**
 * `[COT.7.50]` — **Un pedido de la tienda de marca entra por la misma puerta que los demás.**
 *
 * Crea la cotización y la manda a Kepler, que es lo que telemarketing hace a mano hoy con cada
 * pedido en línea (45 de 45 con folio desde el 2026-11-12). No escribe en el ERP: eso lo hace
 * `QuoteKeplerService`, con su interruptor, su tope y su árbitro. *ADR-056.*
 *
 * ⛔⛔ **Idempotente a propósito.** Un webhook se reintenta; dos entregas del mismo aviso no pueden
 * volverse dos pedidos en el ERP. Antes de crear nada se busca el número del pedido de la tienda.
 * ⚠️ **Deuda con nombre:** la marca vive hoy dentro de `order_notes` porque `commercial.quotes` no
 * tiene una columna de referencia externa. Lo correcto es `external_ref` con índice único por
 * tenant; mientras no exista, una nota escrita a mano que contenga la misma marca y el mismo
 * número podría confundirse con un pedido de la tienda.
 */
/** Qué pasó con un pedido de la tienda. Lo que no se pudo hacer viaja en `motivo`, no en un hueco. */
export interface RegistroPedidoTienda {
  estado: 'creado' | 'ya_estaba' | 'rechazado';
  motivo?: string;
  quote_id?: string;
  quote_code?: string;
  kepler_sucursal?: string;
  kepler_folio?: string;
}

@Injectable()
export class TiendaPedidoService {
  private readonly logger = new Logger(TiendaPedidoService.name);

  /**
   * `[COT.7.50]` Los pedidos que se están registrando AHORA, por número.
   *
   * ⛔ La idempotencia por `yaEntro()` es una lectura seguida de una escritura: **dos entregas del
   * mismo aviso que llegan a la vez pasan las dos** y crean dos pedidos en el ERP. Wix reintenta, y
   * un proxy lento hace que el reintento alcance al original. Mientras `commercial.quotes` no tenga
   * una columna `external_ref` con índice único —la deuda ya nombrada arriba—, el segundo que llega
   * espera al primero y devuelve su resultado. ⚠️ Esto protege **dentro de un proceso**: con varias
   * réplicas de la API el candado real sigue siendo el índice único que falta.
   */
  private readonly enVuelo = new Map<string, Promise<RegistroPedidoTienda>>();

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly quotes: CommercialQuotesService,
    private readonly pricing: QuotePricingService,
    private readonly kepler: QuoteKeplerService,
  ) {}

  /** La marca exacta que se busca para no duplicar: `PEDIDO PAGINA WEB #11222`. */
  static marcaDe(numero: string): string {
    return `${MARCA_CANAL} #${numero}`;
  }

  /** ¿Este pedido de la tienda ya entró? Devuelve la cotización que lo representa, o null. */
  async yaEntro(numero: string): Promise<{ id: string; code: string; kepler_folio: string | null } | null> {
    const marca = TiendaPedidoService.marcaDe(numero);
    const r = await this.tk.run((k) =>
      k('commercial.quotes')
        .select('id', 'code', 'kepler_folio')
        .where('erp_customer_code', CLIENTE_TIENDA)
        .andWhere('origin', 'telemarketing')
        .whereNull('deleted_at')
        .andWhere('order_notes', 'like', `%${marca}%`)
        .orderBy('created_at', 'desc')
        .first(),
    );
    return r ? { id: String(r.id), code: String(r.code), kepler_folio: r.kepler_folio ?? null } : null;
  }

  /**
   * Convierte las escaleras del motor de precios en la ficha que necesita el productor puro:
   * una lista de `{ unidad, factor }` por SKU. **Una sola definición de unidad** — la del motor.
   */
  private fichasDe(escaleras: Map<string, Ladder>): Map<string, FichaTienda> {
    const out = new Map<string, FichaTienda>();
    for (const [sku, led] of escaleras) {
      const unidades: FichaTienda['unidades'] = [];
      for (const paso of Object.values(led?.rungs ?? {})) {
        const etiqueta = (paso?.label ?? '').trim();
        if (!etiqueta) continue;
        // `size` es cuántas unidades base entran en el peldaño: eso es el factor.
        const factor = Number(paso?.size ?? 1) || 1;
        if (!unidades.some((u) => u.unidad === etiqueta)) unidades.push({ unidad: etiqueta, factor });
      }
      out.set(sku, { unidades });
    }
    return out;
  }

  /**
   * Registra el pedido: cotización + envío a Kepler. Devuelve qué pasó, siempre; lo que no se
   * pudo hacer **se dice**, no se esconde.
   *
   * Dos entregas del mismo aviso **a la vez** no se vuelven dos pedidos: la segunda espera a la
   * primera y devuelve su resultado (ver `enVuelo`).
   */
  async registrar(pedido: PedidoTienda): Promise<RegistroPedidoTienda> {
    const numero = (pedido?.numero ?? '').trim();
    const yaCorriendo = numero ? this.enVuelo.get(numero) : undefined;
    if (yaCorriendo) {
      this.logger.warn(`Pedido ${numero} de la tienda: ya se estaba registrando, espero a esa corrida`);
      return yaCorriendo;
    }
    const corrida = this.registrarAhora(pedido);
    if (numero) {
      this.enVuelo.set(numero, corrida);
      // el candado se suelta pase lo que pase: si no, un fallo deja el número trabado para siempre
      corrida.catch(() => undefined).finally(() => this.enVuelo.delete(numero));
    }
    return corrida;
  }

  private async registrarAhora(pedido: PedidoTienda): Promise<RegistroPedidoTienda> {
    this.tenantCtx.requireTenantId();
    const numero = (pedido?.numero ?? '').trim();
    if (!numero) throw new BadRequestException('El pedido de la tienda no trae número.');

    // 1. ⛔ idempotencia primero: un reintento del webhook no puede crear un segundo pedido.
    const previo = await this.yaEntro(numero);
    if (previo) {
      this.logger.log(`Pedido ${numero} de la tienda: ya estaba como ${previo.code}`);
      return { estado: 'ya_estaba', quote_id: previo.id, quote_code: previo.code, kepler_folio: previo.kepler_folio ?? undefined };
    }

    // 2. las escaleras del motor: una sola definición de unidad para todo el proyecto
    const skus = [...new Set((pedido.renglones ?? []).map((r) => (r.sku ?? '').trim()).filter(Boolean))];
    if (!skus.length) return { estado: 'rechazado', motivo: 'el pedido no trae ningún SKU' };
    const escaleras = await this.tk.run((k) => this.pricing.ladders(k, SUCURSAL_TIENDA, skus));
    const fichas = this.fichasDe(escaleras);

    // 3. el productor puro decide, y rechaza entero si algo no se puede armar
    let armada;
    try {
      armada = pedidoTiendaACotizacion(pedido, (sku) => fichas.get(sku) ?? null, LARGO_OBSERVACIONES);
    } catch (e) {
      if (e instanceof NoSeConvierte) {
        this.logger.warn(`Pedido ${numero} de la tienda, no se arma: ${e.message}`);
        return { estado: 'rechazado', motivo: e.message };
      }
      throw e;
    }

    // 4. el peldaño NO se inventa acá: lo resuelve `rungDeRotulo` contra la escalera del SKU
    const lines: CreateQuoteLine[] = armada.renglones.map((r) => ({
      sku: r.sku,
      quantity: r.quantity,
      rung: rungDeRotulo(r.qty_unit, (escaleras.get(r.sku) ?? null) as LadderParaRotulo | null),
    }));

    // 5. la cotización, por el mismo camino que usa telemarketing
    const creada = await this.quotes.create({
      erp_customer_code: armada.cliente,
      source_branch: armada.sucursal,
      origin: 'telemarketing',
      order_notes: armada.notas,
      lines,
    });

    // 6. a Kepler, por la puerta que ya existe (interruptor y tope incluidos)
    try {
      const envio = await this.kepler.enviar(String(creada.id));
      return {
        estado: 'creado',
        quote_id: String(creada.id),
        quote_code: String(creada.code),
        kepler_sucursal: envio.kepler.sucursal,
        kepler_folio: envio.kepler.folio,
      };
    } catch (e) {
      // La cotización QUEDA: es el testigo de que el pedido llegó. Lo que falló se declara.
      const motivo = e instanceof Error ? e.message : String(e);
      this.logger.error(`Pedido ${numero}: cotización ${creada.code} creada, pero Kepler falló: ${motivo}`);
      return { estado: 'creado', quote_id: String(creada.id), quote_code: String(creada.code), motivo };
    }
  }
}
