import {
  diaIso, diasEntre, ESCALON1_COMPRA_PCT, ESCALON1_OCS_PCT, ESCALONES_LLENADO, estadoDeRegla, PERIODOS_DIA_FIJO, sumarDias, VENTANA_REZAGO_DIAS,
  type AlcanceDeQuienVe, type AvanceDelEmbudo, type CambioDeRegla, type EmbudoLlenado, type EscalonLlenado, type PesoProveedor, type CalendarioCompras, type EstadoRevision, type FuenteActividad, type MarcaVista, type PropuestaDiaFijo,
  type ReglaCalendario, type ReglaRevision, type ZonaDeCompra,
} from '@megadulces/contracts';

/**
 * `[PQ.3.3]` El calendario de compras sin base de datos: qué plazas cubre cada alcance, qué actividad
 * de Kepler le toca a cada regla y el armado de la respuesta. Puras, para probarlas sin Postgres; el
 * SQL vive en `purchase-calendar.sql.ts` y se prueba contra base real.
 */

/** Un renglón de `SQL_ACTIVIDAD_KEPLER`: lo que Kepler dice de un proveedor en una plaza. */
export interface FilaActividad {
  readonly supplier_code: string;
  readonly plaza: string;
  /** Días con actividad dentro de la ventana de rezago. */
  readonly fechas: readonly string[];
  /** La última actividad (OC hasta un año; entrada dentro de su ventana). */
  readonly ultima: string;
  readonly ultima_fuente: Exclude<FuenteActividad, 'marca'>;
}

/** Un renglón de `SQL_SUCURSALES_Y_ZONAS`. */
export interface SucursalZona {
  readonly branch_code: string;
  readonly branch_name: string | null;
  readonly branch_short: string | null;
  readonly zona_code: string | null;
  readonly zona_nombre: string | null;
}

type Alcance = Pick<ReglaRevision, 'scope' | 'zone_code' | 'branch_code'>;

/** Las plazas que cubre un alcance. `null` = todas (corporativo). */
export function plazasDelAlcance(r: Alcance, sucursales: readonly SucursalZona[]): ReadonlySet<string> | null {
  if (r.scope === 'corporate') return null;
  if (r.scope === 'branch') return new Set(r.branch_code ? [r.branch_code] : []);
  return new Set(sucursales.filter((s) => s.zona_code && s.zona_code === r.zone_code).map((s) => s.branch_code));
}

/** «Todas las sucursales» · «Zona Zamora» · «Yurécuaro». Nunca un código pelón si hay nombre. */
export function nombreDelAlcance(r: Alcance, sucursales: readonly SucursalZona[]): string {
  if (r.scope === 'corporate') return 'Todas las sucursales';
  if (r.scope === 'zone') {
    const z = sucursales.find((s) => s.zona_code === r.zone_code);
    return z?.zona_nombre ? `Zona ${z.zona_nombre}` : `Zona ${r.zone_code}`;
  }
  const s = sucursales.find((x) => x.branch_code === r.branch_code);
  return s?.branch_name ?? `Sucursal ${r.branch_code}`;
}

/** Quién revisa cuando la regla no nombra a nadie: el puesto del alcance (anexo C §10.1). */
export function revisaPorAlcance(r: Alcance, sucursales: readonly SucursalZona[]): string {
  if (r.scope === 'corporate') return 'Gerencia de compras';
  if (r.scope === 'zone') return `Gerencia de zona (${nombreDelAlcance(r, sucursales)})`;
  return `Encargado de ${nombreDelAlcance(r, sucursales)}`;
}

/** La actividad de Kepler que le toca a UNA regla: la de su proveedor, en las plazas de su alcance. */
export function actividadDeLaRegla(
  r: Alcance & Pick<ReglaRevision, 'supplier_code'>,
  filas: readonly FilaActividad[],
  sucursales: readonly SucursalZona[],
): { readonly fechas: string[]; readonly ultima: { readonly fecha: string; readonly fuente: FuenteActividad } | null } {
  const plazas = plazasDelAlcance(r, sucursales);
  const suyas = filas.filter((f) => f.supplier_code === r.supplier_code && (plazas === null || plazas.has(f.plaza)));
  const fechas = [...new Set(suyas.flatMap((f) => f.fechas))].sort();
  const ultima = suyas.reduce<FilaActividad | null>((m, f) => (!m || f.ultima > m.ultima ? f : m), null);
  return { fechas, ultima: ultima ? { fecha: ultima.ultima, fuente: ultima.ultima_fuente } : null };
}

