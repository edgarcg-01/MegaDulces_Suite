import type { AndenLineaOffline, AndenPaqueteOffline, AndenValeEnCurso, AndenValeOffline, ErpPendingBranch } from '@megadulces/contracts';
import type { DiscrepancyKind, ErpOrderMatch, OpenSessionDto, ReceivingLine, ReceivingSession } from '../receiving-session.service';
import type { EvaluatePayload } from '../receiving-auditor.service';

/**
 * `[WMS-REC.20]` **El Andén sin red — las decisiones, sin Angular ni base.**
 *
 * Pedido de quien recibe (2026-10-07): con poco internet hay que poder seguir, y lo terminado
 * se manda solo cuando vuelve la conexión. Este módulo decide; el servicio guarda y envía.
 *
 * **Dos capas por vale.** La *base* es lo último que dijo el servidor (más lo que se le mandó con
 * éxito); encima va la *cola* de lo que falta mandar. En pantalla se ve la base con la cola
 * aplicada (`superponer`). Así, cuando llega el detalle del servidor no se cuenta dos veces lo que
 * sigue en cola, y lo ya enviado no desaparece — que es lo que invitaría a fecharlo otra vez y
 * duplicar existencia.
 *
 * **Cada escritura lleva su llave (`client_uuid`) desde el primer intento.** Si falla por red se
 * encola CON LA MISMA llave: aunque el servidor sí la haya recibido, el reintento no duplica
 * (WMS-REC.19).
 */

/**
 * Cuánto se espera al servidor antes de tratarlo como "sin red", en milisegundos. Una red mala no
 * contesta: se cuelga, y sin tope la pantalla se queda "cargando" para siempre. La captura espera
 * más porque sube la foto de la etiqueta.
 */
export const TOPE = { lectura: 10_000, escritura: 20_000, captura: 45_000 } as const;

/** Prefijo de un vale que existe sólo en el equipo (se abrió sin red). */
export const PREFIJO_LOCAL = 'local:';

export function esLocal(id: string | null | undefined): boolean {
  return !!id && id.startsWith(PREFIJO_LOCAL);
}

