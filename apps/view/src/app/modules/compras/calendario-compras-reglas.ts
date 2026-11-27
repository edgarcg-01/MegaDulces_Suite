import {
  ETIQUETA_MOTIVO_NO_SE_PIDE, fechasDeLaRegla, historialDeLaRegla, OCASIONAL_CADA_N_DIAS, sumarDias, diaIso, ultimoCambioSinHistorial,
  type CambioDeRegla, type PasoDelHistorial,
  type AlcanceDeQuienVe, type AvanceDelEmbudo, type EscalonLlenado, type EstadoDeRegla, type FuenteActividad, type MarcaVista, type PatronDeRegla, type PesoProveedor, type PropuestaDiaFijo, type PropuestaSinRegla,
  type ReglaCalendario,
} from '@megadulces/contracts';

/**
 * `[PQ.3.5]` Calendario de compras — lo que la pantalla dice en palabras, sin Angular para probarlo solo.
 * Las fechas de una regla las calcula el MISMO contrato que usa la API (`fechasDeLaRegla`): la vista
 * «Semana» y el estado del servidor no pueden contar días distintos.
 */

const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
/** Plural de cada día (sábado y domingo cambian; los demás no). */
const DIAS_PLURAL = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados', 'domingos'];
const DIAS_CORTOS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** `YYYY-MM-DD` → «lun 23 nov», sin pasar por la zona horaria. */
export function diaCorto(f: string | null | undefined): string {
  if (!f) return '—';
  const [, m, d] = f.split('-').map(Number);
  return `${DIAS_CORTOS[diaIso(f) - 1]} ${d} ${MESES[(m || 1) - 1]}`;
}

/** «hoy», «mañana», «en 3 días», «hace 5 días» contra `hoy`. */
export function relativo(f: string, hoy: string): string {
  const d = Math.round((Date.UTC(...ymd(f)) - Date.UTC(...ymd(hoy))) / 86_400_000);
  if (d === 0) return 'hoy';
  if (d === 1) return 'mañana';
  if (d === -1) return 'ayer';
  return d > 0 ? `en ${d} días` : `hace ${-d} días`;
}

function ymd(f: string): [number, number, number] {
  const [y, m, d] = f.split('-').map(Number);
  return [y, m - 1, d];
}

/** «a, b y c». */
function lista(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
}

/** `[PQ.3.15]` «Una vez al mes»: el Nº de ese día en el mes (5 = el último). */
const ORDINAL_DEL_MES = ['', 'primer', 'segundo', 'tercer', 'cuarto', 'último'];

/**
 * «Cada miércoles» · «El 15 y el último de cada mes» · «Cada 14 días». `[PQ.3.15]` Con cadencia (DC29):
 * «Cada 2 semanas, en martes» · «El primer martes de cada mes» · «El último lunes y jueves de cada mes».
 */
export function patronEnPalabras(r: PatronDeRegla): string {
  if (r.pattern === 'weekdays') {
    const ds = [...(r.weekdays ?? [])].sort((a, b) => a - b);
    const nombres = lista(ds.map((d) => DIAS[d - 1]));
    if (r.month_week) return `El ${ORDINAL_DEL_MES[r.month_week] ?? r.month_week} ${nombres} de cada mes`;
    if (r.week_interval && r.week_interval > 1) {
      const que = ds.length === 7 ? 'todos los días' : ds.length === 5 && ds.every((d, i) => d === i + 1) ? 'de lunes a viernes' : `en ${nombres}`;
      return `Cada ${r.week_interval} semanas, ${que}`;
    }
    if (ds.length === 7) return 'Todos los días';
    if (ds.length === 5 && ds.every((d, i) => d === i + 1)) return 'De lunes a viernes';
    return `Cada ${nombres}`;
  }
  if (r.pattern === 'month_days') {
    const nums = [...(r.month_days ?? [])].sort((a, b) => a - b).map(String);
    if (!nums.length) return 'El último de cada mes';
    if (nums.length === 1) return `El ${nums[0]}${r.month_last_day ? ' y el último' : ''} de cada mes`;
    return `Los días ${lista(r.month_last_day ? [...nums, 'el último'] : nums)} de cada mes`;
  }
  const n = r.every_n_days ?? 0;
  return n === 1 ? 'Cada día' : `Cada ${n} días`;
}