/**
 * `[PQ.3.14]` Día fijo de un proveedor en una plaza — cuándo se propone (anexo C §10.2, medido en prod el
 * 2026-11-21 con la actividad de 12 meses de las 340 claves):
 * - al menos `DIA_FIJO_MIN_DIAS` días con orden o entrada en 12 meses (con menos, cualquier día «es fijo»);
 * - al menos el 70 % de esos días en el MISMO día de la semana (es el umbral con el que se midieron los 16
 *   pares de §10.2, y donde el 84 % de las OC cae ese día: el proveedor pasa, se le pide y entrega);
 * - el periodo es la MEDIANA entre esos días: 7, 14, 21 o 28. Otra (un par da 49) no es un día fijo;
 * - y SIGUE con ese ritmo: en las últimas 13 semanas cayó en ese día al menos la mitad de las veces que le
 *   tocaba. Sin esto se colaba un par con racha semanal en abril y nada después: con la regla puesta habría
 *   amanecido rezagado 97 de cada 100 días (control con `estadoDeRegla`, 180 días).
 * Con eso salen 12 reglas de sucursal para 10 proveedores (8 cada semana, 2 cada 14, 1 cada 21 y 1 cada 28); por
 * el ritmo reciente quedan fuera 2, y 1 por periodo irregular.
 */
export const DIA_FIJO_MIN_DIAS = 8;
export const DIA_FIJO_MIN_PARTE = 0.7;
/** La ventana del ritmo reciente: 13 semanas. */
export const DIA_FIJO_RECIENTE_DIAS = 91;

export type DiaFijoMedido =
  | ({ readonly motivo: null } & Omit<PropuestaDiaFijo, 'branch_code'>)
  | { readonly motivo: 'pocos_dias' | 'sin_dia_fijo' | 'periodo_irregular' | 'sin_ritmo_reciente' };

/** El día fijo de UNA plaza, de sus días con actividad (12 meses). Pura. */
export function diaFijoDeActividad(fechas: readonly string[], hoy: string): DiaFijoMedido {
  const f = [...new Set(fechas)].sort();
  if (f.length < DIA_FIJO_MIN_DIAS) return { motivo: 'pocos_dias' };
  const cuenta = new Array<number>(8).fill(0);
  for (const x of f) cuenta[diaIso(x)] += 1;
  let weekday = 1;
  for (let d = 2; d <= 7; d++) if (cuenta[d] > cuenta[weekday]) weekday = d;
  const enElDia = f.filter((x) => diaIso(x) === weekday);
  if (enElDia.length < DIA_FIJO_MIN_PARTE * f.length) return { motivo: 'sin_dia_fijo' };
  const pasos = enElDia.slice(1).map((x, i) => diasEntre(enElDia[i], x)).sort((a, b) => a - b);
  const mediana = pasos[Math.floor((pasos.length - 1) / 2)];
  const periodo = PERIODOS_DIA_FIJO.find((p) => p === mediana);
  if (!periodo) return { motivo: 'periodo_irregular' };
  const recientes = enElDia.filter((x) => diasEntre(x, hoy) < DIA_FIJO_RECIENTE_DIAS && diasEntre(x, hoy) >= 0).length;
  const esperadas = Math.floor(DIA_FIJO_RECIENTE_DIAS / periodo);
  if (2 * recientes < esperadas) return { motivo: 'sin_ritmo_reciente' };
  return {
    motivo: null, weekday, every_days: periodo, dias: f.length, en_el_dia: enElDia.length,
    recientes: { en_el_dia: recientes, esperadas }, ultima: f[f.length - 1],
  };
}

/**
 * `[PQ.3.14]` Las reglas de sucursal que se proponen, por proveedor. Sólo en sucursales con zona: en el CEDIS el
 * día fijo es el de RECEPCIÓN, no el de revisión (R7: 28 de 31 caen en miércoles y sólo el 37 % de las OC ese
 * día), y una plaza que no es sucursal no puede llevar regla.
 */
