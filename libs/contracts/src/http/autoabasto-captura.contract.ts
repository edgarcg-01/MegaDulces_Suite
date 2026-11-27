/**
 * `[AB.PM.2]` **El pedido a mano de Autoabasto: el alcance de cada renglón y cómo se parte al mandarlo.**
 *
 * Pedido de Francisco (2026-11-26): la captura a mano tiene que traer «la medición del alcance en días
 * como se mide en pedido de compras a proveedor». Esa medición ya vive UNA vez —`diasDeCobertura()` y
 * `TOPE_COBERTURA_DIAS` en `cantidad-pedido.contract.ts` (`[AB.40]`, `[RA.45D]`)—, así que aquí NO se
 * escribe otra fórmula (ADR-056): se le ponen los estados que la pantalla necesita para decirla.
 *
 * Plan y reglas en `docs/IMPLEMENTACION/FASES/FASE_AB_ANEXO_PEDIDO_A_MANO_2026-11-26.md` (R2–R5, R7).
 */
import { cabeBajoTope, diasDeCobertura, TOPE_COBERTURA_DIAS, type EntradaTope } from './cantidad-pedido.contract';
import {
  coberturaAutoabasto, redondearPedido,
  type AutoabastoRequisicionCreada, type EscaleraUnidades, type OrigenNoValido, type RedondeoPedido,
} from './autoabasto-pedido.contract';

/**
 * Por qué un alcance se puede o no decir:
 *  · `medible`: hay venta de 30 días y la unidad del almacén es confiable;
 *  · `sin_venta`: no hubo venta en 30 días — NO es «cero días», es que no hay ritmo con qué medir;
 *  · `no_confiable`: la unidad de este almacén está contradicha, así que la existencia tampoco es verdad.
 */
export type EstadoAlcance = 'medible' | 'sin_venta' | 'no_confiable';

export interface EntradaAlcance extends EntradaTope {
  /** Lo que se está pidiendo a mano, en unidad base. */
  pedidoBase: number;
  /** Código del almacén que pide (para su cobertura objetivo: 21 días en las sucursales que no surten a otras). */
  almacenCode?: string | null;
}

export interface AlcanceRenglon {
  estado: EstadoAlcance;
  /** Días que aguanta lo que hay más lo que ya viene, sin pedir nada. `null` = no medible. */
  hoy: number | null;
  /** Días con lo que se pide. `null` = no medible. */
  con_pedido: number | null;
  /**
   * Lo pedido deja MÁS días que el tope. Se dice, no se bloquea: el tope gobierna lo que el motor
   * sugiere, no prohíbe capturar (`[RA.45D]`). Lo que no se puede medir no pasa el tope (`false`):
   * afirmar un exceso sin ritmo de venta sería inventarlo.
   */
  pasa_tope: boolean;
  /** El tope con el que se comparó, en días. */
  tope: number;
  /** Para cuántos días pide este almacén (la cobertura de su mesa). */
  objetivo: number;
}

/** El alcance de un renglón del pedido a mano: hoy → con lo que pides, con la cuenta de Pedido de Compras. */
export function alcanceDelRenglon(e: EntradaAlcance): AlcanceRenglon {
  const tope = e.topeDias ?? TOPE_COBERTURA_DIAS;
  const objetivo = coberturaAutoabasto(e.almacenCode);
  const estado: EstadoAlcance = e.noConfiable ? 'no_confiable' : Number(e.venta30Base) > 0 ? 'medible' : 'sin_venta';
  if (estado !== 'medible') return { estado, hoy: null, con_pedido: null, pasa_tope: false, tope, objetivo };
  const pedido = Math.max(0, Number(e.pedidoBase) || 0);
  const hoy = diasDeCobertura(e);
  const conPedido = diasDeCobertura(e, pedido);
  return { estado, hoy, con_pedido: conPedido, pasa_tope: conPedido != null && conPedido > tope, tope, objetivo };
}

// ── Cómo se parte el pedido a mano al mandarlo (R5, R7) ───────────────────────────────────────

/** A quién se le pide un renglón: una sucursal (por su código de almacén) o Compras. */
export type DestinoCaptura = { tipo: 'sucursal'; code: string } | { tipo: 'compras' };

export interface RenglonCaptura {
  product_id: string;
  destino: DestinoCaptura;
  /** Lo pedido, en unidad base. */
  cantidad_base: number;
}