/**
 * La línea de abajo del patrón: lo que hace con un fin de semana (sólo «días del mes» se corre, DC19). `[PQ.3.15]` En
 * «cada N semanas», desde cuándo cuenta.
 */
export function corrimientoEnPalabras(r: PatronDeRegla): string | null {
  if (r.pattern === 'weekdays' && r.week_interval && r.week_interval > 1 && r.week_anchor) return `A partir del ${diaCorto(r.week_anchor)}`;
  if (r.pattern !== 'month_days') return null;
  return r.weekend_shift === 'monday' ? 'Si cae en fin de semana, pasa al lunes' : 'Si cae en fin de semana, se adelanta al viernes';
}

export type Severidad = 'danger' | 'warn' | 'info' | 'success' | 'secondary';

export interface EstadoVisible {
  readonly etiqueta: string;
  readonly severidad: Severidad;
  /** La línea de abajo: desde cuándo se debe, hasta cuándo está fuera, la siguiente fecha. */
  readonly detalle: string;
}

/** El estado con PALABRA, nunca sólo color (la etiqueta lleva el atraso). */
export function estadoEnPalabras(e: EstadoDeRegla, r: Pick<ReglaCalendario, 'out_of_cycle_until' | 'out_of_cycle_reason'>, hoy: string): EstadoVisible {
  const sig = e.proxima ? `la siguiente, ${diaCorto(e.proxima.fecha)}` : '';
  switch (e.estado) {
    case 'rezagada':
      return {
        etiqueta: `Rezagada · ${e.dias_atraso} ${e.dias_atraso === 1 ? 'día' : 'días'}`,
        severidad: 'danger',
        detalle: `Se debe desde el ${diaCorto(e.pendiente_desde)}`,
      };
    case 'toca_hoy':
      return { etiqueta: 'Toca hoy', severidad: 'warn', detalle: sig ? `Después, ${diaCorto(e.proxima?.fecha)}` : '' };
    case 'sin_ancla':
      return {
        etiqueta: 'Sin fecha base',
        severidad: 'secondary',
        detalle: 'Sin OC ni entrada en Kepler para contar los días: marca la primera revisión o define otro patrón',
      };
    case 'fuera_de_ciclo':
      return {
        etiqueta: 'Fuera de ciclo',
        severidad: 'secondary',
        detalle: `Hasta el ${diaCorto(r.out_of_cycle_until)}${r.out_of_cycle_reason ? ` · ${r.out_of_cycle_reason}` : ''}`,
      };
    default:
      return { etiqueta: 'Al día', severidad: 'success', detalle: e.proxima ? `La siguiente, ${diaCorto(e.proxima.fecha)} (${relativo(e.proxima.fecha, hoy)})` : '' };
  }
}

/** De dónde salió la última atención, en palabras. Exportado para el candado del manual (`[PQ.3.29]`: una fuente nueva sin explicar lo pone en rojo). */
export const FUENTE_ACTIVIDAD: Readonly<Record<Exclude<FuenteActividad, 'marca'>, string>> = {
  oc: 'Orden de compra',
  oc_cancelada: 'Orden de compra cancelada',
  entrada: 'Entrada aplicada',
  // `[PQ.3.29]` DC40: la requisición de compra de la Suite, en la sucursal a la que va (no espera la OC de Kepler).
  requisicion: 'Requisición de la Suite',
};

