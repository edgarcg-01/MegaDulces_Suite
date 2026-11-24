/**
 * [SM.55] Qué turnos de caja le tocan a la encargada, en qué va cada uno, y el control por día
 * y por cajera.
 *
 * Medido en prod (1–22 nov 2026, solo lectura): en 94 turnos Kepler registró retiros que la
 * Suite no tiene completos, y en 51 de los 57 sin ningún conteo nadie abrió el arqueo — tampoco
 * contaron el cajón. Desde [SM.51] la cajera ya no ve el aviso «retiros sin contar», y la bandeja
 * de descuadres (/almacen/cuadre) tiene 2,591 hallazgos con CERO respuestas: lo que falta no es
 * otra bandeja, es una lista corta con dueña (la encargada de la sucursal) y que cada turno quede
 * justificado y seguido hasta cerrarlo.
 *
 * Funciones puras: reciben la respuesta de «Sucursales y sus cajas» (`armarCajasDelDia`, la misma
 * liga conteo ↔ turno que usa esa pantalla) y el historial ya leído; no tocan base de datos.
 */
import { MOTIVOS_RETIROS } from '@megadulces/contracts/http/arqueo-cajas';
import type {
  ArqueoCajasResp, ArqueoCajasTurno, ArqueoRevisionCajera, ArqueoRevisionDia, ArqueoRevisionEvento,
  ArqueoRevisionFirmaDia, ArqueoRevisionJustificacion, ArqueoRevisionTotales, ArqueoRevisionTurno, EstadoRevision,
  MotivoRevision,
} from '@megadulces/contracts/http/arqueo-cajas';

/** La regla del caso por turno, y la del día firmado. Las dos se registran APAGADAS. */
export const RULE_KEY_REVISION = 'turno_sin_verificar';
export const RULE_KEY_DIA = 'dia_revisado';

/** Cómo se distingue cada renglón del historial en `discrepancy_feedback.causa`. */
export const PREFIJO_ACCION = 'accion:';
export const MARCA_CERRADO = 'cerrado';
export const MARCA_DIA = 'dia_revisado';

export function claveTurno(warehouse: string, caja: string, fecha: string, folio: string): string {
  return `${RULE_KEY_REVISION}:${warehouse}:${caja}:${fecha}:${folio}`;
}

export function claveDia(warehouse: string, fecha: string): string {
  return `${RULE_KEY_DIA}:${warehouse}:${fecha}`;
}

/**
 * Por qué este turno hay que revisarlo. Lista vacía = cuadra.
 *
 * - Un turno ABIERTO no se revisa: la cajera todavía puede contar.
 * - El cajón sin contar solo cuenta si Kepler publicó un esperado mayor a cero: sin esperado no
 *   hay contra qué (turno de apertura fallida, o el feed no lo trajo) y pedirle a alguien que lo
 *   justifique sería pedirle que explique un hueco del dato.
 */
export function motivosDeRevision(t: Pick<ArqueoCajasTurno,
  'abierto' | 'retiros_estado' | 'cierres' | 'esperado'>): MotivoRevision[] {
  if (t.abierto) return [];
  const m: MotivoRevision[] = [];
  if (t.retiros_estado === 'faltan') m.push('retiros_sin_contar');
  if (t.retiros_estado === 'de_mas') m.push('retiros_de_mas');
  if (!t.cierres.length && t.esperado != null && t.esperado > 0) m.push('cajon_sin_contar');
  return m;
}

/** Un turno ya cerrado, antes de leer su historial. */
export type TurnoBase = Omit<ArqueoRevisionTurno, 'estado' | 'justificacion' | 'historial'>;

/** TODOS los turnos cerrados de UN día (también los que cuadran), en orden de sucursal, caja y apertura. */
export function turnosCerrados(dia: ArqueoCajasResp): TurnoBase[] {
  const out: TurnoBase[] = [];
  for (const s of dia.sucursales) {
    for (const t of s.turnos) {
      if (t.abierto) continue;
      out.push({
        clave: claveTurno(s.warehouse_code, t.caja, dia.fecha, t.folio),
        fecha: dia.fecha,
        warehouse_code: s.warehouse_code,
        warehouse_nombre: s.nombre,
        caja: t.caja,
        folio: t.folio,
        cajero_code: t.cajero_code,
        cajero_nombre: t.cajero_nombre,
        hora_apertura: t.hora_apertura,
        hora_cierre: t.hora_cierre,
        motivos: motivosDeRevision(t),
        retirado_kepler: t.retirado_kepler,
        retiros_contados: t.retiros_contados,
        retiros_diferencia: t.retiros_diferencia,
        cajon_contado: t.cierres.length > 0,
      });
    }
  }
  return out;
}