export interface GrupoCaptura {
  destino: DestinoCaptura;
  renglones: RenglonCaptura[];
  total_base: number;
  /**
   * Si este grupo puede salir hoy. Un grupo de sucursal sí: nace `AUTORIZADO` en el Kepler del origen
   * (ADR-127). El de Compras NO, hasta que exista confirmar la ruta (`[AB.NI.11]`): una ruta propuesta
   * no autoriza escribir a un proveedor (`[AB.NI.10]`).
   */
  enviable: boolean;
  motivo: string | null;
}

export interface CapturaPartida {
  grupos: GrupoCaptura[];
  /** Renglones que no pueden ir a ningún grupo, con su motivo. */
  descartados: Array<{ product_id: string; motivo: string }>;
}

const MOTIVO_COMPRAS = 'Ruta por confirmar: Compras confirma a quién se le pide antes de que salga.';

/**
 * Parte los renglones del pedido a mano en lo que se va a mandar: **un grupo por sucursal origen**
 * (en Kepler un pedido de sucursal sale de UNA sucursal) y uno para Compras, al final. Los renglones
 * en cero no viajan, y uno que se pide a la propia sucursal se descarta con su motivo.
 */
export function partirCaptura(renglones: readonly RenglonCaptura[], almacenCode: string): CapturaPartida {
  const propio = String(almacenCode ?? '').trim();
  const grupos = new Map<string, GrupoCaptura>();
  const descartados: CapturaPartida['descartados'] = [];
  for (const r of renglones) {
    const cantidad = Number(r.cantidad_base);
    if (!(cantidad > 0)) continue;
    if (r.destino.tipo === 'sucursal') {
      const code = String(r.destino.code ?? '').trim();
      if (!code) { descartados.push({ product_id: r.product_id, motivo: 'No dice a qué sucursal se le pide.' }); continue; }
      if (code === propio) { descartados.push({ product_id: r.product_id, motivo: 'No se le puede pedir a la propia sucursal.' }); continue; }
    }
    const llave = r.destino.tipo === 'sucursal' ? `s:${String(r.destino.code).trim()}` : 'compras';
    const destino: DestinoCaptura = r.destino.tipo === 'sucursal' ? { tipo: 'sucursal', code: String(r.destino.code).trim() } : { tipo: 'compras' };
    const g = grupos.get(llave) ?? { destino, renglones: [], total_base: 0, enviable: destino.tipo === 'sucursal', motivo: destino.tipo === 'sucursal' ? null : MOTIVO_COMPRAS };
    g.renglones.push({ ...r, destino, cantidad_base: cantidad });
    g.total_base += cantidad;
    grupos.set(llave, g);
  }
  const lista = [...grupos.values()].sort((a, b) => {
    if (a.destino.tipo !== b.destino.tipo) return a.destino.tipo === 'sucursal' ? -1 : 1;
    return b.renglones.length - a.renglones.length
      || (a.destino.tipo === 'sucursal' && b.destino.tipo === 'sucursal' ? a.destino.code.localeCompare(b.destino.code) : 0);
  });
  return { grupos: lista, descartados };
}

// ── [AB.PM.4] R6: a quién se le puede pedir ──────────────────────────────────────────────────

/**
 * R6 — por qué un almacén NO sirve de origen de un pedido de sucursal, en el orden de lectura de quien
 * eligió mal (`[PQ.139]`, `ORIGEN_NO_VALIDO`). `null` = sí sirve. La usan `origenElegido` (al guardar y
 * mandar) y la lista de orígenes de la pantalla: una sola regla, para que la lista no ofrezca lo que el
 * servidor después rechaza.
 */
export function fallaDeOrigen(
  w: { id: string; active?: boolean | null; kind?: string | null; kepler_code?: string | null } | null | undefined,
  almacenId: string,
): OrigenNoValido | null {
  if (!w) return 'no_existe';
  if (w.active === false) return 'inactivo';
  if (String(w.kind ?? '').trim() === 'truck') return 'es_camion';
  if (!String(w.kepler_code ?? '').trim()) return 'sin_kepler';
  if (w.id === almacenId) return 'es_el_mismo';
  return null;
}

/** `GET /commercial/autoabasto/pedido/mano/origenes` — las sucursales a las que se les puede pedir. */
export interface AutoabastoManoOrigenesResponse {
  origenes: Array<{ code: string; name: string }>;
}

// ── [AB.PM.3] R8 (a) y (b): en qué se captura y qué se propone ───────────────────────────────

/** Una presentación de Kepler en la que se captura el pedido a mano. */
export interface UnidadCaptura {
  unidad: string;
  /** Unidades base por cada una. Siempre entero (R8 a). */
  factor: number;
}

const entero = (f: number | null | undefined): number | null => {
  const n = Number(f);
  return f != null && Number.isFinite(n) && n > 1 && Number.isInteger(n) ? n : null;
};
const rotulo = (u: string | null | undefined): string => String(u ?? '').trim().toUpperCase();

