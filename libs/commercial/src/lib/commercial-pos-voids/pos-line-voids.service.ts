import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ScopeService } from '@megadulces/platform-core';

/**
 * `[BP.3]` — BITÁCORA DE RETIROS EN CAJA: el renglón que el cajero quitó del ticket.
 *
 * ── Por qué este servicio existe ─────────────────────────────────────────────────────────────
 * Medido el 2026-09-28 contra las 9 ramas y confirmado en vivo en una caja: cuando el cajero
 * quita un producto del ticket, **Kepler exige contraseña de supervisor y después no escribe
 * nada en ningún lado.** `pv_aut_cambios.kpl` abre `kdpv_gerentes` y `kdpv_kdku` sólo para
 * validar; `elimina_prod()` marca la celda EN MEMORIA; y el guardado rechaza cualquier renglón
 * en cantidad 0, así que la marca nunca llega a la base. Cero coincidencias de "ELIMINADO" en
 * las 46 columnas de texto de `kdm2`.
 *
 * Tampoco hay interruptor: `kdconfig` trae el catálogo COMPLETO de 48 parámetros, 19 del POS, y
 * ninguno es de bitácora. Y parchear el programa no sirve: el cliente **re-descarga las páginas
 * del servidor al abrir** (medido: el parche duró 90 minutos en disco y cero en ejecución).
 *
 * Por eso el dato nace de una persona, igual que `floor_stockouts`. Detalle en
 * `FASE_BP_BITACORA_POS.md`.
 *
 * ── Quién captura, y por qué NO es el cajero ─────────────────────────────────────────────────
 * Lo que se registra es **una autorización**, y la firma es de quien la dio. Un cajero
 * registrando sus propios retiros sin el autorizante sería un log que no prueba nada. Por eso
 * `STORE_POS_VOID_CAPTURAR` deriva de `STORE_LIVE_VER` (supervisión) y no del arqueo.
 *
 * ── Valorar lo retirado, con la unidad declarada ─────────────────────────────────────────────
 * `est_value = piece_price × (qty_original − qty_final)`, leyendo `analytics.v_label_prices` —
 * el MISMO precio que muestran la etiqueta y el verificador, así que la cifra es conmensurable
 * con lo que el cliente vio en el anaquel.
 *
 * ⚠️ **Sólo se valora cuando la cantidad está en PIEZAS.** `piece_price` es por pieza, y la
 * rejilla del POS maneja PZA, PAQ y CJA. Multiplicar un precio por pieza por una cantidad en
 * cajas inventaría una cifra que el dato no sostiene — es exactamente la trampa que documenta
 * `UNIDADES_DE_MEDIDA.md` y que ya costó dinero en otras fases. Cuando la unidad no es pieza, o
 * no hay precio, queda **NULL con `est_source='sin_dato'`, nunca $0** (ADR-056). El CHECK de la
 * tabla lo vuelve imposible de violar aunque este código se equivoque.
 */

/** Unidades que sí son la pieza. Cualquier otra cosa no se valora: se declara. */
const UNIDADES_PIEZA = new Set(['', 'PZA', 'PZ', 'PIEZA', 'PIEZAS', 'UN', 'UNI', 'UNIDAD']);

export type VoidReason =
  | 'error_captura'
  | 'cliente_desistio'
  | 'precio_incorrecto'
  | 'producto_danado'
  | 'cantidad_incorrecta'
  | 'otro';

export interface RegistrarVoidDto {
  /** Código de la sucursal. Viaja explícito, nunca se deduce del usuario. */
  warehouse_code: string;
  caja?: string | null;
  /** Clave del supervisor que autorizó (la misma que teclea en Kepler). Obligatoria: es la firma. */
  supervisor_code: string;
  supervisor_name?: string | null;
  cashier_code?: string | null;
  cashier_name?: string | null;
  sku?: string | null;
  scanned_code?: string | null;
  /** Lo que la persona escribió, si el producto no resolvió. */
  product_name?: string | null;
  qty_original: number;
  qty_final?: number;
  unidad?: string | null;
  reason: VoidReason;
  reason_note?: string | null;
  /** Cuándo pasó en la caja (ISO). Si no viene, se asume ahora. */
  occurred_at?: string | null;
}