/** Solo los que tienen algo que revisar. */
export function turnosPorRevisar(dia: ArqueoCajasResp): TurnoBase[] {
  return turnosCerrados(dia).filter((t) => t.motivos.length > 0);
}

/** Un renglón crudo de `discrepancy_feedback`. */
export interface FilaHistorial {
  causa: string | null;
  nota: string | null;
  created_by: string | null;
  nombre: string | null;
  created_at: Date | string;
}

const rango = (c: string | null): number => (c === MARCA_CERRADO ? 2 : c?.startsWith(PREFIJO_ACCION) ? 1 : 0);

/** Las filas del caso → su historial tipado, en orden. Una fila que no se reconoce se ignora. */
export function historialDe(filas: FilaHistorial[]): ArqueoRevisionEvento[] {
  return [...filas]
    // Con la misma hora (filas viejas guardadas en una sola transacción) manda el orden lógico.
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || rango(a.causa) - rango(b.causa))
    .map((f): ArqueoRevisionEvento | null => {
      const causa = f.causa ?? '';
      const base = { nota: f.nota, por: f.created_by, por_nombre: f.nombre, at: new Date(f.created_at).toISOString() };
      if (causa === MARCA_CERRADO) return { tipo: 'cerrado', valor: null, ...base };
      if (causa.startsWith(PREFIJO_ACCION)) return { tipo: 'accion', valor: causa.slice(PREFIJO_ACCION.length), ...base };
      if (causa && causa !== MARCA_DIA) return { tipo: 'causa', valor: causa, ...base };
      return null;
    })
    .filter((e): e is ArqueoRevisionEvento => e != null);
}

/** La última causa del historial (la que manda). */
export function ultimaCausa(h: ArqueoRevisionEvento[]): ArqueoRevisionJustificacion | null {
  const c = [...h].reverse().find((e) => e.tipo === 'causa');
  return c ? { causa: c.valor ?? '', nota: c.nota ?? '', por: c.por, por_nombre: c.por_nombre, at: c.at } : null;
}

/** Los retiros de la Suite no empatan con los de Kepler (lo único que se justifica). */
export function descuadraRetiros(motivos: MotivoRevision[]): boolean {
  return motivos.some((m) => MOTIVOS_RETIROS.includes(m));
}

/**
 * En qué va el turno, en cuanto a sus RETIROS. El orden importa: un turno que ya empata no se le
 * pide a nadie aunque tenga historial (la cajera contó después); uno cerrado ya no vuelve a
 * seguimiento. El cajón sin contar NO pide justificación (decisión de David, 2026-11-24): va como
 * dato informativo en `motivos`, y el turno que solo tiene eso queda `cuadra` en retiros.
 */
export function estadoDe(motivos: MotivoRevision[], h: ArqueoRevisionEvento[]): EstadoRevision {
  if (h.some((e) => e.tipo === 'cerrado')) return 'cerrado';
  if (!descuadraRetiros(motivos)) return 'cuadra';
  return h.some((e) => e.tipo === 'causa') ? 'en_seguimiento' : 'por_justificar';
}

/** Puede cerrarse un caso: tiene causa y al menos una acción, y no está cerrado. */
export function puedeCerrar(h: ArqueoRevisionEvento[], conAccionNueva: boolean): boolean {
  if (h.some((e) => e.tipo === 'cerrado')) return false;
  if (!h.some((e) => e.tipo === 'causa')) return false;
  return conAccionNueva || h.some((e) => e.tipo === 'accion');
}

/** El control por día: un renglón por sucursal y fecha, más reciente arriba. */
export function resumenDias(
  turnos: ArqueoRevisionTurno[],
  firmas: Map<string, ArqueoRevisionFirmaDia>,
): ArqueoRevisionDia[] {
  const m = new Map<string, ArqueoRevisionDia>();
  for (const t of turnos) {
    const k = claveDia(t.warehouse_code, t.fecha);
    const d = m.get(k) ?? {
      fecha: t.fecha, warehouse_code: t.warehouse_code, turnos: 0, cuadran: 0, por_justificar: 0,
      en_seguimiento: 0, cerrados: 0, revisado: firmas.get(k) ?? null,
    };
    d.turnos++;
    if (t.estado === 'cuadra') d.cuadran++;
    else if (t.estado === 'por_justificar') d.por_justificar++;
    else if (t.estado === 'en_seguimiento') d.en_seguimiento++;
    else d.cerrados++;
    m.set(k, d);
  }
  return [...m.values()].sort((a, b) => b.fecha.localeCompare(a.fecha) || a.warehouse_code.localeCompare(b.warehouse_code));
}

