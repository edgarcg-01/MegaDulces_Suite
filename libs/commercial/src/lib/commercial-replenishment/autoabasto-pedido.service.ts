import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService, MX_TZ, toMxDateKey } from '@megadulces/platform-core';
import {
  redondearPedido,
  aplicarMinimoMenor,
  necesitaMotivo,
  normalizarPosiciones,
  MOTIVOS_AJUSTE,
  POSICIONES_PEDIDO_DEFAULT,
  type PosicionPedido,
  type AutoabastoPosicionesRequest,
  type MotivoAjuste,
  type AjusteLinea,
  type EscaleraUnidades,
  type AutoabastoPedidoGrupo,
  type AutoabastoPedidoLinea,
  type AutoabastoPedidoResponse,
  type AutoabastoAjusteRequest,
  type AutoabastoAjusteResponse,
  type AutoabastoRestablecerRequest,
  type AutoabastoAceptarGrupoRequest,
  type AutoabastoAbrirRequest,
} from '@megadulces/contracts';
import { CommercialReplenishmentService } from './commercial-replenishment.service';

/** Abiertos de esta antigüedad o menos cuentan como «ya pedido» (decisión de Francisco, 2026-10-12). */
const VENTANA_YA_PEDIDO_DIAS = 7;
/** Lo negado se mira sobre este periodo. Sólo informa: no cambia el sugerido (decisión 2026-10-12). */
const VENTANA_NEGADO_DIAS = 30;
/** Cobertura del objetivo: la misma de la base 'demanda' del motor (= /compras/pedido). */
const COBERTURA_DIAS = 30;

/**
 * Lo pedido a otra sucursal y lo que no le surtieron, por producto, para UNA sucursal destino.
 *
 * El pedido de una sucursal a su matriz vive en Kepler como un pedido `U-D-40` de la MATRIZ con
 * cliente interno `TI…` de la sucursal (`c27='SUCURSAL'`). Medido 2026-10-12: 01→02 152 pedidos,
 * 01→03 119, 01→04 138, 06→05 87, 08→07 90 en 60 días. El código `TI` de cada sucursal lo da
 * Kepler (`analytics.v_erp_branch_catalog`).
 *
 * Se toma la versión VIGENTE de cada pedido (`DISTINCT ON … ORDER BY c9 DESC`, mismo criterio que
 * `warehouse-orders.service.ts`) y el renglón ancla `c1`: la base de una plaza guarda copias de
 * pedidos de otra con la misma serie y folio.
 *
 *  · `ya_pedido` — abiertos (AUTORIZADO / SURTIDO / CHECADO) de `VENTANA_YA_PEDIDO_DIAS` o menos,
 *    en unidad base (`kdm2.c9`).
 *  · `atorado`   — abiertos más viejos: se muestran para reclamarlos, NO se restan. Medido: 29 de
 *    77 abiertos tenían más de 7 días.
 *  · `negado`    — en los EMBARCADOS del periodo, `pedido − embarcado` (`c51 − c54`, en la
 *    presentación `c55`) llevado a unidad base con el factor del renglón (`c9 / c56`). ⚠️ Que
 *    `c51` sea siempre lo pedido originalmente es la hipótesis de FASE_DN, todavía sin arbitrar.
 *
 * ⚠️ Un pedido abierto sin renglones no suma nada: medido en La Piedad, los 2 abiertos de la 01
 * estaban vacíos (en la práctica, cancelados). Kepler no decodifica «cancelado» en `c11`.
 */