export function diasFijosPorProveedor(
  filas: readonly Pick<FilaActividad, 'supplier_code' | 'plaza' | 'fechas'>[],
  sucursales: readonly SucursalZona[],
  hoy: string,
): Map<string, PropuestaDiaFijo[]> {
  const conZona = new Set(sucursales.filter((s) => s.zona_code).map((s) => s.branch_code));
  const out = new Map<string, PropuestaDiaFijo[]>();
  for (const fila of filas) {
    if (!conZona.has(fila.plaza)) continue;
    const m = diaFijoDeActividad(fila.fechas, hoy);
    if (m.motivo !== null) continue;
    const { motivo: _m, ...p } = m;
    const lista = out.get(fila.supplier_code) ?? [];
    lista.push({ branch_code: fila.plaza, ...p });
    out.set(fila.supplier_code, lista);
  }
  for (const lista of out.values()) lista.sort((a, b) => a.branch_code.localeCompare(b.branch_code));
  return out;
}

/**
 * `[PQ.3.14]` Reparte las propuestas: «sin regla» = los proveedores sin ninguna regla viva, con todo su día fijo;
 * «pendiente» = los que YA tienen alguna regla y aún tienen día fijo en una sucursal sin SU regla de sucursal.
 * Una regla de zona o corporativa no cubre la de sucursal (§10.1: no se suman), así que no la borra.
 */
export function repartirPropuestas<T extends { readonly supplier_code: string; readonly reglas_vivas: number }>(
  todos: readonly (T & { readonly con_regla_de_sucursal: readonly string[] })[],
  dias: ReadonlyMap<string, readonly PropuestaDiaFijo[]>,
): { sin_regla: (T & { dias_fijos: PropuestaDiaFijo[] })[]; dia_fijo_pendiente: (T & { dias_fijos: PropuestaDiaFijo[] })[] } {
  const con = todos.map(({ con_regla_de_sucursal, ...p }) => {
    const tiene = new Set(con_regla_de_sucursal);
    return { ...(p as unknown as T), dias_fijos: (dias.get(p.supplier_code) ?? []).filter((d) => !tiene.has(d.branch_code)) };
  });
  return {
    sin_regla: con.filter((p) => p.reglas_vivas === 0),
    dia_fijo_pendiente: con.filter((p) => p.reglas_vivas > 0 && p.dias_fijos.length > 0),
  };
}

/** `[PQ.3.18]` Lo que el embudo necesita de cada proveedor del universo (la vista PQ.3.1). */
export interface FilaEmbudo {
  readonly supplier_code: string;
  readonly proposal_status: string;
  readonly reglas_vivas: number;
  /** Tiene día fijo en alguna sucursal (PQ.3.14): su regla ya viene armada, no es «ocasional». */
  readonly con_dia_fijo: boolean;
}

/** `[PQ.3.18]` La compra de 12 meses de un proveedor: monto y número de sus OC vivas. */
export interface CompraDoceMeses {
  readonly monto: number;
  readonly ocs: number;
}

const unDecimal = (x: number): number => Math.round(x * 10) / 10;
const OCASIONAL = new Set(['pocas_compras', 'una_compra']);

/**
 * `[PQ.3.18]` El embudo de llenado (anexo C §10.10), puro. Escalón 1 = los que, de mayor a menor, juntan el 80 % de la
 * COMPRA **o** el 50 % de las OC (dinero y operaciones no ordenan igual); 3 = ocasionales (una o pocas compras, sin
 * día fijo); 2 = el resto. El escalón es del proveedor, no de si ya tiene regla: así el avance de cada escalón no se
 * mueve de lugar al llenarse. `compra = null` = no se pudo leer: se cuentan proveedores y reglas, y nada más.
 */
