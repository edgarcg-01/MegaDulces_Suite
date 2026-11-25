import {
  diaIso, SEMANA_DEL_MES_ULTIMA, sumarDias, type AlcanceRevision, type GuardarReglaRespuesta, type PatronDeRegla, type ZonaDeCompra,
} from '@megadulces/contracts';

/**
 * Las mejoras que pidieron los usuarios al día siguiente de salir a prod (anexo C §10.12), en funciones puras para
 * probarlas sin montar la pantalla:
 * - `[PQ.3.15]` la cadencia de «días de la semana» (DC29);
 * - `[PQ.3.21]` varias zonas o sucursales en una captura (DC28);
 * - `[PQ.3.22]` el responsable de la regla (DC30).
 */

/** `[PQ.3.15]` La cadencia, en el orden en que la pidieron los usuarios. */
export type Cadencia = 'semana' | '2' | '3' | 'mes' | '6';

export const OPCIONES_CADENCIA: readonly { readonly label: string; readonly value: Cadencia }[] = [
  { label: 'Cada semana', value: 'semana' },
  { label: 'Cada 2 semanas', value: '2' },
  { label: 'Cada 3 semanas', value: '3' },
  { label: 'Una vez al mes', value: 'mes' },
  { label: 'Cada 6 semanas', value: '6' },
];

/** `[PQ.3.15]` «Una vez al mes»: cuál de ese día en el mes. */
export const OPCIONES_SEMANA_DEL_MES: readonly { readonly label: string; readonly value: string }[] = [
  { label: 'Primero', value: '1' },
  { label: 'Segundo', value: '2' },
  { label: 'Tercero', value: '3' },
  { label: 'Cuarto', value: '4' },
  { label: 'Último', value: String(SEMANA_DEL_MES_ULTIMA) },
];

/** La cadencia que ya trae una regla (para «Corregir la regla» y la propuesta del día fijo). */
export function cadenciaDeLaRegla(r: Pick<PatronDeRegla, 'week_interval' | 'week_anchor' | 'month_week'>): {
  readonly cadencia: Cadencia; readonly ancla: string | null; readonly mesSemana: number;
} {
  if (r.month_week) return { cadencia: 'mes', ancla: null, mesSemana: r.month_week };
  const k = r.week_interval ?? null;
  if (k === 2 || k === 3 || k === 6) return { cadencia: String(k) as Cadencia, ancla: r.week_anchor ?? null, mesSemana: 1 };
  return { cadencia: 'semana', ancla: null, mesSemana: 1 };
}

/** Lo que la cadencia guarda: cada semana = nada; cada N semanas = N y la ancla; una vez al mes = cuál. */
export function camposDeCadencia(cadencia: Cadencia, ancla: string | null, mesSemana: number): {
  readonly week_interval: number | null; readonly week_anchor: string | null; readonly month_week: number | null;
} {
  if (cadencia === 'mes') return { week_interval: null, week_anchor: null, month_week: mesSemana };
  if (cadencia === 'semana') return { week_interval: null, week_anchor: null, month_week: null };
  return { week_interval: Number(cadencia), week_anchor: ancla, month_week: null };
}

/**
 * «A partir del» por omisión: el primer día elegido que viene desde `hoy` (incluido). Sin días elegidos, `hoy`.
 * Así la primera revisión es la siguiente que ya esperaba quien captura.
 */
export function anclaPorOmision(hoy: string, weekdays: readonly number[]): string {
  if (!weekdays.length) return hoy;
  for (let i = 0; i < 7; i++) {
    const f = sumarDias(hoy, i);
    if (weekdays.includes(diaIso(f))) return f;
  }
  return hoy;
}

/** `[PQ.3.22]` El puesto como se lee: `gerente_compras` → «Gerente compras». No se inventa un nombre que la base no tiene. */
export function puestoLegible(role: string | null | undefined): string {
  const t = (role ?? '').replace(/_/g, ' ').trim().toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : 'Sin puesto';
}

/**
 * `[PQ.3.22]` Las sucursales que cubre lo que se está capturando: en la corporativa, todas; por zona, las de cada zona
 * elegida; por sucursal, las elegidas. Es contra lo que se mide si alguien puede ser responsable.
 */
export function plazasDeLosLugares(
  scope: AlcanceRevision, lugares: readonly string[], zonas: readonly ZonaDeCompra[], todas: readonly string[],
): string[] {
  if (scope === 'corporate') return [...todas];
  if (scope === 'branch') return [...new Set(lugares)];
  const elegidas = new Set(lugares);
  return [...new Set(zonas.filter((z) => elegidas.has(z.code)).flatMap((z) => z.sucursales))];
}

/** «a, b y c». */
function lista(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
}

/**
 * `[PQ.3.21]` El aviso después de guardar. Un lugar: como siempre («Regla creada: BOTANAS en Yurécuaro, cada lunes.»).
 * Varios: cuántas, dónde y qué pasó con cada una («2 reglas de BOTANAS, cada martes: La Piedad (nueva) y Zamora (reemplazada).»).
 */
export function avisoDeGuardado(
  r: Pick<GuardarReglaRespuesta, 'reglas'>, proveedor: string, patron: string, nombreDe: (lugar: string | null) => string,
): string {
  const rs = r.reglas ?? [];
  if (rs.length <= 1) {
    const una = rs[0];
    return `${una?.accion === 'actualizada' ? 'Regla actualizada' : 'Regla creada'}: ${proveedor} en ${nombreDe(una?.lugar ?? null)}, ${patron.toLowerCase()}.`;
  }
  const cada = rs.map((x) => `${nombreDe(x.lugar)} (${x.accion === 'actualizada' ? 'reemplazada' : 'nueva'})`);
  return `${rs.length} reglas de ${proveedor}, ${patron.toLowerCase()}: ${lista(cada)}.`;
}