const PEDIDOS_SUCURSAL_SQL = `
WITH dest AS (
  SELECT dest_code FROM analytics.v_erp_branch_catalog WHERE tenant_id = :t AND suc_code = :suc
),
h AS MATERIALIZED (
  SELECT DISTINCT ON (k.sucursal, k.c5, k.c6)
         k.sucursal, k.c2, k.c3, k.c4, k.c5, k.c6, upper(btrim(k.c11::text)) AS est, k.c9::date AS f
    FROM kepler_ods.kdm1 k
   WHERE k.c2 = 'U' AND k.c3 = 'D' AND (k.c4)::int = 40
     AND btrim(k.c1) = btrim(k.sucursal)
     AND k.c9 >= current_date - 60
     AND upper(btrim(k.c27::text)) = 'SUCURSAL'
     AND btrim(k.c10::text) IN (SELECT dest_code FROM dest)
   ORDER BY k.sucursal, k.c5, k.c6, k.c9 DESC
),
l AS (
  SELECT h.est, h.f, btrim(x.c8::text) AS sku,
         NULLIF(btrim(x.c9::text), '')::numeric  AS base_qty,
         NULLIF(btrim(x.c51::text), '')::numeric AS ped,
         NULLIF(btrim(x.c54::text), '')::numeric AS emb,
         NULLIF(btrim(x.c56::text), '')::numeric AS fin
    FROM h
    JOIN kepler_ods.kdm2 x
      ON x.sucursal = h.sucursal AND x.c2 = h.c2 AND x.c3 = h.c3 AND x.c4 = h.c4 AND x.c5 = h.c5 AND x.c6 = h.c6
     AND btrim(x.c1) = btrim(x.sucursal)
)
SELECT sku,
       COALESCE(sum(base_qty) FILTER (WHERE est IN ('AUTORIZADO','SURTIDO','CHECADO') AND f >= current_date - ${VENTANA_YA_PEDIDO_DIAS}), 0) AS ya_pedido,
       COALESCE(sum(base_qty) FILTER (WHERE est IN ('AUTORIZADO','SURTIDO','CHECADO') AND f <  current_date - ${VENTANA_YA_PEDIDO_DIAS}), 0) AS atorado,
       COALESCE(sum(GREATEST(ped - emb, 0) * base_qty / NULLIF(fin, 0))
                FILTER (WHERE est = 'EMBARCADO' AND f >= current_date - ${VENTANA_NEGADO_DIAS}), 0) AS negado
  FROM l
 GROUP BY sku`;

/** ¿Hay cliente de traspaso para esta sucursal? Sin él, lo pedido NO se mide (≠ «cero»). */
const TIENE_DESTINO_SQL = `SELECT 1 FROM analytics.v_erp_branch_catalog WHERE tenant_id = :t AND suc_code = :suc LIMIT 1`;


