/**
 * EMB.12 — Reglas puras de «Nuevo embarque desde Kepler».
 *
 * Viven aparte del servicio para poder probarlas sin base de datos: cada una decide un número
 * o un nombre que se le enseña al usuario, y un error ahí no truena — publica otra cosa.
 *
 * Contexto (medido en Kepler, ver la migración 20261006210000):
 *   · la GUÍA (`kdm1.c86`) es el viaje; cada U-D-41 dentro de ella es una PARADA;
 *   · serie 1 = «Embarque Telemarketing» (a cliente), serie 2 = «Embarque Sucursal» (traspaso a
 *     una sucursal `TI###` o carga del camión de ruta `RUTA 21`/`RD 501`);
 *   · los catálogos de Kepler reusan claves cortas: normalizar a ciegas atribuye mal (EMB.0.1).
 *
 * Las formas que viajan al front (tipo de viaje, resumen, comisión) son las del contrato
 * `@megadulces/contracts` (ADR-052): acá son alias, no una segunda definición que pueda divergir.
 */
import type {
  KeplerDestinoTipo, KeplerMetodoResolucion, NuevoEmbarqueComision, NuevoEmbarqueResumen,
  NuevoEmbarqueTipoViaje,
} from '@megadulces/contracts';

export type MetodoResolucion = KeplerMetodoResolucion;

export interface EntradaCatalogo {
  codigo: string;
  nombre: string | null;
}

export interface Resolucion {
  codigo: string | null;
  nombre: string | null;
  /** null = el documento no traía código; no es lo mismo que no haberlo encontrado. */
  metodo: MetodoResolucion | null;
}

/**
 * Un `date` de Postgres como `YYYY-MM-DD`.
 *
 * ⛔ NUNCA `String(fecha).slice(0, 10)`: node-postgres entrega el `date` como un `Date` a la
 * medianoche LOCAL, y `String()` lo pinta como «Sat Oct 03» (LC.16 cobró exactamente esto). Las
 * partes locales recuperan el día que guardó la base, en cualquier zona horaria del servidor.
 */
export function fechaISO(v: Date | string | null | undefined): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (x: number) => String(x).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : null;
}

/** `'00017'` → `'17'`. Vacío o sólo ceros → null. */
export function claveNormalizada(code?: string | null): string | null {
  if (code == null) return null;
  const c = String(code).trim().replace(/^0+/, '');
  return c === '' ? null : c;
}

