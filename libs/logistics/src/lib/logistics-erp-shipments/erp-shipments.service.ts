import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * EMB — Los embarques REALES del ERP Kepler para la pantalla de Embarques.
 *
 * Lee las vistas derive-no-copy de la Fase EMB (`analytics.erp_shipment_*`), que cuelgan del
 * ODS y traen la frescura del CDC. No escribe nada: el ERP es el dueño del embarque.
 *
 * ── ⛔ "ENTREGA PENDIENTE" NO EXISTE EN KEPLER, y la pantalla no puede fingir que sí ──────
 * Medido en prod: `estatus` vale `EMBARCADO` en **1,782 de 1,782** embarques de los últimos 30
 * días. El ERP registra que la mercancía SALIÓ; no registra que llegó. Tampoco hay hora de
 * salida ni de llegada (la fecha tiene grano de día) ni acuse de recibo.
 *
 * Así que este servicio NO inventa un semáforo entregado/pendiente. Publica lo único que sí
 * es verdad y es útil:
 *   · `en_calle`  = el viaje salió HOY. Eso se sabe, y es lo que justifica el mapa en vivo.
 *   · `entrega_confirmada` = **null siempre, con motivo** (`confirmacion_fuente: 'no_existe'`).
 *     Un booleano en false diría "no entregado", que es una afirmación que nadie midió.
 * El día que la app capture el acuse (POD), ese campo tiene dónde llenarse sin romper nada.
 */

const M = process.env.MEGADULCES_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

export interface TripRow {
  sucursal: string;
  guia_embarque: string;
  guia_digital: string;
  fecha: string;
  paradas: number;
  destinos: number;
  transporte_code: string | null;
  transporte_descripcion: string | null;
  transporte_placas: string | null;
  chofer_nombre: string | null;
  total: string;
  vehicle_id: string | null;
  vehicle_plate: string | null;
  en_calle: boolean;
  /** Estado del rastreador, o null si esa unidad no tiene GPS. Son cosas distintas. */
  gps_status: string | null;
  gps_seen_at: string | null;
  gps_speed: number | null;
}

