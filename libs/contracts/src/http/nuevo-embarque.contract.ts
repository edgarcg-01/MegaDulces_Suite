/**
 * `[EMB.12]` «Nuevo embarque» desde Kepler — el contrato HTTP (ADR-052).
 *
 * El productor (`libs/logistics`: `ErpShipmentsService.nuevoEmbarque`, `listTrips` y
 * `LogisticsShipmentsService.createFromKepler`) y el consumidor (`apps/view`, módulo de
 * logística) importan de acá. Tipos más DOS funciones puras chicas (`comisionesDeLaGuia`,
 * `erroresDeTarifa`): la regla de la comisión la leen la hoja (para el botón) y la API (para el
 * 400), y si viviera en dos lados una dejaría pasar lo que la otra frena. Nada de datos: este
 * barril lo cargan las apps Angular desde el arranque.
 *
 * Endpoints:
 *   · `GET  /logistics/erp-shipments/trips?fecha&sucursal&solo_sin_tomar` → `KeplerTripList`
 *   · `GET  /logistics/erp-shipments/trips/:sucursal/:guia/nuevo-embarque` → `NuevoEmbarqueHoja`
 *   · `POST /logistics/shipments/from-kepler/:sucursal/:guia` (`TomaKeplerBody`) → `TomaKeplerResultado`
 *
 * Lo que Kepler no tiene se declara `null`, no `0`: el peso del viaje (`peso_total`) no existe
 * en Kepler y el tipo lo dice siempre.
 */

/** Cómo se resolvió una clave de Kepler contra su catálogo. null = el documento no traía clave. */
export type KeplerMetodoResolucion = 'exacto' | 'normalizado' | 'ambiguo' | 'sin_resolver';

/** A dónde va una parada: serie 1 = cliente; serie 2 = sucursal o camión de ruta. */
export type KeplerDestinoTipo = 'cliente' | 'sucursal' | 'ruta';

/** Un viaje = una guía de embarque de Kepler (`kdm1.c86`). Fila de la lista del paso 1. */
export interface KeplerTripRow {
  sucursal: string;
  guia_embarque: string;
  guia_digital: string;
  fecha: string;
  paradas: number;
  destinos: number;
  series: number;
  transporte_code: string | null;
  transporte_descripcion: string | null;
  transporte_placas: string | null;
  chofer_code: string | null;
  chofer_nombre: string | null;
  /** Kepler no trae chofer: lo precarga de la unidad y la unidad no tiene uno asignado. */
  chofer_falta: boolean;
  /** «Entrega a cliente», «Traspaso a sucursal», «Carga a camión de ruta» o la mezcla. */
  tipo_etiqueta: string | null;
  /** Total de los documentos tal como lo da la vista (texto numérico de Postgres). */
  total: string | number;
  vehicle_id: string | null;
  vehicle_plate: string | null;
  destinos_texto: string | null;
  tomado_shipment_id: string | null;
  tomado_folio: string | null;
}

export interface KeplerTripList {
  rows: KeplerTripRow[];
  page: number;
  limit: number;
  total: number;
}

/** Quién surtió, checó o embarcó una parada, resuelto contra `kdm_cat_sur/che/emb`. */
export interface KeplerResponsable {
  codigo: string | null;
  nombre: string | null;
  metodo: KeplerMetodoResolucion | null;
}

/** Una parada = un documento `U-D-41` dentro de la guía. */
export interface NuevoEmbarqueParada {
  serie: number;
  serie_label: string;
  folio: string;
  folio_digital: string;
  fecha: string | null;
  cliente_code: string | null;
  destino_nombre: string | null;
  destino_colonia: string | null;
  destino_ciudad: string | null;
  destino_estado: string | null;
  domicilio: string | null;
  /** El documento no trae domicilio (`kdm1.c85` vacío) y se supuso el 1. Lo supuesto se declara. */
  domicilio_supuesto: boolean | null;
  domicilio_calle: string | null;
  domicilio_ciudad: string | null;
  ruta_clave: string | null;
  ruta_nombre: string | null;
  orden_visita: number | null;
  ruta_metodo: string | null;
  total: number;
  /** De los renglones en unidad de manejo CJA/BTO. null = la parada no tiene renglones. */
  cajas: number | null;
  sueltos: number | null;
  /** Sólo los renglones vendidos por kilo. null = ninguno. */
  kg: number | null;
  renglones: number | null;
  renglones_sin_empaque: number | null;
  /** `kdm1.c43`: F y R traen factura hija, N no, A sin decodificar. */
  facturacion: string | null;
  facturado: boolean | null;
  hora_captura: string | null;
  nota_almacen: string | null;
  pedido_folio: string | null;
  pedido_folio_digital: string | null;
  surtio: KeplerResponsable;
  checo: KeplerResponsable;
  embarco: KeplerResponsable;
}

