/**
 * `[MCP.10]` La revisión en caja, del lado de la pantalla y sin Angular: qué producto se está
 * revisando, qué hace cada botón y qué se manda al terminar. Se prueba sola (revision-caja.spec.ts).
 *
 * Pensado para cajeras mayores (David, 2026-10-29): UN producto a la vez, resaltado; lo normal es un
 * solo toque («Está bien»); los demás botones son para cuando algo no cuadra.
 */
import type { PresaleReviewFinishRequest, PresaleReviewLine } from '@megadulces/contracts';

/**
 * Estado de un renglón en la pantalla.
 *  · `por_revisar` — vino completo según el surtidor; falta que la cajera lo confirme.
 *  · `falta` — vienen menos de lo pedido: pedírselo al surtidor o confirmar que no hay.
 *  · `sobra` — vinieron de más: devolverle lo que sobra al surtidor.
 *  · `bien` / `completo` / `nohay` / `devuelto` — ya resuelto.
 */
export type EstadoRenglon = 'por_revisar' | 'falta' | 'sobra' | 'bien' | 'completo' | 'nohay' | 'devuelto';

export interface MarcaRenglon {
  estado: EstadoRenglon;
  /** Cuántos vienen de verdad, en la unidad mostrada. */
  vienen: number;
  /** «Seguir con otro»: se espera al surtidor y el renglón pasa al final. */
  despues: boolean;
}

export interface ProgresoPedido {
  marcas: Record<string, MarcaRenglon>;
  /** Para «← Anterior»: cómo estaba cada renglón antes de cada toque. */
  hist: Array<{ key: string; antes: MarcaRenglon }>;
}

const RESUELTOS: ReadonlySet<EstadoRenglon> = new Set(['bien', 'completo', 'nohay', 'devuelto']);
export const resuelto = (m: MarcaRenglon | undefined): boolean => !!m && RESUELTOS.has(m.estado);

/** De dónde parte cada renglón: lo que dejó el surtidor contra lo pedido. */
export function estadoPorCantidad(ordered: number, vienen: number, eraFalta: boolean): EstadoRenglon {
  if (vienen < ordered) return 'falta';
  if (vienen > ordered) return 'sobra';
  return eraFalta ? 'completo' : 'bien';
}

export function progresoInicial(lines: PresaleReviewLine[]): ProgresoPedido {
  const marcas: Record<string, MarcaRenglon> = {};
  for (const l of lines) marcas[l.key] = { estado: l.picked < l.ordered ? 'falta' : 'por_revisar', vienen: l.picked, despues: false };
  return { marcas, hist: [] };
}

/** El renglón que se está revisando: el primero sin resolver que no se dejó para después. `null` = todos listos. */
export function renglonActual(lines: PresaleReviewLine[], p: ProgresoPedido): PresaleReviewLine | null {
  const pendientes = lines.filter((l) => !resuelto(p.marcas[l.key]));
  return pendientes.find((l) => !p.marcas[l.key]?.despues) ?? pendientes[0] ?? null;
}

export const resueltos = (lines: PresaleReviewLine[], p: ProgresoPedido): number => lines.filter((l) => resuelto(p.marcas[l.key])).length;

/** Lo que hace cada botón sobre UN renglón. Devuelve un progreso nuevo (no muta). */
export type Accion =
  | { tipo: 'bien' | 'completar' | 'nohay' | 'devuelto' | 'despues' }
  | { tipo: 'contar'; vienen: number };

export function aplicar(p: ProgresoPedido, l: PresaleReviewLine, a: Accion): ProgresoPedido {
  const antes = p.marcas[l.key] ?? { estado: 'por_revisar', vienen: l.picked, despues: false };
  // Un renglón que el surtido borró sin copia no puede volver al pedido: sólo «No hay» o «después».
  if (!l.restorable && (a.tipo === 'completar' || a.tipo === 'contar' || a.tipo === 'bien' || a.tipo === 'devuelto')) return p;
  let despues: MarcaRenglon;
  switch (a.tipo) {
    case 'bien': despues = { ...antes, estado: 'bien', vienen: l.ordered, despues: false }; break;
    case 'completar':
      despues = { ...antes, estado: 'completo', vienen: l.ordered, despues: false }; break;
    case 'nohay': despues = { ...antes, estado: 'nohay', despues: false }; break;
    case 'devuelto': despues = { ...antes, estado: 'devuelto', despues: false }; break;
    case 'despues':
      // No es una decisión: no entra al historial de «Anterior».
      return { ...p, marcas: { ...p.marcas, [l.key]: { ...antes, despues: true } } };
    case 'contar': {
      const vienen = Math.max(0, a.vienen);
      const eraFalta = antes.estado === 'falta' || antes.estado === 'sobra' || l.picked < l.ordered;
      despues = { estado: estadoPorCantidad(l.ordered, vienen, eraFalta), vienen, despues: false };
      break;
    }
  }
  return { marcas: { ...p.marcas, [l.key]: despues }, hist: [...p.hist, { key: l.key, antes }] };
}