/** La última atención en palabras: qué documento (o qué marca) y cuándo. */
export function atencionEnPalabras(
  u: { readonly fecha: string; readonly fuente: FuenteActividad } | null,
  marca: MarcaVista | null,
): { readonly que: string; readonly cuando: string } {
  if (!u) return { que: 'Sin OC ni entrada en el último año', cuando: '' };
  if (u.fuente !== 'marca') return { que: FUENTE_ACTIVIDAD[u.fuente], cuando: diaCorto(u.fecha) };
  if (marca?.outcome === 'ordered_outside_kepler') return { que: 'Se pidió fuera de Kepler', cuando: diaCorto(u.fecha) };
  const motivo = marca?.skip_reason ? ETIQUETA_MOTIVO_NO_SE_PIDE[marca.skip_reason] : '';
  return { que: `No se pidió${motivo ? ` (${motivo.toLowerCase()})` : ''}`, cuando: diaCorto(u.fecha) };
}

/** Una fecha de revisión de una regla dentro de un rango (vistas «Semana» y «Mes»). */
export interface FechaEnCalendario {
  readonly fecha: string;
  /** La fecha original si cayó en fin de semana y se corrió. */
  readonly corrida_de: string | null;
  /** Viene de una «hoy no se pide» con nueva fecha, no del patrón. */
  readonly pospuesta: boolean;
  readonly regla: ReglaCalendario;
}

/**
 * Las fechas de revisión de cada regla en [`desde`, `hasta`], en orden de fecha (y, el mismo día, en el
 * orden de la API: lo que se debe primero).
 *
 * - Una regla fuera de ciclo no tiene fechas hasta el día siguiente a su «hasta».
 * - «Cada N días» cuenta desde su siguiente fecha (la API ya la ancló en Kepler); sin ancla no tiene fechas.
 * - Una «hoy no se pide» con nueva fecha agrega esa fecha.
 */
export function fechasEnRango(reglas: readonly ReglaCalendario[], desde: string, hasta: string): FechaEnCalendario[] {
  const out: (FechaEnCalendario & { orden: number })[] = [];
  reglas.forEach((r, orden) => {
    let inicio = desde;
    if (r.out_of_cycle_until && r.out_of_cycle_until >= desde) inicio = sumarDias(r.out_of_cycle_until, 1);
    if (inicio > hasta) return;
    let fechas: { fecha: string; corrida_de: string | null }[] = [];
    if (r.pattern === 'every_n_days') {
      const n = r.every_n_days ?? 0;
      const prox = r.estado.proxima?.fecha;
      if (prox && n >= 1) fechas = fechasDeLaRegla(r, inicio, hasta, sumarDias(prox, -n));
    } else {
      fechas = fechasDeLaRegla(r, inicio, hasta);
    }
    const ya = new Set(fechas.map((f) => f.fecha));
    for (const f of fechas) out.push({ ...f, pospuesta: false, regla: r, orden });
    const p = r.ultima_marca?.postponed_to;
    if (p && p >= inicio && p <= hasta && !ya.has(p)) out.push({ fecha: p, corrida_de: null, pospuesta: true, regla: r, orden });
  });
  return out
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.orden - b.orden)
    .map((f) => ({ fecha: f.fecha, corrida_de: f.corrida_de, pospuesta: f.pospuesta, regla: f.regla }));
}

/** Las siguientes `n` fechas de UNA regla desde `hoy` (incluido), con el mismo cálculo que «Semana». */
export function proximasDeLaRegla(r: ReglaCalendario, hoy: string, n: number): FechaEnCalendario[] {
  return fechasEnRango([r], hoy, sumarDias(hoy, 400)).slice(0, n);
}

/** Lo que propone Kepler para un proveedor sin regla, en palabras. */
export function propuestaEnPalabras(p: Pick<PropuestaSinRegla, 'proposal_status' | 'cycle_days_proposed'>): string {
  switch (p.proposal_status) {
    case 'propuesto': return `Cada ${p.cycle_days_proposed} días`;
    case 'compra_continua': return 'Compra continua (rondas pegadas)';
    case 'pocas_compras': return 'Pocas rondas: define el ciclo a mano';
    default: return 'Una sola compra en el año';
  }
}