export interface NuevoEmbarqueTipoViaje {
  /** Lo que acepta `logistics.shipments.type`. Llevar a un camión de ruta también es traspaso. */
  tipo: 'entrega' | 'traspaso';
  etiqueta: string;
  /** El viaje lleva paradas de más de un tipo. */
  mixto: boolean;
  destinos: Record<KeplerDestinoTipo, number>;
}

export interface NuevoEmbarqueResumen {
  paradas: number;
  clientes: number;
  rutas: Array<{ clave: string; nombre: string | null; paradas: number }>;
  paradas_sin_ruta: number;
  cajas: number;
  sueltos: number;
  /** Kilos de los renglones vendidos POR KILO. null = ninguna parada lleva renglones por kilo. */
  kg_vendido_por_kilo: number | null;
  /** El peso total del viaje no existe en Kepler (no hay peso por producto). Se dice, siempre. */
  peso_total: null;
  renglones_sin_empaque: number;
  /** Paradas a cliente: precio de venta con impuestos. */
  valor_venta: number;
  /** Traspasos y cargas a ruta: Kepler los valúa a COSTO. No se suman con la venta. */
  valor_traspaso: number;
  facturadas: number;
  paradas_a_cliente: number;
}

export interface NuevoEmbarqueComision {
  driver: number | null;
  helper: number | null;
  /** La regla de un viaje con VARIAS rutas: la de mayor comisión. Es una propuesta (EMB.13). */
  regla: 'mayor_comision_del_viaje';
  ruta_usada: { clave: string; nombre: string | null; route_id: string } | null;
  emparejadas: Array<{
    clave: string; nombre: string | null; route_id: string;
    metodo: 'kepler_code' | 'nombre'; driver: number; helper: number;
  }>;
  /** Rutas del viaje que el catálogo de la Suite no tiene: no se adivina su tarifa. */
  sin_tarifa: Array<{ clave: string; nombre: string | null }>;
}

/** La hoja de un viaje: lo que Kepler ya escribió + la tarifa del catálogo + si ya se tomó. */
export interface NuevoEmbarqueHoja {
  viaje: {
    sucursal: string;
    sucursal_nombre: string | null;
    guia: string;
    guia_digital: string;
    fecha: string | null;
    hora_captura_desde: string | null;
    hora_captura_hasta: string | null;
    tipo: NuevoEmbarqueTipoViaje;
    multi_transporte: boolean;
    multi_chofer: boolean;
    multi_fecha: boolean;
  };
  unidad: {
    kepler_code: string | null;
    descripcion: string | null;
    placas: string | null;
    metodo: string | null;
    vehicle_id: string | null;
    suite: { plate: string; model: string | null; brand: string | null; status: string } | null;
    gps: boolean;
    motivo: string | null;
  };
  chofer: {
    kepler_code: string | null;
    nombre: string | null;
    metodo: string | null;
    asignado_a_la_unidad: string | null;
    driver_id: string | null;
    en_suite: boolean;
    falta: boolean;
    motivo: string | null;
  };
  responsables: { surtio: string[]; checo: string[]; embarco: string[]; sin_resolver: number };
  paradas: NuevoEmbarqueParada[];
  resumen: NuevoEmbarqueResumen;
  comision: NuevoEmbarqueComision;
  tomado: { id: string; folio: string; status: string } | null;
  procedencia: Record<string, string>;
}

/**
 * Lo que el coordinador captura al tomar el viaje: sólo lo que Kepler no tiene. Las comisiones
 * NO van: se calculan de la tarifa de las rutas del viaje (`comisionesDeLaGuia`), y la API
 * rechaza una capturada que no coincida.
 */