export interface RegistrarVoidResult {
  id: string;
  warehouse_code: string;
  sku: string | null;
  product_name: string | null;
  qty_retirada: number;
  est_value: number | null;
  est_source: 'precio_erp' | 'sin_dato';
  /** Por qué no se valoró, cuando no se valoró. Se dice, no se calla. */
  est_motivo: string | null;
}

export interface VoidSalida {
  id: string;
  occurred_at: string;
  reported_at: string;
  warehouse_code: string;
  caja: string | null;
  supervisor_code: string;
  supervisor_name: string | null;
  cashier_code: string | null;
  sku: string | null;
  product_name: string | null;
  qty_original: number;
  qty_final: number;
  qty_retirada: number;
  unidad: string | null;
  reason: VoidReason;
  reason_note: string | null;
  est_value: number | null;
  est_source: string;
}

export interface ResumenSupervisor {
  supervisor_code: string;
  supervisor_name: string | null;
  eventos: number;
  /** Suma de lo valorado. `eventos_sin_valorar` dice cuántos NO entraron acá. */
  valor_total: number | null;
  eventos_sin_valorar: number;
}

@Injectable()
export class PosLineVoidsService {
  private readonly logger = new Logger(PosLineVoidsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    /**
     * `[ZN.3]` / ADR-050 — el alcance de datos. NO es `@Optional()`: acá el alcance decide si se
     * contesta o no, y un servicio instanciado sin él tendría que elegir entre abrirse
     * (fail-open) o romperse. El módulo hermano ya pagó este defecto: el permiso abría la
     * pantalla pero no acotaba las filas, y alguien de una plaza podía leer otra.
     */
    private readonly scope: ScopeService,
  ) {}

  /** ¿Esta persona alcanza ESTA sucursal? El corte vive en `ScopeService`, no copiado acá. */
  private async assertAlcanza(warehouseCode: string): Promise<void> {
    await this.scope.assertCanRead('warehouse', warehouseCode);
  }