interface FilaPedidos { sku: string; ya_pedido: string | number; atorado: string | number; negado: string | number }
interface FilaEscalera {
  sku: string; unit_base: string | null; u2_label: string | null; u3_label: string | null;
  f2: string | number | null; f3: string | number | null; is_weight: boolean | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numONull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * `[AB.16]` Fase AB — **«Mi pedido»** de una sucursal.
 *
 * NO calcula el reabasto: toma los renglones de la mesa (`criticalStock` con la base 'demanda',
 * los mismos que valida AB.15 contra /compras/pedido) y les agrega lo que la mesa no sabe —lo ya
 * pedido a la matriz, lo atorado, lo negado— y la cantidad a capturar en Kepler, redondeada con
 * la regla de §15.2 (`redondearPedido`, en `libs/contracts`).
 *
 * Sólo LEE. La Suite no escribe en Kepler: el almacenista captura el pedido allá con lo que ve acá.
 */
@Injectable()
export class AutoabastoPedidoService {
  constructor(
    private readonly motor: CommercialReplenishmentService,
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async pedido(almacen: { id: string; code: string; name: string }, area: string, puedeAjustar = false): Promise<AutoabastoPedidoResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const mesa = await this.motor.criticalStock(
      { warehouse_id: almacen.id, target_basis: 'demanda', export: true }, area,
    );
    const filas = mesa.rows;
    const skus = [...new Set(filas.map((f) => String(f['sku'])))];

    const { pedidos, escaleras, medidos, borrador, ajustes, guardable, posiciones } = await this.tk.run(async (trx: Knex.Transaction) => {
      // `[AB.18]` El borrador guardado y lo que la persona ya ajustó. Sólo LEE: abrir el pedido no
      // escribe nada (el borrador nace con el primer ajuste). Si la migración del borrador todavía
      // no llegó a esta base, el pedido se sirve igual y lo declara (`guardado_disponible`); se pregunta con
      // `to_regclass` porque un SELECT fallido abortaría la transacción entera.
      const guardable = await this.borradorDisponible(trx);
      const borrador = guardable ? await this.borradorDe(trx, tenantId, almacen.id) : null;
      // `[AB.19]` Hasta dónde pide: lo guardado en el borrador; sin borrador, el default.
      let posiciones: PosicionPedido[] = [...POSICIONES_PEDIDO_DEFAULT];
      if (borrador) {
        const b = await trx('commercial.autoabasto_pedidos').where({ tenant_id: tenantId, id: borrador }).first('posiciones');
        posiciones = normalizarPosiciones(b?.posiciones);
      }
      const ajustes = new Map<string, AjusteLinea & { cantidad_base: number }>();
      if (borrador) {
        const ls: FilaLinea[] = await trx('commercial.autoabasto_pedido_lineas')
          .where({ tenant_id: tenantId, pedido_id: borrador })
          .select('product_id', 'cantidad', 'unidad', 'cantidad_base', 'motivo', 'ajustado_por_username', 'ajustado_at');
        for (const l of ls) {
          ajustes.set(l.product_id, {
            cantidad: num(l.cantidad), unidad: l.unidad, motivo: (l.motivo as MotivoAjuste | null) ?? null,
            ajustado_por: l.ajustado_por_username, ajustado_at: new Date(l.ajustado_at).toISOString(),
            cantidad_base: num(l.cantidad_base),
          });
        }
      }
      const binds = { t: tenantId, suc: almacen.code };
      const destino = await trx.raw(TIENE_DESTINO_SQL, binds);
      const medidos = (destino.rows ?? []).length > 0;
      const pedidos = new Map<string, FilaPedidos>();
      if (medidos) {
        const r = await trx.raw(PEDIDOS_SUCURSAL_SQL, binds);
        for (const p of (r.rows ?? []) as FilaPedidos[]) pedidos.set(p.sku, p);
      }
      const escaleras = new Map<string, EscaleraUnidades>();
      if (skus.length) {
        // Escalera de unidades de Kepler (vista sobre kdii), sólo de los productos de la mesa.
        const e: FilaEscalera[] = await trx('analytics.v_product_unit_ladder')
          .select('sku', 'unit_base', 'u2_label', 'u3_label', 'f2', 'f3', 'is_weight')
          .whereIn('sku', skus);
        for (const x of e) {
          escaleras.set(x.sku, {
            unit_base: x.unit_base, u2_label: x.u2_label, u3_label: x.u3_label,
            f2: numONull(x.f2), f3: numONull(x.f3), is_weight: !!x.is_weight,
          });
        }
      }
      return { pedidos, escaleras, medidos, borrador, ajustes, guardable, posiciones };
    });

    const grupos = new Map<string, AutoabastoPedidoGrupo>();
    for (const f of filas) {
      const sku = String(f['sku']);
      // El factor del almacén: las cantidades "_nat" vienen en unidad base, las de la mesa en cajas.
      const cf = Math.max(1, num(f['caja_factor']));
      const p = pedidos.get(sku);
      const yaBase = num(p?.ya_pedido);
      const faltaBase = num(f['suggested_qty_nat']);
      const netaBase = Math.max(0, faltaBase - yaBase);
      const costo = numONull(f['unit_cost']);
      // Se valúa sólo si el motor no retuvo el $ del renglón (peldaño contradicho, U.2).
      const valuable = f['rung_veredicto'] == null && costo != null;
      // `[AB.20]` Lo que va en unidad menor y vale menos de $200 no se pide. Sin costo confiable el
      // mínimo no se puede revisar: el renglón se queda y se declara (`sin_costo`), no se supone.
      // Un agotado se pide aunque no llegue al mínimo: el mínimo sólo frena bajo mínimo / bajo reorden.
      const minimo = aplicarMinimoMenor(redondearPedido(netaBase, escaleras.get(sku) ?? null), valuable ? costo : null, String(f['bucket'] ?? ''));
      const aPedir = minimo.redondeo;
      // `[AB.18]` Lo que de verdad lleva el pedido: el ajuste de la persona si existe; si no, el sugerido.
      const productId = String(f['product_id']);
      const guardado = ajustes.get(productId) ?? null;
      const efectivoBase = guardado ? guardado.cantidad_base : aPedir.cantidad_base;
      const efectivoCant = guardado ? guardado.cantidad : aPedir.cantidad;
      const ajuste: AjusteLinea | null = guardado
        ? { cantidad: guardado.cantidad, unidad: guardado.unidad, motivo: guardado.motivo, ajustado_por: guardado.ajustado_por, ajustado_at: guardado.ajustado_at }
        : null;

      const linea: AutoabastoPedidoLinea = {
        product_id: productId,
        sku,
        nombre: String(f['nombre'] ?? ''),
        venta_30d: numONull(f['venta_30d']),
        existencia: num(f['on_hand']),
        objetivo: numONull(f['target_qty']),
        falta: num(f['suggested_qty']),
        ya_pedido: r1(yaBase / cf),
        atorado: r1(num(p?.atorado) / cf),
        negado_30d: r1(num(p?.negado) / cf),
        falta_neta: r1(netaBase / cf),
        a_pedir: aPedir,
        ajuste,
        valor: valuable && efectivoBase > 0 ? r2(efectivoBase * (costo as number)) : null,
        costo_base: valuable ? (costo as number) : null,
        posicion: String(f['bucket'] ?? ''),
        minimo_menor: minimo.estado,
        valor_menor: minimo.valor_menor,
      };

      const via = f['replenish_via'];
      const origen = f['source_warehouse_code'];
      const tipo: AutoabastoPedidoGrupo['tipo'] =
        via === 'transfer' && origen ? 'matriz' : f['supplier_id'] ? 'proveedor' : 'sin_ruta';
      const clave = tipo === 'matriz' ? String(origen) : tipo === 'proveedor' ? String(f['supplier_id']) : null;
      const llave = `${tipo}:${clave ?? ''}`;
      let g = grupos.get(llave);
      if (!g) {
        g = {
          tipo,
          clave,
          nombre: tipo === 'matriz' ? String(origen) : tipo === 'proveedor' ? String(f['supplier_name'] ?? 'Proveedor') : 'Sin ruta configurada',
          lineas: [],
          renglones_a_pedir: 0,
          total_cajas: 0,
          renglones_sin_caja: 0,
          total_valor: null,
          sin_valuar: 0,
          minimo_cajas: tipo === 'proveedor' ? numONull(f['supplier_min_boxes']) : null,
          minimo_valor: tipo === 'proveedor' ? numONull(f['supplier_min_amount']) : null,
        };
        grupos.set(llave, g);
      }
      g.lineas.push(linea);
      if (efectivoCant > 0) {
        g.renglones_a_pedir++;
        // Cajas sólo de lo que tiene caja: lo pedido en cajas, o en la menor con un factor de caja
        // real en el almacén. Lo demás (piezas sin caja, kilos) se cuenta aparte, no se suma.
        if (aPedir.regla === 'cajas' || (aPedir.regla === 'nada' && cf > 1 && aPedir.factor === cf)) g.total_cajas += efectivoBase / cf;
        else if (aPedir.regla === 'menor' && cf > 1) g.total_cajas += efectivoBase / cf;
        else g.renglones_sin_caja++;
        if (linea.valor != null) g.total_valor = (g.total_valor ?? 0) + linea.valor;
        else g.sin_valuar++;
      }
    }

    const orden: Record<AutoabastoPedidoGrupo['tipo'], number> = { matriz: 0, proveedor: 1, sin_ruta: 2 };
    const lista = [...grupos.values()]
      .map((g) => ({
        ...g,
        total_cajas: r1(g.total_cajas),
        total_valor: g.total_valor == null ? null : r2(g.total_valor),
        // Primero lo que hay que pedir, por valor; lo cubierto por lo ya pedido queda abajo.
        lineas: g.lineas.sort((a, b) =>
          (b.a_pedir.cantidad > 0 ? 1 : 0) - (a.a_pedir.cantidad > 0 ? 1 : 0)
          || (b.valor ?? 0) - (a.valor ?? 0)
          || a.sku.localeCompare(b.sku)),
      }))
      .sort((a, b) => orden[a.tipo] - orden[b.tipo] || (b.total_valor ?? 0) - (a.total_valor ?? 0));

    const ahora = new Date();
    return {
      almacen,
      fecha_mx: toMxDateKey(ahora),
      hora_mx: new Intl.DateTimeFormat('es-MX', { timeZone: MX_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(ahora),
      cobertura_dias: COBERTURA_DIAS,
      ventana_ya_pedido_dias: VENTANA_YA_PEDIDO_DIAS,
      ventana_negado_dias: VENTANA_NEGADO_DIAS,
      grupos: lista,
      pedidos_medidos: medidos,
      pedido_id: borrador,
      puede_ajustar: puedeAjustar,
      guardado_disponible: guardable,
      posiciones,
    };
  }

  /**
   * `[AB.19]` Hasta dónde pide el almacenista (agotado, bajo mínimo, bajo reorden, otros). Se
   * guarda en el borrador y deja huella con lo que había antes: elegir sólo lo agotado es una
   * decisión que el aprendizaje tiene que ver, no un filtro de pantalla.
   */
  async guardarPosiciones(warehouseId: string, req: AutoabastoPosicionesRequest): Promise<{ posiciones: PosicionPedido[] }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const posiciones = normalizarPosiciones(req.posiciones);
    return this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorOCrea(trx, tenantId, warehouseId);
      const previo = await trx('commercial.autoabasto_pedidos').where({ tenant_id: tenantId, id: pedidoId }).first('posiciones');
      await trx('commercial.autoabasto_pedidos')
        .where({ tenant_id: tenantId, id: pedidoId })
        .update({ posiciones: trx.raw('?::text[]', [posiciones]), updated_at: trx.fn.now() });
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, evento: 'posiciones',
        datos: JSON.stringify({ antes: normalizarPosiciones(previo?.posiciones), despues: posiciones }),
      });
      return { posiciones };
    });
  }

  // ── [AB.18] Ajustes del almacenista y su huella ─────────────────────────────────────────────

  /** ¿Existe ya la tabla del borrador en esta base? (`[AB.18]` se migra antes que el código.) */
  private async borradorDisponible(trx: Knex.Transaction): Promise<boolean> {
    const r = await trx.raw(`SELECT to_regclass('commercial.autoabasto_pedidos') IS NOT NULL AS ok`);
    return Boolean(r.rows?.[0]?.ok);
  }

  /** Antes de escribir: sin las tablas, un mensaje que se entiende en vez de un 500. */
  private async exigeBorrador(trx: Knex.Transaction): Promise<void> {
    if (!(await this.borradorDisponible(trx))) {
      throw new ServiceUnavailableException('Esta base todavía no tiene el borrador del pedido: falta aplicar su migración.');
    }
  }

  /** El borrador vivo del almacén, o `null`. Un solo borrador por almacén (índice único parcial). */
  private async borradorDe(trx: Knex.Transaction, tenantId: string, warehouseId: string): Promise<string | null> {
    const r = await trx('commercial.autoabasto_pedidos')
      .where({ tenant_id: tenantId, warehouse_id: warehouseId, estado: 'borrador' })
      .first('id');
    return r ? String(r.id) : null;
  }

  /** El borrador vivo, creándolo si no existe. Dos clics simultáneos no crean dos: ON CONFLICT. */
  private async borradorOCrea(trx: Knex.Transaction, tenantId: string, warehouseId: string): Promise<string> {
    const actual = await this.borradorDe(trx, tenantId, warehouseId);
    if (actual) return actual;
    const ctx = this.tenantCtx.get();
    await trx.raw(
      `INSERT INTO commercial.autoabasto_pedidos (tenant_id, warehouse_id, motor, abierto_por, abierto_por_username)
       VALUES (?, ?, ?::jsonb, ?, ?)
       ON CONFLICT (tenant_id, warehouse_id) WHERE estado = 'borrador' DO NOTHING`,
      [tenantId, warehouseId, JSON.stringify({ base: 'demanda', cobertura_dias: COBERTURA_DIAS,
        ventana_ya_pedido_dias: VENTANA_YA_PEDIDO_DIAS, ventana_negado_dias: VENTANA_NEGADO_DIAS }),
      ctx?.userId ?? null, ctx?.username ?? null]);
    const creado = await this.borradorDe(trx, tenantId, warehouseId);
    if (!creado) throw new Error('No se pudo abrir el borrador del pedido.');
    return creado;
  }

  private async huella(trx: Knex.Transaction, fila: Record<string, unknown>): Promise<void> {
    const ctx = this.tenantCtx.get();
    await trx('commercial.autoabasto_huella').insert({
      ...fila,
      user_id: ctx?.userId ?? null,
      username: ctx?.username ?? null,
    });
  }

  /**
   * Guarda lo que la persona dejó en un renglón. La foto (sugerido, unidad, factor, contexto) viene
   * de la pantalla: es lo que la persona VIO, que es justo lo que la huella necesita, y evita
   * recalcular el pedido entero en cada clic. Se validan los números y el motivo (±20%).
   */
  async ajustar(warehouseId: string, req: AutoabastoAjusteRequest): Promise<AutoabastoAjusteResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const cantidad = Number(req.cantidad), sugerido = Number(req.sugerido), factor = Number(req.factor);
    if (!Number.isFinite(cantidad) || cantidad < 0 || !Number.isInteger(cantidad)) {
      throw new BadRequestException('La cantidad tiene que ser un entero de 0 en adelante.');
    }
    if (!Number.isFinite(sugerido) || sugerido < 0) throw new BadRequestException('Falta el sugerido que se vio.');
    if (!Number.isFinite(factor) || factor <= 0) throw new BadRequestException('El renglón no trae factor de unidad: no se puede ajustar.');
    if (!['matriz', 'proveedor', 'sin_ruta'].includes(req.origen_tipo)) throw new BadRequestException('Origen inválido.');
    const motivo = req.motivo ?? null;
    if (motivo != null && !(MOTIVOS_AJUSTE as readonly string[]).includes(motivo)) throw new BadRequestException('Motivo fuera de la lista.');
    if (necesitaMotivo(sugerido, cantidad) && !motivo) {
      throw new BadRequestException('El ajuste se aleja más de 20% de lo sugerido: elige un motivo.');
    }
    const ms = req.ms_en_renglon == null ? null : Math.max(0, Math.round(Number(req.ms_en_renglon) || 0));
    const ctx = this.tenantCtx.get();

    return this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorOCrea(trx, tenantId, warehouseId);
      const previo = await trx('commercial.autoabasto_pedido_lineas')
        .where({ tenant_id: tenantId, pedido_id: pedidoId, product_id: req.product_id }).first('cantidad');
      const antes = previo ? num(previo.cantidad) : sugerido;
      const ahora = new Date();
      await trx.raw(
        `INSERT INTO commercial.autoabasto_pedido_lineas
           (tenant_id, pedido_id, product_id, sku, origen_tipo, origen_clave, sugerido, sugerido_unidad, sugerido_base,
            cantidad, unidad, cantidad_base, motivo, contexto, ajustado_por, ajustado_por_username, ajustado_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?,?)
         ON CONFLICT (tenant_id, pedido_id, product_id) DO UPDATE SET
           sugerido = EXCLUDED.sugerido, sugerido_unidad = EXCLUDED.sugerido_unidad, sugerido_base = EXCLUDED.sugerido_base,
           cantidad = EXCLUDED.cantidad, unidad = EXCLUDED.unidad, cantidad_base = EXCLUDED.cantidad_base,
           motivo = EXCLUDED.motivo, contexto = EXCLUDED.contexto, ajustado_por = EXCLUDED.ajustado_por,
           ajustado_por_username = EXCLUDED.ajustado_por_username, ajustado_at = EXCLUDED.ajustado_at, updated_at = now()`,
        [tenantId, pedidoId, req.product_id, req.sku ?? null, req.origen_tipo, req.origen_clave ?? null,
          sugerido, req.unidad ?? null, sugerido * factor, cantidad, req.unidad ?? null, cantidad * factor,
          motivo, JSON.stringify(req.contexto ?? {}), ctx?.userId ?? null, ctx?.username ?? null, ahora]);
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, product_id: req.product_id,
        evento: 'ajustar', sugerido, antes, despues: cantidad, unidad: req.unidad ?? null, motivo, ms_en_renglon: ms,
        datos: JSON.stringify({ origen_tipo: req.origen_tipo, origen_clave: req.origen_clave ?? null, factor }),
      });
      return {
        pedido_id: pedidoId,
        product_id: req.product_id,
        ajuste: { cantidad, unidad: req.unidad ?? null, motivo, ajustado_por: ctx?.username ?? null, ajustado_at: ahora.toISOString() },
      };
    });
  }

  /** Vuelve el renglón al sugerido: borra el ajuste y deja la huella. */
  async restablecer(warehouseId: string, req: AutoabastoRestablecerRequest): Promise<AutoabastoAjusteResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorDe(trx, tenantId, warehouseId);
      if (!pedidoId) throw new BadRequestException('No hay ajustes que restablecer.');
      const previo = await trx('commercial.autoabasto_pedido_lineas')
        .where({ tenant_id: tenantId, pedido_id: pedidoId, product_id: req.product_id })
        .first('cantidad', 'sugerido', 'unidad');
      if (previo) {
        await trx('commercial.autoabasto_pedido_lineas')
          .where({ tenant_id: tenantId, pedido_id: pedidoId, product_id: req.product_id }).delete();
        await this.huella(trx, {
          tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, product_id: req.product_id,
          evento: 'restablecer', sugerido: previo.sugerido, antes: previo.cantidad, despues: previo.sugerido,
          unidad: previo.unidad, ms_en_renglon: req.ms_en_renglon == null ? null : Math.max(0, Math.round(Number(req.ms_en_renglon) || 0)),
        });
      }
      return { pedido_id: pedidoId, product_id: req.product_id, ajuste: null };
    });
  }

  /** La persona revisó un grupo y lo acepta como está. Sólo huella: no cambia cantidades. */
  async aceptarGrupo(warehouseId: string, req: AutoabastoAceptarGrupoRequest): Promise<{ ok: true }> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!['matriz', 'proveedor', 'sin_ruta'].includes(req.origen_tipo)) throw new BadRequestException('Origen inválido.');
    await this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorOCrea(trx, tenantId, warehouseId);
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, evento: 'aceptar_grupo',
        datos: JSON.stringify({ origen_tipo: req.origen_tipo, origen_clave: req.origen_clave ?? null, renglones: Math.max(0, Number(req.renglones) || 0) }),
      });
    });
    return { ok: true };
  }

  /** La persona abrió su pedido. Huella de cuándo y cuánto tenía enfrente; no crea borrador. */
  async abrir(warehouseId: string, req: AutoabastoAbrirRequest): Promise<{ ok: true }> {
    const tenantId = this.tenantCtx.requireTenantId();
    await this.tk.run(async (trx: Knex.Transaction) => {
      await this.exigeBorrador(trx);
      const pedidoId = await this.borradorDe(trx, tenantId, warehouseId);
      await this.huella(trx, {
        tenant_id: tenantId, warehouse_id: warehouseId, pedido_id: pedidoId, evento: 'abrir',
        datos: JSON.stringify({ renglones: Math.max(0, Number(req.renglones) || 0) }),
      });
    });
    return { ok: true };
  }
}

interface FilaLinea {
  product_id: string; cantidad: string | number; unidad: string | null; cantidad_base: string | number;
  motivo: string | null; ajustado_por_username: string | null; ajustado_at: string | Date;
}
