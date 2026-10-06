import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import {
  comisionSugerida,
  EntradaCatalogo,
  fechaISO,
  ordenarParadas,
  ParadaKepler,
  resolverPorCodigo,
  resumirViaje,
  tipoDeViaje,
} from './nuevo-embarque.logic';

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
    from?: string; to?: string; fecha?: string; sucursal?: string; serie?: string;
    search?: string; solo_hoy?: string; solo_sin_tomar?: string; page?: string; limit?: string;
  }) {
    const page = Math.max(1, parseInt(q.page || '1', 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(q.limit || '50', 10) || 50));
    const hoy = q.solo_hoy === 'true' || q.solo_hoy === '1';
    const sinTomar = q.solo_sin_tomar === 'true' || q.solo_sin_tomar === '1';
    const fecha = q.fecha && /^\d{4}-\d{2}-\d{2}$/.test(q.fecha) ? q.fecha : null;

    // EMB.12 — el embarque de la Suite que ya TOMÓ esta guía (si alguno). La guía cancelada se
    // puede volver a tomar, así que no cuenta.
    const tomadoSql = (col: 'id' | 'folio') => `(SELECT s.${col} FROM logistics.shipments s
        WHERE s.tenant_id = t.tenant_id AND s.kepler_sucursal = t.sucursal AND s.kepler_guia = t.guia_embarque
          AND s.deleted_at IS NULL AND s.status <> 'cancelado' LIMIT 1)`;

    return this.tk.run(M, async (trx) => {
      const base = () => {
        const b = trx('analytics.erp_shipment_trips as t').where('t.tenant_id', M);
        if (hoy) b.whereRaw('t.fecha = (now() AT TIME ZONE ?)::date', ['America/Mexico_City']);
        else if (fecha) b.where('t.fecha', fecha);
        else {
          if (q.from) b.where('t.fecha', '>=', q.from);
          if (q.to) b.where('t.fecha', '<=', q.to);
          if (!q.from && !q.to) b.whereRaw("t.fecha >= current_date - 30");
        }
        if (q.sucursal) b.where('t.sucursal', q.sucursal);
        if (sinTomar) b.whereRaw(`${tomadoSql('id')} IS NULL`);
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
          't.chofer_code', 't.chofer_nombre', 't.total', 't.vehicle_id', 't.vehicle_plate',
          't.multi_transporte', 't.multi_chofer', 't.series',
          trx.raw(`${tomadoSql('id')} as tomado_shipment_id`),
          trx.raw(`${tomadoSql('folio')} as tomado_folio`),
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

      // EMB.12 — a dónde va cada viaje, en palabras. Sale de `erp_shipment_stops` filtrando por
      // sucursal (usa `ix_kdm1_venta_doc`), no de la cabecera completa recalculada otra vez.
      const porGuia = new Map<string, Array<{ serie: number; cliente_code: string | null; donde: string | null }>>();
      if (rows.length) {
        const sucs = [...new Set(rows.map((r: any) => r.sucursal))];
        const guias = [...new Set(rows.map((r: any) => r.guia_embarque))];
        // ⚠️ whereIn y no `= ANY(?)` en un raw: knex expande un arreglo en `?` a varios placeholders.
        const d = await trx('analytics.erp_shipment_stops')
          .whereIn('sucursal', sucs).whereIn('guia_embarque', guias)
          .select('sucursal', 'guia_embarque', 'serie', 'cliente_code',
            trx.raw('coalesce(destino_ciudad, destino_nombre, cliente_code) AS donde'));
        for (const x of d) {
          const k = `${x.sucursal}|${x.guia_embarque}`;
          if (!porGuia.has(k)) porGuia.set(k, []);
          porGuia.get(k)!.push({ serie: Number(x.serie), cliente_code: x.cliente_code, donde: x.donde });
        }
      }
      for (const r of rows as any[]) {
        const paradas = porGuia.get(`${r.sucursal}|${r.guia_embarque}`) ?? [];
        r.destinos_texto = [...new Set(paradas.map((p) => p.donde).filter(Boolean))].join(' · ') || null;
        r.tipo_etiqueta = paradas.length ? tipoDeViaje(paradas).etiqueta : null;
        // Kepler precarga el chofer desde la unidad: la 00008 de Padre Hidalgo no tiene uno
        // asignado, así que sale vacío en el 99.8% de sus embarques. Se dice, no se inventa.
        r.chofer_falta = !r.chofer_code;
      }

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
   * EMB.12 — Todo lo que «Nuevo embarque» necesita de UN viaje de Kepler, en una llamada.
   *
   * Es de sólo lectura: arma la hoja con lo que Kepler ya capturó (unidad, chofer, paradas con su
   * ruta y orden, carga, valor, responsables de almacén) y lo que la Suite sabe de esos mismos
   * objetos (la unidad en la flota, el chofer en el padrón, la tarifa de la ruta). Lo que no
   * existe en ninguno de los dos lados se devuelve null CON MOTIVO, nunca en cero.
   *
   * Cuatro consultas, todas filtradas por sucursal + guía: la cabecera (resolvedores de unidad y
   * chofer), las paradas enriquecidas con su carga (LATERAL para que el filtro llegue a los
   * índices de kdm2), los catálogos de responsables de esa sucursal, y lo de la Suite.
   */
  async nuevoEmbarque(sucursal: string, guia: string) {
    return this.tk.run(M, async (trx) => {
      const trip = await trx('analytics.erp_shipment_trips')
        .where({ tenant_id: M, sucursal, guia_embarque: guia }).first();
      if (!trip) throw new NotFoundException(`Kepler no tiene el viaje ${sucursal}-G${guia}`);

      const headers = await trx('analytics.erp_shipment_headers')
        .where({ tenant_id: M, sucursal, guia_embarque: guia })
        .select('serie', 'serie_label', 'folio', 'folio_digital', 'fecha', 'cliente_code',
          'destino_nombre', 'destino_colonia', 'destino_ciudad', 'destino_estado', 'total',
          'pedido_folio', 'pedido_folio_digital', 'comentarios',
          'resp_surtido', 'resp_checado', 'resp_embarque',
          'transporte_code', 'transporte_clave_kepler', 'transporte_descripcion', 'transporte_placas',
          'transporte_metodo', 'chofer_code', 'chofer_clave_kepler', 'chofer_nombre', 'chofer_metodo',
          'chofer_asignado_a_la_unidad', 'vehicle_id', 'vehicle_plate');

      const { rows: extras } = await trx.raw(
        `SELECT s.serie, s.folio, s.domicilio, s.domicilio_supuesto, s.domicilio_calle,
                s.domicilio_ciudad, s.domicilio_telefono, s.ruta_clave, s.ruta_nombre,
                s.orden_visita, s.ruta_metodo, s.facturacion, s.facturado,
                s.hora_captura, s.usuario_captura, s.nota_almacen,
                l.renglones, l.cajas, l.sueltos, l.kg, l.renglones_kg, l.renglones_sin_empaque
           FROM analytics.erp_shipment_stops s
           LEFT JOIN LATERAL (
             SELECT * FROM analytics.erp_shipment_stop_load x
              WHERE x.sucursal = s.sucursal AND x.serie = s.serie AND x.folio = s.folio
           ) l ON true
          WHERE s.sucursal = ? AND s.guia_embarque = ?`, [sucursal, guia]);
      const extraDe = new Map<string, any>(extras.map((e: any) => [`${e.serie}|${e.folio}`, e]));

      const catalogos = await trx('analytics.v_kepler_responsables')
        .where({ sucursal }).select('rol', 'codigo', 'nombre');
      const cat = (rol: string): EntradaCatalogo[] =>
        catalogos.filter((c: any) => c.rol === rol).map((c: any) => ({ codigo: c.codigo, nombre: c.nombre }));
      const catSur = cat('surtido');
      const catChe = cat('checado');
      const catEmb = cat('embarque');

      const paradas = ordenarParadas(headers.map((h: any) => {
        const e = extraDe.get(`${h.serie}|${h.folio}`) ?? {};
        return {
          ...h,
          ...e,
          fecha: fechaISO(h.fecha),
          serie: Number(h.serie),
          total: Number(h.total ?? 0),
          cajas: e.cajas == null ? null : Number(e.cajas),
          sueltos: e.sueltos == null ? null : Number(e.sueltos),
          kg: e.kg == null ? null : Number(e.kg),
          orden_visita: e.orden_visita == null ? null : Number(e.orden_visita),
          surtio: resolverPorCodigo(h.resp_surtido, catSur),
          checo: resolverPorCodigo(h.resp_checado, catChe),
          embarco: resolverPorCodigo(h.resp_embarque, catEmb),
        } as ParadaKepler & Record<string, any>;
      }));

      const resumen = resumirViaje(paradas);
      const tipo = tipoDeViaje(paradas);

      // ── Lo que la Suite sabe de los mismos objetos ───────────────────────────────────
      const primero = (k: string) => headers.map((h: any) => h[k]).find((v: any) => v != null) ?? null;
      const choferClave = primero('chofer_clave_kepler');
      const vehicleId = trip.vehicle_id ?? null;

      // El nombre de la sucursal sale del catálogo de Kepler (`pv_suc_ip`: 06 → «Sucursal Canindo»).
      // ⚠️ Se pregunta antes si la tabla existe: una consulta que falla dentro de la transacción
      // la aborta entera, y el nombre no vale tumbar la hoja.
      const { rows: [hayPv] } = await trx.raw(`SELECT to_regclass('kepler_ods.pv_suc_ip') IS NOT NULL AS ok`);
      const sucNombre: string | null = hayPv?.ok
        ? await trx.raw(`SELECT btrim(c2) AS nombre FROM kepler_ods.pv_suc_ip WHERE btrim(c1) = ? LIMIT 1`, [sucursal])
          .then((r: any) => r.rows?.[0]?.nombre ?? null)
        : null;

      // ⚠️ En SECUENCIA, no con Promise.all: dentro de una transacción todas van por el MISMO
      // cliente de pg, y mandarle consultas simultáneas está deprecado (pg@9 lo quita). Medido:
      // con Promise.all el driver avisaba «client is already executing a query».
      const vehiculo = vehicleId
        ? await trx('logistics.vehicles').where({ id: vehicleId }).whereNull('deleted_at')
          .first('id', 'plate', 'brand', 'model', 'status', 'active')
        : null;
      const conGps = vehicleId
        ? await trx('logistics.trackers').where({ vehicle_id: vehicleId }).whereNull('deleted_at').first('id')
        : null;
      const chofer = choferClave
        ? await trx('logistics.drivers').where({ kepler_code: choferClave }).whereNull('deleted_at')
          .first('id', 'full_name', 'active')
        : null;
      const rutas = await trx('logistics.routes').whereNull('deleted_at').where('active', true)
        .select('id', 'name', 'kepler_code', 'driver_commission', 'helper_commission');
      const tomado = await trx('logistics.shipments')
        .where({ kepler_sucursal: sucursal, kepler_guia: guia })
        .whereNull('deleted_at').whereNot('status', 'cancelado')
        .first('id', 'folio', 'status');

      const nombresUnicos = (k: 'surtio' | 'checo' | 'embarco') =>
        [...new Set(paradas.map((p: any) => p[k]?.nombre).filter(Boolean))] as string[];
      const sinResolver = paradas.reduce((a: number, p: any) =>
        a + (['surtio', 'checo', 'embarco'] as const)
          .filter((k) => p[k]?.metodo && !['exacto', 'normalizado'].includes(p[k].metodo)).length, 0);
      const horas = paradas.map((p: any) => p.hora_captura).filter(Boolean).sort();

      return {
        viaje: {
          sucursal,
          sucursal_nombre: sucNombre,
          guia,
          guia_digital: trip.guia_digital,
          fecha: fechaISO(trip.fecha),
          hora_captura_desde: horas[0] ?? null,
          hora_captura_hasta: horas[horas.length - 1] ?? null,
          tipo,
          multi_transporte: trip.multi_transporte,
          multi_chofer: trip.multi_chofer,
          multi_fecha: trip.multi_fecha,
        },
        unidad: {
          kepler_code: primero('transporte_clave_kepler') ?? primero('transporte_code'),
          descripcion: trip.transporte_descripcion,
          placas: trip.transporte_placas,
          metodo: primero('transporte_metodo'),
          vehicle_id: vehiculo?.id ?? null,
          suite: vehiculo ? { plate: vehiculo.plate, model: vehiculo.model, brand: vehiculo.brand, status: vehiculo.status } : null,
          gps: !!conGps,
          motivo: !vehicleId
            ? 'La unidad de Kepler no tiene fila en la flota de la Suite.'
            : (!conGps ? 'La unidad no tiene rastreador: los km se capturan.' : null),
        },
        chofer: {
          kepler_code: choferClave ?? primero('chofer_code'),
          nombre: primero('chofer_nombre'),
          metodo: primero('chofer_metodo'),
          asignado_a_la_unidad: primero('chofer_asignado_a_la_unidad'),
          driver_id: chofer?.id ?? null,
          en_suite: !!chofer,
          falta: !primero('chofer_code'),
          motivo: !primero('chofer_code')
            ? 'Kepler no trae chofer: lo precarga de la unidad y esta unidad no tiene uno asignado.'
            : (!chofer ? 'El chofer de Kepler no está en el padrón de la Suite.' : null),
        },
        responsables: {
          surtio: nombresUnicos('surtio'),
          checo: nombresUnicos('checo'),
          embarco: nombresUnicos('embarco'),
          sin_resolver: sinResolver,
        },
        paradas,
        resumen,
        comision: comisionSugerida(resumen.rutas, rutas),
        tomado: tomado ?? null,
        procedencia: {
          fuente: 'kepler_ods: kdm1/kdm2 U-D-41 + kdudent/kdm_rutas/kdm_rutas2 + kdm_cat_* (vistas en vivo)',
          ruta: 'Por domicilio de entrega (cliente c10 + domicilio c85 → kdudent.c13). El embarque no la trae.',
          cajas: 'De los renglones: kdm2.c54 en unidad de manejo CJA/BTO. La nota manual de almacén no se usa como fuente.',
          peso: 'No existe en Kepler (sin peso por producto). Sólo se conocen los kilos de renglones vendidos por kilo.',
          valor: 'Entrega a cliente = precio de venta con impuestos; traspaso = costo. No se suman.',
          entrega: 'Kepler no registra la llegada; la confirma el chofer en la Suite.',
        },
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