export function armarEmbudo(
  filas: readonly FilaEmbudo[],
  compra: ReadonlyMap<string, CompraDoceMeses> | null,
): { readonly peso: ReadonlyMap<string, PesoProveedor>; readonly embudo: EmbudoLlenado } {
  const conRegla = (f: FilaEmbudo) => f.reglas_vivas > 0;
  if (!compra) {
    return {
      peso: new Map(),
      embudo: {
        measured: false,
        note: 'No se pudo leer la compra de 12 meses: el peso de cada proveedor no se midió y la lista va en el orden de Kepler.',
        total: { escalon: null, proveedores: filas.length, con_regla: filas.filter(conRegla).length, compra_pct: null, compra_con_regla_pct: null, ocs_pct: null, ocs_con_regla_pct: null },
        escalones: [],
      },
    };
  }
  const de = (f: FilaEmbudo): CompraDoceMeses => compra.get(f.supplier_code) ?? { monto: 0, ocs: 0 };
  const totalMonto = filas.reduce((a, f) => a + Math.max(0, de(f).monto), 0);
  const totalOcs = filas.reduce((a, f) => a + Math.max(0, de(f).ocs), 0);
  // Los primeros que, de mayor a menor, juntan el umbral: entra el que empieza ANTES de cruzarlo.
  const primeros = (valor: (f: FilaEmbudo) => number, total: number, umbral: number): Set<string> => {
    const out = new Set<string>();
    if (total <= 0) return out;
    let acum = 0;
    for (const f of [...filas].sort((a, b) => valor(b) - valor(a) || a.supplier_code.localeCompare(b.supplier_code))) {
      if ((100 * acum) / total >= umbral || valor(f) <= 0) break;
      out.add(f.supplier_code);
      acum += valor(f);
    }
    return out;
  };
  const porCompra = primeros((f) => Math.max(0, de(f).monto), totalMonto, ESCALON1_COMPRA_PCT);
  const porOcs = primeros((f) => Math.max(0, de(f).ocs), totalOcs, ESCALON1_OCS_PCT);
  const escalonDe = (f: FilaEmbudo): EscalonLlenado =>
    porCompra.has(f.supplier_code) || porOcs.has(f.supplier_code) ? 1 : OCASIONAL.has(f.proposal_status) && !f.con_dia_fijo ? 3 : 2;
  const pct = (x: number, t: number): number => (t > 0 ? unDecimal((100 * x) / t) : 0);
  const peso = new Map<string, PesoProveedor>(filas.map((f) => [f.supplier_code, {
    escalon: escalonDe(f), compra_pct: pct(Math.max(0, de(f).monto), totalMonto), ocs_12m: Math.max(0, de(f).ocs),
  }]));
  const avance = (escalon: EscalonLlenado | null, xs: readonly FilaEmbudo[]): AvanceDelEmbudo => {
    const con = xs.filter(conRegla);
    const suma = (ys: readonly FilaEmbudo[], k: keyof CompraDoceMeses) => ys.reduce((a, f) => a + Math.max(0, de(f)[k]), 0);
    return {
      escalon, proveedores: xs.length, con_regla: con.length,
      compra_pct: pct(suma(xs, 'monto'), totalMonto), compra_con_regla_pct: pct(suma(con, 'monto'), totalMonto),
      ocs_pct: pct(suma(xs, 'ocs'), totalOcs), ocs_con_regla_pct: pct(suma(con, 'ocs'), totalOcs),
    };
  };
  return {
    peso,
    embudo: {
      measured: true, note: null, total: avance(null, filas),
      escalones: ESCALONES_LLENADO.map((e) => avance(e, filas.filter((f) => peso.get(f.supplier_code)?.escalon === e))),
    },
  };
}

/**
 * Desde cuándo leer ENTRADAS de Kepler (la parte cara de la consulta): la ventana de rezago o, si una
 * regla «cada N días» es más larga, N + 7 días, para que su ancla no se quede fuera.
 */
export function desdeEntradas(hoy: string, reglas: readonly Pick<ReglaRevision, 'pattern' | 'every_n_days'>[]): string {
  const maxN = Math.max(0, ...reglas.filter((r) => r.pattern === 'every_n_days').map((r) => r.every_n_days ?? 0));
  return sumarDias(hoy, -Math.max(VENTANA_REZAGO_DIAS, maxN + 7));
}

/** Una regla tal como la lee el repositorio (más su nombre de proveedor y quién la definió). */
export interface ReglaLeida extends ReglaRevision {
  readonly supplier_name: string | null;
  readonly reviewer_name: string | null;
  readonly definida_por: string | null;
  readonly definida_el: string;
  /** Día (México) de la última modificación: la regla no debe fechas de antes. */
  readonly vigente_desde: string;
  /** `[PQ.3.17]` ¿Se tocó después de crearla? (`updated_at` > `created_at`: un alta deja los dos iguales). */
  readonly fue_cambiada?: boolean;
  /** `[PQ.3.17]` Quién la tocó por última vez (`updated_by`) y cuándo (UTC). */
  readonly cambiada_por?: string | null;
  readonly cambiada_el?: string;
  readonly note: string | null;
  /** La ficha con productos en Pedido para esta clave (R5); `null` si no hay. */
  readonly pedido_supplier_id: string | null;
}