export interface TomaKeplerBody {
  delivery_type: 'route' | 'long_trip';
  /** Sólo si Kepler no trae chofer: si lo trae, la API rechaza otro. */
  driver_id?: string | null;
  helper1_id?: string | null;
  helper2_id?: string | null;
  per_diem_total?: number | null;
  per_diem_breakdown?: unknown;
  overnight?: boolean;
  freight_revenue?: number | null;
  actual_km?: number | null;
  total_weight_kg?: number | null;
  notes?: string | null;
}

/** Lo que devuelve tomar el viaje: el embarque, su guía de entrega y cuántas paradas lleva. */
export interface TomaKeplerResultado {
  shipment: { id: string; folio: string; status: string; kepler_sucursal: string; kepler_guia: string };
  guide: { id: string; number: string; status: string };
  destinatarios: number;
}

// ── La comisión del viaje: se CALCULA, no se captura ─────────────────────────────────────────
//
// Fórmula de la beta de Logística (`megadulces_beta`, `autoFillComisionChofer` /
// `autoFillComisionAyudante`): chofer = tarifa de chofer de la ruta; cada ayudante que va =
// tarifa de ayudante de la misma ruta. La beta tenía UN destino por embarque; una guía de Kepler
// cruza varias rutas y se aplica la de MAYOR tarifa (decisión de Logística, 2026-10-07).
// Sin tarifa la beta guardaba 0, y Liquidaciones paga lo que dice la guía: un 0 es no pagar. Por
// eso aquí no hay 0 por omisión — si falta una tarifa, la hoja no deja crear (`erroresDeTarifa`).

/** Dónde se captura la tarifa que falta. */
export const DONDE_SE_CAPTURA_LA_TARIFA = 'Logística › Configuración › Comisiones';

/** Las comisiones que lleva la guía. Sólo tienen sentido cuando `erroresDeTarifa` viene vacío. */
export function comisionesDeLaGuia(
  comision: Pick<NuevoEmbarqueComision, 'driver' | 'helper'>,
  ayudantes: { helper1: boolean; helper2: boolean },
): { driver_commission: number; helper1_commission: number; helper2_commission: number } {
  return {
    driver_commission: comision.driver ?? 0,
    helper1_commission: ayudantes.helper1 ? (comision.helper ?? 0) : 0,
    helper2_commission: ayudantes.helper2 ? (comision.helper ?? 0) : 0,
  };
}

/**
 * Lo que impide calcular la comisión, en una línea cada cosa. Vacío = se puede.
 *
 * ⚠️ Una ruta sin tarifa frena aunque otra del viaje sí la tenga: con «la mayor del viaje», la
 * que falta podría ser justo la mayor (la más lejana), y tomar otra sería pagar de menos.
 */
export function erroresDeTarifa(
  comision: Pick<NuevoEmbarqueComision, 'driver' | 'helper' | 'sin_tarifa' | 'ruta_usada'>,
  paradasSinRuta: number,
  ayudantes: { helper1: boolean; helper2: boolean },
): string[] {
  const nombre = (r: { clave: string; nombre: string | null }) => r.nombre || r.clave;
  if (paradasSinRuta > 0) {
    return [`${paradasSinRuta === 1 ? 'Una parada no tiene' : `${paradasSinRuta} paradas no tienen`} ruta en Kepler: sin ruta no se calcula la comisión.`];
  }
  if (comision.sin_tarifa.length) {
    return [`Falta la tarifa de ${comision.sin_tarifa.map(nombre).join(', ')} en ${DONDE_SE_CAPTURA_LA_TARIFA}.`];
  }
  if (!comision.ruta_usada) return ['El viaje no tiene ruta en Kepler: sin ruta no se calcula la comisión.'];
  const ruta = nombre(comision.ruta_usada);
  const e: string[] = [];
  if (!((comision.driver ?? 0) > 0)) e.push(`${ruta} no tiene tarifa de chofer en ${DONDE_SE_CAPTURA_LA_TARIFA}.`);
  if ((ayudantes.helper1 || ayudantes.helper2) && !((comision.helper ?? 0) > 0)) {
    e.push(`${ruta} no tiene tarifa de ayudante en ${DONDE_SE_CAPTURA_LA_TARIFA}.`);
  }
  return e;
}
