import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { ObjectStorageService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type {
  CargaDelEmbarque,
  CargadorRegistrado,
  CargadoresBody,
  CerrarParadaBody,
  CierreDeEmbarque,
  EstadoDeViaje,
  PagoViaje,
  ParadaCierre,
} from '@megadulces/contracts';
import type {
  CentroDeCosto, ComisionDeRuta, Corte, DesgloseDeOperacion, SinCentro, DocumentoDeLaOperacion, EstadoRecepcion, OperacionDelReporte,
  PersonaDelPadron, RenglonDelReparto, ReporteDePagos, RolDelReparto, TipoParadaKepler, TipoViajePago,
  ConceptoDelReparto, TripulacionSugerida, HorarioGpsDeOperacion,
  ConceptoDelVale, LineaDelVale, PagoDePersona, PagoEnKepler, PagosDeLaCatorcena, ValeDeLaCatorcena,
} from '@megadulces/contracts';
import {
  horaNormal, MOTIVO_NO_MEDIBLE,
  conceptoDelReparto, corteDe, erroresDeCargadores, erroresDeCierreDeParada, esFecha, faltasDelViaje, repartoDeCarga,
  SKUS_SIN_CARGA, SUCURSAL_QUE_PAGA_EL_CENTRO, TARIFA_CARGA_CAJA_KEY,
  estadoDelPago, lineasDelVale, llaveDeLinea, nombreParaCasar, PROVEEDOR_DE_LA_SOLICITUD, solicitudesDelReporte, tipoDeParadaKepler, tipoDelViaje, totalDeCarga, totalesDelReparto, WAREHOUSE_DISPLAY_ORDER,
} from '@megadulces/contracts';
import { CambioRegistrado, tarifaVigenteEl } from '../logistics-config/tarifas-fijas.logic';
import {
  comisionSugerida, EntradaCatalogo, fechaISO, resolverPorCodigo, RutaSuite,
} from '../logistics-erp-shipments/nuevo-embarque.logic';
import type { ResultadoGps } from '../logistics-shipments/gps-viaje.logic';
import { leerMismoViaje, leerMismoViajePorHoja, leerViajeGps } from '../logistics-shipments/gps-viaje.lectura';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `[CML.P]` Un renglón ya amarrado a un vale de Gastos que no se rechazó. */
interface FilaAmarrada {
  driver_id: string; source: LineaDelVale['source']; source_id: string; concept: ConceptoDelVale; amount: Num;
  vale_id: string; status: string; importe: Num; created_at: Date | string; folio_solicitud: string | null;
}

/** `YYYY-MM-DD` + n días (fecha de calendario, sin zona). */
export function sumarDias(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Fila cruda de `logistics.v_trip_stop_closure` (pg devuelve numeric como texto y date como Date). */
type Num = string | number | null;
type Fecha = string | Date | null;
interface FilaParada extends Omit<ParadaCierre, 'value' | 'importe_embarcado' | 'recepcion_importe' | 'recepcion_fecha' | 'diferencia' | 'delivered_at' | 'remision_url'> {
  value: Num;
  importe_embarcado: Num;
  recepcion_importe: Num;
  recepcion_fecha: Fecha;
  diferencia: Num;
  delivered_at: Fecha;
  proof_photo_url: string | null;
  shipment_id: string;
}
/** Fila cruda de `logistics.v_trip_state`. */
interface FilaViaje extends Omit<EstadoDeViaje, 'shipment_date' | 'paradas' | 'paradas_cerradas' | 'paradas_con_diferencia' | 'paradas_pendientes'> {
  shipment_date: Fecha;
  paradas: Num;
  paradas_cerradas: Num;
  paradas_con_diferencia: Num;
  paradas_pendientes: Num;
}
/** Fila cruda de `logistics.v_trip_pay_items`. */
export interface FilaPago extends Omit<PagoViaje, 'shipment_date' | 'amount'> {
  shipment_date: Fecha;
  amount: Num;
}
interface FilaCargador { id: string; driver_id: string; persona: string; rate: Num; pagado: boolean | null }
/** Lo que hace falta del embarque para calcular su carga. */
interface EmbarqueCarga {
  id: string;
  shipment_date: Fecha;
  kepler_sucursal: string | null;
  kepler_guia: string | null;
  boxes_count: Num;
  status?: string;
}
const COLS_EMBARQUE = ['id', 'shipment_date', 'kepler_sucursal', 'kepler_guia', 'boxes_count', 'status'];

/** `[EMB.43]` `[EMB.47]` Filas crudas del reporte. */
interface FilaViajeKepler {
  sucursal: string; guia_embarque: string; fecha: Fecha; paradas: Num; chofer_code: string | null; chofer_nombre: string | null; total: Num;
}
interface FilaParadaKepler {
  sucursal: string; guia_embarque: string; serie: number | string; folio: string; cliente_code: string | null; destino_nombre: string | null;
  ruta_clave?: string | null; ruta_nombre?: string | null;
}
interface FilaCajasKepler { sucursal: string; serie: number | string; folio: string; cajas: Num; sueltos?: Num; renglones?: Num }
/** `[EMB.48]` Lo que un documento lleva de productos que no se cargan (tiempo aire). */
interface FilaSinCarga { sucursal: string; serie: number | string; folio: string; cantidad: Num; renglones: Num }
interface FilaSuite {
  shipment_id: string; folio: string; kepler_sucursal: string; kepler_guia: string;
  guide_id: string | null; driver_id: string | null; helper1_id: string | null; helper2_id: string | null;
  driver_commission: Num; helper1_commission: Num; helper2_commission: Num;
  viatico_driver: Num; viatico_helper1: Num; viatico_helper2: Num;
  /** `[EMB.51]` El desglose del viático que guardó la guía (horario, tarifas, comidas). */
  per_diem_breakdown?: unknown;
  departure_time: string | null; arrival_time: string | null; overnight: boolean | null;
  /** `[CML.HV]` Cuándo se guardó la tripulación al salir (null = no se guardó por ese camino). */
  crew_saved_at: Date | string | null;
  /** `[CML.J]` Clave de Kepler (SUC|GUIA) de la otra guía del mismo viaje, confirmada. */
  same_trip_as: string | null;
  /** `[CML.K]` La última reapertura del viaje cerrado (cuándo y por qué). */
  reopened_at: Date | string | null; reopen_reason: string | null;
  /** `[CML.K]` Km de la hoja de viaje (`shipments.actual_km`). */
  actual_km: Num;
}
interface FilaCarga { shipment_id: string; driver_id: string; rate: Num; boxes: Num; rate_per_box: Num }
/** La tarifa por caja con su bitácora: se evalúa por día sin volver a la base. */
interface TarifaConBitacora { row: { id: string; value: Num; active: boolean }; cambios: CambioRegistrado[] }

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const centavos = (n: number) => Math.round(n * 100) / 100;

/** `[EMB.48]` Lo que lleva una guía en las paradas que pagan. */
export interface CargaDeGuia {
  cajas: number;
  /** Unidades en otra presentación (paquete, pieza, kilo), sin el tiempo aire. */
  sueltos: number;
  /** Todos sus documentos son sólo tiempo aire: no hay nada que cargar. */
  soloSinCarga: boolean;
}

/**
 * `[EMB.47]` Cajas por guía, de las paradas que PAGAN: la carga a camión de ruta no paga por caja
 * (decisión del 2026-10-24), así que sus cajas no entran aunque vayan en la misma guía.
 * `null` = ninguna parada que paga tiene renglones en Kepler (no se sabe); 0 = sólo piezas sueltas.
 *
 * `[EMB.48]` Además dice cuántas unidades van sueltas y si la guía no lleva más que tiempo aire
 * (`sinCarga`: lo que cada documento trae de `SKUS_SIN_CARGA`).
 */
export function cargaPorGuia(
  paradas: FilaParadaKepler[], renglones: FilaCajasKepler[], sinCarga: FilaSinCarga[] = [],
): Map<string, CargaDeGuia | null> {
  const doc = (r: { sucursal: string; serie: number | string; folio: string }) => `${r.sucursal}|${Number(r.serie)}|${r.folio}`;
  const porDoc = new Map<string, { cajas: number; sueltos: number; renglones: number }>();
  for (const r of renglones) {
    const a = porDoc.get(doc(r)) ?? { cajas: 0, sueltos: 0, renglones: 0 };
    a.cajas += Number(r.cajas ?? 0);
    a.sueltos += Number(r.sueltos ?? 0);
    a.renglones += Number(r.renglones ?? 0);
    porDoc.set(doc(r), a);
  }
  const sc = new Map(sinCarga.map((s) => [doc(s), s]));
  const out = new Map<string, CargaDeGuia | null>();
  const vistos = new Set<string>();
  for (const p of paradas) {
    if (tipoDeParadaKepler(p.serie, p.cliente_code) === 'carga_ruta') continue;
    const k = doc(p);
    const guia = `${p.sucursal}|${p.guia_embarque}`;
    if (!out.has(guia)) out.set(guia, null);
    // Una guía puede listar el mismo documento dos veces: se cuenta una.
    const d = porDoc.get(k);
    if (vistos.has(`${guia}|${k}`) || !d) continue;
    vistos.add(`${guia}|${k}`);
    const s = sc.get(k);
    const prev = out.get(guia) ?? { cajas: 0, sueltos: 0, soloSinCarga: true };
    out.set(guia, {
      cajas: prev.cajas + d.cajas,
      sueltos: prev.sueltos + Math.max(0, d.sueltos - Number(s?.cantidad ?? 0)),
      soloSinCarga: prev.soloSinCarga && !!s && d.renglones > 0 && Number(s.renglones) >= d.renglones,
    });
  }
  return out;
}

/** `[EMB.47]` Sólo las cajas (lo que usa el registro de cargadores). */
export function cajasPorGuia(paradas: FilaParadaKepler[], renglones: FilaCajasKepler[]): Map<string, number | null> {
  return new Map([...cargaPorGuia(paradas, renglones)].map(([g, c]) => [g, c ? c.cajas : null]));
}

/**
 * `[EMB.48]` La comisión de la ruta de cada guía, con la MISMA regla con que se completa la guía:
 * las rutas de TODAS sus paradas (como `resumirViaje`) contra el catálogo, y gana la de mayor tarifa.
 */
export function comisionPorGuia(paradas: FilaParadaKepler[], catalogo: RutaSuite[]): Map<string, ComisionDeRuta> {
  const rutas = new Map<string, Map<string, { clave: string; nombre: string | null }>>();
  for (const p of paradas) {
    const g = `${p.sucursal}|${p.guia_embarque}`;
    if (!rutas.has(g)) rutas.set(g, new Map());
    const clave = p.ruta_clave?.trim();
    if (clave && !rutas.get(g)!.has(clave)) rutas.get(g)!.set(clave, { clave, nombre: p.ruta_nombre ?? null });
  }
  const out = new Map<string, ComisionDeRuta>();
  for (const [g, rs] of rutas) {
    const c = comisionSugerida([...rs.values()], catalogo);
    out.set(g, {
      chofer: c.driver,
      ayudante: c.helper,
      ruta: c.ruta_usada ? (c.ruta_usada.nombre ?? c.ruta_usada.clave) : null,
      sin_tarifa: c.sin_tarifa.map((x) => x.nombre ?? x.clave),
    });
  }
  return out;
}

/**
 * `[EMB.47]` Lo que le toca a cada quien de UNA operación: comisión y viático de la tripulación
 * (calculados al completar la guía) y la carga de cada cargador (guardada al registrarlos).
 *
 * `[EMB.48]` Mientras la guía no se completa, la comisión del chofer de Kepler ya se sabe (la
 * tarifa de la ruta): sale como renglón con `fuente: 'kepler'`. Al completarse, la reemplaza la de
 * la guía, que es el mismo monto por la misma regla.
 */
export function renglonesDeLaOperacion(
  tipo: TipoViajePago,
  s: FilaSuite | null,
  cargas: FilaCarga[],
  nombre: (id: string) => string,
  deKepler: { chofer_id: string | null; comision: number | null; ruta?: string | null } = { chofer_id: null, comision: null },
): RenglonDelReparto[] {
  const out: RenglonDelReparto[] = [];
  const poner = (
    id: string | null, rol: RolDelReparto, concepto: ConceptoDelReparto, monto: Num, calculo: string,
    fuente: RenglonDelReparto['fuente'] = 'captura',
  ) => {
    const importe = centavos(Number(monto ?? 0));
    if (!id || !(importe > 0)) return;
    const c = conceptoDelReparto(tipo, concepto);
    out.push({ persona_id: id, persona: nombre(id), rol, concepto, codigo: c.codigo, nombre_concepto: c.nombre, importe, fuente, calculo });
  };
  const ruta = deKepler.ruta ? `la ruta ${deKepler.ruta}` : 'la ruta del viaje';
  // La guía completa trae su comisión calculada; mientras no, la de la ruta para el chofer que se sabe.
  // ⚠️ «Completa» = chofer + salida + llegada (`pendientesDeLaGuia`), NO la comisión: la columna es
  // NOT NULL con 0 por default y la guía que nace al tomar el viaje la trae en 0.
  const guiaCompleta = !!s?.driver_id && !!s?.departure_time && !!s?.arrival_time;
  if (!guiaCompleta) {
    poner(s?.driver_id ?? deKepler.chofer_id, 'chofer', 'comision', deKepler.comision,
      `Tarifa de ${ruta}: ${pesos(Number(deKepler.comision ?? 0))} al chofer (el que trae Kepler; se confirma al guardar el horario)`, 'kepler');
  } else if (s) {
    const comision = (quien: string) => `Comisión de la guía: tarifa de ${ruta} para ${quien}`;
    poner(s.driver_id, 'chofer', 'comision', s.driver_commission, comision('el chofer'));
    poner(s.driver_id, 'chofer', 'viatico', s.viatico_driver, calculoDeViatico(s.per_diem_breakdown, 'driver'));
    poner(s.helper1_id, 'ayudante', 'comision', s.helper1_commission, comision('el ayudante'));
    poner(s.helper1_id, 'ayudante', 'viatico', s.viatico_helper1, calculoDeViatico(s.per_diem_breakdown, 'helper1'));
    poner(s.helper2_id, 'ayudante', 'comision', s.helper2_commission, comision('el ayudante'));
    poner(s.helper2_id, 'ayudante', 'viatico', s.viatico_helper2, calculoDeViatico(s.per_diem_breakdown, 'helper2'));
  }
  for (const c of cargas) poner(c.driver_id, 'cargador', 'carga', c.rate, calculoDeCarga(c, cargas.length));
  return out;
}

/**
 * `[CML.J]` D17 opción A — el MISMO viaje físico se paga UNA vez. Las operaciones ligadas (el
 * coordinador confirmó que eran el mismo viaje: `delivery_guides.same_trip_as`) forman un grupo; en
 * el grupo, cada persona cobra la comisión MAYOR (la de la ruta mayor) y un solo viático. La carga
 * (cajas × tarifa) no se toca: cada guía cargó sus propias cajas. Una liga a una guía que no está en
 * el reporte no agrupa nada (no se adivina). Devuelve, por operación, sus renglones y con quién viajó.
 */
export function consolidarMismoViaje(
  ops: ReadonlyArray<{ clave: string; renglones: RenglonDelReparto[]; liga: string | null }>,
): Map<string, { renglones: RenglonDelReparto[]; con: string[] }> {
  const presentes = new Set(ops.map((o) => o.clave));
  const padre = new Map<string, string>(ops.map((o) => [o.clave, o.clave]));
  const raiz = (k: string): string => { let r = k; while (padre.get(r) !== r) r = padre.get(r) as string; return r; };
  for (const o of ops) {
    if (o.liga && o.liga !== o.clave && presentes.has(o.liga)) {
      const a = raiz(o.clave); const b = raiz(o.liga);
      if (a !== b) padre.set(a < b ? b : a, a < b ? a : b);
    }
  }
  const grupos = new Map<string, string[]>();
  for (const o of ops) grupos.set(raiz(o.clave), [...(grupos.get(raiz(o.clave)) ?? []), o.clave]);
  const out = new Map(ops.map((o) => [o.clave, { renglones: [...o.renglones], con: [] as string[] }]));
  const guia = (k: string) => k.split('|')[1] ?? k;
  for (const miembros of grupos.values()) {
    if (miembros.length < 2) continue;
    const orden = [...miembros].sort();
    for (const k of orden) (out.get(k) as { con: string[] }).con = orden.filter((x) => x !== k);
    for (const concepto of ['comision', 'viatico'] as const) {
      const personas = new Set(orden.flatMap((k) => (out.get(k)?.renglones ?? []).filter((r) => r.concepto === concepto).map((r) => r.persona_id)));
      for (const p of personas) {
        let mejor: { k: string; importe: number } | null = null;
        for (const k of orden) {
          const r = out.get(k)?.renglones.find((x) => x.concepto === concepto && x.persona_id === p);
          if (r && (!mejor || r.importe > mejor.importe)) mejor = { k, importe: r.importe };
        }
        if (!mejor) continue;
        const otras = orden.filter((k) => k !== mejor?.k).map(guia).join(', ');
        for (const k of orden) {
          const e = out.get(k) as { renglones: RenglonDelReparto[] };
          if (k === mejor.k) {
            e.renglones = e.renglones.map((r) => r.concepto === concepto && r.persona_id === p
              ? { ...r, calculo: `${r.calculo} · Mismo viaje que la guía ${otras}: se paga una sola vez${concepto === 'comision' ? ' (la ruta mayor)' : ''}` }
              : r);
          } else {
            e.renglones = e.renglones.filter((r) => !(r.concepto === concepto && r.persona_id === p));
          }
        }
      }
    }
  }
  return out;
}

/** `[CML.T1]` Un viaje ya capturado (guía completa: chofer + salida + llegada), para sugerir. */
export interface TripulacionPrevia {
  driver_id: string;
  helper1_id: string | null;
  helper2_id: string | null;
  /** Fecha del viaje de Kepler (`shipments.shipment_date`), YYYY-MM-DD. */
  fecha: string;
  sucursal: string | null;
  guia: string | null;
}

/** `[CML.T1]` Cuántos días atrás se busca el viaje anterior: una tripulación vieja ya no dice nada. */
export const DIAS_DE_TRIPULACION_SUGERIDA = 30;

/**
 * `[CML.H]` Lo que el GPS dice del viaje, para la pantalla: el viaje, o el motivo en una frase
 * (la misma de la revisión de embarques). Nunca un horario inventado ni en cero.
 */
export function horarioGpsDe(r: ResultadoGps): HorarioGpsDeOperacion {
  return r.ok ? { viaje: r.viaje, motivo: null } : { viaje: null, motivo: MOTIVO_NO_MEDIBLE[r.motivo] };
}

const restarDias = (fecha: string, dias: number): string => {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
};

/**
 * `[CML.T1]` Los ayudantes que probablemente fueron: los del viaje anterior del MISMO chofer.
 *
 * Por qué: en producción se capturó la tripulación de 4 de 448 viajes (CML.0, 2026-11-20); elegirla
 * a mano viaje por viaje es lo que nadie hace. La sugerencia sólo precarga: quien captura la confirma.
 *
 * Reglas (si alguna no se cumple, NO se sugiere: mejor nada que una persona equivocada):
 *  - sólo viajes del mismo chofer, del mismo día o antes, a ≤ 30 días, y nunca el mismo viaje;
 *  - gana el más reciente (`previas` viene ordenada del más nuevo al más viejo);
 *  - un ayudante que ya no está activo, o que es el propio chofer, se quita;
 *  - si el viaje anterior llevaba ayudantes y ninguno sigue activo, no se sugiere «fue solo».
 */
export function tripulacionSugerida(
  choferId: string | null,
  viaje: { fecha: string; sucursal: string; guia: string },
  previas: TripulacionPrevia[],
  activos: ReadonlySet<string>,
): TripulacionSugerida | null {
  if (!choferId || !esFecha(viaje.fecha)) return null;
  const desde = restarDias(viaje.fecha, DIAS_DE_TRIPULACION_SUGERIDA);
  const previa = previas.find((p) =>
    p.driver_id === choferId && esFecha(p.fecha) && p.fecha <= viaje.fecha && p.fecha >= desde
    && !(p.sucursal === viaje.sucursal && p.guia === viaje.guia));
  if (!previa) return null;
  const vale = (id: string | null) => (id && id !== choferId && activos.has(id) ? id : null);
  const llevaba = [previa.helper1_id, previa.helper2_id].filter(Boolean).length;
  const quedan = [vale(previa.helper1_id), vale(previa.helper2_id)].filter((x): x is string => !!x);
  const unicos = [...new Set(quedan)];
  if (llevaba > 0 && unicos.length === 0) return null;
  return { helper1_id: unicos[0] ?? null, helper2_id: unicos[1] ?? null, fecha: previa.fecha, guia: previa.guia };
}

/**
 * `[EMB.53]` El centro de costo del PISO de cada sucursal, del catálogo de Kepler (`kdc3`): es
 * `1-0P-NN-00` con NN = el código MD de la sucursal (MD-42 La Piedad Abastos → 1-01-42-00 «LA PIEDAD
 * ABASTOS PISO»; verificado contra los nombres de las 9). Si el catálogo trae cero o más de uno
 * para ese NN, la sucursal se queda sin centro: no se adivina.
 */
export function centrosDePiso(kdc3: Array<{ codigo: string; nombre: string | null }>): Map<string, CentroDeCosto> {
  const out = new Map<string, CentroDeCosto>();
  for (const g of WAREHOUSE_DISPLAY_ORDER) {
    const md = g.codes.find((c) => /^MD-\d{2}$/.test(c));
    if (!md) continue;
    const forma = new RegExp(`^1-0\\d-${md.slice(3)}-00$`);
    const candidatos = kdc3.filter((c) => forma.test(c.codigo.trim()));
    if (candidatos.length !== 1) continue;
    const centro = { codigo: candidatos[0].codigo.trim(), nombre: (candidatos[0].nombre ?? '').trim() || candidatos[0].codigo.trim() };
    for (const suc of g.codes.filter((c) => /^\d{2}$/.test(c))) out.set(suc, centro);
  }
  return out;
}

/**
 * `[EMB.53]` El centro de costo de UNA operación. Un traspaso va al piso de su sucursal destino
 * (`TI###` → sucursal por `pv_suc_ip`, la misma regla que `erp_shipment_stop_closure`). Una entrega
 * a cliente, o un traspaso a varias sucursales, NO se resuelve aquí: se dice por qué.
 *
 * `[EMB.54]` Morelia Madero se carga a Morelia Abastos y Zamora Centro a Canindo (así lo captura
 * Logística: `SUCURSAL_QUE_PAGA_EL_CENTRO`), y las dos sucursales de una plaza cuentan como UN destino.
 */
export function centroDeOperacion(
  paradas: FilaParadaKepler[],
  tiASucursal: Map<string, string>,
  centros: Map<string, CentroDeCosto>,
): { centro: CentroDeCosto | null; sin_centro: SinCentro | null } {
  const pagan = paradas.filter((p) => tipoDeParadaKepler(p.serie, p.cliente_code) !== 'carga_ruta');
  if (pagan.some((p) => tipoDeParadaKepler(p.serie, p.cliente_code) === 'cliente')) return { centro: null, sin_centro: 'cliente' };
  const sucursales = pagan.map((p) => tiASucursal.get((p.cliente_code ?? '').trim()) ?? null);
  if (!sucursales.length || sucursales.some((x) => x == null)) return { centro: null, sin_centro: 'sin_catalogo' };
  const distintas = [...new Set((sucursales as string[]).map((s) => SUCURSAL_QUE_PAGA_EL_CENTRO[s] ?? s))];
  if (distintas.length > 1) return { centro: null, sin_centro: 'varios_destinos' };
  const centro = centros.get(distintas[0]) ?? null;
  return centro ? { centro, sin_centro: null } : { centro: null, sin_centro: 'sin_catalogo' };
}

/** `[EMB.51]` Pesos para leer: «$1,234.50». Sin Intl: el resultado es el mismo en cualquier servidor. */
export function pesos(n: number): string {
  const [ent, dec] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}$${ent.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

const COMIDA_LABEL: Record<string, string> = { cafe: 'café', desayuno: 'desayuno', comida: 'comida', cena: 'cena' };

/**
 * `[EMB.51]` Cómo salió el viático de una persona, del desglose que guardó la guía al completarse
 * (`per_diem_breakdown`: horario, tarifas y qué comidas tocaron). Sin desglose, se dice.
 */
export function calculoDeViatico(breakdown: unknown, persona: 'driver' | 'helper1' | 'helper2'): string {
  const b = (breakdown && typeof breakdown === 'object' ? breakdown : null) as {
    horario?: { salida?: string | null; llegada?: string | null; duerme_fuera?: boolean };
    tarifas?: Record<string, number>;
  } & Record<string, unknown> | null;
  const p = b?.[persona] as Record<string, unknown> | undefined;
  if (!b || !p) return 'Viático de la guía (sin desglose guardado)';
  const comidas = Object.keys(COMIDA_LABEL).filter((m) => p[m] === true)
    .map((m) => `${COMIDA_LABEL[m]} ${pesos(Number(b.tarifas?.[m] ?? 0))}`);
  const h = b.horario ?? {};
  const cuando = `Salida ${h.salida ?? '—'}, llegada ${h.llegada ?? '—'}${h.duerme_fuera ? ', durmió fuera' : ''}`;
  return `${cuando}: ${comidas.length ? comidas.join(' + ') : 'ninguna comida'}`;
}

/** `[EMB.51]` Cómo salió la carga de un cargador, con lo que se guardó al registrarlo. */
export function calculoDeCarga(c: FilaCarga, cargadores: number): string {
  if (c.boxes == null || c.rate_per_box == null) return 'Carga por persona (regla anterior a la tarifa por caja)';
  const cajas = Number(c.boxes);
  const tarifa = Number(c.rate_per_box);
  const total = centavos(cajas * tarifa);
  const entre = cargadores > 1 ? ` entre ${cargadores} cargadores` : '';
  return `${cajas.toLocaleString('en-US')} cajas × ${pesos(tarifa)} = ${pesos(total)}${entre}`;
}
const dia = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/** `[EMB.50]` Filas crudas del desglose. */
export interface FilaParadaDesglose {
  serie: number | string; folio: string; cliente_code: string | null; destino_nombre: string | null;
  usuario_captura: string | null; hora_captura: string | null;
}
export interface FilaCabeceraDesglose { serie: number | string; folio: string; resp_surtido: string | null; resp_checado: string | null; resp_embarque: string | null }
export interface FilaCierreDesglose {
  serie: number | string; folio: string; destino_sucursal: string | null; recepcion_folio: string | null;
  recepcion_fecha: string | Date | null; diferencia: Num; cierre_kepler: string | null;
}
export interface FilaRenglonDesglose { serie: number | string; folio: string; linea: Num; sku: string | null; cantidad: Num; presentacion: string | null }
export interface CatalogoResponsables { surtido: EntradaCatalogo[]; checado: EntradaCatalogo[]; embarque: EntradaCatalogo[] }

const CAJA = new Set(['CJA', 'BTO']);
const ESTADOS_RECEPCION = new Set<EstadoRecepcion>(['cerrada', 'faltante', 'sobrante', 'pendiente', 'destino_desconocido']);

/**
 * `[EMB.50]` Arma el desglose de una guía, documento por documento, con la MISMA regla de cajas
 * que el reporte (`erp_shipment_stop_load`): cuenta la cantidad capturada en CJA/BTO; lo demás
 * con presentación son sueltas; el tiempo aire no cuenta; una carga a ruta no paga (0 y 0).
 */
export function documentosDelDesglose(
  paradas: FilaParadaDesglose[],
  cabeceras: FilaCabeceraDesglose[],
  cierres: FilaCierreDesglose[],
  renglones: FilaRenglonDesglose[],
  catalogo: CatalogoResponsables,
  productos: Map<string, string>,
  capturoRecepcion: Map<string, string>,
): DocumentoDeLaOperacion[] {
  const llave = (r: { serie: number | string; folio: string }) => `${Number(r.serie)}|${String(r.folio).trim()}`;
  const cab = new Map(cabeceras.map((c) => [llave(c), c]));
  const cie = new Map(cierres.map((c) => [llave(c), c]));
  const porDoc = new Map<string, FilaRenglonDesglose[]>();
  for (const r of renglones) porDoc.set(llave(r), [...(porDoc.get(llave(r)) ?? []), r]);
  const quien = (code: string | null | undefined, cat: EntradaCatalogo[]) => {
    const r = resolverPorCodigo(code, cat);
    return { codigo: r.codigo, nombre: r.nombre };
  };
  const cantidad = (v: Num): number | null => {
    const x = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return v == null || String(v).trim() === '' || !Number.isFinite(x) ? null : x;
  };
  const vistos = new Set<string>();
  const out: DocumentoDeLaOperacion[] = [];
  for (const p of paradas) {
    const k = llave(p);
    if (vistos.has(k)) continue;
    vistos.add(k);
    const tipo = tipoDeParadaKepler(p.serie, p.cliente_code);
    const pagan = tipo !== 'carga_ruta';
    const lineas = (porDoc.get(k) ?? [])
      .map((r) => {
        const pres = r.presentacion?.trim().toUpperCase() || null;
        const cant = cantidad(r.cantidad);
        const sku = String(r.sku ?? '').trim();
        return {
          linea: num(r.linea),
          sku,
          producto: productos.get(sku) ?? null,
          cantidad: cant,
          presentacion: pres,
          cajas: pres && CAJA.has(pres) && cant != null ? cant : 0,
          sin_carga: SKUS_SIN_CARGA.includes(sku),
        };
      })
      .sort((a, b) => (a.linea ?? 0) - (b.linea ?? 0));
    const cuentan = pagan ? lineas.filter((l) => !l.sin_carga) : [];
    const c = cab.get(k);
    const ci = cie.get(k);
    const estado = ci?.cierre_kepler as EstadoRecepcion | undefined;
    out.push({
      serie: Number(p.serie),
      folio: String(p.folio).trim(),
      tipo,
      destino: p.destino_nombre?.trim() || null,
      cajas: centavos(cuentan.reduce((a, l) => a + l.cajas, 0)),
      sueltos: centavos(cuentan.filter((l) => l.presentacion && !CAJA.has(l.presentacion)).reduce((a, l) => a + (l.cantidad ?? 0), 0)),
      surtio: quien(c?.resp_surtido, catalogo.surtido),
      checo: quien(c?.resp_checado, catalogo.checado),
      embarco: quien(c?.resp_embarque, catalogo.embarque),
      capturo: p.usuario_captura?.trim() || null,
      hora_captura: p.hora_captura?.trim() || null,
      recepcion: tipo === 'traspaso' && ci && estado && ESTADOS_RECEPCION.has(estado)
        ? {
            sucursal: ci.destino_sucursal,
            folio: ci.recepcion_folio,
            fecha: fechaISO(ci.recepcion_fecha as Date | string | null),
            capturo: ci.destino_sucursal && ci.recepcion_folio
              ? capturoRecepcion.get(`${ci.destino_sucursal}|${ci.recepcion_folio}`) ?? null : null,
            diferencia: num(ci.diferencia),
            estado,
          }
        : null,
      renglones: lineas,
    });
  }
  return out.sort((a, b) => a.serie - b.serie || a.folio.localeCompare(b.folio));
}

/**
 * `[EMB.24]` `[EMB.26]` `[EMB.27]` — Cierre del viaje y registro de cargadores (ADR-091).
 *
 * Lee las vistas `logistics.v_trip_*` (migración `20261012084447`): la Suite NO guarda el estado
 * del viaje, lo DERIVA de las paradas — traspasos con la recepción de Kepler, cargas a ruta al
 * embarcar, clientes con la entrega que registra Logística aquí (foto de la remisión opcional).
 */
@Injectable()
export class TripClosureService {
  private readonly logger = new Logger(TripClosureService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly storage: ObjectStorageService,
  ) {}

  /** Para el log: el nombre de quien opera. */
  private actor(): string | null {
    return this.tenantCtx.get()?.username ?? null;
  }

  /** Para las columnas de auditoría de `logistics.*`, que son `uuid` (el id del usuario). */
  private actorId(): string | null {
    const id = this.tenantCtx.get()?.userId ?? null;
    return id && UUID.test(id) ? id : null;
  }

  /**
   * `[EMB.47]` El reporte de la catorcena: cada viaje de Kepler (traspaso y cliente) con sus cajas,
   * quién fue y cuánto le toca a cada quien. El viaje y las cajas son de Kepler y se leen en vivo
   * (`analytics.erp_shipment_*`, sin copia); de la Suite sólo se lee lo que Kepler no sabe: la
   * tripulación con su comisión y viático (la guía) y quién cargó (`load_details`).
   *
   * ⛔ No lee `logistics.v_trip_state`: esa vista calcula el cierre de TODAS las paradas antes de
   * filtrar y se pasó de 60 s en prod (2026-10-24).
   *
   * Tres lecturas en paralelo, cada una en su transacción: dentro de UNA sola, Postgres las forma en
   * fila. Medido 8–21 oct 2026 (todas las sucursales): viajes 322 ms; paradas 65 ms + cajas de 1,341
   * documentos 240 ms + tiempo aire 110 ms. ⚠️ El total del endpoint en prod: NO MEDIDO todavía.
   *
   * `[EMB.48]` Cada operación dice lo que ya se sabe SIN capturar nada —la carga (cajas × tarifa) y
   * la comisión de su ruta, ya asignada al chofer de Kepler—, y las guías de sólo tiempo aire salen
   * (se cuentan): «todos los viajes salen en 0» era eso, la pantalla callaba lo que ya sabía.
   */
  async reporte(desde?: string, hasta?: string, sucursal?: string): Promise<ReporteDePagos> {
    const corte = this.resolverCorte(desde, hasta);
    if (sucursal != null && sucursal !== '' && !/^[0-9]{2}$/.test(sucursal)) {
      throw new BadRequestException('La sucursal va como su código de Kepler de dos dígitos.');
    }
    const suc = sucursal || null;
    const delCorte = (trx: Knex.Transaction, tabla: string) => {
      const q = trx(tabla).where('tenant_id', trx.raw('public.current_tenant_id()')).whereBetween('fecha', [corte.desde, corte.hasta]);
      return suc ? q.where({ sucursal: suc }) : q;
    };

    const [viajes, kepler, base] = await Promise.all([
      this.tk.run((trx) =>
        delCorte(trx, 'analytics.erp_shipment_trips')
          .select('sucursal', 'guia_embarque', 'fecha', 'paradas', 'chofer_code', 'chofer_nombre', 'total') as Promise<FilaViajeKepler[]>),
      this.tk.run(async (trx) => {
        const paradas: FilaParadaKepler[] = await delCorte(trx, 'analytics.erp_shipment_stops')
          .select('sucursal', 'guia_embarque', 'serie', 'folio', 'cliente_code', 'destino_nombre', 'ruta_clave', 'ruta_nombre');
        if (!paradas.length) return { paradas, renglones: [] as FilaCajasKepler[], sinCarga: [] as FilaSinCarga[] };
        // Constantes en arreglo, no un JOIN: así baja al índice de kdm2 (mismo motivo que `cajasDe`).
        const sucs = [...new Set(paradas.map((p) => p.sucursal))];
        const series = [...new Set(paradas.map((p) => Number(p.serie)))];
        const folios = [...new Set(paradas.map((p) => p.folio))];
        const renglones: FilaCajasKepler[] = await trx('analytics.erp_shipment_stop_load')
          .where('tenant_id', trx.raw('public.current_tenant_id()'))
          .whereRaw('sucursal = ANY(?::text[])', [sucs])
          .whereRaw('serie = ANY(?::int[])', [series])
          .whereRaw('folio = ANY(?::text[])', [folios])
          .select('sucursal', 'serie', 'folio', 'cajas', 'sueltos', 'renglones');
        // `[EMB.48]` Lo que cada documento lleva de tiempo aire: mismos filtros que la vista de cajas.
        // Medido 2026-10-26: 30 ms (314 folios) y 110 ms (1,341).
        const { rows: sinCarga } = await trx.raw<{ rows: FilaSinCarga[] }>(
          `SELECT btrim(sucursal) AS sucursal, c5::int AS serie, btrim(c6) AS folio, count(*)::int AS renglones,
                  sum(nullif(regexp_replace(c54::text, '[^0-9.-]', '', 'g'), '')::numeric) AS cantidad
             FROM kepler_ods.kdm2
            WHERE c2 = 'U' AND c3 = 'D' AND c4::int = 41 AND btrim(c1) = btrim(sucursal)
              AND btrim(sucursal) = ANY(?::text[]) AND c5::int = ANY(?::int[]) AND btrim(c6) = ANY(?::text[])
              AND btrim(c8::text) = ANY(?::text[])
            GROUP BY 1, 2, 3`,
          [sucs, series, folios, [...SKUS_SIN_CARGA]],
        );
        return { paradas, renglones, sinCarga };
      }),
      this.tk.run(async (trx) => ({
        personas: await (trx('logistics.drivers').whereNull('deleted_at').where({ active: true, status: 'activo' })
          .orderBy('full_name').select('id', 'full_name', 'roles') as Promise<PersonaDelPadron[]>),
        tarifa: await this.tarifaCarga(trx),
        // `[EMB.48]` El catálogo de rutas con su tarifa: el mismo que lee la toma del viaje.
        rutas: await (trx('logistics.routes').whereNull('deleted_at').where('active', true)
          .select('id', 'name', 'kepler_code', 'driver_commission', 'helper_commission', 'sin_comision') as Promise<RutaSuite[]>),
        // `[EMB.53]` TI### → sucursal (como `erp_shipment_stop_closure`) y los centros de piso de `kdc3`.
        ti: (await trx.raw<{ rows: Array<{ ti: string; suc: string }> }>(
          `SELECT DISTINCT ON (btrim(c7)) btrim(c7) AS ti, btrim(c1) AS suc FROM kepler_ods.pv_suc_ip
            WHERE btrim(c7) ~ '^TI[0-9]+$' AND btrim(c1) ~ '^[0-9]{2}$' ORDER BY btrim(c7), btrim(c1)`)).rows,
        kdc3: (await trx.raw<{ rows: Array<{ codigo: string; nombre: string | null }> }>(
          `SELECT btrim(c1) AS codigo, btrim(c2::text) AS nombre FROM kepler_ods.kdc3
            WHERE btrim(sucursal) = '00' AND btrim(c1) ~ '^1-0[0-9]-[0-9]{2}-00$'`)).rows,
      })),
    ]);

    // Tipo y destinos de cada guía, con sus paradas.
    const porGuia = new Map<string, { tipos: TipoParadaKepler[]; destinos: string[] }>();
    for (const p of kepler.paradas) {
      const k = `${p.sucursal}|${p.guia_embarque}`;
      const g = porGuia.get(k) ?? { tipos: [], destinos: [] };
      const tipo = tipoDeParadaKepler(p.serie, p.cliente_code);
      g.tipos.push(tipo);
      const nombre = (p.destino_nombre ?? '').trim();
      if (tipo !== 'carga_ruta' && nombre && !g.destinos.includes(nombre)) g.destinos.push(nombre);
      porGuia.set(k, g);
    }
    const carga = cargaPorGuia(kepler.paradas, kepler.renglones, kepler.sinCarga);
    const tiASucursal = new Map(base.ti.map((r) => [r.ti, r.suc]));
    const centros = centrosDePiso(base.kdc3);
    const paradasPorGuia = new Map<string, FilaParadaKepler[]>();
    for (const p of kepler.paradas) {
      const g = `${p.sucursal}|${p.guia_embarque}`;
      paradasPorGuia.set(g, [...(paradasPorGuia.get(g) ?? []), p]);
    }
    const comisiones = comisionPorGuia(kepler.paradas, base.rutas);
    const enAlcance = viajes.filter((v) => tipoDelViaje(porGuia.get(`${v.sucursal}|${v.guia_embarque}`)?.tipos ?? []));
    // `[EMB.48]` Una guía de puro tiempo aire no es un viaje que cargar: se cuenta y no entra.
    const pagan = enAlcance.filter((v) => !carga.get(`${v.sucursal}|${v.guia_embarque}`)?.soloSinCarga);

    // Lo que la Suite sabe de esas guías: la tripulación con sus montos y quién cargó.
    const nombres = new Map(base.personas.map((p) => [p.id, p.full_name]));
    const { suite, cargas, choferPorClave, previas } = await this.tk.run(async (trx) => {
      const suite = new Map<string, FilaSuite>();
      const cargas = new Map<string, FilaCarga[]>();
      const choferPorClave = new Map<string, string>();
      const previas: TripulacionPrevia[] = [];
      if (!pagan.length) return { suite, cargas, choferPorClave, previas };
      // `[EMB.48]` El chofer de Kepler, casado con el padrón ACTIVO por su clave (como la toma del
      // viaje). Medido 2026-10-26: los 15 choferes de la catorcena casan.
      const claves = [...new Set(pagan.map((v) => v.chofer_code?.trim()).filter((c): c is string => !!c))];
      if (claves.length) {
        const choferes: Array<{ id: string; full_name: string; kepler_code: string }> = await trx('logistics.drivers')
          .whereIn('kepler_code', claves).whereNull('deleted_at').where({ active: true, status: 'activo' })
          .select('id', 'full_name', 'kepler_code');
        for (const c of choferes) {
          const clave = c.kepler_code?.trim();
          if (!clave) continue;
          choferPorClave.set(clave, c.id);
          nombres.set(c.id, c.full_name);
        }
      }
      const { rows } = await trx.raw<{ rows: FilaSuite[] }>(
        `SELECT s.id AS shipment_id, s.folio, s.kepler_sucursal, s.kepler_guia,
                g.id AS guide_id, g.driver_id, g.helper1_id, g.helper2_id,
                g.driver_commission, g.helper1_commission, g.helper2_commission,
                NULLIF(g.per_diem_breakdown -> 'driver'  ->> 'subtotal', '')::numeric AS viatico_driver,
                NULLIF(g.per_diem_breakdown -> 'helper1' ->> 'subtotal', '')::numeric AS viatico_helper1,
                NULLIF(g.per_diem_breakdown -> 'helper2' ->> 'subtotal', '')::numeric AS viatico_helper2,
                g.per_diem_breakdown,
                g.departure_time::text AS departure_time, g.arrival_time::text AS arrival_time, g.overnight,
                g.crew_saved_at, g.same_trip_as, g.reopened_at, g.reopen_reason, s.actual_km
           FROM logistics.shipments s
           LEFT JOIN LATERAL (
             SELECT * FROM logistics.delivery_guides g
              WHERE g.shipment_id = s.id AND g.deleted_at IS NULL AND g.status <> 'cancelada'
              ORDER BY g.created_at LIMIT 1
           ) g ON true
          WHERE s.deleted_at IS NULL AND s.status <> 'cancelado' AND s.kepler_guia IS NOT NULL
            AND (s.kepler_sucursal, s.kepler_guia) IN (SELECT x.s, x.g FROM unnest(?::text[], ?::text[]) AS x(s, g))`,
        [pagan.map((v) => v.sucursal), pagan.map((v) => v.guia_embarque)],
      );
      for (const r of rows) suite.set(`${r.kepler_sucursal}|${r.kepler_guia}`, r);
      if (rows.length) {
        const filas: FilaCarga[] = await trx('logistics.load_details')
          .whereIn('shipment_id', rows.map((r) => r.shipment_id))
          .select('shipment_id', 'driver_id', 'rate', 'boxes', 'rate_per_box');
        for (const c of filas) cargas.set(c.shipment_id, [...(cargas.get(c.shipment_id) ?? []), c]);
      }
      // Quien ya no está activo sigue cobrando lo que hizo: su nombre se lee aparte.
      const ids = new Set<string>();
      for (const r of rows) for (const id of [r.driver_id, r.helper1_id, r.helper2_id]) if (id) ids.add(id);
      for (const cs of cargas.values()) for (const c of cs) ids.add(c.driver_id);
      const faltan = [...ids].filter((id) => !nombres.has(id));
      if (faltan.length) {
        const otros: Array<{ id: string; full_name: string }> = await trx('logistics.drivers').whereIn('id', faltan).select('id', 'full_name');
        for (const o of otros) nombres.set(o.id, o.full_name);
      }
      // `[CML.T1]` Los viajes YA capturados de estos choferes (guía completa), del más nuevo al más
      // viejo, desde 30 días antes del corte: de aquí sale la tripulación sugerida.
      const choferes = [...new Set([...choferPorClave.values(), ...rows.map((r) => r.driver_id).filter((x): x is string => !!x)])];
      if (choferes.length) {
        const { rows: hist } = await trx.raw<{ rows: TripulacionPrevia[] }>(
          `SELECT g.driver_id, g.helper1_id, g.helper2_id, to_char(s.shipment_date, 'YYYY-MM-DD') AS fecha,
                  s.kepler_sucursal AS sucursal, s.kepler_guia AS guia
             FROM logistics.delivery_guides g
             JOIN logistics.shipments s ON s.id = g.shipment_id
            WHERE g.deleted_at IS NULL AND g.status <> 'cancelada' AND s.deleted_at IS NULL AND s.status <> 'cancelado'
              AND g.driver_id = ANY(?::uuid[])
              -- [CML.HV] También la tripulación guardada al salir, aunque el horario no haya llegado.
              AND ((g.departure_time IS NOT NULL AND g.arrival_time IS NOT NULL) OR g.crew_saved_at IS NOT NULL)
              AND s.shipment_date BETWEEN ?::date - ${DIAS_DE_TRIPULACION_SUGERIDA} AND ?::date
            ORDER BY s.shipment_date DESC, g.updated_at DESC`,
          [choferes, corte.desde, corte.hasta],
        );
        previas.push(...hist);
      }
      return { suite, cargas, choferPorClave, previas };
    });
    const activos = new Set(base.personas.map((p) => p.id));
    const nombre = (id: string) => nombres.get(id) ?? 'Persona sin nombre en el padrón';

    const operaciones: OperacionDelReporte[] = pagan.map((v) => {
      const k = `${v.sucursal}|${v.guia_embarque}`;
      const tipo = tipoDelViaje(porGuia.get(k)?.tipos ?? []) as TipoViajePago;
      const fecha = dia(v.fecha) as string;
      const s = suite.get(k) ?? null;
      const deCarga = s ? cargas.get(s.shipment_id) ?? [] : [];
      // Lo guardado al registrar a los cargadores manda: un cambio de tarifa después no lo mueve.
      const guardada = deCarga.find((c) => c.boxes != null);
      const tarifa = guardada?.rate_per_box != null
        ? Number(guardada.rate_per_box)
        : base.tarifa ? tarifaVigenteEl(base.tarifa.row, base.tarifa.cambios, fecha) : null;
      const deKepler = carga.get(k) ?? null;
      const cajasOp = guardada ? Number(guardada.boxes) : deKepler ? deKepler.cajas : null;
      const comisionRuta = comisiones.get(k) ?? { chofer: null, ayudante: null, ruta: null, sin_tarifa: [] };
      const choferKeplerId = v.chofer_code?.trim() ? choferPorClave.get(v.chofer_code.trim()) ?? null : null;
      const renglones = renglonesDeLaOperacion(tipo, s, deCarga, nombre, {
        chofer_id: choferKeplerId, comision: comisionRuta.chofer, ruta: comisionRuta.ruta,
      });
      return {
        sucursal: v.sucursal,
        guia: v.guia_embarque,
        fecha,
        paradas: Number(v.paradas ?? 0),
        destinos: (porGuia.get(k)?.destinos ?? []).join(' · '),
        tipo,
        chofer_kepler: v.chofer_nombre?.trim() || null,
        importe: Number(v.total ?? 0),
        shipment_id: s?.shipment_id ?? null,
        shipment_folio: s?.folio ?? null,
        guide_id: s?.guide_id ?? null,
        driver_id: s?.driver_id ?? null,
        helper1_id: s?.helper1_id ?? null,
        helper2_id: s?.helper2_id ?? null,
        departure_time: s?.departure_time?.slice(0, 5) ?? null,
        arrival_time: s?.arrival_time?.slice(0, 5) ?? null,
        overnight: !!s?.overnight,
        cargadores: deCarga.length,
        faltan: faltasDelViaje(s ? { ...s, cargadores: deCarga.length } : null, !!choferKeplerId),
        cajas: cajasOp,
        sueltos: deKepler ? deKepler.sueltos : null,
        ...centroDeOperacion(paradasPorGuia.get(k) ?? [], tiASucursal, centros),
        comision_ruta: comisionRuta,
        chofer_kepler_id: choferKeplerId,
        tarifa_por_caja: tarifa,
        carga_total: deCarga.length
          ? centavos(deCarga.reduce((a, c) => a + Number(c.rate ?? 0), 0))
          : totalDeCarga(cajasOp, tarifa),
        cargador_ids: deCarga.map((c) => c.driver_id),
        renglones,
        // [CML.K] Lo de un viaje sin cerrar (renglón `kepler`) es «por cerrar»: no cuenta como repartido.
        ...totalesDelReparto(renglones),
        // `[CML.T1]` Sólo si la tripulación todavía no está capturada: lo capturado manda.
        // `[CML.HV]` Guardada al salir también manda (aunque haya salido sin ayudantes).
        tripulacion_sugerida: s?.driver_id && ((s.departure_time && s.arrival_time) || s.crew_saved_at)
          ? null
          : tripulacionSugerida(s?.driver_id ?? choferKeplerId, { fecha, sucursal: v.sucursal, guia: v.guia_embarque }, previas, activos),
        tripulacion_guardada_en: s?.crew_saved_at ? new Date(s.crew_saved_at).toISOString() : null,
        mismo_viaje_liga: s?.same_trip_as ?? null,
        reabierta: s?.reopened_at ? { en: new Date(s.reopened_at).toISOString(), motivo: s.reopen_reason ?? '' } : null,
        km: s?.actual_km == null ? null : Number(s.actual_km),
      };
    });
    // `[CML.J]` D17 A: las guías que el coordinador confirmó como el MISMO viaje se pagan una vez.
    const consolidado = consolidarMismoViaje(operaciones.map((o) => ({
      clave: `${o.sucursal}|${o.guia}`, renglones: o.renglones, liga: suite.get(`${o.sucursal}|${o.guia}`)?.same_trip_as ?? null,
    })));
    for (const o of operaciones) {
      const c = consolidado.get(`${o.sucursal}|${o.guia}`);
      if (!c || !c.con.length) continue;
      o.renglones = c.renglones;
      Object.assign(o, totalesDelReparto(c.renglones));
      o.mismo_viaje_confirmado = c.con;
    }
    // Lo que más falta, primero; dentro, lo más viejo primero (es lo que ya debería estar).
    operaciones.sort((a, b) => b.faltan.length - a.faltan.length || a.fecha.localeCompare(b.fecha) || a.guia.localeCompare(b.guia));
    return {
      corte,
      operaciones,
      fuera_de_alcance: viajes.length - enAlcance.length,
      solo_tiempo_aire: enAlcance.length - pagan.length,
      personas: base.personas.map((p) => ({ id: p.id, full_name: p.full_name, roles: Array.isArray(p.roles) ? p.roles : [] })),
      leido_at: new Date().toISOString(),
    };
  }

  /**
   * `[EMB.50]` El desglose de UNA operación: sus documentos con cajas, quién surtió/checó/embarcó
   * (catálogos de Kepler) y, en los traspasos, la recepción en destino con quién la capturó.
   * Todo de Kepler en vivo, con constantes (sin JOIN contra kdm2). Medido 2026-10-26 sobre la guía
   * más grande de la catorcena (27 paradas, 233 renglones): ~200 ms entre las seis lecturas.
   */
  async desglose(sucursal: string, guia: string): Promise<DesgloseDeOperacion> {
    if (!/^[0-9]{2}$/.test(sucursal ?? '')) throw new BadRequestException('La sucursal va como su código de Kepler de dos dígitos.');
    if (!/^[0-9]{1,10}$/.test(guia ?? '')) throw new BadRequestException('La guía va como el folio de Kepler (sólo dígitos).');
    return this.tk.run(async (trx) => {
      const tenant = trx.raw('public.current_tenant_id()');
      const paradas: FilaParadaDesglose[] = await trx('analytics.erp_shipment_stops')
        .where('tenant_id', tenant).where({ sucursal, guia_embarque: guia })
        .select('serie', 'folio', 'cliente_code', 'destino_nombre', 'usuario_captura', 'hora_captura');
      if (!paradas.length) throw new NotFoundException(`Kepler no tiene la guía ${guia}.`);
      const cabeceras: FilaCabeceraDesglose[] = await trx('analytics.erp_shipment_headers')
        .where('tenant_id', tenant).where({ sucursal, guia_embarque: guia })
        .select('serie', 'folio', 'resp_surtido', 'resp_checado', 'resp_embarque');
      const catalogo: Array<{ rol: string; codigo: string; nombre: string | null }> = await trx('analytics.v_kepler_responsables')
        .where({ sucursal }).select('rol', 'codigo', 'nombre');
      const cierres: FilaCierreDesglose[] = await trx('analytics.erp_shipment_stop_closure')
        .where('tenant_id', tenant).where({ sucursal, guia_embarque: guia })
        .select('serie', 'folio', 'destino_sucursal', 'recepcion_folio', 'recepcion_fecha', 'diferencia', 'cierre_kepler');
      const series = [...new Set(paradas.map((p) => Number(p.serie)))];
      const folios = [...new Set(paradas.map((p) => String(p.folio).trim()))];
      const { rows: renglones } = await trx.raw<{ rows: FilaRenglonDesglose[] }>(
        `SELECT c5::int AS serie, btrim(c6) AS folio, c7::text AS linea, btrim(c8::text) AS sku,
                c54::text AS cantidad, nullif(btrim(c55::text), '') AS presentacion
           FROM kepler_ods.kdm2
          WHERE c2 = 'U' AND c3 = 'D' AND c4::int = 41 AND btrim(c1) = btrim(sucursal)
            AND btrim(sucursal) = ? AND c5::int = ANY(?::int[]) AND btrim(c6) = ANY(?::text[])`,
        [sucursal, series, folios],
      );
      // Sólo los renglones de ESTA guía: el mismo folio puede existir en otra serie.
      const deLaGuia = new Set(paradas.map((p) => `${Number(p.serie)}|${String(p.folio).trim()}`));
      const propios = renglones.filter((r) => deLaGuia.has(`${Number(r.serie)}|${String(r.folio).trim()}`));
      const skus = [...new Set(propios.map((r) => String(r.sku ?? '').trim()).filter(Boolean))];
      const productos = new Map<string, string>();
      if (skus.length) {
        const { rows } = await trx.raw<{ rows: Array<{ sku: string; nombre: string | null }> }>(
          `SELECT btrim(c1) AS sku, btrim(c2::text) AS nombre FROM kepler_ods.kdii
            WHERE btrim(sucursal) = ? AND btrim(c1) = ANY(?::text[])`, [sucursal, skus]);
        for (const r of rows) if (r.nombre) productos.set(r.sku, r.nombre);
      }
      // Quién capturó cada recepción en destino (`kdm1.c67` del U-A-50): una clave de usuario.
      const conRecepcion = cierres.filter((c) => c.destino_sucursal && c.recepcion_folio);
      const capturoRecepcion = new Map<string, string>();
      if (conRecepcion.length) {
        const { rows } = await trx.raw<{ rows: Array<{ sucursal: string; folio: string; usuario: string | null }> }>(
          `SELECT btrim(sucursal) AS sucursal, btrim(c6) AS folio, nullif(btrim(c67::text), '') AS usuario
             FROM kepler_ods.kdm1
            WHERE c2 = 'U' AND c3 = 'A' AND c4 = 50 AND btrim(c1) = btrim(sucursal)
              AND btrim(sucursal) = ANY(?::text[]) AND btrim(c6) = ANY(?::text[])`,
          [[...new Set(conRecepcion.map((c) => c.destino_sucursal as string))], [...new Set(conRecepcion.map((c) => c.recepcion_folio as string))]],
        );
        for (const r of rows) if (r.usuario) capturoRecepcion.set(`${r.sucursal}|${r.folio}`, r.usuario);
      }
      const cat = (rol: string): EntradaCatalogo[] => catalogo.filter((c) => c.rol === rol).map((c) => ({ codigo: c.codigo, nombre: c.nombre }));
      const documentos = documentosDelDesglose(paradas, cabeceras, cierres, propios,
        { surtido: cat('surtido'), checado: cat('checado'), embarque: cat('embarque') }, productos, capturoRecepcion);
      // [CML.H] El horario según el GPS de la unidad que Kepler puso en la guía (sólo precarga).
      const viaje: { vehicle_id: string | null; fecha: string } | undefined = await trx('analytics.erp_shipment_trips')
        .where('tenant_id', tenant).where({ sucursal, guia_embarque: guia })
        .first('vehicle_id', trx.raw(`to_char(fecha, 'YYYY-MM-DD') AS fecha`));
      // La primera captura de la guía; normalizada a HH:MM para que «9:05» no quede después de «10:00».
      const hora = paradas.map((p) => horaNormal(p.hora_captura)).filter((h): h is string => !!h).sort()[0] ?? null;
      const gps: ResultadoGps = viaje
        ? await leerViajeGps(trx, { sucursal, fecha: viaje.fecha, hora, vehicleId: viaje.vehicle_id }, new Date())
        : { ok: false, motivo: 'sin_unidad' };
      // [CML.J] Otras guías de la misma unidad con la misma salida del GPS: el mismo viaje físico (D17).
      let mismoViaje = gps.ok && viaje
        ? await leerMismoViaje(trx, { sucursal, guia, fecha: viaje.fecha, vehicleId: viaje.vehicle_id }, gps.viaje, new Date())
        : [];
      let omitidas = 0;
      // [CML.J] D17 caso 3: sin GPS, la hoja de viaje dice cuándo estuvo fuera el camión; otra guía de la
      // misma unidad capturada en ese rato es el desvío. Sólo con el horario ya capturado en la guía.
      if (!gps.ok && viaje?.vehicle_id) {
        const hoja: { salida: string | null; llegada: string | null; overnight: boolean | null } | undefined = await trx('logistics.shipments as s')
          .join('logistics.delivery_guides as g', 'g.shipment_id', 's.id')
          .where({ 's.kepler_sucursal': sucursal, 's.kepler_guia': guia })
          .whereNull('s.deleted_at').whereNot('s.status', 'cancelado')
          .whereNull('g.deleted_at').whereNot('g.status', 'cancelada')
          .orderBy('g.created_at')
          .first(trx.raw('g.departure_time::text AS salida'), trx.raw('g.arrival_time::text AS llegada'), 'g.overnight');
        if (hoja?.salida && hoja.llegada) {
          const porHoja = await leerMismoViajePorHoja(trx,
            { sucursal, guia, fecha: viaje.fecha, vehicleId: viaje.vehicle_id, hora_captura: hora },
            { salida: hoja.salida, llegada: hoja.llegada, duerme_fuera: !!hoja.overnight });
          mismoViaje = porHoja.sugeridas;
          omitidas = porHoja.omitidas;
        }
      }
      return {
        sucursal,
        guia,
        documentos,
        cajas: centavos(documentos.reduce((a, d) => a + d.cajas, 0)),
        sueltos: centavos(documentos.reduce((a, d) => a + d.sueltos, 0)),
        leido_at: new Date().toISOString(),
        horario_gps: { ...horarioGpsDe(gps), mismo_viaje: mismoViaje, ...(omitidas ? { mismo_viaje_omitidas: omitidas } : {}) },
      };
    });
  }

  /**
   * `[CML.P]` El pago de la catorcena, por persona: lo que pide (lo mismo que «Por persona»), cuánto
   * ya está en un vale de Gastos y si Kepler ya lo pagó (X-A-10 al acreedor de comisiones, del día
   * siguiente al corte hasta una semana después del viernes de pago).
   *
   * ⚠️ El pago de Kepler se casa por NOMBRE del beneficiario (`kdm1.c24`) — SUPUESTO declarado en
   * `nombreParaCasar`. Si Kepler no se pudo leer, `kepler_medido: false` y nadie sale «pagado».
   */
  async pagos(desde?: string, hasta?: string): Promise<PagosDeLaCatorcena> {
    const rep = await this.reporte(desde, hasta);
    const sols = solicitudesDelReporte(rep.operaciones);
    const lineas = new Map(sols.map((s) => [s.persona_id, lineasDelVale(s, rep.operaciones).lineas]));
    const ids = sols.map((s) => s.persona_id);

    const amarradas = ids.length
      ? await this.tk.run((trx) => trx('finance.trip_pay_lines as l')
          .join('finance.expense_proofs as p', 'p.id', 'l.expense_proof_id')
          .whereIn('l.driver_id', ids).where('l.vigente', true).whereNot('p.status', 'rechazada')
          .select('l.driver_id', 'l.source', 'l.source_id', 'l.concept', 'l.amount', 'p.id as vale_id', 'p.status',
            trx.raw('p.importe::numeric AS importe'), 'p.created_at', 'p.folio_solicitud') as Promise<FilaAmarrada[]>)
      : [];

    const desdePago = sumarDias(rep.corte.hasta, 1);
    const hastaPago = sumarDias(rep.corte.pago, 7);
    let kepler_medido = true;
    let pagosKepler: PagoEnKepler[] = [];
    try {
      pagosKepler = await this.tk.run(async (trx) => {
        const { rows } = await trx.raw(
          `SELECT m.sucursal, btrim(m.c6) AS folio, to_char(m.c9, 'YYYY-MM-DD') AS fecha,
                  COALESCE(m.c16, 0)::numeric AS importe, btrim(COALESCE(m.c24, '')) AS beneficiario
             FROM kepler_ods.kdm1 m
            WHERE m.c2 = 'X' AND m.c3 = 'A' AND m.c4 = 10
              AND COALESCE(btrim(m.c43), '') <> 'C'
              AND btrim(m.c10) = ?
              AND m.c9 >= ?::date AND m.c9 < (?::date + 1)`,
          [PROVEEDOR_DE_LA_SOLICITUD.codigo, desdePago, hastaPago]);
        return (rows as Array<Omit<PagoEnKepler, 'importe'> & { importe: string }>).map((r) => ({ ...r, importe: Number(r.importe) }));
      });
    } catch (e: unknown) {
      kepler_medido = false;
      this.logger.warn(`[CML.P] No se pudo leer el pago de Kepler: ${(e as Error)?.message}`);
    }

    const porNombre = new Map<string, PagoEnKepler[]>();
    for (const p of pagosKepler) {
      const k = nombreParaCasar(p.beneficiario);
      porNombre.set(k, [...(porNombre.get(k) ?? []), p]);
    }
    const casados = new Set<string>();

    const personas: PagoDePersona[] = sols.map((s) => {
      const llaves = new Set((lineas.get(s.persona_id) ?? []).map(llaveDeLinea));
      const mias = amarradas.filter((a) => a.driver_id === s.persona_id && llaves.has(llaveDeLinea({ source: a.source, source_id: a.source_id, concept: a.concept })));
      const en_vale = Math.round(mias.reduce((t, a) => t + Number(a.amount), 0) * 100) / 100;
      const vales = new Map<string, ValeDeLaCatorcena>();
      for (const a of mias) {
        if (!vales.has(a.vale_id)) {
          vales.set(a.vale_id, {
            id: a.vale_id, status: a.status, importe: Number(a.importe),
            creado_at: new Date(a.created_at).toISOString(), folio_solicitud: a.folio_solicitud ?? null,
          });
        }
      }
      const nombre = nombreParaCasar(s.persona);
      const pagos_kepler = porNombre.get(nombre) ?? [];
      if (pagos_kepler.length) casados.add(nombre);
      const pagado = Math.round(pagos_kepler.reduce((t, p) => t + p.importe, 0) * 100) / 100;
      return {
        persona_id: s.persona_id,
        persona: s.persona,
        a_pagar: s.total,
        en_vale,
        falta_en_vale: Math.max(0, Math.round((s.total - en_vale) * 100) / 100),
        vales: [...vales.values()],
        pagos_kepler,
        diferencia: pagos_kepler.length ? Math.round((pagado - s.total) * 100) / 100 : null,
        estado: estadoDelPago(s.total, en_vale, pagos_kepler.length),
      };
    });

    return {
      corte: rep.corte,
      personas,
      pagados_sin_calculo: pagosKepler.filter((p) => !casados.has(nombreParaCasar(p.beneficiario))),
      kepler_medido,
      leido_at: new Date().toISOString(),
    };
  }

  /** `[EMB.43]` El corte pedido, o la catorcena que va corriendo (la que contiene hoy). */
  private resolverCorte(desde?: string, hasta?: string): Corte {
    if (esFecha(desde) && esFecha(hasta)) {
      if (desde > hasta) throw new BadRequestException('«desde» es posterior a «hasta».');
      return { desde, hasta, pago: corteDe(hasta).pago };
    }
    if (desde || hasta) throw new BadRequestException('Las fechas van como YYYY-MM-DD.');
    return corteDe(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }));
  }

  async cierre(shipmentId: string): Promise<CierreDeEmbarque> {
    if (!UUID.test(shipmentId)) throw new BadRequestException('shipment_id inválido');
    const datos = await this.tk.run(async (trx) => {
      const s: EmbarqueCarga | undefined = await trx('logistics.shipments')
        .where({ id: shipmentId }).whereNull('deleted_at').first(COLS_EMBARQUE);
      if (!s) throw new NotFoundException('Embarque no encontrado');
      const [viajes, paradas, pagos, cargadores, carga] = await Promise.all([
        trx('logistics.v_trip_state').where({ shipment_id: shipmentId }).orderBy('guide_number'),
        trx('logistics.v_trip_stop_closure')
          .where({ shipment_id: shipmentId })
          .orderByRaw('sequence_order NULLS LAST, kepler_folio NULLS LAST, recipient_id'),
        trx('logistics.v_trip_pay_items').where({ shipment_id: shipmentId }).orderBy(['rol', 'persona', 'concept']),
        this.cargadoresDe(trx, shipmentId),
        this.cargaDe(trx, s),
      ]);
      return { viajes, paradas, pagos, cargadores, carga };
    });

    const paradas: ParadaCierre[] = await Promise.all(
      (datos.paradas as FilaParada[]).map(async (p) => ({
        recipient_id: p.recipient_id,
        guide_id: p.guide_id,
        sequence_order: p.sequence_order,
        customer_name: p.customer_name,
        kepler_serie: p.kepler_serie,
        kepler_folio: p.kepler_folio,
        value: num(p.value),
        tipo_parada: p.tipo_parada,
        destino_code: p.destino_code,
        importe_embarcado: num(p.importe_embarcado),
        recepcion_folio: p.recepcion_folio,
        recepcion_importe: num(p.recepcion_importe),
        recepcion_fecha: dia(p.recepcion_fecha),
        diferencia: num(p.diferencia),
        recipient_status: p.recipient_status,
        delivered_at: p.delivered_at ? new Date(p.delivered_at).toISOString() : null,
        delivered_to: p.delivered_to,
        incident_type: p.incident_type,
        incident_notes: p.incident_notes,
        estado_parada: p.estado_parada,
        motivo: p.motivo,
        remision_url: await this.urlDe(p.proof_photo_url),
      })),
    );

    return {
      shipment_id: shipmentId,
      viajes: (datos.viajes as FilaViaje[]).map((v): EstadoDeViaje => ({
        guide_id: v.guide_id,
        guide_number: v.guide_number,
        shipment_id: v.shipment_id,
        shipment_folio: v.shipment_folio,
        kepler_sucursal: v.kepler_sucursal,
        kepler_guia: v.kepler_guia,
        shipment_date: dia(v.shipment_date) as string,
        estado_viaje: v.estado_viaje,
        paradas: Number(v.paradas),
        paradas_cerradas: Number(v.paradas_cerradas),
        paradas_con_diferencia: Number(v.paradas_con_diferencia),
        paradas_pendientes: Number(v.paradas_pendientes),
      })),
      paradas,
      pagos: (datos.pagos as FilaPago[]).map(aPagoViaje),
      cargadores: datos.cargadores,
      carga: datos.carga,
    };
  }

  /** `[EMB.24]` La parada de cliente se cierra con el resultado que registra Logística (foto opcional). */
  async cerrarParada(recipientId: string, body: CerrarParadaBody): Promise<ParadaCierre> {
    if (!UUID.test(recipientId)) throw new BadRequestException('recipientId inválido');
    const tenantId = this.tenantCtx.requireTenantId();

    const parada = await this.tk.run((trx) =>
      trx('logistics.v_trip_stop_closure').where({ recipient_id: recipientId }).first(),
    );
    if (!parada) throw new NotFoundException('Parada no encontrada');
    const errs = erroresDeCierreDeParada(body, parada);
    if (errs.length) {
      if (errs[0] === 'La parada ya se cerró.') throw new ConflictException(errs[0]);
      throw new BadRequestException(errs.join(' '));
    }

    // Si viene foto, se sube ANTES de escribir: si el almacenamiento falla, la parada sigue pendiente.
    const key = body.foto ? (await this.storage.putFile(body.foto, `logistics/${tenantId}/remisiones`)).key : null;
    const entregado = body.resultado === 'entregado';

    const actualizada = await this.tk.run(async (trx) => {
      const n = await trx('logistics.guide_recipients')
        .where({ id: recipientId, status: 'pendiente' })
        .update({
          status: entregado ? 'entregado' : 'no_entregado',
          delivered_at: entregado ? trx.fn.now() : null,
          attempted_at: entregado ? null : trx.fn.now(),
          delivered_to: entregado ? (body.recibio ?? '').trim() : null,
          incident_type: entregado ? null : body.motivo,
          incident_notes: (body.nota ?? '').trim() || null,
          ...(key ? { proof_photo_url: key } : {}),
          updated_at: trx.fn.now(),
          updated_by: this.actorId(),
        });
      // Dos personas a la vez: la segunda no pisa a la primera.
      if (!n) return null;
      return trx('logistics.v_trip_stop_closure').where({ recipient_id: recipientId }).first();
    });
    if (!actualizada) {
      if (key) await this.storage.remove(key);
      throw new ConflictException('La parada ya se cerró.');
    }
    this.logger.log(`Parada ${recipientId} cerrada (${body.resultado}) por ${this.actor() ?? '?'}`);
    const shipment = await this.cierre(actualizada.shipment_id);
    return shipment.paradas.find((p) => p.recipient_id === recipientId) as ParadaCierre;
  }

  /**
   * `[EMB.27]` `[EMB.39]` Quién cargó el embarque. Reemplaza la lista. La carga se paga por caja:
   * cajas del embarque × tarifa vigente el día del embarque, repartido en partes iguales a centavos.
   * Cada renglón guarda con qué cajas y qué tarifa se calculó: cambiar la tarifa después no lo mueve.
   */
  async setCargadores(shipmentId: string, body: CargadoresBody): Promise<CierreDeEmbarque> {
    if (!UUID.test(shipmentId)) throw new BadRequestException('shipment_id inválido');
    await this.tk.run(async (trx) => {
      const s: EmbarqueCarga | undefined = await trx('logistics.shipments')
        .where({ id: shipmentId }).whereNull('deleted_at').forUpdate().first(COLS_EMBARQUE);
      if (!s) throw new NotFoundException('Embarque no encontrado');
      if (s.status === 'cancelado') throw new ConflictException('El embarque está cancelado.');

      const carga = await this.cargaDe(trx, s);
      const errs = erroresDeCargadores(body, carga);
      if (errs.length) throw new BadRequestException(errs.join(' '));

      const pagados = await trx('finance.trip_pay_lines as l')
        .join('logistics.load_details as ld', 'ld.id', 'l.source_id')
        .join('finance.expense_proofs as p', 'p.id', 'l.expense_proof_id')
        .where({ 'l.source': 'carga', 'l.vigente': true, 'ld.shipment_id': shipmentId })
        .whereNot('p.status', 'rechazada')
        .count<{ n: string }[]>('* as n');
      if (Number(pagados[0]?.n ?? 0) > 0) {
        throw new ConflictException('La carga de este embarque ya está en un vale: no se puede cambiar.');
      }

      const ids = body.driver_ids;
      if (ids.length) {
        const personas = await trx('logistics.drivers')
          .whereIn('id', ids)
          .whereNull('deleted_at')
          .where({ active: true, status: 'activo' })
          .select('id');
        if (personas.length !== ids.length) {
          throw new BadRequestException('Hay un cargador que no existe o no está activo en el padrón.');
        }
      }

      await trx('logistics.load_details').where({ shipment_id: shipmentId }).del();
      if (ids.length) {
        const partes = repartoDeCarga(carga.total ?? 0, ids.length);
        await trx('logistics.load_details').insert(
          ids.map((driver_id, i) => ({
            tenant_id: trx.raw('public.current_tenant_id()'),
            shipment_id: shipmentId,
            driver_id,
            rate: partes[i],
            boxes: carga.cajas,
            rate_per_box: carga.tarifa_por_caja,
            role_at_time: 'cargador',
            created_by: this.actorId(),
          })),
        );
        this.logger.log(`Carga ${shipmentId}: ${carga.cajas} cajas × $${carga.tarifa_por_caja} = $${carga.total} entre ${ids.length} (${this.actor() ?? '?'})`);
      }
    });
    return this.cierre(shipmentId);
  }

  private async cargadoresDe(trx: Knex.Transaction, shipmentId: string): Promise<CargadorRegistrado[]> {
    const rows = await trx('logistics.load_details as ld')
      .join('logistics.drivers as d', 'd.id', 'ld.driver_id')
      .leftJoin('finance.trip_pay_lines as l', function (this: Knex.JoinClause) {
        this.on('l.source_id', '=', 'ld.id').andOn('l.driver_id', '=', 'ld.driver_id')
          .andOn(trx.raw("l.source = 'carga'")).andOn(trx.raw('l.vigente'));
      })
      .leftJoin('finance.expense_proofs as p', 'p.id', 'l.expense_proof_id')
      .where('ld.shipment_id', shipmentId)
      .orderBy('d.full_name')
      .select('ld.id', 'ld.driver_id', 'd.full_name as persona', 'ld.rate',
        trx.raw("(l.id IS NOT NULL AND COALESCE(p.status,'') <> 'rechazada') AS pagado"));
    return (rows as FilaCargador[]).map((r) => ({
      id: r.id, driver_id: r.driver_id, persona: r.persona, rate: Number(r.rate), pagado: !!r.pagado,
    }));
  }

  /** `[EMB.39]` Tarifa vigente el día del embarque × cajas del embarque. */
  private async cargaDe(trx: Knex.Transaction, s: EmbarqueCarga): Promise<CargaDelEmbarque> {
    const [tarifa, cajas] = await Promise.all([this.tarifaCargaEl(trx, dia(s.shipment_date)), this.cajasDe(trx, s)]);
    return {
      tarifa_por_caja: tarifa,
      cajas: cajas?.cajas ?? null,
      fuente_cajas: cajas?.fuente ?? null,
      total: totalDeCarga(cajas?.cajas ?? null, tarifa),
    };
  }

  /**
   * `[EMB.39]` La tarifa por caja que estaba vigente ese día, derivada de `logistics.tariff_changes`
   * (EMB.28.1): un cambio de tarifa aplica desde el día en que se hizo, no hacia atrás.
   */
  private async tarifaCargaEl(trx: Knex.Transaction, diaEmbarque: string | null): Promise<number | null> {
    if (!diaEmbarque) return null;
    const t = await this.tarifaCarga(trx);
    return t ? tarifaVigenteEl(t.row, t.cambios, diaEmbarque) : null;
  }

  /** `[EMB.47]` La tarifa por caja con su bitácora, para evaluarla día por día sin volver a la base. */
  private async tarifaCarga(trx: Knex.Transaction): Promise<TarifaConBitacora | null> {
    const row = await trx('logistics.config_finance').where({ key: TARIFA_CARGA_CAJA_KEY }).first('id', 'value', 'active');
    if (!row) return null;
    const cambios: CambioRegistrado[] = await trx('logistics.tariff_changes')
      .where({ entity: 'config', entity_id: row.id })
      // `*` y no la lista: `effective_from` (EMB.49) puede no existir todavía; así no truena antes ni después.
      .select('*');
    return { row, cambios };
  }

  /**
   * `[EMB.39]` Cajas del embarque. Si salió de Kepler: Σ de las cajas (presentación CJA/BTO) de
   * las paradas de la guía que pagan, leídas en vivo — `[EMB.47]` sin las cargas a camión de ruta,
   * que no pagan por caja. Si es manual: las capturadas. `null` = no se sabe; un embarque de Kepler
   * con sólo piezas sueltas tiene 0 cajas, que es un dato, no un hueco.
   */
  private async cajasDe(trx: Knex.Transaction, s: EmbarqueCarga): Promise<{ cajas: number; fuente: 'kepler' | 'captura' } | null> {
    if (s.kepler_sucursal && s.kepler_guia) {
      // Dos pasos con constantes, a propósito: un LATERAL contra `erp_shipment_stop_load` no baja
      // serie/folio al índice de kdm2 y recorre TODOS los embarques de la sucursal por parada
      // (medido 2026-10-24: guía de 30 paradas, 1.7–6 s; así, 15 ms con el mismo resultado).
      const paradas: FilaParadaKepler[] = (await trx('analytics.erp_shipment_stops')
        .where({ sucursal: s.kepler_sucursal, guia_embarque: s.kepler_guia })
        .distinct('serie', 'folio', 'cliente_code'))
        .map((p: Pick<FilaParadaKepler, 'serie' | 'folio' | 'cliente_code'>) => ({
          ...p, sucursal: s.kepler_sucursal as string, guia_embarque: s.kepler_guia as string, destino_nombre: null,
        }));
      if (!paradas.length) return null;
      const renglones: FilaCajasKepler[] = (await trx('analytics.erp_shipment_stop_load')
        .where({ sucursal: s.kepler_sucursal })
        .whereIn('serie', [...new Set(paradas.map((p) => Number(p.serie)))])
        .whereIn('folio', [...new Set(paradas.map((p) => p.folio))])
        .select('serie', 'folio', 'cajas'))
        .map((r: Omit<FilaCajasKepler, 'sucursal'>) => ({ ...r, sucursal: s.kepler_sucursal as string }));
      // Sin renglones en Kepler, las cajas no se saben (null); con piezas sueltas, son 0 de verdad.
      const cajas = cajasPorGuia(paradas, renglones).get(`${s.kepler_sucursal}|${s.kepler_guia}`) ?? null;
      return cajas == null ? null : { cajas, fuente: 'kepler' };
    }
    const capturadas = Number(s.boxes_count ?? 0);
    return capturadas > 0 ? { cajas: capturadas, fuente: 'captura' } : null;
  }

  private async urlDe(key: string | null): Promise<string | null> {
    if (!key) return null;
    if (/^https?:\/\//i.test(key)) return key;
    const url = await this.storage.signedUrl(key).catch(() => '');
    return url || null;
  }
}

export function aPagoViaje(r: FilaPago): PagoViaje {
  return {
    source: r.source,
    source_id: r.source_id,
    shipment_id: r.shipment_id,
    shipment_folio: r.shipment_folio,
    kepler_sucursal: r.kepler_sucursal,
    kepler_guia: r.kepler_guia,
    shipment_date: dia(r.shipment_date) as string,
    guide_number: r.guide_number,
    driver_id: r.driver_id,
    persona: r.persona,
    rol: r.rol,
    concept: r.concept,
    amount: Number(r.amount),
    estado_viaje: r.estado_viaje,
    liberado: !!r.liberado,
    motivo: r.motivo,
    en_vale: !!r.en_vale,
    expense_proof_id: r.expense_proof_id,
    vale_status: r.vale_status,
    vale_folio: r.vale_folio,
  };
}