/**
 * `[PQ.3.17]` Lo leído de `analytics.master_data_history`: los cambios de cada regla (el más nuevo primero) y
 * cuántos tiene en total. `measured: false` = no se pudo leer (o el disparador no está): se DICE, no se pinta vacío.
 */
export interface HistorialLeido {
  readonly measured: boolean;
  readonly note: string | null;
  readonly por: ReadonlyMap<string, { readonly cambios: readonly CambioDeRegla[]; readonly total: number }>;
}

/** Un almacén de Pedido (`commercial.warehouses`) por código de sucursal. */
export interface AlmacenPedido {
  readonly id: string;
  readonly code: string;
}

/** Las zonas de compra con sus sucursales, en el orden de las sucursales. */
export function zonasDeCompra(sucursales: readonly SucursalZona[]): ZonaDeCompra[] {
  const m = new Map<string, { nombre: string; sucursales: string[] }>();
  for (const s of sucursales) {
    if (!s.zona_code) continue;
    const z = m.get(s.zona_code) ?? { nombre: s.zona_nombre ?? s.zona_code, sucursales: [] };
    z.sucursales.push(s.branch_code);
    m.set(s.zona_code, z);
  }
  return [...m].map(([code, z]) => ({ code, nombre: z.nombre, sucursales: z.sucursales }));
}

/** Los almacenes de Pedido del alcance de la regla; vacío = todos (corporativo). */
export function almacenesDelAlcance(r: Alcance, sucursales: readonly SucursalZona[], almacenes: readonly AlmacenPedido[]): string[] {
  const plazas = plazasDelAlcance(r, sucursales);
  return plazas === null ? [] : almacenes.filter((a) => plazas.has(a.code)).map((a) => a.id);
}

/**
 * `[PQ.3.6]` ¿Cabe la regla en las sucursales de una persona? `permitidas = null` = todas (su alcance es `all`).
 *
 * Cabe si TODAS las plazas de la regla son suyas (anexo C §10.1, «la sucursal sólo ve las suyas»): el encargado
 * de Yurécuaro ve la regla de Yurécuaro, no la de su zona ni la corporativa, que revisan otros; la gerencia de
 * una zona ve la de su zona y las de sus sucursales; la corporativa, sólo quien ve todas. Una regla sin plazas
 * (zona sin sucursales) no cabe en nadie con alcance recortado: fail-closed.
 */
export function reglaEnAlcance(r: Alcance, sucursales: readonly SucursalZona[], permitidas: readonly string[] | null): boolean {
  if (permitidas === null) return true;
  const plazas = plazasDelAlcance(r, sucursales) ?? new Set(sucursales.map((s) => s.branch_code));
  if (!plazas.size) return false;
  const suyas = new Set(permitidas);
  for (const p of plazas) if (!suyas.has(p)) return false;
  return true;
}

/** `[PQ.3.6]` Lo que se le dice a quien ve: todas, o sus sucursales conocidas, en orden. */
export function alcanceDeQuienVe(sucursales: readonly SucursalZona[], permitidas: readonly string[] | null): AlcanceDeQuienVe {
  const todas = sucursales.map((s) => s.branch_code);
  if (permitidas === null) return { todas: true, sucursales: todas };
  const suyas = new Set(permitidas);
  return { todas: false, sucursales: todas.filter((c) => suyas.has(c)) };
}

/** Orden del calendario: lo que se debe primero, lo que se olvidaría (sin ancla) antes de lo que va bien. */
const ORDEN: Readonly<Record<EstadoRevision, number>> = { rezagada: 0, toca_hoy: 1, sin_ancla: 2, al_dia: 3, fuera_de_ciclo: 4 };

export const FUENTE_CALENDARIO =
  'Atendido = orden de compra de Kepler (también las canceladas: la revisión se hizo) o entrada aplicada, en las plazas de la regla, o una marca en la Suite («se pidió fuera de Kepler», «hoy no se pide»).';

