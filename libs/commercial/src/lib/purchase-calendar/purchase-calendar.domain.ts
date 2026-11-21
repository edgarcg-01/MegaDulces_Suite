import {
  estadoDeRegla, sumarDias, VENTANA_REZAGO_DIAS,
  type AlcanceDeQuienVe, type CalendarioCompras, type EstadoRevision, type FuenteActividad, type MarcaVista, type ReglaCalendario, type ReglaRevision,
  type ZonaDeCompra,
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
  readonly note: string | null;
  /** La ficha con productos en Pedido para esta clave (R5); `null` si no hay. */
  readonly pedido_supplier_id: string | null;
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
      out_of_cycle_until: r.out_of_cycle_until, out_of_cycle_reason: r.out_of_cycle_reason,
      supplier_name: r.supplier_name,
      alcance_nombre: nombreDelAlcance(r, sucursales),
      revisa: r.reviewer_name ?? revisaPorAlcance(r, sucursales),
      estado,
      ultima_actividad: ultima,
      ultima_marca: marcaVista,
      definida_por: r.definida_por,
      definida_el: r.definida_el,
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
  };
}
