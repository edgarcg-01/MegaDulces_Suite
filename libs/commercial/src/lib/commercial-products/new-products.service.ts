import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import {
  Cohorte,
  NewProductKind,
  NewProductRow,
  NewProductSource,
  Resumen,
  aFila,
  construirCohortes,
  construirResumen,
  esKindValido,
  ocultarCosto,
} from './new-products';

export interface NewProductsResponse {
  /** `false` = la matvista existe pero el lote nocturno todavía no la ha poblado. */
  calculado: boolean;
  /** Cuándo se calcularon las cifras (el último refresco nocturno). */
  calculado_at: string | null;
  /** Desde cuándo hay historia de venta y entradas: lo que permite afirmar que algo es nuevo. */
  historia_desde: string | null;
  /** `false` = el usuario no tiene permiso de costo: la inversión viene en NULL a propósito. */
  costo_visible: boolean;
  resumen: Resumen | null;
  cohortes: Cohorte[];
  filas: NewProductRow[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOY = "(now() AT TIME ZONE 'America/Mexico_City')::date";

/**
 * `[NP.2]` **Productos nuevos** — la etiqueta "Nuevo" y su seguimiento a 30, 60 y 90 días.
 *
 * Lee `analytics.mv_new_products` (la refresca el lote nocturno) y le une la clasificación de
 * Compras al momento. La matvista no tiene RLS (Postgres no la soporta en matvistas), así que el
 * tenant se filtra EXPLÍCITO con `public.current_tenant_id()`, que `tk.run` deja puesto.
 *
 * Las decisiones (etapa, estado, hitos, cohortes) viven en `new-products.ts`, puras y probadas.
 */
@Injectable()
export class NewProductsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async list(opts: { puedeVerCosto: boolean }): Promise<NewProductsResponse> {
    return this.tk.run(async (trx) => {
      // Una matvista sin poblar REVIENTA al leerla ("has not been populated"). Se pregunta antes
      // y se declara, en vez de devolver un error que se lea como "la pantalla está rota".
      const estado = await trx.raw(`
        SELECT c.relispopulated AS poblada
          FROM pg_class c
         WHERE c.oid = to_regclass('analytics.mv_new_products')`);
      if (estado.rows[0]?.poblada !== true) {
        return {
          calculado: false, calculado_at: null, historia_desde: null,
          costo_visible: opts.puedeVerCosto, resumen: null, cohortes: [], filas: [],
        };
      }

      const { rows } = await trx.raw(`
        SELECT m.product_id, m.sku, m.nombre, m.marca, m.proveedor,
               to_char(m.alta_suite, 'YYYY-MM-DD')        AS alta_suite,
               m.alta_en_lote,
               to_char(m.primera_recepcion, 'YYYY-MM-DD') AS primera_recepcion,
               to_char(m.primera_venta, 'YYYY-MM-DD')     AS primera_venta,
               to_char(m.lanzamiento, 'YYYY-MM-DD')       AS lanzamiento,
               (${HOY} - m.lanzamiento)::int              AS dia,
               m.fuentes, m.sin_movimiento, m.no_medible, m.exclusion_auto, m.posible_recodificacion,
               m.inversion_30, m.inversion_60, m.inversion_90, m.inversion_total,
               m.entradas, m.plazas_recibido,
               to_char(m.primera_recompra, 'YYYY-MM-DD')  AS primera_recompra,
               m.venta_30, m.venta_60, m.venta_90, m.venta_total,
               m.dias_con_venta_30, m.plazas_venta,
               to_char(m.ultima_venta, 'YYYY-MM-DD')      AS ultima_venta,
               m.plazas_con_existencia,
               r.kind                                     AS clasificacion,
               r.note                                     AS nota,
               r.updated_by_username                      AS clasificado_por,
               to_char(m.historia_desde, 'YYYY-MM-DD')    AS historia_desde,
               m.calculado_at
          FROM analytics.mv_new_products m
          LEFT JOIN catalog.new_product_reviews r
            ON r.tenant_id = m.tenant_id AND r.product_id = m.product_id AND r.deleted_at IS NULL
         WHERE m.tenant_id = public.current_tenant_id()
         ORDER BY m.lanzamiento DESC NULLS LAST, m.nombre`);

      let filas = (rows as NewProductSource[]).map(aFila);
      // Se oculta ANTES de agregar: así la cohorte tampoco deja ver la inversión sumada.
      if (!opts.puedeVerCosto) filas = ocultarCosto(filas);

      const primera = rows[0] as { calculado_at?: Date | string; historia_desde?: string } | undefined;
      return {
        calculado: true,
        calculado_at: primera?.calculado_at ? new Date(primera.calculado_at).toISOString() : null,
        historia_desde: primera?.historia_desde ?? null,
        costo_visible: opts.puedeVerCosto,
        resumen: construirResumen(filas),
        cohortes: construirCohortes(filas),
        filas,
      };
    });
  }

  /**
   * Compras confirma qué es cada código. `kind = null` quita la clasificación (soft-delete): el
   * producto vuelve a "por confirmar" y queda el rastro de quién decidió qué.
   */
  async classify(productId: string, body: { kind?: string | null; note?: string | null }) {
    if (!UUID_RE.test(productId || '')) throw new BadRequestException('Producto inválido');
    const kind = body?.kind ?? null;
    if (kind !== null && !esKindValido(kind)) {
      throw new BadRequestException('Clasificación inválida: nuevo, recodificacion, promocion o no_mercancia');
    }
    const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;
    const ctx = this.tenantCtx.get();
    const userId = ctx?.userId && UUID_RE.test(ctx.userId) ? ctx.userId : null;
    const username = ctx?.username ?? null;

    return this.tk.run(async (trx) => {
      const existe = await trx.raw(
        `SELECT 1 FROM catalog.products WHERE id = ? AND tenant_id = public.current_tenant_id() AND deleted_at IS NULL`,
        [productId]);
      if (!existe.rows.length) throw new NotFoundException('Producto no encontrado');

      if (kind === null) {
        await trx.raw(`
          UPDATE catalog.new_product_reviews
             SET deleted_at = now(), deleted_by = ?, updated_at = now(), updated_by = ?, updated_by_username = ?
           WHERE tenant_id = public.current_tenant_id() AND product_id = ? AND deleted_at IS NULL`,
          [userId, userId, username, productId]);
        return { product_id: productId, clasificacion: null, nota: null };
      }

      await trx.raw(`
        INSERT INTO catalog.new_product_reviews
          (tenant_id, product_id, kind, note, created_by, created_by_username, updated_by, updated_by_username)
        VALUES (public.current_tenant_id(), ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, product_id) WHERE deleted_at IS NULL DO UPDATE
           SET kind = EXCLUDED.kind, note = EXCLUDED.note, updated_at = now(),
               updated_by = EXCLUDED.updated_by, updated_by_username = EXCLUDED.updated_by_username`,
        [productId, kind, note, userId, username, userId, username]);
      return { product_id: productId, clasificacion: kind as NewProductKind, nota: note };
    });
  }
}