export function armarCalendario(
  hoy: string,
  reglas: readonly ReglaLeida[],
  actividad: readonly FilaActividad[],
  marcas: readonly (MarcaVista & { readonly rule_id: string })[],
  sucursales: readonly SucursalZona[],
  almacenes: readonly AlmacenPedido[] = [],
  /** `[PQ.3.6]` Las sucursales de quien ve; `null` = todas. El resumen cuenta SÓLO lo que ve. */
  permitidas: readonly string[] | null = null,
  /** `[PQ.3.17]` El historial de cambios; sin él, el calendario no trae `cambios` ni dice nada del historial. */
  historial: HistorialLeido | null = null,
): CalendarioCompras {
  const filas: ReglaCalendario[] = reglas.filter((r) => reglaEnAlcance(r, sucursales, permitidas)).map((r) => {
    const act = actividadDeLaRegla(r, actividad, sucursales);
    const suyas = marcas.filter((m) => m.rule_id === r.id).sort((a, b) => (a.review_date < b.review_date ? -1 : 1));
    const estado = estadoDeRegla(r, hoy, {
      actividad: act.fechas,
      marcas: suyas,
      ancla: act.ultima?.fecha ?? null,
      vigente_desde: r.vigente_desde,
    });
    const ultimaMarca = suyas.length ? suyas[suyas.length - 1] : null;
    // La última atención la dice quien sea más reciente: Kepler o la marca de la Suite.
    const ultima = ultimaMarca && (!act.ultima || ultimaMarca.review_date > act.ultima.fecha) && ultimaMarca.review_date <= hoy
      ? { fecha: ultimaMarca.review_date, fuente: 'marca' as const }
      : act.ultima;
    const marcaVista: MarcaVista | null = ultimaMarca && {
      review_date: ultimaMarca.review_date, outcome: ultimaMarca.outcome, skip_reason: ultimaMarca.skip_reason,
      postponed_to: ultimaMarca.postponed_to, note: ultimaMarca.note, marcada_por: ultimaMarca.marcada_por, marcada_el: ultimaMarca.marcada_el,
    };
    return {
      id: r.id, supplier_code: r.supplier_code, scope: r.scope, zone_code: r.zone_code, branch_code: r.branch_code,
      pattern: r.pattern, weekdays: r.weekdays, month_days: r.month_days, month_last_day: r.month_last_day,
      every_n_days: r.every_n_days, weekend_shift: r.weekend_shift, reviewer_user_id: r.reviewer_user_id,
      week_interval: r.week_interval ?? null, week_anchor: r.week_anchor ?? null, month_week: r.month_week ?? null,
      out_of_cycle_until: r.out_of_cycle_until, out_of_cycle_reason: r.out_of_cycle_reason,
      supplier_name: r.supplier_name,
      alcance_nombre: nombreDelAlcance(r, sucursales),
      revisa: r.reviewer_name ?? revisaPorAlcance(r, sucursales),
      estado,
      ultima_actividad: ultima,
      ultima_marca: marcaVista,
      definida_por: r.definida_por,
      definida_el: r.definida_el,
      ultimo_cambio: r.fue_cambiada && r.cambiada_el
        ? { por: r.cambiada_por ?? null, el: r.cambiada_el, dia: r.vigente_desde }
        : null,
      ...(historial?.measured
        ? { cambios: historial.por.get(r.id)?.cambios ?? [], cambios_total: historial.por.get(r.id)?.total ?? 0 }
        : {}),
      note: r.note,
      pedido_supplier_id: r.pedido_supplier_id,
      pedido_warehouse_ids: almacenesDelAlcance(r, sucursales, almacenes),
    };
  });
  filas.sort((a, b) =>
    ORDEN[a.estado.estado] - ORDEN[b.estado.estado]
    || b.estado.dias_atraso - a.estado.dias_atraso
    || (a.estado.proxima?.fecha ?? '9999').localeCompare(b.estado.proxima?.fecha ?? '9999')
    || (a.supplier_name ?? a.supplier_code).localeCompare(b.supplier_name ?? b.supplier_code, 'es'));
  const resumen: Record<EstadoRevision, number> = { rezagada: 0, toca_hoy: 0, sin_ancla: 0, al_dia: 0, fuera_de_ciclo: 0 };
  for (const f of filas) resumen[f.estado.estado]++;
  return {
    hoy, reglas: filas, resumen, actividad_desde: sumarDias(hoy, -VENTANA_REZAGO_DIAS), fuente: FUENTE_CALENDARIO,
    zonas: zonasDeCompra(sucursales), sucursales: sucursales.map((s) => s.branch_code),
    tu_alcance: alcanceDeQuienVe(sucursales, permitidas),
    ...(historial ? { historial: { measured: historial.measured, note: historial.note } } : {}),
  };
}
