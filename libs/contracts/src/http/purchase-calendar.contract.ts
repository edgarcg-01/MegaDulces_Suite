/**
 * `[PQ.3.2]` Compras › Calendario de compras — el vocabulario de las reglas de revisión.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_PQ_ANEXO_CALENDARIO_COMPRAS.md` §10 (DC17–DC21) y DC14.
 * Tablas: `commercial.purchase_review_rules` y `commercial.purchase_review_marks`
 * (migración 20261120130156). Los CHECK de esas tablas aceptan EXACTAMENTE las listas de este
 * archivo: lo vigila `database/tests/test-newdb-pq3-2-reglas-revision.js`. Si agregas un valor aquí,
 * agrégalo también al CHECK con una migración, o la pantalla ofrecerá algo que la base rechaza.
 *
 * Tipos, constantes y funciones PURAS de fechas (`[PQ.3.3]`, al final): no lee el reloj ni la base.
 */
import { diasEntre } from '../finance/pago-vencido.contract';
import { sumarDias } from './existencia-historico.contract';

/** Dónde aplica la regla. Corporativo = todas las sucursales; zona = las de una zona de compra. */
export type AlcanceRevision = 'corporate' | 'zone' | 'branch';
export const ALCANCES_REVISION: readonly AlcanceRevision[] = ['corporate', 'zone', 'branch'];

/** Cuándo toca: días de la semana (ISO 1–7), días del mes (1–31 y/o el último) o cada N días. */
export type PatronRevision = 'weekdays' | 'month_days' | 'every_n_days';
export const PATRONES_REVISION: readonly PatronRevision[] = ['weekdays', 'month_days', 'every_n_days'];

/** Si un día del MES cae en sábado o domingo: al viernes anterior (DC19, default) o al lunes siguiente. */
export type CorrimientoFinDeSemana = 'friday' | 'monday';
export const CORRIMIENTOS_FIN_DE_SEMANA: readonly CorrimientoFinDeSemana[] = ['friday', 'monday'];

/**
 * `[PQ.3.15]` La cadencia de una regla por días de la semana (DC29, migración 20261124133043): cada cuántas semanas
 * (2, 3 o 6; cada semana se guarda NULL) a partir de una fecha, o «una vez al mes». Las mismas listas que el CHECK.
 */
export const SEMANAS_CADENCIA: readonly number[] = [2, 3, 6];
/** «Una vez al mes»: el 1º–4º de ese día en el mes, o éste = el último. */
export const SEMANA_DEL_MES_ULTIMA = 5;

/** Lo que quien revisa dice de una fecha cuando Kepler no lo dice solo. */
export type ResultadoRevision = 'ordered_outside_kepler' | 'skipped';
export const RESULTADOS_REVISION: readonly ResultadoRevision[] = ['ordered_outside_kepler', 'skipped'];

/** «Hoy no se pide», con motivo de lista (DC14). `other` exige nota. */
export type MotivoNoSePide = 'order_exists' | 'in_quotation' | 'blocked' | 'not_needed' | 'import' | 'other';
export const MOTIVOS_NO_SE_PIDE: readonly MotivoNoSePide[] = ['order_exists', 'in_quotation', 'blocked', 'not_needed', 'import', 'other'];

/** Las etiquetas en español, para la pantalla. */
export const ETIQUETA_MOTIVO_NO_SE_PIDE: Readonly<Record<MotivoNoSePide, string>> = {
  order_exists: 'Ya hay pedido',
  in_quotation: 'En cotización',
  blocked: 'Bloqueado',
  not_needed: 'No hace falta',
  import: 'Importación',
  other: 'Otro',
};