const limpiarNombre = (s: string | null | undefined) =>
  (s ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

/**
 * Resuelve un código de documento contra un catálogo de Kepler: **exacto → normalizado → nada**.
 *
 * El literal manda porque es lo que el ERP guardó. Sólo si no existe se prueba la clave sin
 * ceros, y si esa clave lleva a DOS nombres distintos (en checadores, `1` = JUAN DIEGO y `01` =
 * IRENE) se declara `ambiguo` en vez de escoger uno: un nombre equivocado es peor que ninguno.
 */
export function resolverPorCodigo(code: string | null | undefined, catalogo: EntradaCatalogo[]): Resolucion {
  const literal = code == null ? '' : String(code).trim();
  if (!literal) return { codigo: null, nombre: null, metodo: null };

  const exacto = catalogo.find((e) => e.codigo.trim() === literal);
  if (exacto) return { codigo: exacto.codigo.trim(), nombre: exacto.nombre, metodo: 'exacto' };

  const clave = claveNormalizada(literal);
  const candidatos = catalogo.filter((e) => claveNormalizada(e.codigo) === clave);
  const nombres = new Set(candidatos.map((e) => limpiarNombre(e.nombre)).filter(Boolean));
  if (candidatos.length && nombres.size <= 1) {
    return { codigo: candidatos[0].codigo.trim(), nombre: candidatos[0].nombre, metodo: 'normalizado' };
  }
  if (nombres.size > 1) return { codigo: literal, nombre: null, metodo: 'ambiguo' };
  return { codigo: literal, nombre: null, metodo: 'sin_resolver' };
}

// ── Tipo de viaje ─────────────────────────────────────────────────────────────────────────

export type DestinoTipo = KeplerDestinoTipo;

/** A qué va una parada. La serie 2 mezcla dos operaciones, y el código del destino las separa. */
export function destinoTipo(serie: number, clienteCode?: string | null): DestinoTipo {
  if (Number(serie) === 1) return 'cliente';
  const c = (clienteCode ?? '').trim().toUpperCase();
  if (/^(RUTA|RD)\b/.test(c) || /^(RUTA|RD)\s*\d/.test(c)) return 'ruta';
  return 'sucursal';
}

export type TipoDeViaje = NuevoEmbarqueTipoViaje;

export function tipoDeViaje(paradas: Array<{ serie: number; cliente_code?: string | null }>): TipoDeViaje {
  const destinos: Record<DestinoTipo, number> = { cliente: 0, sucursal: 0, ruta: 0 };
  for (const p of paradas) destinos[destinoTipo(p.serie, p.cliente_code)]++;
  const tipos = (Object.keys(destinos) as DestinoTipo[]).filter((k) => destinos[k] > 0);
  const mixto = tipos.length > 1;
  const tipo = destinos.cliente > 0 ? 'entrega' : 'traspaso';
  const nombres: Record<DestinoTipo, string> = {
    cliente: 'Entrega a cliente', sucursal: 'Traspaso a sucursal', ruta: 'Carga a camión de ruta',
  };
  const etiqueta = mixto
    ? tipos.map((t) => nombres[t]).join(' + ')
    : (tipos.length ? nombres[tipos[0]] : 'Sin paradas');
  return { tipo, etiqueta, mixto, destinos };
}

// ── Paradas: orden y resumen ──────────────────────────────────────────────────────────────

export interface ParadaKepler {
  serie: number;
  folio: string;
  cliente_code?: string | null;
  destino_nombre?: string | null;
  destino_colonia?: string | null;
  destino_ciudad?: string | null;
  destino_estado?: string | null;
  domicilio_calle?: string | null;
  domicilio_ciudad?: string | null;
  ruta_clave?: string | null;
  ruta_nombre?: string | null;
  orden_visita?: number | string | null;
  total?: number | string | null;
  cajas?: number | string | null;
  sueltos?: number | string | null;
  kg?: number | string | null;
  renglones_sin_empaque?: number | string | null;
  facturado?: boolean | null;
  nota_almacen?: string | null;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
/** Suma de dinero en centavos: sumar flotantes de 13 paradas deja colas de 0.0000001. */
const sumaDinero = (xs: Array<number | string | null | undefined>) =>
  xs.reduce<number>((a, v) => a + Math.round(n(v) * 100), 0) / 100;

/** Ruta (alfabético, sin ruta al final) → orden de visita (sin orden al final) → folio. */
export function ordenarParadas<T extends ParadaKepler>(paradas: T[]): T[] {
  const ordenNum = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? Infinity : Number(v));
  return [...paradas].sort((a, b) => {
    const ra = a.ruta_nombre?.trim() || null;
    const rb = b.ruta_nombre?.trim() || null;
    if (ra !== rb) {
      if (ra === null) return 1;
      if (rb === null) return -1;
      return ra.localeCompare(rb, 'es');
    }
    const oa = ordenNum(a.orden_visita);
    const ob = ordenNum(b.orden_visita);
    if (oa !== ob) return oa - ob;
    return a.folio.localeCompare(b.folio);
  });
}

export type ResumenViaje = NuevoEmbarqueResumen;

export function resumirViaje(paradas: ParadaKepler[]): ResumenViaje {
  const rutas = new Map<string, { clave: string; nombre: string | null; paradas: number }>();
  let sinRuta = 0;
  for (const p of paradas) {
    const clave = p.ruta_clave?.trim();
    if (!clave) { sinRuta++; continue; }
    const r = rutas.get(clave) ?? { clave, nombre: p.ruta_nombre ?? null, paradas: 0 };
    r.paradas++;
    rutas.set(clave, r);
  }
  const kgs = paradas.map((p) => p.kg).filter((v) => v != null && v !== '');
  const aCliente = paradas.filter((p) => destinoTipo(p.serie, p.cliente_code) === 'cliente');
  const otras = paradas.filter((p) => destinoTipo(p.serie, p.cliente_code) !== 'cliente');
  return {
    paradas: paradas.length,
    clientes: new Set(paradas.map((p) => p.cliente_code?.trim()).filter(Boolean)).size,
    rutas: [...rutas.values()].sort((a, b) => (a.nombre ?? a.clave).localeCompare(b.nombre ?? b.clave, 'es')),
    paradas_sin_ruta: sinRuta,
    cajas: paradas.reduce((a, p) => a + n(p.cajas), 0),
    sueltos: paradas.reduce((a, p) => a + n(p.sueltos), 0),
    kg_vendido_por_kilo: kgs.length ? Math.round(kgs.reduce<number>((a, v) => a + n(v), 0) * 100) / 100 : null,
    peso_total: null,
    renglones_sin_empaque: paradas.reduce((a, p) => a + n(p.renglones_sin_empaque), 0),
    valor_venta: sumaDinero(aCliente.map((p) => p.total)),
    valor_traspaso: sumaDinero(otras.map((p) => p.total)),
    facturadas: aCliente.filter((p) => p.facturado === true).length,
    paradas_a_cliente: aCliente.length,
  };
}

// ── Comisión sugerida ─────────────────────────────────────────────────────────────────────

export interface RutaSuite {
  id: string;
  name: string;
  kepler_code?: string | null;
  driver_commission: number | string | null;
  helper_commission: number | string | null;
}

/** Sin acentos, mayúsculas, sólo letras y números. `«Sahuayo»` y `SAHUAYO` son la misma ruta. */
export function nombreNormalizado(s?: string | null): string {
  return (s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

export type ComisionSugerida = NuevoEmbarqueComision;

/**
 * La tarifa del viaje para chofer y ayudante, del catálogo de rutas de la Suite: la de MAYOR
 * tarifa entre sus rutas (decisión de Logística 2026-10-07). Ya no es sugerencia: la guía lleva
 * exactamente esto (`comisionesDeLaGuia`), y si una ruta no tiene tarifa no se crea
 * (`erroresDeTarifa`, ambas en el contrato).
 *
 * Se empareja por `kepler_code` y, si no hay, por nombre normalizado EXACTO. Nada de parecido:
 * `SANTAGIO TANGAMNADAPIO` (así está en Kepler) no es `TANGAMANDAPIO` para una máquina, y
 * proponer una tarifa de otra ruta es peor que decir que no hay.
 */
export function comisionSugerida(
  rutasViaje: Array<{ clave: string; nombre: string | null }>,
  catalogo: RutaSuite[],
): ComisionSugerida {
  const emparejadas: ComisionSugerida['emparejadas'] = [];
  const sinTarifa: ComisionSugerida['sin_tarifa'] = [];
  for (const r of rutasViaje) {
    const porCodigo = catalogo.find((c) => c.kepler_code && c.kepler_code.trim() === r.clave.trim());
    const porNombre = porCodigo ? null
      : catalogo.find((c) => nombreNormalizado(c.name) !== '' && nombreNormalizado(c.name) === nombreNormalizado(r.nombre));
    const c = porCodigo ?? porNombre;
    // Emparejada pero con 0/0 tampoco es tarifa: así quedan las rutas que el importador de
    // dimensiones da de alta desde Kepler (medido en local: «SANTAGIO TANGAMNADAPIO» entró con
    // 0/0 y, contada como emparejada, escondía que nadie le ha puesto comisión).
    if (!c || (n(c.driver_commission) === 0 && n(c.helper_commission) === 0)) {
      sinTarifa.push({ clave: r.clave, nombre: r.nombre });
      continue;
    }
    emparejadas.push({
      clave: r.clave, nombre: r.nombre, route_id: c.id,
      metodo: porCodigo ? 'kepler_code' : 'nombre',
      driver: n(c.driver_commission), helper: n(c.helper_commission),
    });
  }
  const elegida = [...emparejadas].sort((a, b) => b.driver - a.driver || b.helper - a.helper)[0] ?? null;
  return {
    driver: elegida ? elegida.driver : null,
    helper: elegida ? elegida.helper : null,
    regla: 'mayor_comision_del_viaje',
    ruta_usada: elegida ? { clave: elegida.clave, nombre: elegida.nombre, route_id: elegida.route_id } : null,
    emparejadas,
    sin_tarifa: sinTarifa,
  };
}

// ── Toma del viaje ────────────────────────────────────────────────────────────────────────

export interface TomaInput {
  delivery_type?: string | null;
  freight_revenue?: number | null;
  actual_km?: number | null;
  total_weight_kg?: number | null;
  notes?: string | null;
  /**
   * EMB.22 — NO se aceptan al tomar el viaje: la tripulación, el horario y los montos de la guía se
   * capturan sólo en la pestaña Guías («Completar guía»). Están declarados para RECHAZARLOS.
   */
  driver_id?: string | null;
  helper1_id?: string | null;
  helper2_id?: string | null;
  departure_time?: string | null;
  arrival_time?: string | null;
  overnight?: boolean | null;
  driver_commission?: number | null;
  helper1_commission?: number | null;
  helper2_commission?: number | null;
  per_diem_total?: number | null;
  per_diem_breakdown?: unknown;
}

/** Lo que se captura en Guías y por eso no entra al tomar el viaje. */
const SE_CAPTURA_EN_GUIAS: ReadonlyArray<keyof TomaInput> = [
  'driver_id', 'helper1_id', 'helper2_id', 'departure_time', 'arrival_time', 'overnight',
  'driver_commission', 'helper1_commission', 'helper2_commission', 'per_diem_total', 'per_diem_breakdown',
];
export const TRIPULACION_EN_GUIAS = 'La tripulación, el horario, la comisión y los viáticos se capturan en la pestaña Guías del embarque, no al tomar el viaje.';

export interface TomaContexto {
  /** Folio del embarque que ya tomó esta guía, si existe. */
  ya_tomado_folio: string | null;
}

/**
 * Errores en lenguaje del usuario. Lista vacía = se puede tomar.
 *
 * EMB.22 — Tomar el viaje sólo registra lo del EMBARQUE (tipo de entrega, flete, km, peso, notas).
 * La guía nace con lo que Kepler tiene (el chofer, si lo trae) y lo que Kepler no tiene se completa
 * en Guías: ahí se valida la tarifa de las rutas y el horario, y se calculan comisión y viáticos.
 */
export function validarToma(input: TomaInput, ctx: TomaContexto): string[] {
  const errores: string[] = [];
  if (ctx.ya_tomado_folio) {
    errores.push(`Este viaje ya se tomó en el embarque ${ctx.ya_tomado_folio}.`);
  }
  if (!input.delivery_type || !['route', 'long_trip'].includes(input.delivery_type)) {
    errores.push('Indica si la entrega es por ruta o viaje largo.');
  }
  if (SE_CAPTURA_EN_GUIAS.some((k) => input[k] != null && input[k] !== false && input[k] !== '')) {
    errores.push(TRIPULACION_EN_GUIAS);
  }

  const montos: Array<[keyof TomaInput, string]> = [
    ['freight_revenue', 'El flete cobrado'],
    ['total_weight_kg', 'El peso'],
  ];
  for (const [k, etiqueta] of montos) {
    const v = input[k];
    if (v == null) continue;
    if (!Number.isFinite(Number(v)) || Number(v) < 0) errores.push(`${etiqueta} debe ser un número mayor o igual a cero.`);
  }
  if (input.actual_km != null && (!Number.isInteger(Number(input.actual_km)) || Number(input.actual_km) < 0)) {
    errores.push('Los kilómetros deben ser un número entero mayor o igual a cero.');
  }
  return errores;
}

export interface DestinatarioGuia {
  customer_name: string;
  address: string | null;
  boxes_count: number;
  value: number;
  kepler_folio: string;
  kepler_serie: string;
  kepler_warehouse_code: string;
  notes: string | null;
}

/**
 * Las paradas como destinatarios de la guía de la Suite: es la HOJA que el chofer lleva y
 * donde captura la entrega (foto, quién recibió, GPS). Kepler no registra entregas, la Suite sí.
 *
 * Cajas y valor se guardan como lo que se le ENTREGÓ al chofer al salir: es un acuse, y un acuse
 * no puede cambiar si mañana alguien corrige el documento en Kepler.
 */
export function armarDestinatarios(paradas: ParadaKepler[], sucursal: string): DestinatarioGuia[] {
  return ordenarParadas(paradas).map((p) => ({
    customer_name: (p.destino_nombre || p.cliente_code || 'Sin nombre en Kepler').slice(0, 200),
    address: [p.domicilio_calle || p.destino_colonia, p.domicilio_ciudad || p.destino_ciudad, p.destino_estado]
      .map((x) => (x ?? '').trim()).filter(Boolean).join(', ') || null,
    boxes_count: Math.round(n(p.cajas)),
    value: Math.round(n(p.total) * 100) / 100,
    kepler_folio: p.folio,
    kepler_serie: String(p.serie),
    kepler_warehouse_code: sucursal,
    notes: p.nota_almacen?.trim() || null,
  }));
}