/** «← Anterior»: el último toque vuelve a como estaba. */
export function deshacer(p: ProgresoPedido): ProgresoPedido {
  const ultimo = p.hist[p.hist.length - 1];
  if (!ultimo) return p;
  return { marcas: { ...p.marcas, [ultimo.key]: ultimo.antes }, hist: p.hist.slice(0, -1) };
}

/** Lo que se manda al terminar: lo que se queda en el pedido y lo que se devolvió. */
export function cuerpoDeCierre(lines: PresaleReviewLine[], p: ProgresoPedido): PresaleReviewFinishRequest {
  return {
    lines: lines.map((l) => {
      const m = p.marcas[l.key];
      if (!m || !resuelto(m)) throw new Error(`Falta revisar «${l.product_name}».`);
      if (m.estado === 'nohay') return { key: l.key, final: Math.min(m.vienen, l.ordered) };
      if (m.estado === 'devuelto') return { key: l.key, final: l.ordered, returned: Math.max(0, m.vienen - l.ordered) };
      return { key: l.key, final: l.ordered };
    }),
  };
}

/** Lo que no se va a cobrar, para decírselo en grande a la cajera antes de terminar. */
export function noHubo(lines: PresaleReviewLine[], p: ProgresoPedido): Array<{ line: PresaleReviewLine; faltan: number }> {
  return lines
    .filter((l) => p.marcas[l.key]?.estado === 'nohay')
    .map((l) => ({ line: l, faltan: +(l.ordered - Math.min(p.marcas[l.key].vienen, l.ordered)).toFixed(3) }))
    .filter((x) => x.faltan > 0);
}

const UNIDADES: Record<string, [string, string]> = {
  CJA: ['caja', 'cajas'], CAJ: ['caja', 'cajas'], CJ: ['caja', 'cajas'],
  PAQ: ['paquete', 'paquetes'], PQT: ['paquete', 'paquetes'],
  PZA: ['pieza', 'piezas'], PZ: ['pieza', 'piezas'],
  BOL: ['bolsa', 'bolsas'], EXH: ['exhibidor', 'exhibidores'], DIS: ['display', 'displays'],
  KG: ['kg', 'kg'], GR: ['g', 'g'], LT: ['litro', 'litros'], L: ['litro', 'litros'],
};

/** «3 paquetes», «1 caja». Una unidad que no está en la lista se muestra tal cual (no se inventa). */
export function cantidadTexto(n: number, unidad: string): string {
  const u = UNIDADES[String(unidad ?? '').trim().toUpperCase()];
  const num = Number.isInteger(n) ? String(n) : String(+n.toFixed(3));
  if (!u) return `${num} ${unidad}`;
  return `${num} ${n === 1 ? u[0] : u[1]}`;
}

/** `YYYY-MM-DD` de un instante, en hora de México. */
export function fechaMx(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/**
 * Días que lleva sin revisar un pedido que el surtidor terminó en `terminadoIso`, contra `hoy`
 * (`YYYY-MM-DD` del servidor, en hora de México). 0 = se surtió hoy. Lo sin revisar no caduca.
 */
export function diasSinRevisar(terminadoIso: string, hoy: string): number {
  const [a, b] = [fechaMx(terminadoIso), hoy].map((f) => { const [y, m, d] = f.split('-').map(Number); return Date.UTC(y, m - 1, d); });
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** «Sin revisar · hace 2 días»; `null` si es de hoy (lo de hoy es trabajo normal, no un atraso). */
export function textoAtraso(dias: number): string | null {
  if (dias <= 0) return null;
  return dias === 1 ? 'Sin revisar · desde ayer' : `Sin revisar · hace ${dias} días`;
}

/** Paso del − / +: medio en lo que se pesa, uno en lo demás. */
export const pasoDe = (unidad: string): number => (/^(KG|GR|LT|LTS|L|ML)$/i.test(unidad) ? 0.5 : 1);