  private normalizarUnidad(u: string | null | undefined): string {
    return (u ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  }

  /**
   * Precio por pieza de la MISMA fuente que la etiqueta y el verificador.
   * Falla suave y lo dice: un precio que no se pudo leer no es un precio de cero.
   */
  private async precioPieza(
    trx: Knex.Transaction, warehouseCode: string, sku: string,
  ): Promise<number | null> {
    try {
      const r = await trx('analytics.v_label_prices')
        .select('piece_price')
        .whereRaw('BTRIM(sucursal) = BTRIM(?)', [warehouseCode])
        .whereRaw('BTRIM(sku) = BTRIM(?)', [sku])
        .first();
      return r?.piece_price != null ? Number(r.piece_price) : null;
    } catch (e: unknown) {
      this.logger.warn(
        `No se pudo leer precio para valorar el retiro (${warehouseCode}/${sku}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return null;
    }
  }

  private async resolverProducto(
    trx: Knex.Transaction, sku: string | null, code: string | null,
  ): Promise<{ id: string; sku: string; name: string } | null> {
    // ⚠️ La columna del nombre es `nombre`, no `name`: `catalog.products` conserva el nombrado en
    // español del esquema legado. Se alias-ea acá para que el servicio hable un solo idioma.
    if (sku) {
      const p = await trx('catalog.products')
        .select('id', 'sku', 'nombre as name')
        .whereRaw('BTRIM(sku) = BTRIM(?)', [sku])
        .whereNull('deleted_at')
        .first();
      if (p) return p;
    }
    if (code) {
      const p = await trx('catalog.product_barcodes as b')
        .join('catalog.products as p', function (this: Knex.JoinClause) {
          this.on('p.tenant_id', '=', 'b.tenant_id').andOn('p.id', '=', 'b.product_id');
        })
        .select('p.id', 'p.sku', 'p.nombre as name')
        .whereRaw("BTRIM(LTRIM(b.barcode,'0')) = BTRIM(LTRIM(?,'0'))", [code])
        .whereNull('p.deleted_at')
        .first();
      if (p) return p;
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // CAPTURA
  // ─────────────────────────────────────────────────────────────────────────────────────────

  async registrar(dto: RegistrarVoidDto): Promise<RegistrarVoidResult> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ctx = this.tenantCtx.get();

    const qtyOriginal = Number(dto.qty_original);
    const qtyFinal = Number(dto.qty_final ?? 0);
    if (!Number.isFinite(qtyOriginal) || qtyOriginal <= 0) {
      throw new BadRequestException('La cantidad original tiene que ser mayor a cero.');
    }
    if (!Number.isFinite(qtyFinal) || qtyFinal < 0 || qtyFinal >= qtyOriginal) {
      throw new BadRequestException(
        'La cantidad final tiene que ser menor a la original: si no bajó, no hubo retiro que registrar.',
      );
    }
    const supervisor = (dto.supervisor_code ?? '').trim();
    if (!supervisor) {
      throw new BadRequestException('Falta la clave del supervisor que autorizó: es la firma del registro.');
    }
    if (dto.reason === 'otro' && !(dto.reason_note ?? '').trim()) {
      throw new BadRequestException('El motivo "otro" exige escribir cuál. Un "otro" sin explicación deja la fila muda.');
    }

    await this.assertAlcanza(dto.warehouse_code);

    return this.tk.run(async (trx) => {
      const wh = await trx('commercial.warehouses')
        .select('id', 'code')
        .whereRaw('LOWER(code) = LOWER(?)', [dto.warehouse_code])
        .whereNull('deleted_at')
        .first();
      if (!wh) throw new NotFoundException(`No existe la sucursal ${dto.warehouse_code}`);

      const sku = (dto.sku ?? '').trim() || null;
      const code = (dto.scanned_code ?? '').trim() || null;
      const producto = await this.resolverProducto(trx, sku, code);

      // Valoración. Tres razones distintas para no valorar, y las tres se DECLARAN.
      const retirada = qtyOriginal - qtyFinal;
      const unidad = this.normalizarUnidad(dto.unidad);
      let unitPrice: number | null = null;
      let estValue: number | null = null;
      let estMotivo: string | null = null;

      if (!UNIDADES_PIEZA.has(unidad)) {
        estMotivo = `la cantidad está en ${unidad} y el precio de referencia es por pieza`;
      } else if (!producto?.sku) {
        estMotivo = 'el producto no resolvió en el catálogo';
      } else {
        unitPrice = await this.precioPieza(trx, wh.code, producto.sku);
        if (unitPrice == null) estMotivo = 'no hay precio de etiqueta para ese SKU en esa sucursal';
        else estValue = Number((unitPrice * retirada).toFixed(2));
      }
      const estSource: 'precio_erp' | 'sin_dato' = estValue == null ? 'sin_dato' : 'precio_erp';

      const [fila] = await trx('commercial.pos_line_voids')
        .insert({
          tenant_id: tenantId,
          warehouse_id: wh.id,
          caja: (dto.caja ?? '').trim() || null,
          supervisor_code: supervisor,
          supervisor_name: (dto.supervisor_name ?? '').trim() || null,
          cashier_code: (dto.cashier_code ?? '').trim() || null,
          cashier_name: (dto.cashier_name ?? '').trim() || null,
          product_id: producto?.id ?? null,
          sku: producto?.sku ?? sku,
          product_name: producto?.name ?? ((dto.product_name ?? '').trim() || null),
          qty_original: qtyOriginal,
          qty_final: qtyFinal,
          unidad: unidad || null,
          reason: dto.reason,
          reason_note: (dto.reason_note ?? '').trim() || null,
          unit_price: unitPrice,
          est_value: estValue,
          est_source: estSource,
          // Si la caja no manda hora, es ahora. Nunca en el futuro: el CHECK lo rechaza.
          occurred_at: dto.occurred_at ? new Date(dto.occurred_at) : trx.fn.now(),
          reported_by: ctx?.userId ?? null,
          reported_by_username: ctx?.username ?? null,
        })
        .returning(['id']);

      return {
        id: fila.id,
        warehouse_code: wh.code,
        sku: producto?.sku ?? sku,
        product_name: producto?.name ?? ((dto.product_name ?? '').trim() || null),
        qty_retirada: retirada,
        est_value: estValue,
        est_source: estSource,
        est_motivo: estMotivo,
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // LECTURA
  // ─────────────────────────────────────────────────────────────────────────────────────────

  async listar(warehouseCode: string, dias = 30, limite = 200): Promise<VoidSalida[]> {
    await this.assertAlcanza(warehouseCode);
    const d = Math.min(Math.max(Number(dias) || 30, 1), 365);
    const lim = Math.min(Math.max(Number(limite) || 200, 1), 1000);

    return this.tk.run(async (trx) => {
      const filas = await trx('commercial.pos_line_voids as v')
        .join('commercial.warehouses as w', function (this: Knex.JoinClause) {
          this.on('w.tenant_id', '=', 'v.tenant_id').andOn('w.id', '=', 'v.warehouse_id');
        })
        .select(
          'v.id', 'v.occurred_at', 'v.reported_at', 'w.code as warehouse_code', 'v.caja',
          'v.supervisor_code', 'v.supervisor_name', 'v.cashier_code',
          'v.sku', 'v.product_name', 'v.qty_original', 'v.qty_final', 'v.unidad',
          'v.reason', 'v.reason_note', 'v.est_value', 'v.est_source',
        )
        .whereRaw('LOWER(w.code) = LOWER(?)', [warehouseCode])
        .whereRaw(`v.occurred_at >= now() - (? || ' days')::interval`, [d])
        .orderBy('v.occurred_at', 'desc')
        .limit(lim);

      return filas.map((f: Record<string, unknown>) => ({
        ...f,
        qty_original: Number(f['qty_original']),
        qty_final: Number(f['qty_final']),
        qty_retirada: Number(f['qty_original']) - Number(f['qty_final']),
        est_value: f['est_value'] == null ? null : Number(f['est_value']),
      })) as VoidSalida[];
    });
  }

  /**
   * El ángulo por el que esta tabla existe: **cuánto autoriza cada supervisor.**
   *
   * ⚠️ `valor_total` suma SÓLO lo valorado, y `eventos_sin_valorar` dice cuántos quedaron fuera.
   * Publicar la suma sin ese acompañante haría leer "$1,200 retirados" donde en realidad hay
   * $1,200 **más N eventos de monto desconocido** — que es una afirmación distinta.
   */
  async resumenPorSupervisor(warehouseCode: string, dias = 30): Promise<ResumenSupervisor[]> {
    await this.assertAlcanza(warehouseCode);
    const d = Math.min(Math.max(Number(dias) || 30, 1), 365);

    return this.tk.run(async (trx) => {
      const filas = await trx('commercial.pos_line_voids as v')
        .join('commercial.warehouses as w', function (this: Knex.JoinClause) {
          this.on('w.tenant_id', '=', 'v.tenant_id').andOn('w.id', '=', 'v.warehouse_id');
        })
        .select('v.supervisor_code')
        .max('v.supervisor_name as supervisor_name')
        .count('* as eventos')
        .sum('v.est_value as valor_total')
        .countDistinct(trx.raw("CASE WHEN v.est_value IS NULL THEN v.id END as eventos_sin_valorar"))
        .whereRaw('LOWER(w.code) = LOWER(?)', [warehouseCode])
        .whereRaw(`v.occurred_at >= now() - (? || ' days')::interval`, [d])
        .groupBy('v.supervisor_code')
        .orderByRaw('count(*) DESC');

      return filas.map((f: Record<string, unknown>) => ({
        supervisor_code: String(f['supervisor_code']),
        supervisor_name: (f['supervisor_name'] as string | null) ?? null,
        eventos: Number(f['eventos']),
        valor_total: f['valor_total'] == null ? null : Number(f['valor_total']),
        eventos_sin_valorar: Number(f['eventos_sin_valorar'] ?? 0),
      }));
    });
  }
}
