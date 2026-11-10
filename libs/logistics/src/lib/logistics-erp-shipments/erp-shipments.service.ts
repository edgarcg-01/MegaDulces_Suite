import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import type { Knex } from 'knex';
import type {
  GuiaRepartoBusqueda, GuiaRepartoFiltro, GuiaRepartoHoja, GuiaRepartoQuien, GuiaRepartoViaje, GuiaRepartoViajes,
  NuevoEmbarqueHoja, NuevoEmbarqueParada,
} from '@megadulces/contracts';
import { normalizarNumeroDeGuia } from '@megadulces/contracts';
import { armarParadas, asignacionDelChofer, docOrigen, esCargaDeRutaDirecta, esViajeDelChofer, llaveEmbarque, RD_CLIENTE, RD_DESTINO, type EmbarqueDeGuia, type FacturasPorEmbarque } from './guia-reparto.logic';
import {
  comisionSugerida,
  EntradaCatalogo,
  fechaISO,
  ordenarParadas,
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

/**
 * `[EMB.56]` Fuera las cargas de las camionetas de Ruta Directa: no son viajes de reparto
 * (`esCargaDeRutaDirecta`). ⚠️ `coalesce`: con un cliente o destino NULL el `NOT (...)` daría NULL
 * y el WHERE tiraría el embarque.
 */
const sinRutaDirecta = (q: Knex.QueryBuilder) => q.whereRaw(
  `NOT (coalesce(btrim(cliente_code), '') ~* ? OR coalesce(btrim(destino_nombre), '') ~* ?)`, [RD_CLIENTE, RD_DESTINO]);

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

/** EMB.12 — la fila de la lista con lo que necesita «Nuevo embarque» para elegir el viaje. */
interface TripListRow extends TripRow {
  chofer_code: string | null;
  multi_transporte: boolean;
  multi_chofer: boolean;
  series: number;
  tomado_shipment_id: string | null;
  tomado_folio: string | null;
  destinos_texto?: string | null;
  tipo_etiqueta?: string | null;
  chofer_falta?: boolean;
}

/** EMB.12 — el viaje como lo da `analytics.erp_shipment_trips`. */
interface ViajeRow {
  guia_digital: string;
  fecha: Date | string | null;
  vehicle_id: string | null;
  transporte_descripcion: string | null;
  transporte_placas: string | null;
  multi_transporte: boolean;
  multi_chofer: boolean;
  multi_fecha: boolean;
}

/** EMB.12 — una cabecera `U-D-41` de la guía, como la da `analytics.erp_shipment_headers`. */
interface CabeceraParadaRow {
  serie: number | string;
  serie_label: string;
  folio: string;
  folio_digital: string;
  fecha: Date | string | null;
  cliente_code: string | null;
  destino_nombre: string | null;
  destino_colonia: string | null;
  destino_ciudad: string | null;
  destino_estado: string | null;
  total: number | string | null;
  pedido_folio: string | null;
  pedido_folio_digital: string | null;
  resp_surtido: string | null;
  resp_checado: string | null;
  resp_embarque: string | null;
  transporte_code: string | null;
  transporte_clave_kepler: string | null;
  transporte_metodo: string | null;
  chofer_code: string | null;
  chofer_clave_kepler: string | null;
  chofer_nombre: string | null;
  chofer_metodo: string | null;
  chofer_asignado_a_la_unidad: string | null;
}

/** EMB.12 — ruta, domicilio y carga de la parada (`erp_shipment_stops` ⋈ `erp_shipment_stop_load`). */
interface CargaParadaRow {
  serie: number | string;
  folio: string;
  domicilio: string | null;
  domicilio_supuesto: boolean | null;
  domicilio_calle: string | null;
  domicilio_ciudad: string | null;
  domicilio_telefono: string | null;
  ruta_clave: string | null;
  ruta_nombre: string | null;
  orden_visita: number | string | null;
  ruta_metodo: string | null;
  facturacion: string | null;
  facturado: boolean | null;
  hora_captura: string | null;
  nota_almacen: string | null;
  renglones: number | string | null;
  cajas: number | string | null;
  sueltos: number | string | null;
  kg: number | string | null;
  renglones_sin_empaque: number | string | null;
}

/** Número o null — `numeric` de Postgres llega como texto, y una ausencia no es cero. */
const numONull = (v: number | string | null | undefined): number | null => (v == null ? null : Number(v));

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
      const rows: TripListRow[] = await base()
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
        const sucs = [...new Set(rows.map((r) => r.sucursal))];
        const guias = [...new Set(rows.map((r) => r.guia_embarque))];
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
      for (const r of rows) {
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
  async nuevoEmbarque(sucursal: string, guia: string): Promise<NuevoEmbarqueHoja> {
    return this.tk.run(M, async (trx) => {
      const trip: ViajeRow | undefined = await trx('analytics.erp_shipment_trips')
        .where({ tenant_id: M, sucursal, guia_embarque: guia }).first();
      if (!trip) throw new NotFoundException(`Kepler no tiene el viaje ${sucursal}-G${guia}`);

      const headers: CabeceraParadaRow[] = await trx('analytics.erp_shipment_headers')
        .where({ tenant_id: M, sucursal, guia_embarque: guia })
        .select('serie', 'serie_label', 'folio', 'folio_digital', 'fecha', 'cliente_code',
          'destino_nombre', 'destino_colonia', 'destino_ciudad', 'destino_estado', 'total',
          'pedido_folio', 'pedido_folio_digital', 'comentarios',
          'resp_surtido', 'resp_checado', 'resp_embarque',
          'transporte_code', 'transporte_clave_kepler', 'transporte_descripcion', 'transporte_placas',
          'transporte_metodo', 'chofer_code', 'chofer_clave_kepler', 'chofer_nombre', 'chofer_metodo',
          'chofer_asignado_a_la_unidad', 'vehicle_id', 'vehicle_plate');

      const extraDe = await this.cargaDeParadas(trx, sucursal, guia);

      const catalogos: Array<{ rol: string; codigo: string; nombre: string | null }> =
        await trx('analytics.v_kepler_responsables').where({ sucursal }).select('rol', 'codigo', 'nombre');
      const cat = (rol: string): EntradaCatalogo[] =>
        catalogos.filter((c) => c.rol === rol).map((c) => ({ codigo: c.codigo, nombre: c.nombre }));
      const catSur = cat('surtido');
      const catChe = cat('checado');
      const catEmb = cat('embarque');

      // Cada parada se arma campo por campo con la forma del contrato: lo que viaja al front es
      // exactamente lo que `NuevoEmbarqueParada` declara, no la fila cruda de la vista.
      const paradas = ordenarParadas(headers.map((h): NuevoEmbarqueParada => {
        const e = extraDe.get(`${h.serie}|${h.folio}`);
        return {
          serie: Number(h.serie),
          serie_label: h.serie_label,
          folio: h.folio,
          folio_digital: h.folio_digital,
          fecha: fechaISO(h.fecha),
          cliente_code: h.cliente_code,
          destino_nombre: h.destino_nombre,
          destino_colonia: h.destino_colonia,
          destino_ciudad: h.destino_ciudad,
          destino_estado: h.destino_estado,
          domicilio: e?.domicilio ?? null,
          domicilio_supuesto: e?.domicilio_supuesto ?? null,
          domicilio_calle: e?.domicilio_calle ?? null,
          domicilio_ciudad: e?.domicilio_ciudad ?? null,
          ruta_clave: e?.ruta_clave ?? null,
          ruta_nombre: e?.ruta_nombre ?? null,
          orden_visita: numONull(e?.orden_visita),
          ruta_metodo: e?.ruta_metodo ?? null,
          total: Number(h.total ?? 0),
          cajas: numONull(e?.cajas),
          sueltos: numONull(e?.sueltos),
          kg: numONull(e?.kg),
          renglones: numONull(e?.renglones),
          renglones_sin_empaque: numONull(e?.renglones_sin_empaque),
          facturacion: e?.facturacion ?? null,
          facturado: e?.facturado ?? null,
          hora_captura: e?.hora_captura ?? null,
          nota_almacen: e?.nota_almacen ?? null,
          pedido_folio: h.pedido_folio,
          pedido_folio_digital: h.pedido_folio_digital,
          surtio: resolverPorCodigo(h.resp_surtido, catSur),
          checo: resolverPorCodigo(h.resp_checado, catChe),
          embarco: resolverPorCodigo(h.resp_embarque, catEmb),
        };
      }));

      const resumen = resumirViaje(paradas);
      const tipo = tipoDeViaje(paradas);

      // ── Lo que la Suite sabe de los mismos objetos ───────────────────────────────────
      const primero = <K extends keyof CabeceraParadaRow>(k: K): CabeceraParadaRow[K] | null =>
        headers.map((h) => h[k]).find((v) => v != null) ?? null;
      const choferClave = primero('chofer_clave_kepler');
      const vehicleId = trip.vehicle_id ?? null;

      const sucNombre = await this.nombreSucursal(trx, sucursal);

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
        .select('id', 'name', 'kepler_code', 'driver_commission', 'helper_commission', 'sin_comision');
      const tomado = await trx('logistics.shipments')
        .where({ kepler_sucursal: sucursal, kepler_guia: guia })
        .whereNull('deleted_at').whereNot('status', 'cancelado')
        .first('id', 'folio', 'status');

      const nombresUnicos = (k: 'surtio' | 'checo' | 'embarco'): string[] =>
        [...new Set(paradas.map((p) => p[k].nombre).filter((x): x is string => !!x))];
      const sinResolver = paradas.reduce((a, p) =>
        a + (['surtio', 'checo', 'embarco'] as const)
          .filter((k) => { const m = p[k].metodo; return !!m && m !== 'exacto' && m !== 'normalizado'; }).length, 0);
      const horas = paradas.map((p) => p.hora_captura).filter((x): x is string => !!x).sort();

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
   * EMB.12 — ruta, domicilio de entrega, orden de visita y carga de cada parada de la guía, con
   * llave `serie|folio`. La comparten «Nuevo embarque» y la guía de reparto (`[EMB.56]`).
   *
   * ⭐ DOS consultas por llave constante, no un LATERAL (`[EMB.56]`, medido 2026-11-09 en prod
   * sobre la guía 01-G0000969): con el LATERAL la carga costaba **1,880–2,283 ms** porque el
   * agregado de `erp_shipment_stop_load` no recibía el filtro; pidiéndola con sucursal + serie +
   * folios constantes usa `ix_kdm2_venta_doc` y cuesta **6–13 ms**. Las paradas solas, 16 ms.
   */
  private async cargaDeParadas(trx: Knex.Transaction, sucursal: string, guia: string): Promise<Map<string, CargaParadaRow>> {
    const paradas: CargaParadaRow[] = await trx('analytics.erp_shipment_stops')
      .where({ sucursal, guia_embarque: guia })
      .select('serie', 'folio', 'domicilio', 'domicilio_supuesto', 'domicilio_calle', 'domicilio_ciudad',
        'domicilio_telefono', 'ruta_clave', 'ruta_nombre', 'orden_visita', 'ruta_metodo', 'facturacion',
        'facturado', 'hora_captura', 'usuario_captura', 'nota_almacen');
    const porSerie = new Map<number, string[]>();
    for (const p of paradas) {
      const s = Number(p.serie);
      if (!porSerie.has(s)) porSerie.set(s, []);
      porSerie.get(s)!.push(p.folio);
    }
    const carga = new Map<string, Partial<CargaParadaRow>>();
    // En SECUENCIA (mismo cliente de pg dentro de la transacción); a lo más dos: serie 1 y 2.
    for (const [serie, folios] of porSerie) {
      const rows = await trx('analytics.erp_shipment_stop_load')
        .where({ sucursal, serie }).whereIn('folio', folios)
        .select('serie', 'folio', 'renglones', 'cajas', 'sueltos', 'kg', 'renglones_kg', 'renglones_sin_empaque');
      for (const l of rows) carga.set(`${l.serie}|${l.folio}`, l);
    }
    // Sin renglones, la carga queda en null (no en cero): igual que el LEFT JOIN de antes.
    return new Map<string, CargaParadaRow>(paradas.map((p) => {
      const l = carga.get(`${p.serie}|${p.folio}`);
      return [`${p.serie}|${p.folio}`, {
        ...p,
        renglones: l?.renglones ?? null,
        cajas: l?.cajas ?? null,
        sueltos: l?.sueltos ?? null,
        kg: l?.kg ?? null,
        renglones_sin_empaque: l?.renglones_sin_empaque ?? null,
      }];
    }));
  }

  /**
   * El nombre de la sucursal sale del catálogo de Kepler (`pv_suc_ip`: 06 → «Sucursal Canindo»).
   * ⚠️ Se pregunta antes si la tabla existe: una consulta que falla dentro de la transacción la
   * aborta entera, y el nombre no vale tumbar la hoja.
   */
  private async nombreSucursal(trx: Knex.Transaction, sucursal: string): Promise<string | null> {
    const { rows: [hayPv] } = await trx.raw(`SELECT to_regclass('kepler_ods.pv_suc_ip') IS NOT NULL AS ok`);
    if (!hayPv?.ok) return null;
    const r = await trx.raw(`SELECT btrim(c2) AS nombre FROM kepler_ods.pv_suc_ip WHERE btrim(c1) = ? LIMIT 1`, [sucursal]);
    return r.rows?.[0]?.nombre ?? null;
  }

  /**
   * `[EMB.56]` Los viajes de un día, para que el chofer escoja el suyo. Sólo lo justo para
   * reconocerlo (unidad, placas, paradas, a dónde va): ningún importe. `sucursales` null = todas
   * (alcance `all`); `[]` = ninguna.
   *
   * ⭐ Sale de las PARADAS del día, no de `erp_shipment_trips`: esa vista agrega todas las guías
   * antes de filtrar por fecha y costaba **4,117–4,787 ms**; las cabeceras y las paradas filtradas
   * por sucursal + fecha cuestan **13–61 ms** (medido 2026-11-09, sucursal 01, 23-jul-2026).
   * ⚠️ Diferencia declarada: una guía con embarques de dos días aparece en los dos (la vista la
   * fecha en el primero). Es el día que el chofer busca.
   */
  async viajesGuiaReparto(fecha: string, sucursales: string[] | null, quien: GuiaRepartoQuien): Promise<GuiaRepartoViajes> {
    return { fecha, ...(await this.viajesDonde({ fecha }, sucursales, quien)) };
  }

  /**
   * `[EMB.56]` Una guía por su NÚMERO, para reimprimirla sin navegar el calendario (medido con
   * Playwright: llegar al 23-jul desde noviembre costaba 6 clics). El número es por sucursal —la
   * `0000969` existe en Padre Hidalgo (23-jul) y en CEDIS (24-ago)—, así que puede devolver varios
   * viajes y la pantalla los muestra para escoger; nunca imprime uno a ciegas. Mismo alcance y mismo
   * filtro por chofer que la lista del día. Medido: 47–113 ms en todas las sucursales.
   */
  async buscarGuiaReparto(texto: string, sucursales: string[] | null, quien: GuiaRepartoQuien): Promise<GuiaRepartoBusqueda> {
    const guia = normalizarNumeroDeGuia(texto);
    if (!guia) return { guia: null, rows: [], filtro: { por_chofer: !quien.todos, chofer_nombre: null, motivo: null } };
    return { guia, ...(await this.viajesDonde({ guia }, sucursales, quien)) };
  }

  /**
   * Los viajes de un día o de un número de guía, con el filtro por chofer. Una sola implementación
   * para las dos entradas: lo que cambia es de dónde salen los embarques, no cómo se arma la fila.
   */
  private async viajesDonde(
    donde: { fecha: string } | { guia: string },
    sucursales: string[] | null,
    quien: GuiaRepartoQuien,
  ): Promise<{ rows: GuiaRepartoViaje[]; filtro: GuiaRepartoFiltro }> {
    const todos: GuiaRepartoFiltro = { por_chofer: false, chofer_nombre: null, motivo: null };
    if (sucursales && !sucursales.length) {
      return { rows: [], filtro: quien.todos ? todos : { ...todos, por_chofer: true } };
    }
    const llave = 'fecha' in donde ? { fecha: donde.fecha } : { guia_embarque: donde.guia };
    return this.tk.run(M, async (trx) => {
      // [EMB.56] Cada chofer, sólo sus viajes. Sin ficha o sin clave de Kepler no se adivina: se dice.
      const ficha = quien.todos ? null : await this.fichaDeChofer(trx, quien.user_id);
      const filtro: GuiaRepartoFiltro = quien.todos ? todos : {
        por_chofer: true,
        chofer_nombre: ficha?.full_name ?? null,
        motivo: !ficha ? 'sin_ficha_de_chofer' : !ficha.kepler_code?.trim() ? 'sin_clave_kepler' : null,
      };
      if (filtro.motivo) return { rows: [], filtro };

      const cab = trx('analytics.erp_shipment_headers').where({ tenant_id: M, ...llave }).whereNotNull('guia_embarque');
      if (sucursales) cab.whereIn('sucursal', sucursales);
      sinRutaDirecta(cab);
      let docs: Array<{
        sucursal: string; guia_embarque: string; fecha: Date | string | null; transporte_descripcion: string | null;
        transporte_placas: string | null; chofer_clave_kepler: string | null; transporte_clave_kepler: string | null;
      }> = await cab.select('sucursal', 'guia_embarque', 'fecha', 'transporte_descripcion', 'transporte_placas',
        'chofer_clave_kepler', 'transporte_clave_kepler');

      const asignado = new Map<string, 'embarque' | 'unidad'>();
      if (filtro.por_chofer && ficha?.kepler_code) {
        const choferDe = await this.choferesDeUnidades(trx, docs);
        const porGuia = new Map<string, typeof docs>();
        for (const d of docs) {
          const k = `${d.sucursal}|${d.guia_embarque}`;
          if (!porGuia.has(k)) porGuia.set(k, []);
          porGuia.get(k)!.push(d);
        }
        for (const [k, ds] of porGuia) {
          const por = asignacionDelChofer(ds, choferDe.get(ds[0].sucursal) ?? new Map(), ficha.kepler_code);
          if (por) asignado.set(k, por);
        }
        docs = docs.filter((d) => asignado.has(`${d.sucursal}|${d.guia_embarque}`));
        if (!docs.length) return { rows: [], filtro };
      }

      const par = trx('analytics.erp_shipment_stops').where(llave).whereNotNull('guia_embarque');
      if (sucursales) par.whereIn('sucursal', sucursales);
      sinRutaDirecta(par);
      const paradas: Array<{ sucursal: string; guia_embarque: string; cliente_code: string | null; domicilio: string | null; donde: string | null }> = await par
        .select('sucursal', 'guia_embarque', 'cliente_code', 'domicilio',
          trx.raw('coalesce(domicilio_ciudad, destino_ciudad, destino_nombre, cliente_code) AS donde'));

      const viajes = new Map<string, GuiaRepartoViajes['rows'][number]>();
      for (const d of docs) {
        const k = `${d.sucursal}|${d.guia_embarque}`;
        const v = viajes.get(k) ?? {
          sucursal: d.sucursal,
          guia: d.guia_embarque,
          guia_digital: `${d.sucursal}-G${d.guia_embarque}`, // misma forma que erp_shipment_trips
          fecha: fechaISO(d.fecha),
          paradas: 0,
          unidad_descripcion: null,
          unidad_placas: null,
          destinos_texto: null,
          asignado_por: asignado.get(k) ?? null,
        };
        v.unidad_descripcion ??= d.transporte_descripcion;
        v.unidad_placas ??= d.transporte_placas;
        viajes.set(k, v);
      }
      // Una PARADA es un cliente en un domicilio de entrega, igual que en la hoja impresa: contar
      // embarques decía «12 paradas» para la guía 0000969, que en la hoja tiene 9.
      const donde = new Map<string, Set<string>>();
      const puntos = new Map<string, Set<string>>();
      for (const p of paradas) {
        const k = `${p.sucursal}|${p.guia_embarque}`;
        if (!donde.has(k)) { donde.set(k, new Set()); puntos.set(k, new Set()); }
        if (p.donde) donde.get(k)!.add(p.donde);
        puntos.get(k)!.add(`${p.cliente_code ?? ''}|${p.domicilio ?? '1'}`);
      }
      const rows = [...viajes.entries()]
        .map(([k, v]) => ({ ...v, paradas: puntos.get(k)?.size ?? 0, destinos_texto: [...(donde.get(k) ?? [])].join(' · ') || null }))
        .sort((a, b) => a.sucursal.localeCompare(b.sucursal) || b.guia.localeCompare(a.guia));
      return { rows, filtro };
    });
  }

  /** `[EMB.56]` La ficha del padrón de choferes ligada al usuario (`logistics.drivers.user_id`). */
  private async fichaDeChofer(trx: Knex.Transaction, userId: string | null): Promise<{ full_name: string | null; kepler_code: string | null } | null> {
    if (!userId) return null;
    return (await trx('logistics.drivers').where({ user_id: userId }).whereNull('deleted_at')
      .orderBy('active', 'desc').first('full_name', 'kepler_code')) ?? null;
  }

  /**
   * `[EMB.56]` El chofer asignado a cada unidad en el catálogo de Kepler (`kdm_transporte.c4`), por
   * sucursal: sucursal → (unidad → clave del chofer). Es lo que Kepler precarga en el embarque.
   */
  private async choferesDeUnidades(trx: Knex.Transaction, docs: Array<{ sucursal: string; transporte_clave_kepler: string | null }>): Promise<Map<string, Map<string, string>>> {
    const pares = [...new Set(docs.filter((d) => d.transporte_clave_kepler).map((d) => `${d.sucursal}|${d.transporte_clave_kepler!.trim()}`))]
      .map((k) => k.split('|') as [string, string]);
    const out = new Map<string, Map<string, string>>();
    if (!pares.length) return out;
    const { rows } = await trx.raw(
      `SELECT btrim(sucursal) AS sucursal, btrim(c1) AS unidad, NULLIF(btrim(c4::text), '') AS chofer
         FROM kepler_ods.kdm_transporte
        WHERE (btrim(sucursal), btrim(c1)) IN (${pares.map(() => '(?, ?)').join(', ')})`,
      pares.flat());
    for (const r of rows as Array<{ sucursal: string; unidad: string; chofer: string | null }>) {
      if (!r.chofer) continue;
      if (!out.has(r.sucursal)) out.set(r.sucursal, new Map());
      out.get(r.sucursal)!.set(r.unidad, r.chofer);
    }
    return out;
  }

  /**
   * `[EMB.56]` La guía de reparto de UN viaje: la hoja de ruta del chofer, sin importes.
   *
   * Cuatro consultas por llave constante (sucursal + guía): el viaje, las cabeceras (folios de
   * embarque y pedido, cliente, chofer), las paradas con domicilio, orden y carga, y las facturas
   * vigentes por el back-pointer de la factura (`doc_origen`, la liga de `[AX.17]`: 5,927 de 5,929
   * a exactamente un embarque). Medido sobre la guía `0000969`: paradas 35 ms, facturas 62 ms.
   */
  async guiaReparto(sucursal: string, guia: string, quien: GuiaRepartoQuien): Promise<GuiaRepartoHoja> {
    return this.tk.run(M, async (trx) => {
      const noExiste = () => new NotFoundException(`Kepler no tiene el viaje ${sucursal}-G${guia}`);
      const trip: ViajeRow | undefined = await trx('analytics.erp_shipment_trips')
        .where({ tenant_id: M, sucursal, guia_embarque: guia }).first();
      if (!trip) throw noExiste();

      const cabeceras: Array<Pick<CabeceraParadaRow, 'serie' | 'folio' | 'folio_digital' | 'cliente_code'
        | 'destino_nombre' | 'pedido_folio_digital' | 'chofer_nombre' | 'chofer_clave_kepler' | 'transporte_clave_kepler' | 'transporte_code'>> =
        await trx('analytics.erp_shipment_headers')
          .where({ tenant_id: M, sucursal, guia_embarque: guia })
          .select('serie', 'folio', 'folio_digital', 'cliente_code', 'destino_nombre', 'pedido_folio_digital',
            'chofer_nombre', 'chofer_clave_kepler', 'transporte_clave_kepler', 'transporte_code');
      // La carga de una camioneta de Ruta Directa no tiene guía de reparto: se dice, no se imprime vacía.
      const headers = cabeceras.filter((h) => !esCargaDeRutaDirecta(h));
      if (quien.todos && cabeceras.length && !headers.length) {
        throw new NotFoundException(`La guía ${sucursal}-G${guia} es la carga de una camioneta de Ruta Directa: no lleva guía de reparto`);
      }

      // [EMB.56] Un chofer sólo abre SU viaje; el ajeno responde igual que si no existiera.
      if (!quien.todos) {
        const ficha = await this.fichaDeChofer(trx, quien.user_id);
        const clave = ficha?.kepler_code?.trim();
        const choferDe = clave ? await this.choferesDeUnidades(trx, headers.map((h) => ({ sucursal, transporte_clave_kepler: h.transporte_clave_kepler }))) : null;
        if (!clave || !esViajeDelChofer(headers, choferDe?.get(sucursal) ?? new Map(), clave)) throw noExiste();
      }
      const carga = await this.cargaDeParadas(trx, sucursal, guia);

      // Facturas: sólo los embarques a cliente (serie 1) se facturan. Canceladas fuera.
      const aCliente = headers.filter((h) => Number(h.serie) === 1);
      const facturas: FacturasPorEmbarque = new Map();
      if (aCliente.length) {
        const fs: Array<{ doc_origen: string; folio: string; folio_digital: string }> =
          await trx('analytics.erp_sales_invoices as i')
            .where('i.tenant_id', M)
            .whereIn(['i.sucursal', 'i.doc_origen'], aCliente.map((h) => [sucursal, docOrigen(1, h.folio)]))
            .whereRaw('i.cancelada IS NOT TRUE')
            .select('i.doc_origen', 'i.folio', 'i.folio_digital')
            .orderBy('i.folio');
        const porOrigen = new Map(aCliente.map((h) => [docOrigen(1, h.folio), llaveEmbarque(1, h.folio)]));
        for (const f of fs) {
          const k = porOrigen.get(f.doc_origen);
          if (!k) continue;
          if (!facturas.has(k)) facturas.set(k, []);
          facturas.get(k)!.push({ folio: String(f.folio).trim(), folio_digital: f.folio_digital });
        }
      }

      const embarques: EmbarqueDeGuia[] = headers.map((h) => {
        const e = carga.get(`${h.serie}|${h.folio}`);
        return {
          serie: Number(h.serie),
          folio: h.folio,
          folio_digital: h.folio_digital,
          pedido_folio_digital: h.pedido_folio_digital,
          cliente_code: h.cliente_code,
          cliente_nombre: h.destino_nombre,
          domicilio: e?.domicilio ?? null,
          domicilio_supuesto: e?.domicilio_supuesto ?? null,
          domicilio_calle: e?.domicilio_calle ?? null,
          domicilio_ciudad: e?.domicilio_ciudad ?? null,
          domicilio_telefono: e?.domicilio_telefono ?? null,
          ruta_nombre: e?.ruta_nombre ?? null,
          orden_visita: numONull(e?.orden_visita),
          ruta_metodo: e?.ruta_metodo ?? null,
          facturacion: e?.facturacion ?? null,
          nota_almacen: e?.nota_almacen ?? null,
          cajas: numONull(e?.cajas),
          kg: numONull(e?.kg),
        };
      });
      const { paradas, resumen } = armarParadas(embarques, facturas);
      const primero = (k: 'chofer_nombre' | 'transporte_clave_kepler' | 'transporte_code') =>
        headers.map((h) => h[k]).find((v) => v != null) ?? null;

      return {
        viaje: {
          sucursal,
          sucursal_nombre: await this.nombreSucursal(trx, sucursal),
          guia,
          guia_digital: trip.guia_digital,
          fecha: fechaISO(trip.fecha),
        },
        unidad: {
          kepler_code: primero('transporte_clave_kepler') ?? primero('transporte_code'),
          descripcion: trip.transporte_descripcion,
          placas: trip.transporte_placas,
        },
        chofer_kepler: primero('chofer_nombre'),
        paradas,
        resumen,
        procedencia: {
          fuente: 'kepler_ods en vivo: kdm1/kdm2 U-D-41 + kdudent + kdm_rutas2 + facturas U-D-8 (erp_sales_invoices)',
          orden: 'kdm_rutas2.c4 por cliente + domicilio de entrega: el mismo número que imprime Kepler. Sin orden en Kepler = al final.',
          domicilio: 'kdudent por el domicilio de entrega del embarque (c85). No es el domicilio fiscal (kdm1.c33/c34).',
          factura: 'La factura U-D-8 cuyo back-pointer (doc_origen) es el embarque, sin canceladas. Sólo la entrega a cliente se factura.',
          cajas: 'De los renglones: kdm2.c54 en unidad CJA/BTO (coincide con la nota «CJ n» en el 77 %, EMB.12).',
          paquetes: 'Según la nota de almacén («PQ n»): las cajas de paquetería las arma y cuenta el checador; no se pueden calcular (FASE_GP §2.5). Hasta [GP.4b], la nota es la única fuente.',
          importes: 'No viajan: el chofer no cobra; cobra el vendedor con su Guía de Cobranza.',
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