/** `[PQ.3.14]` Cuándo pasa el proveedor en esa sucursal: «cada jueves», «un viernes sí y otro no», «cada 3 semanas, en lunes». */
export function diaFijoEnPalabras(d: Pick<PropuestaDiaFijo, 'weekday' | 'every_days'>): string {
  const dia = DIAS[d.weekday - 1];
  if (d.every_days === 7) return `cada ${dia}`;
  if (d.every_days === 14) return `un ${dia} sí y otro no`;
  return `cada ${d.every_days / 7} semanas, en ${dia}`;
}

/**
 * `[PQ.3.14]` La evidencia del día fijo, lo reciente primero: «5 de 6 en las últimas 13 semanas». Si vino MÁS de lo
 * que el periodo pide, no se dice «9 de 6»: se dice cuántas veces vino.
 */
export function diaFijoReciente(d: Pick<PropuestaDiaFijo, 'weekday' | 'recientes'>): string {
  const { en_el_dia: n, esperadas } = d.recientes;
  const dias = n === 1 ? DIAS[d.weekday - 1] : DIAS_PLURAL[d.weekday - 1];
  return n > esperadas ? `${n} ${dias} en las últimas 13 semanas` : `${n} de ${esperadas} ${DIAS_PLURAL[d.weekday - 1]} en las últimas 13 semanas`;
}

/** `[PQ.3.14]` La evidencia completa, para el formulario: de dónde sale la propuesta, en una frase. */
export function diaFijoEvidencia(d: PropuestaDiaFijo, sucursal: string): string {
  return `Kepler: en ${sucursal}, ${d.en_el_dia} de los ${d.dias} días con orden o entrada de los últimos 12 meses cayeron en `
    + `${DIAS[d.weekday - 1]}; ${diaFijoReciente(d)}.`;
}

/** «la ficha en la Suite está borrada» / «sin ficha en la Suite» (R4). `null` = ficha viva. */
export function fichaEnPalabras(p: Pick<PropuestaSinRegla, 'supplier_record'>): string | null {
  if (p.supplier_record === 'ficha_borrada') return 'su ficha en la Suite está borrada';
  if (p.supplier_record === 'sin_ficha') return 'sin ficha en la Suite';
  return null;
}

/**
 * `[PQ.3.6]` La lista recortada a las sucursales de quien ve se DICE (una lista que esconde filas sin decirlo
 * se lee como la de toda la empresa). `null` = ve todas las reglas.
 */
export function alcanceEnPalabras(a: AlcanceDeQuienVe, nombre: (code: string) => string): string | null {
  if (a.todas) return null;
  if (!a.sucursales.length) return 'Tu ficha no tiene sucursal: no ves reglas hasta que te asignen una.';
  return `Ves sólo las reglas de ${lista(a.sucursales.map(nombre))}: las de todas las sucursales las revisa la gerencia de compras.`;
}