/**
 * R8 (a) — la escalera con la que se captura: la de Kepler **sin los peldaños cuyo factor no es entero**.
 * El traspaso se escribe en unidad base (`[PQ.19]` D24) y Kepler sólo la acepta entera: un bulto de
 * 19.75 KG serían 19.75 KG, y el documento entero rebotaría. Medido el 2026-11-26 en
 * `mv_product_unit_ladder`: 8 de 9,641 escaleras (el 95579 y el 97235 de `[COT.45]`).
 */
export function escaleraDeCaptura(esc: EscaleraUnidades | null): EscaleraUnidades | null {
  if (!esc) return null;
  return { ...esc, f2: entero(esc.f2), f3: entero(esc.f3) };
}

/** R8 (a) — las presentaciones en que se puede capturar, de la mayor a la base. Vacía = Kepler no trae su escalera. */
export function unidadesDeCaptura(esc: EscaleraUnidades | null): UnidadCaptura[] {
  const e = escaleraDeCaptura(esc);
  if (!e || !rotulo(e.unit_base)) return [];
  const fuera: UnidadCaptura[] = [];
  const agregar = (u: string | null, factor: number | null) => {
    const unidad = rotulo(u);
    if (!unidad || factor == null || fuera.some((x) => x.unidad === unidad)) return;
    fuera.push({ unidad, factor });
  };
  agregar(e.u3_label, e.f3);
  agregar(e.u2_label, e.f2);
  agregar(e.unit_base, 1);
  return fuera.sort((a, b) => b.factor - a.factor);
}

/** La presentación pedida, con el factor que dice la escalera. `null` = esa unidad no se puede capturar. */
export function unidadDeCaptura(esc: EscaleraUnidades | null, unidad: string | null | undefined): UnidadCaptura | null {
  const u = rotulo(unidad);
  return unidadesDeCaptura(esc).find((x) => x.unidad === u) ?? null;
}

/**
 * R8 (b) — **lo que se propone pedir**: lo que falta para la cobertura de este almacén, con la misma
 * cuenta de días que el alcance (`cabeBajoTope` con la cobertura de la mesa como tope: 21 días en las
 * sucursales que no surten a otras), redondeado con la regla de media caja (`redondearPedido`) sobre
 * la escalera de captura. Es una propuesta: la persona la cambia. `null` = no se propone (sin venta, la
 * unidad en duda, ya cubierto o sin escalera).
 */
export function propuestaDelRenglon(e: EntradaTope & { almacenCode?: string | null; escalera: EscaleraUnidades | null }): RedondeoPedido | null {
  const falta = cabeBajoTope({ ...e, topeDias: coberturaAutoabasto(e.almacenCode) });
  if (falta == null || !(falta > 0)) return null;
  const r = redondearPedido(falta, escaleraDeCaptura(e.escalera));
  return r.cantidad > 0 && r.unidad ? r : null;
}

// ── [AB.PM.3] R8 (d): lo que Kepler rechazaría del traspaso ──────────────────────────────────

/**
 * Por qué Kepler rechazaría el renglón al escribir el traspaso (las tres revisiones del sink,
 * `kepler-requisition-sink.adapter.ts`, `[PQ.19]` D24). Se revisan **al capturar** porque un solo
 * renglón que no cuadra hace que Kepler rechace el documento ENTERO.
 *  · `sin_factor_suite`   — la Suite no tiene el factor de caja del producto en el almacén que pide;
 *  · `sin_piezas_enteras` — la cantidad, pasada a cajas, no reproduce unidades base enteras;
 *  · `sin_ficha_origen`   — la ficha de Kepler de la sucursal que surte no tiene su unidad base;
 *  · `factor_distinto`    — el factor de la Suite no es el de la ficha de la sucursal que surte.
 */
export type RechazoKepler = 'sin_factor_suite' | 'sin_piezas_enteras' | 'sin_ficha_origen' | 'factor_distinto';

export const RECHAZO_KEPLER_MSG: Record<RechazoKepler, string> = {
  sin_factor_suite: 'Kepler lo rechazaría: la Suite no tiene el factor de caja de este producto en tu sucursal',
  sin_piezas_enteras: 'Kepler lo rechazaría: la cantidad no da unidades enteras',
  sin_ficha_origen: 'Kepler lo rechazaría: la ficha de la sucursal que surte no tiene su unidad base',
  factor_distinto: 'Kepler lo rechazaría: la caja de la Suite no es la de la ficha de la sucursal que surte',
};

// ── [AB.PM.3] Lo que viaja ───────────────────────────────────────────────────────────────────

