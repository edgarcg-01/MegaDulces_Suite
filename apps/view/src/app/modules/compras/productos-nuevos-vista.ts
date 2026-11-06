import { componerEnEscalera, unidadLegible, warehouseName, type UnidadEscalera } from '@megadulces/contracts';
import type { VeredictoCompra } from './productos-flujo.service';
import type { LanzamientoFila, ResultadoLanzamiento } from './catalogo-productos.service';
import type {
  EstadoSemaforo,
  HitoNuevo,
  HitoValores,
  MargenesNuevo,
  PlazaNueva,
  ProductoNuevo,
  UnidadesKepler,
  VeredictoNuevo,
} from './productos-nuevos.service';

/**
 * `[NP.22]` Productos nuevos, lo que se DICE (funciones puras, sin Angular). Vivían dentro de la pantalla
 * `compras-catalogo-nuevos.component.ts`; esa pantalla se unió a Compras › Catálogo › Productos (decisión de David,
 * 2026-11-04) y sus piezas se reparten: la sección
 * «Lanzamiento» de la ficha (`producto-lanzamiento.component.ts`) y el panel de flujo, que usa las cantidades.
 * El bloque de resumen (titular, cifras, cohortes) lo RETIRÓ David el mismo día: sus funciones salieron con él.
 * Las decisiones (resultado, etapa, cortes) son del servidor (`libs/commercial/.../new-products.ts`).
 */

/**
 * `[NP.6]` El semáforo de un hito contra la meta registrada. «Sin meta» y «Sin medir» NO son verde: van
 * en gris, cada uno con su motivo (el registro de umbrales nace vacío hasta que Compras fije la meta).
 */
export const SEMAFORO: Readonly<Record<EstadoSemaforo, { label: string; severity: 'success' | 'warn' | 'danger' | 'secondary' }>> = {
  ok: { label: 'En meta', severity: 'success' },
  warn: { label: 'Debajo de la meta', severity: 'warn' },
  bad: { label: 'Fuera de tolerancia', severity: 'danger' },
  sin_meta: { label: 'Sin meta', severity: 'secondary' },
  sin_medir: { label: 'Sin medir', severity: 'secondary' },
};

/**
 * `[NP.6]` En qué quedó cada corte (sin foto guardada: se deriva de la historia, 2026-11-04). Cumplido = cifra
 * definitiva de esos N días; en curso; o todavía no llega.
 */
export function estadoHitoTexto(h: Pick<HitoValores, 'cerrado'>, dia: number | null, n: HitoNuevo): string {
  if (h.cerrado) return 'Definitivo';
  return hitoVisible(dia, n) ? 'En curso' : 'Todavía no llega';
}

/**
 * `[NP.UI.6]` El seguimiento cuenta desde la compra APLICADA y «Llegó a la empresa» es la entrada física
 * del kardex. Si la mercancía llegó antes, se dice (las dos fechas, cada una con su nombre).
 */
export function inicioDistinto(p: Pick<ProductoNuevo, 'lanzamiento' | 'llegada'>): { seguimiento: string; llegada: string } | null {
  const ll = p.llegada?.fecha ?? null;
  return p.lanzamiento && ll && ll < p.lanzamiento ? { seguimiento: p.lanzamiento, llegada: ll } : null;
}

/** `[NP.UI.5]` ¿Alguna sucursal lo mandó a camiones de ruta? Esa venta no se ve aquí (sólo la de tienda en Kepler). */
export function seMuevePorRuta(plazas: ReadonlyArray<Pick<PlazaNueva, 'enviado_rutas'>>): boolean {
  return plazas.some((p) => Object.keys(p.enviado_rutas ?? {}).length > 0);
}

/** `[NP.15]` Los tres márgenes, cada uno con la pregunta que contesta. */
export const TIPOS_MARGEN: ReadonlyArray<{ id: 'lista' | 'real' | 'pagado'; titulo: string; pregunta: string }> = [
  { id: 'lista', titulo: 'De lista', pregunta: '¿Con qué margen lo pusimos a la venta? (ficha de Kepler)' },
  { id: 'real', titulo: 'Real', pregunta: '¿Cuánto dejó? (costo que Kepler registró en cada venta)' },
  { id: 'pagado', titulo: 'Sobre lo pagado', pregunta: '¿La ficha tiene el costo correcto? (lo que se pagó al comprarlo)' },
];