/** `[PQ.3.6]` «para Yurécuaro» cuando la lista está recortada; vacío si ve todas. */
export function paraQuienVe(a: AlcanceDeQuienVe, nombre: (code: string) => string): string {
  return a.todas || !a.sucursales.length ? '' : ` para ${lista(a.sucursales.map(nombre))}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `[PQ.3.18]` El embudo de llenado en palabras (anexo C §10.10).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Un porcentaje con un decimal como máximo: «82.8 %», «0 %». Entre el número y el signo va un espacio que NO se parte
 * (U+00A0): la prueba visual en el celular encontró «68.1» en un renglón y «% de las OC» en el siguiente.
 */
export function porcentaje(x: number): string {
  return `${x.toLocaleString('es-MX', { maximumFractionDigits: 1 })}\u00a0%`;
}

/** Qué junta cada escalón, en el orden en que se llena (el % pegado a su número, como en `porcentaje`). */
export const NOMBRE_ESCALON: Readonly<Record<EscalonLlenado, string>> = {
  1: 'Escalón 1 · el 80\u00a0% de la compra o el 50\u00a0% de las OC',
  2: 'Escalón 2 · el resto con compra recurrente',
  3: 'Escalón 3 · ocasionales',
};

/** La línea del avance total: «Con regla: 0 de 340 proveedores · 0 % de la compra · 0 % de las OC». Sin medir, lo dice. */
export function avanceTotalEnPalabras(t: AvanceDelEmbudo): string {
  const prov = `Con regla: ${t.con_regla} de ${t.proveedores} ${t.proveedores === 1 ? 'proveedor' : 'proveedores'}`;
  if (t.compra_con_regla_pct === null || t.ocs_con_regla_pct === null) return `${prov} (lo que pesan en la compra no se midió)`;
  return `${prov} · ${porcentaje(t.compra_con_regla_pct)} de la compra · ${porcentaje(t.ocs_con_regla_pct)} de las OC`;
}

/** El avance de un escalón: «0 de 62 proveedores · 0 de 82.8 % de la compra · 0 de 65.8 % de las OC». */
export function avanceEscalonEnPalabras(e: AvanceDelEmbudo): string {
  if (e.proveedores === 0) return 'Ningún proveedor en este escalón';
  const prov = `${e.con_regla} de ${e.proveedores} ${e.proveedores === 1 ? 'proveedor' : 'proveedores'}`;
  if (e.compra_pct === null || e.compra_con_regla_pct === null || e.ocs_pct === null || e.ocs_con_regla_pct === null) return prov;
  return `${prov} · ${porcentaje(e.compra_con_regla_pct)} de ${porcentaje(e.compra_pct)} de la compra · ${porcentaje(e.ocs_con_regla_pct)} de ${porcentaje(e.ocs_pct)} de las OC`;
}

/** El peso de un proveedor en su renglón: principal y detalle. Sin medir, lo dice. */
export function pesoEnPalabras(peso: PesoProveedor | null, rondas: number): { readonly principal: string; readonly detalle: string } {
  const r = `${rondas} ${rondas === 1 ? 'ronda' : 'rondas'} en 12 meses`;
  if (!peso) return { principal: 'Peso no medido', detalle: r };
  return { principal: `${porcentaje(peso.compra_pct)} de la compra`, detalle: `${peso.ocs_12m} OC · ${r} · escalón ${peso.escalon}` };
}

/** `[PQ.3.18]` (c) Lo que dice el aviso tras definir los ocasionales en bloque (y lo que no se tocó, si hubo). */
export function avisoOcasionales(r: { readonly definidas: number; readonly hasta: string; readonly omitidas: readonly unknown[] }): string {
  const hechas = r.definidas === 1 ? '1 proveedor ocasional quedó' : `${r.definidas} proveedores ocasionales quedaron`;
  const base = r.definidas ? `${hechas} fuera de ciclo hasta el ${diaCorto(r.hasta)}, con una regla «cada ${OCASIONAL_CADA_N_DIAS} días».` : 'No se definió ningún ocasional.';
  const n = r.omitidas.length;
  return n ? `${base} ${n === 1 ? '1 no se tocó' : `${n} no se tocaron`}: ya tenían regla o ya no eran ocasionales.` : base;
}

// ── [PQ.3.17] Quién la definió, quién la cambió y de qué a qué (anexo C §10.9, DC25) ────────────────────────────────

const CAMPOS_DEL_PATRON = ['pattern', 'weekdays', 'month_days', 'month_last_day', 'every_n_days', 'weekend_shift', 'week_interval', 'week_anchor', 'month_week'];

/** El patrón entero, con su segunda línea (desde cuándo cuenta, qué hace en fin de semana). */
function patronCompleto(r: PatronDeRegla): string {
  const c = corrimientoEnPalabras(r);
  return c ? `${patronEnPalabras(r)} (${c.charAt(0).toLowerCase()}${c.slice(1)})` : patronEnPalabras(r);
}

/** «Ana López» · «sin nombre declarado» (la escritura no dijo quién: hecha fuera de la Suite). */
export function quienCambio(c: Pick<CambioDeRegla, 'por'>): string {
  return c.por ?? 'sin nombre declarado';
}

/**
 * `[PQ.3.17]` Lo que cambió en un paso del historial, en renglones: el patrón entero antes y después (no las columnas
 * sueltas), el responsable por nombre, fuera de ciclo con su motivo, la nota, la baja. Una escritura que no movió nada
 * de eso (se guardó igual) también se dice: el historial cuenta cada vez que alguien guardó.
 */
export function pasoEnPalabras(p: PasoDelHistorial): string[] {
  const c = p.cambio.campos;
  const hay = (k: string) => k in c;
  const out: string[] = [];
  if (CAMPOS_DEL_PATRON.some(hay)) {
    const a = patronCompleto(p.antes);
    const d = patronCompleto(p.despues);
    out.push(a === d ? `Patrón: ${d}, guardado otra vez` : `Patrón: ${a} → ${d}`);
  }
  if (hay('reviewer_user_id')) {
    const n = (id: string | null) => (id ? p.cambio.nombres[id] ?? 'sin nombre registrado' : 'nadie (revisa el puesto)');
    out.push(`Responsable: ${n(p.antes.reviewer_user_id)} → ${n(p.despues.reviewer_user_id)}`);
  }
  if (hay('out_of_cycle_until')) {
    const hasta = p.despues.out_of_cycle_until;
    const motivo = p.despues.out_of_cycle_reason;
    out.push(hasta ? `Fuera de ciclo hasta el ${diaCorto(hasta)}${motivo ? `: «${motivo}»` : ''}` : 'Regresó al ciclo');
  } else if (hay('out_of_cycle_reason') && p.despues.out_of_cycle_reason) {
    out.push(`Motivo de fuera de ciclo: «${p.despues.out_of_cycle_reason}»`);
  }
  if (hay('note')) out.push(p.despues.note ? `Nota: «${p.despues.note}»` : 'Se quitó la nota');
  if (hay('deleted_at') && c['deleted_at'].despues) out.push('Dada de baja');
  if (!out.length) out.push('Se guardó sin cambios');
  return out;
}

/** `[PQ.3.17]` El historial de una regla listo para pintar (o `null` si no hay nada que decir). */
export interface HistorialVisible {
  readonly pasos: readonly { readonly cuando: string; readonly quien: string; readonly lineas: readonly string[] }[];
  /** «Se ven los 10 más recientes de 14.» */
  readonly mas: string | null;
  /** El último cambio es de antes de que se guardara el historial. */
  readonly sin_historial: string | null;
}

/**
 * `[PQ.3.17]` De la regla del calendario a lo que dice el detalle. `medido = false` (el historial no se pudo leer):
 * sin pasos y sin «antes del historial»; eso lo dice el aviso del calendario, no una lista vacía.
 */
export function historialVisible(
  r: Pick<ReglaCalendario, 'pattern' | 'weekdays' | 'month_days' | 'month_last_day' | 'every_n_days' | 'weekend_shift' | 'week_interval'
    | 'week_anchor' | 'month_week' | 'reviewer_user_id' | 'out_of_cycle_until' | 'out_of_cycle_reason' | 'note' | 'ultimo_cambio' | 'cambios' | 'cambios_total'>,
  medido: boolean,
): HistorialVisible | null {
  if (!medido || !r.cambios) return null;
  const pasos = historialDeLaRegla(r, r.cambios).map((p) => ({ cuando: diaCorto(p.cambio.dia), quien: quienCambio(p.cambio), lineas: pasoEnPalabras(p) }));
  const total = r.cambios_total ?? r.cambios.length;
  const sin = ultimoCambioSinHistorial(r)
    ? 'Ese último cambio es de antes de que se guardara el historial: se sabe quién y cuándo, no de qué a qué.'
    : null;
  if (!pasos.length && !sin) return null;
  return { pasos, mas: total > pasos.length ? `Se ven los ${pasos.length} más recientes de ${total}.` : null, sin_historial: sin };
}