/**
 * Cuántas veces se repite cada error por cajera. La llave es el código de cajera de Kepler del
 * turno: si el código es compartido (cuentas tipo «C01»), el número es del código, no de la persona,
 * y la pantalla lo dice.
 */
export function resumenCajeras(turnos: ArqueoRevisionTurno[]): ArqueoRevisionCajera[] {
  const m = new Map<string, ArqueoRevisionCajera>();
  for (const t of turnos) {
    const k = t.cajero_code ?? '(sin código)';
    const c = m.get(k) ?? {
      cajero_code: k, cajero_nombre: t.cajero_nombre, sucursales: [], turnos: 0, con_problema: 0,
      motivos: { retiros_sin_contar: 0, retiros_de_mas: 0, cajon_sin_contar: 0 }, causas: {}, por_justificar: 0,
      retirado_kepler: 0, retiros_contados: 0, retiros_diferencia: 0, retiros_descuadre: 0, turnos_descuadre: 0,
    };
    if (!c.sucursales.includes(t.warehouse_code)) c.sucursales.push(t.warehouse_code);
    c.turnos++;
    if (t.motivos.length) c.con_problema++;
    for (const mo of t.motivos) c.motivos[mo]++;
    if (t.justificacion) c.causas[t.justificacion.causa] = (c.causas[t.justificacion.causa] ?? 0) + 1;
    if (t.estado === 'por_justificar') c.por_justificar++;
    sumarRetiros(c, t);
    m.set(k, c);
  }
  return [...m.values()]
    .map((c) => ({ ...c, ...redondear(c) }))
    .filter((c) => c.turnos_descuadre > 0)
    .sort((a, b) => b.retiros_descuadre - a.retiros_descuadre || b.por_justificar - a.por_justificar || a.cajero_code.localeCompare(b.cajero_code));
}

type SumaRetiros = Pick<ArqueoRevisionTotales,
  'retirado_kepler' | 'retiros_contados' | 'retiros_diferencia' | 'retiros_descuadre' | 'turnos_descuadre'>;

/** Acumula los retiros de un turno. El descuadre (sin signo) solo de los que no empatan. */
function sumarRetiros(acc: SumaRetiros, t: ArqueoRevisionTurno): void {
  acc.retirado_kepler += Number(t.retirado_kepler) || 0;
  acc.retiros_contados += Number(t.retiros_contados) || 0;
  acc.retiros_diferencia += Number(t.retiros_diferencia) || 0;
  if (descuadraRetiros(t.motivos)) {
    acc.retiros_descuadre += Math.abs(Number(t.retiros_diferencia) || 0);
    acc.turnos_descuadre++;
  }
}

const centavos = (n: number): number => Math.round(n * 100) / 100;
function redondear<T extends SumaRetiros>(x: T): SumaRetiros {
  return {
    retirado_kepler: centavos(x.retirado_kepler), retiros_contados: centavos(x.retiros_contados),
    retiros_diferencia: centavos(x.retiros_diferencia), retiros_descuadre: centavos(x.retiros_descuadre),
    turnos_descuadre: x.turnos_descuadre,
  };
}

/**
 * Kepler contra Suite de TODOS los turnos cerrados del rango. La meta de la pantalla es que la
 * diferencia neta sea 0; el descuadre sin signo evita que un + esconda un −.
 */
export function totalesRetiros(turnos: ArqueoRevisionTurno[]): ArqueoRevisionTotales {
  const acc: SumaRetiros = { retirado_kepler: 0, retiros_contados: 0, retiros_diferencia: 0, retiros_descuadre: 0, turnos_descuadre: 0 };
  const cajeras = new Set<string>();
  let porJustificar = 0;
  for (const t of turnos) {
    sumarRetiros(acc, t);
    if (descuadraRetiros(t.motivos)) cajeras.add(t.cajero_code ?? '(sin código)');
    if (t.estado === 'por_justificar') porJustificar++;
  }
  return { ...redondear(acc), cajeras_descuadre: cajeras.size, por_justificar: porJustificar };
}

/** Los días de `desde` a `hasta`, ambos incluidos ('YYYY-MM-DD'). */
export function diasEntre(desde: string, hasta: string): string[] {
  const out: string[] = [];
  const d = new Date(`${desde}T12:00:00Z`);
  const fin = new Date(`${hasta}T12:00:00Z`);
  while (d <= fin) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Suma o resta días a una fecha 'YYYY-MM-DD'. */
export function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