export function nuevaLlave(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Respaldo con la forma de un UUID v4 (el servidor valida la forma, no el origen).
  const h = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${h(8)}-${h(4)}-4${h(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${h(3)}-${h(12)}`;
}

// ── La cola ───────────────────────────────────────────────────────────────

interface OpBase {
  id: string;
  /** Orden de llegada: dentro de un vale se manda en este orden. */
  seq: number;
  /** El vale: su id del servidor, o `local:<llave>` si se abrió sin red. */
  valeKey: string;
  creadoEn: string;
  intentos: number;
  /** `error` = el servidor la rechazó por una razón de negocio: no se reintenta sola. */
  estado: 'pendiente' | 'error';
  error?: string;
}

export type OpAnden = OpBase &
  (
    | { tipo: 'abrir'; dto: OpenSessionDto & { client_uuid: string } }
    | {
        tipo: 'fechar';
        /** Renglón del vale (local o del servidor). Vacío = captura suelta, fuera del vale. */
        lineaId: string;
        payload: Omit<EvaluatePayload, 'source_ref' | 'receiving_line_id'> & { client_uuid: string };
      }
    | { tipo: 'renglon'; lineaId: string; received_qty: number }
    | { tipo: 'cerrar' }
  );

/** Lo que el equipo guarda de cada vale. */
export interface ValeGuardado {
  key: string;
  /** Id del vale en el servidor. `null` mientras se abrió sin red y no se ha mandado. */
  sessionId: string | null;
  /** La base: lo último que dijo el servidor, o el vale armado del paquete si es local. */
  vale: ReceivingSession;
  /** Renglón local → renglón del servidor, una vez abierto allá. */
  mapa: Record<string, string>;
  /** A qué sucursal del menú pertenece (para el paquete y el menú sin red). */
  sucursal: string | null;
  /** El vale del menú del que salió, si se abrió desde el menú. */
  erp: ErpOrderMatch | null;
  actualizado: string;
}

// ── Red ───────────────────────────────────────────────────────────────────

/**
 * ¿Falló la RED (se reintenta sola) o el servidor dijo que no (hay que mirarla)?
 *
 * Sin respuesta (0), tiempo agotado (408), demasiadas (429) y errores del servidor (5xx) son de
 * red. 401 también: la sesión venció y al volver a entrar la cola sigue — tirarla perdería lo
 * capturado. Todo lo demás (400/403/404/409/422) es una respuesta de negocio.
 */
export function esFallaDeRed(e: unknown): boolean {
  const s = (e as { status?: number } | null)?.status;
  if (typeof s !== 'number') return true;
  return s === 0 || s === 401 || s === 408 || s === 429 || s >= 500;
}

/**
 * ¿El servidor NO se alcanzó? (sin respuesta, tiempo agotado, la puerta de entrada caída). Es la
 * pregunta de las LECTURAS: sólo así se cae a lo guardado en el equipo. Un 500 sí contestó — es
 * un error del servidor y se dice, no se esconde detrás de datos viejos.
 */
export function esSinRed(e: unknown): boolean {
  const s = (e as { status?: number } | null)?.status;
  if (typeof s !== 'number') return true;
  return s === 0 || s === 408 || s === 502 || s === 503 || s === 504;
}

/** Cuántas veces se reintenta un error del servidor (500) antes de detener el vale para que alguien lo mire. */
export const MAX_INTENTOS_500 = 5;

/** El motivo que da el servidor, o uno genérico. Nunca "Error" pelado. */
export function motivoDe(e: unknown, accion: string): string {
  const x = e as { status?: number; error?: { message?: string | string[] }; message?: string } | null;
  const m = x?.error?.message;
  if (Array.isArray(m) && m.length) return m.join(' · ');
  if (typeof m === 'string' && m.trim()) return m;
  return `No se pudo ${accion}${x?.status ? ` (HTTP ${x.status})` : ''}.`;
}

// ── El vale armado del paquete ───────────────────────────────────────────

/** El vale que se trabaja sin red: misma forma que el detalle del servidor, renglones `local:`. */
export function valeLocal(v: AndenValeOffline, llave: string): ReceivingSession {
  return {
    id: `${PREFIJO_LOCAL}${llave}`,
    folio: 'Sin folio aún',
    warehouse_id: v.warehouse_id || '',
    warehouse_code: v.warehouse_code ?? undefined,
    warehouse_name: v.warehouse_name ?? undefined,
    supplier_code: v.proveedor_code ?? null,
    source_kind: v.fuente === 'embarque' ? 'erp_transfer' : 'erp_receipt',
    source_ref: null,
    status: 'open',
    created_at: new Date().toISOString(),
    lines: v.lineas.map((l, i) => lineaLocal(l, i)),
    origin: v.origin ?? null,
    erp: {
      sucursal: v.sucursal,
      folio: v.folio,
      receipt_date: v.receipt_date ?? null,
      proveedor_code: v.proveedor_code ?? null,
      proveedor_nombre: v.proveedor_nombre ?? null,
      monto: Number(v.monto) || 0,
      tipo: v.tipo,
      fuente: v.fuente,
      serie: v.serie ?? null,
    },
  };
}

function lineaLocal(l: AndenLineaOffline, i: number): ReceivingLine {
  return {
    id: `${PREFIJO_LOCAL}${i}`,
    product_id: l.product_id,
    sku: l.sku,
    product_name: l.product_name,
    expected_sku: l.expected_sku,
    expected_name: l.expected_name,
    expected_qty: l.expected_qty,
    received_qty: 0,
    discrepancy_kind: 'pending',
    declared_qty: 0,
    held_qty: 0,
    holds: 0,
    expected_unit: l.expected_unit,
  };
}

/** ¿Este vale del menú es el que pide el usuario? Un embarque se reconoce también por su serie. */
export function mismoDocumento(a: Pick<ErpOrderMatch, 'sucursal' | 'folio' | 'serie' | 'fuente'>, b: Pick<ErpOrderMatch, 'sucursal' | 'folio' | 'serie' | 'fuente'>): boolean {
  const emb = (x: typeof a) => x.fuente === 'embarque';
  return emb(a) === emb(b) && a.sucursal === b.sucursal && a.folio === b.folio && (!emb(a) || Number(a.serie) === Number(b.serie));
}

// ── Renglón local ↔ renglón del servidor ─────────────────────────────────

/**
 * Empareja los renglones que el equipo trabajó sin red con los que el servidor creó al abrir.
 *
 * NO por posición: el detalle del servidor ordena por estado y todos los renglones de un vale nacen
 * con el mismo `created_at`, así que su orden no es el de Kepler. Se empareja por (SKU, cantidad) y,
 * dentro de eso, por orden de aparición — dos renglones con el mismo SKU y la misma cantidad son
 * intercambiables, y basta con que el emparejamiento sea uno a uno.
 */
export function emparejarRenglones(locales: ReceivingLine[], servidor: ReceivingLine[]): Record<string, string> {
  const clave = (l: ReceivingLine) => `${l.expected_sku ?? ''}|${Number(l.expected_qty) || 0}`;
  const libres = new Map<string, string[]>();
  for (const l of servidor) {
    const k = clave(l);
    libres.set(k, [...(libres.get(k) ?? []), l.id]);
  }
  const out: Record<string, string> = {};
  for (const l of locales) {
    const cola = libres.get(clave(l));
    const id = cola?.shift();
    if (id) out[l.id] = id;
  }
  return out;
}

// ── Aplicar lo pendiente encima de la base ───────────────────────────────

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Copia de `ReceivingSessionService.discrepancyFor` del servidor: el renglón cerrado sin red se ve igual. */
export function discrepancia(expected: number, received: number): DiscrepancyKind {
  if (received === 0 && expected > 0) return 'pending';
  if (received < expected) return 'faltante';
  if (received > expected) return 'sobrante';
  return 'ok';
}

/**
 * La base con lo que falta mandar aplicado encima. Sin red no hay semáforo: una caducidad en cola
 * cuenta como declarada (el bodeguero ya la fechó), y el veredicto llega al enviarla.
 *
 * `mapa` traduce renglones locales a los del servidor cuando la base ya es la del servidor y la
 * cola todavía nombra renglones locales.
 */
export function superponer(base: ReceivingSession, ops: OpAnden[], mapa: Record<string, string> = {}): ReceivingSession {
  const lineas = (base.lines ?? []).map((l) => ({ ...l }));
  const porId = new Map(lineas.map((l) => [l.id, l]));
  const renglon = (id: string) => porId.get(mapa[id] ?? id) ?? porId.get(id);
  let status = base.status;
  for (const op of [...ops].sort((a, b) => a.seq - b.seq)) {
    if (op.tipo === 'fechar' && op.lineaId) {
      const l = renglon(op.lineaId);
      if (l) l.declared_qty = num(l.declared_qty) + num(op.payload.quantity);
    } else if (op.tipo === 'renglon') {
      const l = renglon(op.lineaId);
      if (l) {
        l.received_qty = op.received_qty;
        l.discrepancy_kind = discrepancia(num(l.expected_qty), op.received_qty);
      }
    } else if (op.tipo === 'cerrar') {
      status = 'closed';
    }
  }
  return { ...base, status, lines: lineas };
}

/** Lo que una escritura que SÍ llegó al servidor cambia en la base, sin volver a pedir el detalle. */
export function conCapturaEnviada(base: ReceivingSession, lineaId: string, cantidad: number, retenida: boolean): ReceivingSession {
  return {
    ...base,
    lines: (base.lines ?? []).map((l) =>
      l.id !== lineaId
        ? l
        : {
            ...l,
            declared_qty: num(l.declared_qty) + cantidad,
            held_qty: num(l.held_qty) + (retenida ? cantidad : 0),
          },
    ),
  };
}

// ── Menú sin red ─────────────────────────────────────────────────────────

/** Los vales de un paquete que todavía no se abrieron en el equipo. */
export function valesDisponibles(p: AndenPaqueteOffline, guardados: ValeGuardado[]): AndenValeOffline[] {
  return p.vales.filter((v) => !guardados.some((g) => g.erp && mismoDocumento(g.erp, v)));
}

/** El menú de sucursales armado con los paquetes bajados. Mismo cálculo que el servidor, menos el alcance. */
export function menuDesdePaquetes(paquetes: AndenPaqueteOffline[], guardados: ValeGuardado[], hoy: string): ErpPendingBranch[] {
  return paquetes
    .map((p) => {
      const vs = valesDisponibles(p, guardados);
      const compras = vs.filter((v) => v.tipo !== 'traspaso');
      const w = p.vales.find((v) => v.warehouse_id) ?? null;
      return {
        sucursal: p.sucursal,
        warehouse_id: w?.warehouse_id ?? null,
        warehouse_code: w?.warehouse_code ?? null,
        warehouse_name: w?.warehouse_name ?? null,
        pendientes: vs.length,
        compras: compras.length,
        anteriores: compras.filter((v) => (v.receipt_date ?? hoy) < hoy).length,
        traspasos: vs.length - compras.length,
        ultimo: vs.map((v) => v.receipt_date ?? '').sort().pop() || null,
        sin_almacen: !w,
      } as ErpPendingBranch;
    })
    .filter((b) => b.pendientes > 0);
}

/** Los vales guardados en el equipo que siguen abiertos, con la forma de «Incompletos». */
export function incompletosLocales(guardados: ValeGuardado[], ops: OpAnden[]): AndenValeEnCurso[] {
  return guardados
    .map((g) => ({ g, vista: superponer(g.vale, ops.filter((o) => o.valeKey === g.key), g.mapa) }))
    .filter(({ vista }) => vista.status === 'open')
    .map(({ g, vista }) => {
      const lineas = vista.lines ?? [];
      const porFechar = lineas.filter(
        (l) => l.discrepancy_kind === 'pending' && num(l.expected_qty) - num(l.declared_qty) - num(l.held_qty) > 0,
      ).length;
      return {
        id: g.key,
        folio: g.vale.folio,
        source_kind: g.vale.source_kind,
        documento: g.erp ? (g.erp.fuente === 'embarque' ? `Embarque ${g.erp.folio}` : `${g.erp.sucursal}/${g.erp.folio}`) : null,
        warehouse_id: g.vale.warehouse_id,
        warehouse_code: g.vale.warehouse_code ?? null,
        warehouse_name: g.vale.warehouse_name ?? null,
        origin: g.vale.origin ?? { kind: 'supplier', isCedis: false, label: 'Proveedor', name: g.vale.supplier_code ?? null },
        renglones: lineas.length,
        por_fechar: porFechar,
        abierto_por: null,
        created_at: g.vale.created_at ?? g.actualizado,
      };
    });
}