/** Un margen en porcentaje, con un decimal; sin medir = guion, nunca 0%. */
export function margenTexto(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${v.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

/** Los tres márgenes en una línea: "17.0% · 10.1% · 10.0%" (lista · real · pagado). */
export function tresMargenes(m: MargenesNuevo | null): string {
  if (!m) return '—';
  return TIPOS_MARGEN.map((t) => margenTexto(m[t.id].pct)).join(' · ');
}

/**
 * `[NP.15]` Las sucursales en el orden de "dónde se mueve mejor": primero las que compiten (por su
 * lugar) y después las que todavía no (por venta por día). Las que no tienen venta en la historia
 * no aparecen: no hay nada que comparar.
 */
/** `[NP.16]` "Padre Hidalgo y Canindo": las sucursales donde entró la primera compra. */
/** "A", "A y B", "A, B y C". */
const enumerar = (n: string[]) => (n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} y ${n[n.length - 1]}`);

export function sucursalesTexto(s: ReadonlyArray<{ plaza: string; nombre: string | null }>): string {
  return enumerar(s.map((x) => x.nombre || warehouseName(x.plaza)));
}

/**
 * `[NP.16]` Las sucursales del reparto: primero las que compraron (las que reparten), luego las que
 * recibieron de otra, y al final las demás con existencia. Una sin compra, sin traspaso, sin envío y
 * sin existencia no tiene nada que decir en el reparto.
 */
export function ordenReparto(plazas: PlazaNueva[]): PlazaNueva[] {
  const hay = (u: UnidadesKepler | undefined) => Object.keys(u ?? {}).length > 0;
  const grupo = (p: PlazaNueva) => (hay(p.unidades_recibidas) ? 0 : hay(p.recibido_traspaso) ? 1 : 2);
  return plazas
    .filter((p) => hay(p.unidades_recibidas) || hay(p.recibido_traspaso) || hay(p.enviado_sucursales)
      || hay(p.enviado_rutas) || (p.existencia ?? 0) > 0)
    .slice()
    .sort((a, b) => grupo(a) - grupo(b) || a.plaza.localeCompare(b.plaza));
}

/**
 * `[NP.16]` Lo que le llegó a una sucursal desde el inicio: sus compras más lo que le llegó de otra
 * sucursal. Cada rótulo de Kepler por su lado (no se convierten entre sí).
 */
export function leLlego(p: Pick<PlazaNueva, 'unidades_recibidas' | 'recibido_traspaso'>): UnidadesKepler {
  const out: UnidadesKepler = {};
  for (const u of [p.unidades_recibidas, p.recibido_traspaso]) {
    for (const [k, q] of Object.entries(u ?? {})) out[k] = Math.round(((out[k] ?? 0) + q) * 1000) / 1000;
  }
  return out;
}

export function ordenMovimiento(plazas: PlazaNueva[]): PlazaNueva[] {
  return plazas
    .filter((p) => p.movimiento?.venta_neta_dia !== null && p.movimiento?.venta_neta_dia !== undefined)
    .slice()
    .sort((a, b) => (a.movimiento.lugar ?? 999) - (b.movimiento.lugar ?? 999)
      || (b.movimiento.venta_neta_dia ?? 0) - (a.movimiento.venta_neta_dia ?? 0));
}

/** `[NP.22]` El CEDIS (`commercial.warehouses.code = '00'`, no vende al público): compra y reparte, no vende. */
export const PLAZA_CEDIS = '00';

/** Las sucursales que VENDEN (sin el CEDIS): las que se listan en «Por sucursal» (pedido de David, 2026-11-04). */
export function sucursalesQueVenden(plazas: PlazaNueva[]): PlazaNueva[] {
  return plazas.filter((p) => p.plaza !== PLAZA_CEDIS);
}

/**
 * `[NP.22]` Todas las sucursales en una sola lista: primero las que se mueven, en el orden de
 * `ordenMovimiento`; después las que aún no tienen venta por día, en el orden del servidor. Ninguna se pierde.
 */
export function ordenSucursales(plazas: PlazaNueva[]): PlazaNueva[] {
  const conMovimiento = ordenMovimiento(plazas);
  return [...conMovimiento, ...plazas.filter((p) => !conMovimiento.includes(p))];
}

/**
 * `[NP.20]` Cada resultado del lanzamiento, como se ve. Contesta «¿el lanzamiento funcionó?»; si hay que COMPRAR lo
 * dice Productos (un solo motor de compra, decisión de David 2026-11-03). El orden es el de «qué pide atención
 * primero». Antes: Recomprar · Esperar → Se queda · Revisar → Revisar · No recomprar → Sacar.
 */
export const VEREDICTOS: Record<VeredictoNuevo, { label: string; tono: 'ok' | 'warn' | 'bad' | 'info' | 'muted'; icon: string }> = {
  sacar: { label: 'Sacar', tono: 'bad', icon: 'pi pi-times-circle' },
  revisar: { label: 'Revisar', tono: 'warn', icon: 'pi pi-exclamation-circle' },
  agotado: { label: 'Agotado: no se juzga', tono: 'info', icon: 'pi pi-box' },
  se_queda: { label: 'Se queda', tono: 'ok', icon: 'pi pi-check-circle' },
  pronto: { label: 'Aún es pronto', tono: 'muted', icon: 'pi pi-hourglass' },
};
export const ORDEN_VEREDICTOS: VeredictoNuevo[] = ['sacar', 'revisar', 'agotado', 'se_queda', 'pronto'];

/**
 * `[NP.20]` Un servidor anterior puede traer el vocabulario de antes: se lee con el nuevo, con
 * el mismo mapeo que el servidor (`veredictoVigente`). Así la pantalla nunca se queda sin etiqueta.
 */
export function veredictoVista(v: string | null | undefined): VeredictoNuevo {
  const viejo: Record<string, VeredictoNuevo> = { recomprar: 'se_queda', esperar: 'se_queda', no_recomprar: 'sacar' };
  if (v && v in VEREDICTOS) return v as VeredictoNuevo;
  return (v && viejo[v]) || 'revisar';
}

/**
 * `[NP.UI.3]` Cuando los dos veredictos tiran en sentido contrario se DICE en el panel, para que no se lean como
 * contradicción: el lanzamiento salió «Sacar» (dejó de venderse con mercancía) y Productos pide reponer.
 */
export function cruceCompra(np: VeredictoNuevo | null, pf: VeredictoCompra | null): string | null {
  if (np === 'sacar' && (pf === 'comprar' || pf === 'traspasar')) {
    return 'Productos mide si alcanza la existencia al ritmo de los últimos 30 días; aquí, si el lanzamiento sigue vendiéndose. '
      + 'Antes de reponer, confirma por qué dejó de venderse donde sí hay mercancía.';
  }
  return null;
}

/**
 * `[NP.22]` Los sub-filtros de «Mostrar › Productos nuevos», con los mismos nombres de la pantalla vieja (los usa
 * Compras). Los cinco resultados, en el orden de «qué pide atención primero», llevan su tono e icono; los demás son
 * vistas fuera del juicio. Filtrar y contar lo hace el SERVIDOR (la lista del catálogo es paginada): aquí sólo se nombran.
 */
export const RESULTADOS_LANZAMIENTO: ReadonlyArray<{
  id: ResultadoLanzamiento; label: string; grupo: 'resultado' | 'otros'; veredicto: VeredictoNuevo | null;
}> = [
  { id: 'seguimiento', label: 'Todos en seguimiento', grupo: 'resultado', veredicto: null },
  ...ORDEN_VEREDICTOS.map((v) => ({ id: v as ResultadoLanzamiento, label: VEREDICTOS[v].label, grupo: 'resultado' as const, veredicto: v })),
  { id: 'sin_venta_30', label: 'Sin venta en su primer mes', grupo: 'otros', veredicto: null },
  { id: 'sin_movimiento', label: 'Dados de alta, sin movimiento', grupo: 'otros', veredicto: null },
  { id: 'no_medible', label: 'No medibles', grupo: 'otros', veredicto: null },
  { id: 'excluido', label: 'Excluidos', grupo: 'otros', veredicto: null },
];

/** Un sub-filtro de la URL que no existe cae a «seguimiento» (el mismo default del servidor). */
export function resultadoValido(s: string | null | undefined): ResultadoLanzamiento {
  return RESULTADOS_LANZAMIENTO.some((r) => r.id === s) ? (s as ResultadoLanzamiento) : 'seguimiento';
}

export const etiquetaResultado = (id: ResultadoLanzamiento) => RESULTADOS_LANZAMIENTO.find((r) => r.id === id)?.label ?? 'Todos en seguimiento';

/** `[NP.22]` La celda «Día»: el día del lanzamiento y en qué etapa va (la regla de la pantalla vieja). */
export function diaLanzamiento(l: Pick<LanzamientoFila, 'dia' | 'etapa' | 'estado'> | null | undefined): { dia: string; etapa: string | null } | null {
  if (!l) return null;
  if (l.dia === null) return { dia: 'Sin movimiento', etapa: null };
  const fuera = l.estado === 'excluido' ? 'Excluido' : l.estado === 'no_medible' ? 'No medible' : null;
  return { dia: `Día ${l.dia}`, etapa: fuera ?? (l.etapa === 'graduado' ? 'Cumplió 90 días' : null) };
}

/** `[NP.22]` La celda «¿Funcionó?»: el resultado con su tono, o por qué no se juzga. */
export function celdaFunciono(l: Pick<LanzamientoFila, 'veredicto' | 'motivo' | 'estado'> | null | undefined): {
  label: string; tono: 'ok' | 'warn' | 'bad' | 'info' | 'muted'; icon: string | null; motivo: string | null;
} | null {
  if (!l) return null;
  if (l.veredicto) {
    const v = VEREDICTOS[veredictoVista(l.veredicto)];
    return { label: v.label, tono: v.tono, icon: v.icon, motivo: l.motivo };
  }
  const label = l.estado === 'sin_movimiento' ? 'Sin movimiento' : l.estado === 'excluido' ? 'Excluido' : 'No se puede medir';
  return { label, tono: 'muted', icon: null, motivo: l.motivo };
}

/**
 * El hito se muestra si ya cerró o si es el tramo EN CURSO. Los de más adelante van con guion:
 * a los 23 días, el valor "a 60 días" sería el mismo que el de 30 y se leería como un dato.
 */
export function hitoVisible(dia: number | null, n: HitoNuevo): boolean {
  return dia !== null && dia >= n - 30;
}

/** Fecha `YYYY-MM-DD` en corto, SIN corrimiento de zona (se lee como UTC y se pinta como UTC). */
export function fechaCorta(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return '—';
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(t);
}

/** La escalera de Kepler, de lo grande a lo chico: así se lee "3 cajas · 40 piezas". */
const ORDEN_UNIDAD: Record<string, number> = { CJA: 0, BTO: 1, CUB: 2, PAQ: 3, KG: 4, PZA: 5 };
const rangoUnidad = (u: string) => ORDEN_UNIDAD[u] ?? (/^[0-9]+$/.test(u) ? 6 : u === '?' ? 8 : 7);
const cifra = (q: number) => q.toLocaleString('es-MX', { maximumFractionDigits: 2 });

/**
 * Una cantidad con su rótulo de Kepler, en palabras: "3 cajas", "1 paquete", "6 de 500 g".
 * El rótulo se traduce con `unidadLegible` (el censo medido del repo); uno que no se conoce se
 * imprime TAL CUAL (`SER`), y sin rótulo se dice "sin unidad" — nunca se le llama pieza.
 */
/** `[NP.16]` Una cantidad partida en cifra y rótulo, para pintarlas con distinto peso en una tabla. */
export interface CantidadPartes {
  cifra: string;
  rotulo: string;
}

/** La regla de `cantidadTexto`, partida: "3" + "cajas". Una sola implementación para las dos. */
export function cantidadPartes(q: number, unidad: string | null | undefined): CantidadPartes {
  const u = (unidad ?? '').trim().toUpperCase();
  if (!u || u === '?') return { cifra: cifra(q), rotulo: 'sin unidad' };
  // Gramaje de la bolsa (500, 250): no es un nombre de unidad.
  if (/^[0-9]+$/.test(u)) return { cifra: cifra(q), rotulo: `de ${u} g` };
  const leg = unidadLegible(u);
  if (!leg.conocida) return { cifra: cifra(q), rotulo: u };
  return { cifra: cifra(q), rotulo: Math.abs(q) === 1 ? leg.singular : leg.plural };
}

export function cantidadTexto(q: number, unidad: string | null | undefined): string {
  const p = cantidadPartes(q, unidad);
  return `${p.cifra} ${p.rotulo}`;
}

/**
 * `[NP.16]` Las unidades de un producto, una por renglón. Con la escalera de la ficha, en cajas
 * completas y lo demás en paquetes o piezas (178 paquetes y 2 piezas = 29 cajas, 4 paquetes y 2
 * piezas); lo que no se puede convertir va al final, tal cual. Sin escalera, cada rótulo de Kepler
 * por su lado, de lo grande a lo chico.
 */
export function listaUnidades(u: UnidadesKepler | null | undefined, esc?: ReadonlyArray<UnidadEscalera> | null): CantidadPartes[] {
  const comp = componerEnEscalera(u, esc);
  const crudas = (x: UnidadesKepler | null | undefined) => Object.entries(x ?? {})
    .filter(([, q]) => Math.abs(q) >= 0.0005)
    .sort(([a], [b]) => rangoUnidad(a) - rangoUnidad(b) || a.localeCompare(b))
    .map(([k, q]) => cantidadPartes(q, k));
  if (!comp) return crudas(u);
  return [...comp.partes.map((p) => cantidadPartes(p.cantidad, p.rotulo)), ...crudas(comp.sin_convertir)];
}

/** Las unidades en una línea: "29 cajas, 4 paquetes y 2 piezas" (o "3 cajas · 40 piezas" sin escalera). */
export function textoUnidades(u: UnidadesKepler | null | undefined, esc?: ReadonlyArray<UnidadEscalera> | null): string {
  const l = listaUnidades(u, esc).map((p) => `${p.cifra} ${p.rotulo}`);
  return componerEnEscalera(u, esc) ? enumerar(l) : l.join(' · ');
}

/** `[NP.16]` La existencia partida para una tabla. */
export interface ExistenciaPartes {
  estado: 'hay' | 'agotado' | 'sin_registro' | 'en_duda';
  /** La existencia (o la estimada, si está en duda) en la escalera de la ficha. Vacía = cero o no medida. */
  partes: CantidadPartes[];
  /** Con la existencia en duda: por qué ("Kepler sumó paquetes como si fueran piezas"). */
  motivo: string | null;
}

type ExistenciaDe = Pick<PlazaNueva, 'existencia' | 'existencia_unidad' | 'existencia_fuente' | 'escalera' | 'existencia_duda'>;

/** Una cantidad en la base de la ficha, escrita en su escalera. */
function enBase(q: number, p: ExistenciaDe): CantidadPartes[] {
  if (!p.existencia_unidad) {
    return [{ cifra: cifra(q), rotulo: p.existencia_fuente === 'wincaja' ? 'unidades de Wincaja' : '(unidad sin declarar en Kepler)' }];
  }
  return listaUnidades({ [p.existencia_unidad]: q }, p.escalera);
}

export function existenciaPartes(p: ExistenciaDe): ExistenciaPartes {
  const d = p.existencia_duda;
  if (d) {
    const plural = (r: string) => unidadLegible(r).conocida ? unidadLegible(r).plural : r;
    return {
      estado: 'en_duda',
      partes: d.estimada !== null && d.estimada > 0 ? enBase(d.estimada, p) : [],
      motivo: `Kepler sumó ${enumerar(d.otros.map(plural))} como si fueran ${plural(d.base)}`
        + (d.estimada === null ? '; no se pudieron convertir con la ficha.' : '. Convertidos con la ficha, ésta es la existencia.'),
    };
  }
  if (p.existencia === null) return { estado: 'sin_registro', partes: [], motivo: null };
  if (p.existencia <= 0) return { estado: 'agotado', partes: [], motivo: null };
  return { estado: 'hay', partes: enBase(p.existencia, p), motivo: null };
}

/**
 * La existencia de una plaza en palabras, en la escalera de SU ficha de Kepler: "Hay 5 cajas, 3
 * paquetes y 4 piezas". La caja sólo aparece si la ficha la declara con su factor; nunca se inventa.
 */
export function existenciaTexto(p: ExistenciaDe): string {
  const e = existenciaPartes(p);
  const txt = enumerar(e.partes.map((x) => `${x.cifra} ${x.rotulo}`));
  if (e.estado === 'sin_registro') return 'Sin existencia registrada';
  if (e.estado === 'agotado') return 'Agotado';
  if (e.estado === 'en_duda') {
    return `En duda: ${txt ? `según el kardex hay ${txt}` : 'el kardex no alcanza para estimarla'}`;
  }
  return `Hay ${txt}`;
}

/**
 * Sólo las semanas COMPLETAS van a la gráfica. La semana en curso trae únicamente los días que
 * ya pasaron, y pintarla hacía que la línea "se desplomara" al final — se leía como una caída que
 * no existe. Lo de esta semana se dice en texto ("Hoy $…").
 */
export function semanasCerradas(semanas: number[], dia: number | null): number[] {
  if (dia === null || !semanas.length) return [];
  return (dia + 1) % 7 === 0 ? semanas : semanas.slice(0, -1);
}

/** La tendencia de 4 semanas contra las 4 anteriores, en palabras. */
export function tendenciaTexto(t: number | null): string {
  if (t === null) return 'Sin 8 semanas para comparar';
  const pct = Math.round((t - 1) * 100);
  if (pct === 0) return 'Igual que las 4 semanas anteriores';
  return `${pct > 0 ? '+' : ''}${pct}% contra las 4 semanas anteriores`;
}