/** Una regla de revisión tal como la guarda la base (fechas `YYYY-MM-DD`). */
export interface ReglaRevision {
  readonly id: string;
  /** Clave de proveedor de KEPLER (la de la vista PQ.3.1), no el id de la ficha. */
  readonly supplier_code: string;
  readonly scope: AlcanceRevision;
  /** `zona_code` de `analytics.v_branch_zone` (LP · ZAM · MOR) cuando `scope = 'zone'`. */
  readonly zone_code: string | null;
  /** Sucursal de Kepler ('00'–'08') cuando `scope = 'branch'`. */
  readonly branch_code: string | null;
  readonly pattern: PatronRevision;
  /** ISO: 1 = lunes … 7 = domingo. */
  readonly weekdays: readonly number[] | null;
  readonly month_days: readonly number[] | null;
  readonly month_last_day: boolean;
  readonly every_n_days: number | null;
  readonly weekend_shift: CorrimientoFinDeSemana;
  /** `[PQ.3.15]` Días de la semana: cada cuántas semanas (2, 3 o 6). `null`/ausente = cada semana. */
  readonly week_interval?: number | null;
  /** `[PQ.3.15]` A partir de qué fecha cuenta `week_interval`: su semana (lunes a domingo) es la semana 0. */
  readonly week_anchor?: string | null;
  /** `[PQ.3.15]` «Una vez al mes» (DC29): el 1º–4º de ese día en el mes, o `SEMANA_DEL_MES_ULTIMA` = el último. */
  readonly month_week?: number | null;
  /**
   * `null` = revisa el puesto del alcance (corporativo: gerencia de compras; sucursal: su encargado).
   * `[PQ.3.22]` Con valor, es la persona RESPONSABLE de la regla (DC30): puede marcarla y la ve en «Mis revisiones».
   */
  readonly reviewer_user_id: string | null;
  readonly out_of_cycle_until: string | null;
  readonly out_of_cycle_reason: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `[PQ.3.3]` Las fechas de una regla y su estado de hoy. Funciones PURAS: las usan la API (el
// calendario) y la pantalla (la vista previa «próximas revisiones» del formulario), así las dos
// dicen lo mismo. Fechas `YYYY-MM-DD` de calendario civil: «hoy» lo pone quien llama, en hora de
// México (`libs/platform-core` mx-date); aquí no se lee el reloj.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Lo que la fecha de una regla necesita: el patrón y sus días. */
export type PatronDeRegla = Pick<ReglaRevision, 'pattern' | 'weekdays' | 'month_days' | 'month_last_day' | 'every_n_days' | 'weekend_shift'
  | 'week_interval' | 'week_anchor' | 'month_week'>;

/** Una fecha de revisión. `corrida_de` = la fecha original cuando cayó en fin de semana y se movió. */
export interface FechaDeRevision {
  readonly fecha: string;
  readonly corrida_de: string | null;
}

// `sumarDias` y `diasEntre` ya existían (Existencia histórica y Pagos): se REUSAN, no se copia una
// tercera versión (ADR-056). Las dos trabajan en UTC sobre `YYYY-MM-DD`, sin zona que mover.
const aMs = (f: string): number => {
  const [y, m, d] = f.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** Día de la semana ISO: 1 = lunes … 7 = domingo. */
export function diaIso(f: string): number {
  const d = new Date(aMs(f)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Un día del MES que cae en sábado o domingo se mueve al viernes anterior o al lunes siguiente (DC19). */
function corrida(f: string, hacia: CorrimientoFinDeSemana): string {
  const d = diaIso(f);
  if (d === 6) return sumarDias(f, hacia === 'monday' ? 2 : -1);
  if (d === 7) return sumarDias(f, hacia === 'monday' ? 1 : -2);
  return f;
}

/** El lunes de la semana de `f` (las semanas van de lunes a domingo). */
const lunesDe = (f: string): string => sumarDias(f, 1 - diaIso(f));

/** Cuántos días tiene el mes de `f`. */
const diasDelMes = (f: string): number => {
  const [y, m] = f.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * `[PQ.3.15]` ¿A la fecha `f` (que ya cae en un día de la regla) le toca por la cadencia (DC29)?
 * - **Una vez al mes:** el Nº de ese día en el mes (días 1–7 = el primero, 8–14 = el segundo…) o, con
 *   `SEMANA_DEL_MES_ULTIMA`, el último (le faltan menos de 7 días al fin de mes).
 * - **Cada N semanas:** desde la semana de la ancla, una sí y N−1 no. Antes de la ancla no hay revisiones, y sin
 *   ancla no se inventa una.
 * - **Cada semana** (sin cadencia): todas.
 */
function tocaPorCadencia(r: PatronDeRegla, f: string): boolean {
  const mw = r.month_week ?? null;
  if (mw != null) {
    const dia = Number(f.slice(8, 10));
    return mw === SEMANA_DEL_MES_ULTIMA ? dia + 7 > diasDelMes(f) : Math.ceil(dia / 7) === mw;
  }
  const k = r.week_interval ?? null;
  if (k == null || k <= 1) return true;
  if (!r.week_anchor || aMs(f) < aMs(r.week_anchor)) return false;
  const semanas = Math.round((aMs(lunesDe(f)) - aMs(lunesDe(r.week_anchor))) / (7 * 86_400_000));
  return semanas % k === 0;
}

/**
 * Las fechas de revisión de la regla en [`desde`, `hasta`] (las dos incluidas), en orden.
 *
 * - **Días de la semana:** cada día que coincide; sábado y domingo valen si la regla los nombra. Con cadencia
 *   (`[PQ.3.15]`), sólo las semanas que tocan: cada N semanas desde la ancla, o el Nº/último del mes.
 * - **Días del mes:** cada día de la lista y, si aplica, el último del mes. Un día que el mes no tiene
 *   (31 de noviembre, 30 de febrero) **no** se recorre al último: para eso está «el último». Si cae en
 *   fin de semana se corre (DC19) y cuenta la fecha corrida, aunque cambie de mes (el último de enero
 *   de 2027 es domingo: viernes 29 de enero, o lunes 1 de febrero si la regla corre al lunes).
 * - **Cada N días:** ancla + N, + 2N… desde la última vez que se atendió. Sin ancla no hay fecha: no
 *   se inventa (el calendario la declara «sin ancla»).
 */
export function fechasDeLaRegla(r: PatronDeRegla, desde: string, hasta: string, ancla: string | null = null): FechaDeRevision[] {
  if (aMs(hasta) < aMs(desde)) return [];
  const out: FechaDeRevision[] = [];
  if (r.pattern === 'weekdays') {
    const dias = new Set(r.weekdays ?? []);
    if (!dias.size) return [];
    for (let f = desde; aMs(f) <= aMs(hasta); f = sumarDias(f, 1)) {
      if (dias.has(diaIso(f)) && tocaPorCadencia(r, f)) out.push({ fecha: f, corrida_de: null });
    }
    return out;
  }
  if (r.pattern === 'month_days') {
    const vistas = new Set<string>();
    // Desde un mes antes hasta uno después: una fecha corrida puede entrar al rango desde el mes vecino.
    let [y, m] = sumarDias(desde, -31).split('-').map(Number);
    const [yFin, mFin] = sumarDias(hasta, 31).split('-').map(Number);
    while (y < yFin || (y === yFin && m <= mFin)) {
      const ultimoDia = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const dias = new Set((r.month_days ?? []).filter((d) => d >= 1 && d <= ultimoDia));
      if (r.month_last_day) dias.add(ultimoDia);
      for (const d of [...dias].sort((a, b) => a - b)) {
        const original = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const f = corrida(original, r.weekend_shift);
        if (aMs(f) < aMs(desde) || aMs(f) > aMs(hasta) || vistas.has(f)) continue;
        vistas.add(f);
        out.push({ fecha: f, corrida_de: f === original ? null : original });
      }
      if (m === 12) { y++; m = 1; } else m++;
    }
    return out.sort((a, b) => aMs(a.fecha) - aMs(b.fecha));
  }
  const n = r.every_n_days ?? 0;
  if (!ancla || n < 1) return [];
  for (let f = sumarDias(ancla, n); aMs(f) <= aMs(hasta); f = sumarDias(f, n)) if (aMs(f) >= aMs(desde)) out.push({ fecha: f, corrida_de: null });
  return out;
}

/** Las próximas `cuantas` fechas a partir de `desde` (incluida). Para la vista previa del formulario. */
export function proximasRevisiones(r: PatronDeRegla, desde: string, cuantas: number, ancla: string | null = null): FechaDeRevision[] {
  // 400 días alcanzan para cualquier regla válida (cada N ≤ 365).
  return fechasDeLaRegla(r, desde, sumarDias(desde, 400), ancla).slice(0, cuantas);
}

/** Días que un pedido puede ADELANTARSE a la fecha y aun así atenderla (se pidió el lunes para el miércoles). */
export const TOLERANCIA_ADELANTO_DIAS = 3;
/** Hasta dónde se buscan fechas sin atender: más atrás, el rezago ya no es de hoy. */
export const VENTANA_REZAGO_DIAS = 62;

export type EstadoRevision = 'al_dia' | 'toca_hoy' | 'rezagada' | 'fuera_de_ciclo' | 'sin_ancla';

/** Una marca de quien revisa sobre una fecha (`commercial.purchase_review_marks`). */
export interface MarcaRevision {
  readonly review_date: string;
  readonly outcome: ResultadoRevision;
  readonly postponed_to: string | null;
}

export interface EstadoDeRegla {
  readonly estado: EstadoRevision;
  /** Desde qué fecha se debe (rezagada) o la de hoy (toca hoy); `null` si está al día. */
  readonly pendiente_desde: string | null;
  /** Días de atraso contra `pendiente_desde`; 0 si toca hoy o está al día. */
  readonly dias_atraso: number;
  /** La siguiente fecha DESPUÉS de hoy (o después de «fuera de ciclo hasta»). */
  readonly proxima: FechaDeRevision | null;
}

/**
 * El estado de HOY de una regla (DC14: no hay cierre de día; lo no atendido amanece rezagado).
 *
 * `actividad`: los días en que el proveedor quedó atendido en el alcance de la regla (documentos de
 * Kepler: OC o entrada). Las `marcas` también atienden su fecha («se pidió fuera de Kepler», «hoy no
 * se pide»), y una «hoy no se pide» con nueva fecha agrega esa fecha.
 *
 * Días de la semana y del mes: cada actividad atiende primero la última fecha ya vencida si quedó sin
 * atender (pedido tarde) y, si no, la siguiente a ≤ 3 días (pedido adelantado). El estado lo decide la
 * fecha MÁS RECIENTE ≤ hoy: si está atendida, la regla va al día aunque antes se haya fallado (eso es
 * historia, no rezago de hoy); si no, se debe desde la primera de la racha sin atender.
 *
 * Una regla no debe fechas de ANTES de existir: `vigente_desde` (el día en que se definió) acota la
 * búsqueda; sin él, la ventana es de 62 días.
 *
 * Cada N días: se ancla en la última actividad o en `ancla` (la última ronda de Kepler, vista PQ.3.1);
 * vence en ancla + N, o en la nueva fecha de una «hoy no se pide» posterior al ancla.
 */
export interface EntradaEstadoDeRegla {
  readonly actividad?: readonly string[];
  readonly marcas?: readonly MarcaRevision[];
  readonly ancla?: string | null;
  readonly vigente_desde?: string | null;
}

export function estadoDeRegla(
  r: PatronDeRegla & Pick<ReglaRevision, 'out_of_cycle_until'>,
  hoy: string,
  { actividad = [], marcas = [], ancla = null, vigente_desde = null }: EntradaEstadoDeRegla = {},
): EstadoDeRegla {
  const atendio = [...new Set([...actividad, ...marcas.map((m) => m.review_date)])].filter((f) => aMs(f) <= aMs(hoy)).sort();
  const pospuestas = marcas.filter((m) => m.outcome === 'skipped' && m.postponed_to).map((m) => m.postponed_to as string).sort();
  const n = r.every_n_days ?? 0;

  if (r.out_of_cycle_until && aMs(r.out_of_cycle_until) >= aMs(hoy)) {
    const proxima = proximasRevisiones(r, sumarDias(r.out_of_cycle_until, 1), 1, mayor(ultimo(atendio), ancla))[0] ?? null;
    return { estado: 'fuera_de_ciclo', pendiente_desde: null, dias_atraso: 0, proxima };
  }

  if (r.pattern === 'every_n_days') {
    const base = mayor(ultimo(atendio), ancla);
    if (!base || n < 1) return { estado: 'sin_ancla', pendiente_desde: null, dias_atraso: 0, proxima: null };
    const vence = pospuestas.find((p) => aMs(p) > aMs(base)) ?? sumarDias(base, n);
    if (aMs(vence) > aMs(hoy)) return { estado: 'al_dia', pendiente_desde: null, dias_atraso: 0, proxima: { fecha: vence, corrida_de: null } };
    // Vencida: si hoy se atiende, la siguiente es hoy + N.
    return deuda(vence, hoy, { fecha: sumarDias(hoy, n), corrida_de: null });
  }

  const desde = mayor(sumarDias(hoy, -VENTANA_REZAGO_DIAS), vigente_desde) as string;
  const fechas = [...new Set([
    ...fechasDeLaRegla(r, desde, sumarDias(hoy, TOLERANCIA_ADELANTO_DIAS)).map((x) => x.fecha),
    ...pospuestas.filter((p) => aMs(p) >= aMs(desde)),
  ])].sort();
  const atendida = new Set<string>();
  for (const a of atendio) {
    const ultimaVencida = [...fechas].reverse().find((f) => aMs(f) <= aMs(a));
    const tarde = ultimaVencida && !atendida.has(ultimaVencida) ? ultimaVencida : undefined;
    const adelantada = fechas.find((f) => aMs(f) > aMs(a) && diasEntre(a, f) <= TOLERANCIA_ADELANTO_DIAS && !atendida.has(f));
    const f = tarde ?? adelantada;
    if (f) atendida.add(f);
  }
  const deLaRegla = proximasRevisiones(r, sumarDias(hoy, 1), 1)[0] ?? null;
  const pospuesta = pospuestas.find((p) => aMs(p) > aMs(hoy) && !atendida.has(p));
  const proxima = pospuesta && (!deLaRegla || aMs(pospuesta) < aMs(deLaRegla.fecha)) ? { fecha: pospuesta, corrida_de: null } : deLaRegla;

  const vencidas = fechas.filter((f) => aMs(f) <= aMs(hoy));
  if (!vencidas.length || atendida.has(vencidas[vencidas.length - 1])) return { estado: 'al_dia', pendiente_desde: null, dias_atraso: 0, proxima };
  let i = vencidas.length - 1;
  while (i > 0 && !atendida.has(vencidas[i - 1])) i--;
  return deuda(vencidas[i], hoy, proxima);
}

function deuda(desde: string, hoy: string, proxima: FechaDeRevision | null): EstadoDeRegla {
  const atraso = diasEntre(desde, hoy);
  return atraso === 0
    ? { estado: 'toca_hoy', pendiente_desde: desde, dias_atraso: 0, proxima }
    : { estado: 'rezagada', pendiente_desde: desde, dias_atraso: atraso, proxima };
}

const ultimo = (xs: readonly string[]): string | null => (xs.length ? xs[xs.length - 1] : null);
const mayor = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : aMs(a) >= aMs(b) ? a : b);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `[PQ.3.4]` La API: `GET /compras/calendario`, `GET /compras/calendario/propuestas` y las escrituras.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * De dónde salió la última atención: OC de Kepler (viva o cancelada), entrada de Kepler, marca de la Suite o
 * `[PQ.3.29]` requisición de compra de la Suite (DC40: cuenta desde que se crea, en la sucursal DESTINO de cada
 * renglón; cancelada o en borrador no cuenta).
 */
export type FuenteActividad = 'oc' | 'oc_cancelada' | 'entrada' | 'marca' | 'requisicion';

export interface MarcaVista extends MarcaRevision {
  readonly skip_reason: MotivoNoSePide | null;
  readonly note: string | null;
  readonly marcada_por: string | null;
  readonly marcada_el: string;
}

/** Una regla con su estado de hoy, tal como la pinta el calendario. */
export interface ReglaCalendario extends ReglaRevision {
  readonly supplier_name: string | null;
  /** «Todas las sucursales» · «Zona Zamora» · «Yurécuaro». */
  readonly alcance_nombre: string;
  /** Quién revisa: la persona elegida, o el puesto del alcance si no hay. */
  readonly revisa: string;
  readonly estado: EstadoDeRegla;
  readonly ultima_actividad: { readonly fecha: string; readonly fuente: FuenteActividad } | null;
  readonly ultima_marca: MarcaVista | null;
  readonly definida_por: string | null;
  readonly definida_el: string;
  /** La nota con que se definió la regla (para corregirla sin perderla). */
  readonly note: string | null;
  /**
   * `[PQ.3.5]` «Abrir en Pedido»: la ficha del proveedor que tiene productos en Pedido con esta clave de
   * Kepler. `null` = la clave no tiene productos en Pedido (R5: sus productos están en otra ficha), y la
   * pantalla lo dice en vez de abrir un Pedido vacío.
   */
  readonly pedido_supplier_id: string | null;
  /** Los almacenes de Pedido de las sucursales del alcance; vacío = todas (corporativo). */
  readonly pedido_warehouse_ids: readonly string[];
  /**
   * `[PQ.3.17]` El último cambio DESPUÉS de crearla, según la regla misma (`updated_by` / `updated_at`): un patrón
   * reemplazado, fuera de ciclo, el responsable. `null` = nadie la ha tocado desde que se definió. Existe aunque el
   * historial no lo tenga (un cambio de antes de que se guardara).
   */
  readonly ultimo_cambio?: UltimoCambio | null;
  /** `[PQ.3.17]` Los cambios guardados, el más nuevo primero (hasta `CAMBIOS_POR_REGLA`). */
  readonly cambios?: readonly CambioDeRegla[];
  /** `[PQ.3.17]` Cuántos cambios guardados tiene en total (puede haber más de los que vienen). */
  readonly cambios_total?: number;
}

// ── [PQ.3.17] Quién creó, quién cambió y de qué a qué (anexo C §10.9, DC25) ──────────────────────────────────────

/** Cuántos cambios de cada regla viajan con el calendario (los más nuevos). */
export const CAMBIOS_POR_REGLA = 10;

/** `[PQ.3.17]` El último cambio de una regla: quién y cuándo. */
export interface UltimoCambio {
  /** Nombre de quien lo hizo; `null` = no hay nombre registrado para ese usuario. */
  readonly por: string | null;
  /** El instante, UTC (`YYYY-MM-DDTHH:MM:SSZ`): con él se casa con su fila del historial. */
  readonly el: string;
  /** El día, hora de México (`YYYY-MM-DD`), para decirlo. */
  readonly dia: string;
}

/** Una columna de la regla antes y después de un cambio, tal como la guardó el historial (JSON). */
export interface CampoCambiado {
  readonly antes: unknown;
  readonly despues: unknown;
}

/**
 * `[PQ.3.17]` Un cambio de la regla, de `analytics.master_data_history` (VP.3.1, el log compartido; sin tabla
 * propia, ADR-056): cuándo, quién y SÓLO las columnas que se movieron.
 */
export interface CambioDeRegla extends UltimoCambio {
  readonly campos: Readonly<Record<string, CampoCambiado>>;
  /** Los nombres de los responsables que aparecen en el cambio (`reviewer_user_id` antes y después), por id. */
  readonly nombres: Readonly<Record<string, string>>;
}

/** Lo que cambia la regla y se puede decir de qué a qué (la fila del historial trae SÓLO lo que se movió). */
export type EstadoDeLaRegla = PatronDeRegla & Pick<ReglaRevision, 'reviewer_user_id' | 'out_of_cycle_until' | 'out_of_cycle_reason'>
  & { readonly note: string | null };

/** Un paso del historial: el cambio con la regla completa antes y después (para decir el patrón entero). */
export interface PasoDelHistorial {
  readonly cambio: CambioDeRegla;
  readonly antes: EstadoDeLaRegla;
  readonly despues: EstadoDeLaRegla;
}

const CAMPOS_DEL_ESTADO: readonly (keyof EstadoDeLaRegla)[] = [
  'pattern', 'weekdays', 'month_days', 'month_last_day', 'every_n_days', 'weekend_shift', 'week_interval', 'week_anchor',
  'month_week', 'reviewer_user_id', 'out_of_cycle_until', 'out_of_cycle_reason', 'note',
];

/** El JSON del historial con la forma de la regla: listas de números, el resto tal cual (`null` si no venía). */
function valorDelHistorial(campo: keyof EstadoDeLaRegla, v: unknown): unknown {
  if (v === undefined) return null;
  if ((campo === 'weekdays' || campo === 'month_days') && Array.isArray(v)) return v.map(Number);
  return v;
}

/**
 * `[PQ.3.17]` Cada cambio con la regla completa antes y después. La fila del historial trae SÓLO lo que se movió:
 * lo demás se reconstruye hacia atrás desde la regla de hoy (el «antes» de un cambio es la base del anterior). Lo que
 * el cambio SÍ trae manda sobre lo reconstruido, en los dos lados: así un hueco (una escritura que no pasó por el
 * disparador) no le atribuye a un cambio un valor que no escribió. Del más nuevo al más viejo, y así salen.
 */
export function historialDeLaRegla(actual: EstadoDeLaRegla, cambios: readonly CambioDeRegla[]): PasoDelHistorial[] {
  const pasos: PasoDelHistorial[] = [];
  let estado: Record<string, unknown> = { ...actual };
  for (const cambio of cambios) {
    const despues: Record<string, unknown> = { ...estado };
    const antes: Record<string, unknown> = { ...estado };
    for (const campo of CAMPOS_DEL_ESTADO) {
      if (!(campo in cambio.campos)) continue;
      despues[campo] = valorDelHistorial(campo, cambio.campos[campo].despues);
      antes[campo] = valorDelHistorial(campo, cambio.campos[campo].antes);
    }
    pasos.push({ cambio, antes: antes as unknown as EstadoDeLaRegla, despues: despues as unknown as EstadoDeLaRegla });
    estado = antes;
  }
  return pasos;
}

/** Holgura para casar el último cambio con su fila del historial (el disparador corre en la MISMA transacción). */
const HOLGURA_MS = 2000;

/**
 * `[PQ.3.17]` ¿El último cambio de la regla falta en el historial? Entonces es anterior a que se guardara (la
 * migración 20261124231747 vigila también `updated_at`, así que toda escritura posterior deja su fila): se sabe
 * quién y cuándo, no de qué a qué. Sin último cambio, no falta nada.
 */
export function ultimoCambioSinHistorial(r: { readonly ultimo_cambio?: UltimoCambio | null; readonly cambios?: readonly CambioDeRegla[] }): boolean {
  if (!r.ultimo_cambio) return false;
  const t = Date.parse(r.ultimo_cambio.el);
  return !(r.cambios ?? []).some((c) => Math.abs(Date.parse(c.el) - t) <= HOLGURA_MS);
}

/** Una zona de compra con sus sucursales (código de Kepler), para elegir el alcance de una regla. */
export interface ZonaDeCompra {
  readonly code: string;
  /** «La Piedad» · «Zamora» · «Morelia». */
  readonly nombre: string;
  readonly sucursales: readonly string[];
}

export interface CalendarioCompras {
  /** `YYYY-MM-DD`, hora de México. */
  readonly hoy: string;
  readonly reglas: readonly ReglaCalendario[];
  readonly resumen: Readonly<Record<EstadoRevision, number>>;
  /** Desde qué día se buscó actividad para el rezago (lo de antes ya no es rezago de hoy). */
  readonly actividad_desde: string;
  /** De dónde sale «atendido»: se DICE, para que nadie lea el estado como si fuera otra cosa. */
  readonly fuente: string;
  /** Las zonas de compra con sus sucursales: las MISMAS con que la API valida una regla. */
  readonly zonas: readonly ZonaDeCompra[];
  /** Todas las sucursales que puede llevar una regla de sucursal (código de Kepler). */
  readonly sucursales: readonly string[];
  /**
   * `[PQ.3.6]` Lo que ve quien pregunta (anexo C §10.1): todas las reglas, o sólo las que caben COMPLETAS en
   * sus sucursales (la sucursal ve las suyas; la zona, las de su zona y sus sucursales; la corporativa, sólo
   * quien ve todas). Se dice para que una lista recortada no se lea como la de toda la empresa.
   */
  readonly tu_alcance: AlcanceDeQuienVe;
  /**
   * `[PQ.3.17]` Si el historial de cambios de las reglas se pudo leer (el disparador de la migración 20261124231747
   * activo y la lectura sin error). `measured: false` = la pantalla no dice «sin cambios»: dice que no se midió.
   */
  readonly historial?: { readonly measured: boolean; readonly note: string | null };
}

/** `[PQ.3.6]` Las sucursales de quien ve el calendario (`ScopeService`, área `compras`). */
export interface AlcanceDeQuienVe {
  /** `true` = ve todas las reglas, también las corporativas. */
  readonly todas: boolean;
  /** Sus sucursales (código de Kepler), en orden. Vacío y `todas: false` = su ficha no tiene sucursal. */
  readonly sucursales: readonly string[];
}

/** Un proveedor con compra en Kepler y SIN regla: la propuesta de la vista PQ.3.1 para que la gerencia la confirme. */
export interface PropuestaSinRegla {
  readonly supplier_code: string;
  readonly supplier_name: string | null;
  readonly supplier_record: 'ficha_viva' | 'ficha_borrada' | 'sin_ficha';
  readonly proposal_status: 'propuesto' | 'compra_continua' | 'pocas_compras' | 'una_compra';
  readonly cycle_days_proposed: number | null;
  readonly next_date_proposed: string | null;
  readonly rounds_12m: number;
  readonly last_order_date: string;
  readonly branches_12m: readonly string[];
  /** `[PQ.3.14]` Reglas vivas del proveedor (0 en `sin_regla`). */
  readonly reglas_vivas: number;
  /**
   * `[PQ.3.14]` Las sucursales donde este proveedor tiene día fijo y todavía NO tienen su regla de sucursal: una regla
   * propuesta por cada una.
   */
  readonly dias_fijos: readonly PropuestaDiaFijo[];
  /** `[PQ.3.18]` Su peso en el embudo de llenado; `null` = la compra de 12 meses no se pudo leer (no medido). */
  readonly peso: PesoProveedor | null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `[PQ.3.18]` El embudo de llenado (anexo C §10.10): por qué proveedor seguir y cuánto se lleva. Dinero y
// operaciones NO ordenan igual (medido el 2026-11-22: el 50 % de la compra son 10 proveedores; el 50 % de las OC,
// 22, y 14 de esos 22 casi no pesan en dinero), así que el escalón 1 junta a los dos.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** 1 = los que hacen el 80 % de la compra o el 50 % de las OC · 2 = el resto con compra recurrente · 3 = ocasionales. */
export type EscalonLlenado = 1 | 2 | 3;
export const ESCALONES_LLENADO: readonly EscalonLlenado[] = [1, 2, 3];
/** Hasta qué parte acumulada de la COMPRA (monto de OC) entra un proveedor al escalón 1. */
export const ESCALON1_COMPRA_PCT = 80;
/** Hasta qué parte acumulada de las OC (operaciones) entra un proveedor al escalón 1. */
export const ESCALON1_OCS_PCT = 50;

/** El peso de un proveedor: sus OC vivas (X-A-35, estatus ≠ C) de 12 meses. */
export interface PesoProveedor {
  readonly escalon: EscalonLlenado;
  /** Su parte de la compra de 12 meses, en % (un decimal). */
  readonly compra_pct: number;
  /** Sus OC vivas de 12 meses. */
  readonly ocs_12m: number;
}

/** El avance de un escalón (o del total, `escalon: null`). Los % son de la compra y de las OC de TODOS los proveedores. */
export interface AvanceDelEmbudo {
  readonly escalon: EscalonLlenado | null;
  readonly proveedores: number;
  /** Con al menos una regla viva (también las que están fuera de ciclo). */
  readonly con_regla: number;
  /** Lo que pesa el escalón y lo que de eso ya tiene regla. `null` = no medido. */
  readonly compra_pct: number | null;
  readonly compra_con_regla_pct: number | null;
  readonly ocs_pct: number | null;
  readonly ocs_con_regla_pct: number | null;
}

export interface EmbudoLlenado {
  /** `false` = la compra de 12 meses no se pudo leer: los conteos sí, los % y los escalones no. */
  readonly measured: boolean;
  readonly note: string | null;
  readonly total: AvanceDelEmbudo;
  /** Los tres escalones, en orden; vacío si no se midió. */
  readonly escalones: readonly AvanceDelEmbudo[];
}

/**
 * `[PQ.3.18]` (c) Los ocasionales en bloque (DC27, anexo C §10.10): a cada uno, una regla para todas las sucursales
 * «cada 180 días» y fuera de ciclo 26 semanas con motivo. No amanecen rezagados y en esa fecha regresan solos a
 * «Por revisar» (que se vea si siguen siendo ocasionales). Cada regla se puede cambiar o dar de baja después.
 */
export const OCASIONAL_CADA_N_DIAS = 180;
export const OCASIONAL_FUERA_DE_CICLO_DIAS = 182;
export const OCASIONAL_MOTIVO = 'Ocasional: una o pocas compras en 12 meses (definido en bloque desde el embudo).';
/** Más de esto en una sola llamada no es «los ocasionales» (hoy son 94): se rechaza. */
export const OCASIONALES_MAX = 500;

export interface DefinirOcasionalesDto {
  /** Las claves que la pantalla mostró como ocasionales sin regla; el servidor sólo toca las que HOY lo siguen siendo. */
  readonly supplier_codes: readonly string[];
}

export interface DefinirOcasionalesRespuesta {
  readonly definidas: number;
  /** Hasta cuándo quedan fuera de ciclo (`YYYY-MM-DD`). */
  readonly hasta: string;
  /** Las que no se tocaron y por qué (p. ej. ya tienen regla, o ya no son ocasionales). */
  readonly omitidas: readonly { readonly supplier_code: string; readonly motivo: string }[];
}

/** `null` = válido. */
export function validarOcasionales(d: DefinirOcasionalesDto): string | null {
  if (!d || !Array.isArray(d.supplier_codes) || !d.supplier_codes.length) return 'Faltan los proveedores.';
  if (d.supplier_codes.some((c) => typeof c !== 'string' || !c.trim())) return 'Cada proveedor va por su clave de Kepler.';
  if (d.supplier_codes.length > OCASIONALES_MAX) return `Son más de ${OCASIONALES_MAX}: eso no son los ocasionales.`;
  return null;
}

/** El orden de trabajo: escalón, luego lo que pesa en la compra, luego las OC. Sin peso, al final y en su orden. */
export function ordenDelEmbudo(a: { readonly peso: PesoProveedor | null }, b: { readonly peso: PesoProveedor | null }): number {
  if (!a.peso || !b.peso) return a.peso ? -1 : b.peso ? 1 : 0;
  return a.peso.escalon - b.peso.escalon || b.peso.compra_pct - a.peso.compra_pct || b.peso.ocs_12m - a.peso.ocs_12m;
}

/** `[PQ.3.14]` Los periodos que se proponen: cada semana, cada 2, 3 o 4 semanas. Otro intervalo no es un día fijo. */
export type PeriodoDiaFijo = 7 | 14 | 21 | 28;
export const PERIODOS_DIA_FIJO: readonly PeriodoDiaFijo[] = [7, 14, 21, 28];

/**
 * `[PQ.3.14]` Un proveedor que en una sucursal pasa, se le pide y entrega el mismo día de la semana (anexo C §10.2):
 * la regla de sucursal que Kepler propone. Se deriva de los días con orden de compra o entrada en 12 meses; no se
 * captura ni se copia.
 */
export interface PropuestaDiaFijo {
  readonly branch_code: string;
  /** Día ISO: 1 = lunes … 7 = domingo. */
  readonly weekday: number;
  /** 7 = cada semana (regla «días de la semana»); 14, 21 o 28 = «cada N días», contando desde `ultima`. */
  readonly every_days: PeriodoDiaFijo;
  /** Días con orden o entrada en la sucursal en 12 meses, y cuántos cayeron en `weekday`. */
  readonly dias: number;
  readonly en_el_dia: number;
  /** Las últimas 13 semanas: cuántas veces cayó en `weekday` contra las que le tocaban con este periodo. */
  readonly recientes: { readonly en_el_dia: number; readonly esperadas: number };
  /** La última orden o entrada en la sucursal: la fecha base de «cada N días». */
  readonly ultima: string;
}

/**
 * Lo que la regla propuesta guarda: «días de la semana» si es cada semana. `[PQ.3.15]` Si es cada 2, 3 o 6 semanas,
 * también: con esa cadencia y la ancla en la última orden o entrada de ESA sucursal, para que «un viernes sí y otro
 * no» no se mueva con la actividad de Kepler (antes era «cada 14 días»). Cualquier otro periodo, «cada N días».
 */
export function patronDelDiaFijo(p: Pick<PropuestaDiaFijo, 'weekday' | 'every_days' | 'ultima'>): PatronDeRegla {
  const base = { month_days: null, month_last_day: false, weekend_shift: 'friday' as const, month_week: null };
  if (p.every_days === 7) return { ...base, pattern: 'weekdays', weekdays: [p.weekday], every_n_days: null, week_interval: null, week_anchor: null };
  const semanas = p.every_days / 7;
  if (SEMANAS_CADENCIA.includes(semanas) && p.ultima) {
    return { ...base, pattern: 'weekdays', weekdays: [p.weekday], every_n_days: null, week_interval: semanas, week_anchor: p.ultima };
  }
  return { ...base, pattern: 'every_n_days', weekdays: null, every_n_days: p.every_days, week_interval: null, week_anchor: null };
}

export interface PropuestasCalendario {
  readonly hoy: string;
  readonly sin_regla: readonly PropuestaSinRegla[];
  /**
   * `[PQ.3.14]` Proveedores que YA tienen alguna regla (p. ej. la corporativa) y aún tienen día fijo en una sucursal
   * sin regla de sucursal. Aparte de `sin_regla`: no cuentan como «sin regla».
   */
  readonly dia_fijo_pendiente: readonly PropuestaSinRegla[];
  /** Proveedores con compra que ya tienen al menos una regla. */
  readonly con_regla: number;
  /**
   * `[PQ.3.14]` Si el día fijo por sucursal se pudo medir. Si no (`measured: false`), `dias_fijos` viene vacío
   * porque NO se midió, no porque no haya: la pantalla lo dice. La propuesta por ciclo sigue.
   */
  readonly dia_fijo: { readonly measured: boolean; readonly note: string | null };
  /** `[PQ.3.18]` El embudo de llenado: el avance de la adopción en % de la compra y de las OC. */
  readonly embudo: EmbudoLlenado;
}

export interface GuardarReglaDto {
  readonly supplier_code: string;
  readonly scope: AlcanceRevision;
  readonly zone_code?: string | null;
  readonly branch_code?: string | null;
  /**
   * `[PQ.3.21]` Varias zonas o varias sucursales en una sola captura (DC28): se guarda UNA regla por lugar, con el mismo
   * patrón, todas en la misma transacción (o entran todas o ninguna). Cada una se atiende con lo de su lugar.
   */
  readonly zone_codes?: readonly string[] | null;
  readonly branch_codes?: readonly string[] | null;
  readonly pattern: PatronRevision;
  readonly weekdays?: readonly number[] | null;
  readonly month_days?: readonly number[] | null;
  readonly month_last_day?: boolean;
  readonly every_n_days?: number | null;
  readonly weekend_shift?: CorrimientoFinDeSemana;
  /** `[PQ.3.15]` La cadencia de «días de la semana» (DC29). */
  readonly week_interval?: number | null;
  readonly week_anchor?: string | null;
  readonly month_week?: number | null;
  /** `[PQ.3.22]` La persona responsable (DC30): activa, puede marcar y escribe en TODAS las sucursales de la regla. */
  readonly reviewer_user_id?: string | null;
  readonly note?: string | null;
}

export interface GuardarReglaRespuesta {
  /** La primera regla de la captura (la única, si fue un solo lugar). */
  readonly id: string;
  /** `actualizada` = ya había una regla viva de ese proveedor en ese alcance y se reemplazó su patrón. */
  readonly accion: 'creada' | 'actualizada';
  /** `[PQ.3.21]` Una por lugar, en el orden de la captura. `lugar` = la zona o sucursal (`null` en la corporativa). */
  readonly reglas: readonly { readonly lugar: string | null; readonly id: string; readonly accion: 'creada' | 'actualizada' }[];
}

/** `[PQ.3.21]` Los lugares de una captura: las zonas o sucursales elegidas (la lista, o la única de antes). Corporativa = `[]`. */
export function lugaresDeLaCaptura(d: Pick<GuardarReglaDto, 'scope' | 'zone_code' | 'zone_codes' | 'branch_code' | 'branch_codes'>): string[] {
  const de = (lista: readonly string[] | null | undefined, uno: string | null | undefined): string[] =>
    [...new Set(lista && lista.length ? lista : uno ? [uno] : [])];
  if (d.scope === 'zone') return de(d.zone_codes, d.zone_code);
  if (d.scope === 'branch') return de(d.branch_codes, d.branch_code);
  return [];
}

/** `[PQ.3.21]` Una captura, en una regla por lugar: el DTO de cada una con su zona o sucursal sola. */
export function reglasDeLaCaptura(d: GuardarReglaDto): GuardarReglaDto[] {
  const base: GuardarReglaDto = { ...d, zone_codes: undefined, branch_codes: undefined };
  if (d.scope === 'corporate') return [{ ...base, zone_code: null, branch_code: null }];
  return lugaresDeLaCaptura(d).map((p) => (d.scope === 'zone'
    ? { ...base, zone_code: p, branch_code: null }
    : { ...base, zone_code: null, branch_code: p }));
}

/** `[PQ.3.21]` La validación de la captura entera: hay al menos un lugar, y cada regla que sale de ella es válida. */
export function validarCaptura(d: GuardarReglaDto, zonas: readonly string[], sucursales: readonly string[]): string | null {
  if (!d) return 'Falta la regla.';
  const listas = [d.zone_codes, d.branch_codes].filter((x) => x != null);
  if (listas.some((x) => !Array.isArray(x) || !x.every((c) => typeof c === 'string'))) return 'Las zonas y sucursales van en una lista.';
  if (d.zone_codes?.length && d.scope !== 'zone') return 'Sólo una regla por zona lleva zonas.';
  if (d.branch_codes?.length && d.scope !== 'branch') return 'Sólo una regla por sucursal lleva sucursales.';
  if (d.scope === 'zone' && !lugaresDeLaCaptura(d).length) return 'Elige al menos una zona.';
  if (d.scope === 'branch' && !lugaresDeLaCaptura(d).length) return 'Elige al menos una sucursal.';
  for (const r of reglasDeLaCaptura(d)) {
    const motivo = validarRegla(r, zonas, sucursales);
    if (motivo) return motivo;
  }
  return null;
}

/** `[PQ.3.22]` Quien puede ser responsable de una regla (DC30): persona activa que puede marcar, y dónde escribe. */
export interface ResponsablePosible {
  readonly user_id: string;
  readonly nombre: string;
  readonly puesto: string;
  /** Las sucursales donde puede ESCRIBIR en Compras; `null` = todas. */
  readonly sucursales: readonly string[] | null;
}

export interface ResponsablesCalendario {
  readonly personas: readonly ResponsablePosible[];
}

/**
 * `[PQ.3.22]` ¿Esta persona puede ser responsable de una regla que cubre `plazas` (las sucursales del lugar; en la
 * corporativa, todas)? Sí si escribe en todas ellas: la MISMA cuenta que `reglaEnAlcance` del dominio, para que la
 * pantalla no ofrezca a quien la API rechazaría.
 */
export function puedeSerResponsable(sucursalesDeLaPersona: readonly string[] | null, plazas: readonly string[]): boolean {
  if (sucursalesDeLaPersona === null) return true;
  if (!plazas.length) return false;
  const suyas = new Set(sucursalesDeLaPersona);
  return plazas.every((p) => suyas.has(p));
}

export interface FueraDeCicloDto {
  /** `null` = vuelve al ciclo. */
  readonly hasta: string | null;
  readonly motivo?: string | null;
}

export interface MarcarRevisionDto {
  readonly review_date: string;
  readonly outcome: ResultadoRevision;
  readonly skip_reason?: MotivoNoSePide | null;
  readonly postponed_to?: string | null;
  readonly note?: string | null;
}

const FECHA_RX = /^\d{4}-\d{2}-\d{2}$/;
const esFecha = (f: unknown): f is string => typeof f === 'string' && FECHA_RX.test(f) && sumarDias(f, 0) === f;
const enteros = (xs: unknown): xs is number[] => Array.isArray(xs) && xs.every((x) => Number.isInteger(x));

/**
 * Lo que la base rechazaría, dicho en palabras ANTES de mandarlo (los mismos CHECK de la migración
 * 20261120130156, más que la zona y la sucursal existan). `null` = válida.
 */
export function validarRegla(d: GuardarReglaDto, zonas: readonly string[], sucursales: readonly string[]): string | null {
  if (!d || typeof d.supplier_code !== 'string' || !d.supplier_code.trim()) return 'Falta el proveedor.';
  if (!ALCANCES_REVISION.includes(d.scope)) return 'El alcance tiene que ser corporativo, zona o sucursal.';
  if (d.scope === 'zone' && (!d.zone_code || !zonas.includes(d.zone_code))) return 'Elige una zona de compra.';
  if (d.scope === 'branch' && (!d.branch_code || !sucursales.includes(d.branch_code))) return 'Elige una sucursal.';
  if (d.scope !== 'zone' && d.zone_code) return 'Sólo una regla de zona lleva zona.';
  if (d.scope !== 'branch' && d.branch_code) return 'Sólo una regla de sucursal lleva sucursal.';
  if (!PATRONES_REVISION.includes(d.pattern)) return 'Elige cuándo toca: días de la semana, días del mes o cada cierto número de días.';
  if (d.weekend_shift !== undefined && !CORRIMIENTOS_FIN_DE_SEMANA.includes(d.weekend_shift)) return 'Si cae en fin de semana: viernes o lunes.';
  if (d.pattern === 'weekdays') {
    if (!enteros(d.weekdays) || !d.weekdays.length || d.weekdays.some((x) => x < 1 || x > 7)) return 'Elige al menos un día de la semana.';
    if ((d.month_days && d.month_days.length) || d.month_last_day || d.every_n_days != null) return 'Una regla por días de la semana no lleva días del mes ni «cada N días».';
  }
  // `[PQ.3.15]` La cadencia (DC29): los mismos valores que el CHECK de la migración 20261124133043.
  const wi = d.week_interval ?? null;
  const wa = d.week_anchor ?? null;
  const mw = d.month_week ?? null;
  if (d.pattern !== 'weekdays' && (wi != null || wa != null || mw != null)) return 'Sólo una regla por días de la semana lleva cadencia.';
  if (d.pattern === 'weekdays') {
    if (wi != null && !SEMANAS_CADENCIA.includes(wi)) return 'La cadencia es cada semana, cada 2, 3 o 6 semanas, o una vez al mes.';
    if (wi != null && mw != null) return 'Elige «cada N semanas» o «una vez al mes», no las dos.';
    if (wi != null && wa == null) return 'Di a partir de qué fecha cuenta «cada N semanas».';
    if (wi == null && wa != null) return '«A partir del» sólo va con «cada N semanas».';
    if (wa != null && !esFecha(wa)) return 'La fecha «a partir del» no es válida.';
    if (mw != null && !(Number.isInteger(mw) && mw >= 1 && mw <= SEMANA_DEL_MES_ULTIMA)) return '«Una vez al mes» va el primero, segundo, tercero, cuarto o último.';
  }
  if (d.pattern === 'month_days') {
    const dias = d.month_days ?? [];
    if (!enteros(dias) || dias.some((x) => x < 1 || x > 31)) return 'Los días del mes van del 1 al 31.';
    if (!dias.length && !d.month_last_day) return 'Elige al menos un día del mes o «el último».';
    if ((d.weekdays && d.weekdays.length) || d.every_n_days != null) return 'Una regla por días del mes no lleva días de la semana ni «cada N días».';
  }
  if (d.pattern === 'every_n_days') {
    if (!Number.isInteger(d.every_n_days) || (d.every_n_days as number) < 1 || (d.every_n_days as number) > 365) return '«Cada N días» va de 1 a 365.';
    if ((d.weekdays && d.weekdays.length) || (d.month_days && d.month_days.length) || d.month_last_day) return 'Una regla «cada N días» no lleva días de la semana ni del mes.';
  }
  if (d.note != null && typeof d.note !== 'string') return 'La nota tiene que ser texto.';
  return null;
}

/** Hasta cuántos días ADELANTE se puede marcar «hoy no se pide» (se sabe el viernes que el lunes no se pide). */
export const MARCA_MAX_ADELANTE_DIAS = 14;

/** `null` = la marca es válida. Las mismas reglas que los CHECK de `purchase_review_marks`. */
export function validarMarca(d: MarcarRevisionDto, hoy: string): string | null {
  if (!d || !esFecha(d.review_date)) return 'Falta la fecha que se marca.';
  if (diasEntre(hoy, d.review_date) > MARCA_MAX_ADELANTE_DIAS) return `Sólo se marca hasta ${MARCA_MAX_ADELANTE_DIAS} días adelante.`;
  if (!RESULTADOS_REVISION.includes(d.outcome)) return 'Di si se pidió fuera de Kepler o si hoy no se pide.';
  if (d.outcome === 'ordered_outside_kepler') {
    if (d.skip_reason || d.postponed_to) return '«Se pidió fuera de Kepler» no lleva motivo ni nueva fecha.';
    return null;
  }
  if (!d.skip_reason || !MOTIVOS_NO_SE_PIDE.includes(d.skip_reason)) return 'Elige por qué hoy no se pide.';
  if (d.skip_reason === 'other' && !(d.note ?? '').trim()) return 'Con «Otro», escribe el motivo.';
  if (d.postponed_to != null) {
    if (!esFecha(d.postponed_to)) return 'La nueva fecha no es válida.';
    if (diasEntre(d.review_date, d.postponed_to) < 1) return 'La nueva fecha tiene que ser después de la que tocaba.';
  }
  return null;
}

/** `null` = válido. «Fuera de ciclo hasta» lleva motivo (R2: de temporada, dado de baja…); `hasta: null` lo regresa al ciclo. */
export function validarFueraDeCiclo(d: FueraDeCicloDto, hoy: string): string | null {
  if (!d || d.hasta === undefined) return 'Falta hasta cuándo.';
  if (d.hasta === null) return null;
  if (!esFecha(d.hasta)) return 'La fecha no es válida.';
  if (diasEntre(hoy, d.hasta) < 0) return 'La fecha ya pasó.';
  if (!(d.motivo ?? '').trim()) return 'Di por qué sale del ciclo.';
  return null;
}

/**
 * `[PQ.3.24]` El aviso «Hoy te toca» de Pedido (anexo C §10.16, DC35: **manda el Calendario**). Antes lo decía el
 * ciclo POR CANAL (`commercial.replenishment_channel.next_due_date`), que no conoce las reglas de la gerencia: en los
 * 12 proveedores con regla corporativa medidos el 2026-11-25, el canal y la regla no coincidían en ninguno.
 *
 *  - `con_regla`: proveedores con regla de la gerencia, en las sucursales de quien ve, por el estado de HOY de sus
 *    reglas (el mismo del Calendario). Un proveedor con una regla rezagada y otra que toca hoy cuenta UNA vez, como
 *    rezagado.
 *  - `sin_regla`: los canales de compra (proveedor × sucursal) que ninguna regla viva cubre, con la fecha que propone
 *    el ciclo de Kepler — **sin confirmar**. Un proveedor cuenta una vez, por su canal más atrasado.
 */
export interface AvisoCalendario {
  /** `YYYY-MM-DD`, hora de México. */
  readonly hoy: string;
  readonly con_regla: {
    /** Proveedores con al menos una regla rezagada. */
    readonly rezagados: number;
    /** Proveedores con al menos una regla que toca hoy y ninguna rezagada. */
    readonly hoy: number;
    /** Proveedores con regla en las sucursales de quien ve (cualquier estado). */
    readonly proveedores: number;
  };
  readonly sin_regla: {
    /** `false` = no se pudo leer el ciclo por canal: la pantalla lo dice, nunca pinta 0. */
    readonly measured: boolean;
    readonly vencidos: number | null;
    readonly hoy: number | null;
    readonly note: string | null;
  };
  readonly tu_alcance: AlcanceDeQuienVe;
}

/** `[PQ.3.24]` Lo que se le dice a quien lee el aviso: de dónde sale cada número. */
export const FUENTE_AVISO_SIN_REGLA =
  'Sin regla: el ciclo por canal que Kepler propone (entregas pasadas + cadencia), sin confirmar por la gerencia.';