@Injectable()
export class ErpShipmentsService {
  private readonly logger = new Logger(ErpShipmentsService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /** Los viajes (guía de embarque), que es el grano que corresponde a un camión saliendo. */
  async listTrips(q: {
    from?: string; to?: string; sucursal?: string; serie?: string;
    search?: string; solo_hoy?: string; page?: string; limit?: string;
  }) {
    const page = Math.max(1, parseInt(q.page || '1', 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(q.limit || '50', 10) || 50));
    const hoy = q.solo_hoy === 'true' || q.solo_hoy === '1';

    return this.tk.run(M, async (trx) => {
      const base = () => {
        const b = trx('analytics.erp_shipment_trips as t').where('t.tenant_id', M);
        if (hoy) b.whereRaw('t.fecha = (now() AT TIME ZONE ?)::date', ['America/Mexico_City']);
        else {
          if (q.from) b.where('t.fecha', '>=', q.from);
          if (q.to) b.where('t.fecha', '<=', q.to);
          if (!q.from && !q.to) b.whereRaw("t.fecha >= current_date - 30");
        }
        if (q.sucursal) b.where('t.sucursal', q.sucursal);
        if (q.search) {
          const s = `%${q.search.trim().toLowerCase()}%`;
          b.where((w: any) =>
            w.whereRaw('lower(t.guia_digital) like ?', [s])
              .orWhereRaw('lower(coalesce(t.transporte_placas,\'\')) like ?', [s])
              .orWhereRaw('lower(coalesce(t.vehicle_plate,\'\')) like ?', [s])
              .orWhereRaw('lower(coalesce(t.chofer_nombre,\'\')) like ?', [s])
              .orWhereRaw('lower(coalesce(t.transporte_descripcion,\'\')) like ?', [s]));
        }
        return b;
      };

      const [{ count }] = await base().clone().count({ count: '*' });
      const rows = await base()
        .select(
          't.sucursal', 't.guia_embarque', 't.guia_digital', 't.fecha', 't.paradas', 't.destinos',
          't.transporte_code', 't.transporte_descripcion', 't.transporte_placas',
          't.chofer_nombre', 't.total', 't.vehicle_id', 't.vehicle_plate',
          't.multi_transporte', 't.multi_chofer',
          trx.raw("(t.fecha = (now() AT TIME ZONE 'America/Mexico_City')::date) as en_calle"),
          // El GPS se trae por LATERAL para no multiplicar filas cuando la unidad lleva
          // dos rastreadores (hay 4 unidades así).
          trx.raw(`(SELECT g.last_status FROM logistics.trackers g
                     WHERE g.vehicle_id = t.vehicle_id AND g.deleted_at IS NULL
                     ORDER BY g.last_seen_at DESC NULLS LAST LIMIT 1) as gps_status`),
          trx.raw(`(SELECT g.last_seen_at FROM logistics.trackers g
                     WHERE g.vehicle_id = t.vehicle_id AND g.deleted_at IS NULL
                     ORDER BY g.last_seen_at DESC NULLS LAST LIMIT 1) as gps_seen_at`),
          trx.raw(`(SELECT g.last_speed_kmh FROM logistics.trackers g
                     WHERE g.vehicle_id = t.vehicle_id AND g.deleted_at IS NULL
                     ORDER BY g.last_seen_at DESC NULLS LAST LIMIT 1) as gps_speed`),
        )
        .orderBy([{ column: 't.fecha', order: 'desc' }, { column: 't.paradas', order: 'desc' }])
        .limit(limit).offset((page - 1) * limit);

      return {
        rows,
        page, limit, total: Number(count),
        // Procedencia: el consumidor tiene que poder decir de dónde salió esto y con qué NO cuenta.
        procedencia: {
          fuente: 'kepler_ods.kdm1 U-D-41 (vista en vivo)',
          confirmacion_entrega: null,
          confirmacion_fuente: 'no_existe',
          nota: 'Kepler registra que la mercancía SALIÓ (estatus EMBARCADO en el 100% de los documentos). No registra llegada, hora ni acuse.',
        },
      };
    });
  }

  /** KPIs del día para la cabecera de la pantalla. */
  async todayKpis() {
    return this.tk.run(M, async (trx) => {
      const [k] = await trx.raw(
        `SELECT
           count(*)::int                                   AS viajes,
           coalesce(sum(paradas),0)::int                   AS paradas,
           count(DISTINCT transporte_code)::int            AS unidades,
           count(DISTINCT vehicle_id) FILTER (WHERE vehicle_id IS NOT NULL)::int AS unidades_en_flota,
           coalesce(round(sum(total)),0)::numeric          AS valor,
           max(computed_at)                                AS data_as_of
         FROM analytics.erp_shipment_trips
         WHERE tenant_id = ?::uuid AND fecha = (now() AT TIME ZONE 'America/Mexico_City')::date`,
        [M]).then((r: any) => r.rows);
      const [g] = await trx.raw(
        `SELECT count(DISTINCT t.vehicle_id)::int AS con_gps
           FROM analytics.erp_shipment_trips t
           JOIN logistics.trackers g ON g.vehicle_id = t.vehicle_id AND g.deleted_at IS NULL
          WHERE t.tenant_id = ?::uuid AND t.fecha = (now() AT TIME ZONE 'America/Mexico_City')::date`,
        [M]).then((r: any) => r.rows);
      return { ...k, unidades_con_gps: g?.con_gps ?? 0 };
    });
  }

  /** Un viaje: sus paradas, su unidad, dónde está ahora y por dónde anduvo hoy. */
  async tripDetail(sucursal: string, guia: string) {
    return this.tk.run(M, async (trx) => {
      const trip = await trx('analytics.erp_shipment_trips')
        .where({ tenant_id: M, sucursal, guia_embarque: guia }).first();
      if (!trip) throw new NotFoundException(`No existe el viaje ${sucursal}-G${guia}`);

      const paradas = await trx('analytics.erp_shipment_headers')
        .where({ tenant_id: M, sucursal, guia_embarque: guia })
        .select('serie', 'serie_label', 'folio', 'folio_digital', 'fecha', 'cliente_code',
          'destino_nombre', 'destino_colonia', 'destino_ciudad', 'destino_estado',
          'estatus', 'vendedor_nombre', 'pedido_folio', 'pedido_folio_digital',
          'comentarios', 'total', 'chofer_nombre', 'chofer_metodo',
          'resp_surtido', 'resp_checado', 'resp_embarque')
        .orderBy([{ column: 'serie' }, { column: 'folio' }]);

      // Rastreo: la posición de AHORA y el recorrido del día del viaje.
      let gps: any = null;
      let recorrido: Array<{ lat: number; lng: number; at: string }> = [];
      if (trip.vehicle_id) {
        gps = await trx('logistics.trackers')
          .where({ vehicle_id: trip.vehicle_id }).whereNull('deleted_at')
          .select('external_name', 'last_lat', 'last_lng', 'last_speed_kmh', 'last_status',
            'last_status_text', 'last_seen_at', 'route_code')
          .orderBy('last_seen_at', 'desc').first() ?? null;
        // ⚠️ `vehicle_positions` NO tiene RLS (es el patrón de route_location_pings), así que
        // el filtro de tenant va explícito — no lo pone la política.
        const { rows } = await trx.raw(
          `SELECT lat, lng, captured_at AS at
             FROM logistics.vehicle_positions
            WHERE tenant_id = ?::uuid AND vehicle_id = ?
              AND (captured_at AT TIME ZONE 'America/Mexico_City')::date = ?::date
            ORDER BY captured_at`, [M, trip.vehicle_id, trip.fecha]);
        recorrido = rows;
      }

      return {
        trip,
        paradas,
        gps,
        recorrido,
        // ⛔ Lo que la pantalla NO puede afirmar, dicho acá y no en un comentario del HTML.
        entrega_confirmada: null,
        confirmacion_fuente: 'no_existe',
        rastreo_disponible: !!trip.vehicle_id && !!gps,
        rastreo_motivo: !trip.vehicle_id
          ? 'la unidad de Kepler no tiene fila en la flota de la Suite'
          : (!gps ? 'la unidad no tiene rastreador dado de alta' : null),
      };
    });
  }

  /**
   * Qué lleva una parada: los renglones del embarque, en la unidad del ERP y en cajas.
   *
   * ⚠️ Son DOS consultas a propósito (EMB.7.1). Unir el resolvedor de unidad dentro de la
   * vista hacía que pedir un solo documento costara 1,189 ms, porque `v_warehouse_box_factor`
   * no se filtra: se materializa entero en cada llamada. Separado, los renglones salen baratos
   * y el resolvedor se paga una vez, sólo cuando alguien expande la parada.
   */
  async lines(sucursal: string, serie: string, folio: string) {
    return this.tk.run(M, async (trx) => {
      const rows = await trx('analytics.erp_shipment_lines')
        .where({ tenant_id: M, sucursal, serie: Number(serie), folio })
        .select('nro_linea', 'sku', 'descripcion', 'cantidad', 'unidad', 'precio_unitario', 'importe')
        .orderBy('nro_linea');

      // Factor de caja por SKU en ESE almacén — el resolvedor canónico de ADR-055, no
      // `catalog.products.factor_sale` (que discrepa con el ERP en el 73.6% de los casos).
      const skus = [...new Set(rows.map((r: any) => r.sku).filter(Boolean))];
      const factores = new Map<string, any>();
      if (skus.length) {
        const f = await trx('analytics.v_warehouse_box_factor')
          .where('tenant_id', M).andWhere('warehouse_code', sucursal).whereIn('sku', skus)
          .select('sku', 'box_factor', 'box_label', 'factor_source', 'is_master_suspect');
        for (const x of f) factores.set(x.sku, x);
      }

      const conUnidad = rows.map((r: any) => {
        const f = factores.get(r.sku);
        const bf = f && Number(f.box_factor) > 0 ? Number(f.box_factor) : null;
        return {
          ...r,
          // NULL = el resolvedor no cubre ese SKU en ese almacén. No es cero, y la pantalla lo dice.
          cajas: bf ? Math.round((Number(r.cantidad) / bf) * 100) / 100 : null,
          caja_label: f?.box_label ?? null,
          factor_caja: bf,
          unidad_fuente: f?.factor_source ?? null,
          unidad_sospechosa: f?.is_master_suspect ?? null,
        };
      });

      const suma = conUnidad.reduce((a: number, r: any) => a + Number(r.importe || 0), 0);
      return {
        rows: conUnidad,
        resumen: {
          renglones: conUnidad.length,
          // ⚠️ Se llama `suma_renglones`, NO "total": medido en 5 documentos, no reproduce el
          // total de la cabecera y la diferencia no se explica ni con el descuento ni con el
          // IEPS. Presentarla como el total del documento sería inventar una identidad.
          suma_renglones: Math.round(suma * 100) / 100,
          suma_es_total_del_documento: false,
          suma_nota: 'El total del documento lo manda la cabecera. La relación con la suma de renglones está sin decodificar (EMB.10).',
          sin_unidad_resuelta: conUnidad.filter((r: any) => r.cajas === null).length,
        },
      };
    });
  }

  /** Los viajes de hoy con posición, para pintar el mapa en vivo de una sola llamada. */
  async liveToday() {
    return this.tk.run(M, async (trx) => {
      const { rows } = await trx.raw(
        `SELECT t.sucursal, t.guia_embarque, t.guia_digital, t.paradas, t.total,
                t.transporte_descripcion, coalesce(t.vehicle_plate, t.transporte_placas) AS placa,
                t.chofer_nombre, t.vehicle_id,
                g.last_lat AS lat, g.last_lng AS lng, g.last_status AS status,
                g.last_speed_kmh AS speed, g.last_seen_at AS seen_at
           FROM analytics.erp_shipment_trips t
           LEFT JOIN LATERAL (
             SELECT * FROM logistics.trackers x
              WHERE x.vehicle_id = t.vehicle_id AND x.deleted_at IS NULL
              ORDER BY x.last_seen_at DESC NULLS LAST LIMIT 1) g ON true
          WHERE t.tenant_id = ?::uuid
            AND t.fecha = (now() AT TIME ZONE 'America/Mexico_City')::date
          ORDER BY t.paradas DESC`, [M]);
      const conGps = rows.filter((r: any) => r.lat != null && r.lng != null);
      return {
        rows,
        // Se declara la cobertura del mapa: pintar 3 de 8 camiones sin decirlo es peor que no pintarlos.
        cobertura: { viajes: rows.length, ubicables: conGps.length },
      };
    });
  }
}