/** Los números de un producto para pedirlo a mano. Todo en unidad BASE; `null` = no medido, nunca 0. */
export interface AutoabastoManoMedidas {
  unidad_base: string | null;
  /** Las presentaciones en que se captura (R8 a). Vacía = sin escalera: no se puede capturar. */
  unidades: UnidadCaptura[];
  /** Lo que hay en esta sucursal (`analytics.replenishment_plan`, la existencia de la mesa). */
  existencia: number | null;
  /** Lo que hay en la sucursal que surte. Es un dato, nunca un candado (R4, ADR-127 §4). */
  existencia_origen: number | null;
  /** Lo que ya viene: pedidos abiertos y embarcado sin recibir (R2), la misma cuenta que la mesa. */
  viene: number | null;
  /** Venta de 30 días, la misma que la mesa usa para el tope. */
  venta_30d: number | null;
  /** Alcance sin pedir nada (R3). */
  alcance: AlcanceRenglon;
}

/** `GET /commercial/autoabasto/pedido/mano/buscar` — un producto del buscador. */
export interface AutoabastoManoProducto extends AutoabastoManoMedidas {
  product_id: string;
  sku: string;
  nombre: string;
  /** R8 (b): lo que propone la regla de media caja. `null` = no se propone. */
  propuesta: { cantidad: number; unidad: string; cantidad_base: number } | null;
  /**
   * R8 (d), lo que no depende de la cantidad, contra la sucursal elegida: si Kepler lo rechazaría.
   * `null` = pasa, o no hay sucursal elegida.
   */
  kepler: RechazoKepler | null;
}

export interface AutoabastoManoBuscarResponse {
  /** La sucursal a la que se le pide, si se eligió (ya validada: R6). */
  origen: { code: string; name: string } | null;
  productos: AutoabastoManoProducto[];
  /** `false` = esta sucursal no tiene cliente de traspaso en Kepler: lo que viene NO se midió (≠ cero). */
  viene_medido: boolean;
}

/** `PUT /commercial/autoabasto/pedido/mano` — guardar o cambiar un renglón a mano. */
export interface AutoabastoManoGuardarRequest {
  warehouse_id: string;
  product_id: string;
  /** A qué sucursal se le pide, por su código de almacén. `null` = a Compras (R7). */
  origen_code: string | null;
  /** Entero, 1 o más, en `unidad`. */
  cantidad: number;
  /** Una de las `unidades` del producto: el factor lo pone el servidor. */
  unidad: string;
  ms_en_renglon?: number | null;
}

/** `POST /commercial/autoabasto/pedido/mano/quitar`. */
export interface AutoabastoManoQuitarRequest {
  warehouse_id: string;
  product_id: string;
  ms_en_renglon?: number | null;
}

/** Un renglón del pedido a mano, como quedó guardado, con sus números de hoy. */
export interface AutoabastoManoRenglon extends AutoabastoManoMedidas {
  product_id: string;
  sku: string | null;
  nombre: string | null;
  destino: DestinoCaptura;
  /** El nombre de la sucursal que surte, o `null` si va a Compras. */
  origen_nombre: string | null;
  cantidad: number;
  unidad: string | null;
  cantidad_base: number;
  /** Alcance con lo que se pide (R3). */
  alcance_con_pedido: AlcanceRenglon;
  /** R8 (d) con la cantidad: si Kepler lo rechazaría. `null` = pasa, o va a Compras (no se revisa aquí). */
  kepler: RechazoKepler | null;
  capturado_por: string | null;
  capturado_at: string;
}

/** `GET /commercial/autoabasto/pedido/mano` — lo pedido a mano, partido como se va a mandar. */
export interface AutoabastoManoResponse {
  pedido_id: string | null;
  renglones: AutoabastoManoRenglon[];
  /** `partirCaptura`: un grupo por sucursal y Compras al final. */
  grupos: GrupoCaptura[];
  viene_medido: boolean;
}

/** `POST /commercial/autoabasto/pedido/mano/enviar`. */
export interface AutoabastoManoEnviarRequest {
  warehouse_id: string;
  /** Sólo esta sucursal (código de almacén). Ausente = todas las que se pueden mandar. */
  origen_code?: string | null;
  nota?: string | null;
}

export interface AutoabastoManoEnviarResponse {
  /** Un pedido por sucursal, con lo que pasó en Kepler (`kepler`). */
  requisiciones: AutoabastoRequisicionCreada[];
  /** Lo que se queda en el borrador y por qué (Compras por confirmar, Kepler lo rechazaría, ya lo pediste). */
  pendientes: Array<{ product_id: string; motivo: string }>;
}
