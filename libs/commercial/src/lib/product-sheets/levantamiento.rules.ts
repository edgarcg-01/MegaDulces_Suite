/**
 * `[NP.7]` Reglas puras del levantamiento de fichas (Catálogo digital). Sin Nest y sin base: el
 * servicio lee y escribe, aquí se decide. Plan: `docs/IMPLEMENTACION/FASES/FASE_NP7_ALTA_DESDE_FOTOS.md`
 * (§7.1 modelo, §10b.3 flujo, §10b.7 unidades).
 */
import { LEVANTAMIENTO_CARA_OBLIGATORIA } from '@megadulces/contracts';
import type { KdiiFila, Peldano, ResultadoEscaneo } from '../shared/kdii-codigo';

// ── Estados (el CHECK de la migración usa estas mismas listas) ─────────────────────────────────

export const ESTADOS_ALTA = [
  'presolicitud', 'borrador', 'analizada', 'aprobada', 'tecleada_en_kepler', 'ligada', 'conciliada', 'con_diferencias', 'descartada',
] as const;

/**
 * `en_captura` no estaba en §7.1: al escanear se APARTA el producto antes de tener fotos, y ningún
 * estado decía «apartado, sin fotos» (`fotos_tomadas` mentiría). Agregado el 2026-11-02.
 */
export const ESTADOS_LEVANTAMIENTO = [
  'en_captura', 'fotos_tomadas', 'analizada', 'publicada', 'por_revisar', 'recapturar', 'historica',
] as const;

export type EstadoLevantamiento = (typeof ESTADOS_LEVANTAMIENTO)[number];

/** Una sola regla de «el SKU tiene ficha» (§7.1): la usan los sugeridos, el escaneo y la cobertura. */
export const ESTADOS_CON_FICHA: readonly string[] = ['publicada', 'conciliada', 'con_diferencias'];

/** Ya se levantó y espera a Catálogo (o a la IA): no se pide otra captura (§10b.3 punto 5). */
export const ESTADOS_EN_REVISION: readonly string[] = ['fotos_tomadas', 'analizada', 'por_revisar'];

// ── Unidad principal (§10b.7 punto 2) ──────────────────────────────────────────────────────────

/**
 * El peldaño más vendido del SKU en la sucursal. `rungModal` es un FACTOR
 * (`analytics.mv_kepler_sold_rung.rung_modal`), no un número de peldaño: se cruza con los factores de
 * la ficha. ⚠️ El primer instrumento de NP.7.L.0 lo leyó como número de peldaño y el control lo cazó.
 * Sin dato o sin peldaño que coincida → `null` («unidad principal desconocida»), nunca se adivina.
 */
export function peldanoPrincipal(f: Pick<KdiiFila, 'f2' | 'f3'>, rungModal: number | null | undefined): Peldano | null {
  if (rungModal == null || !(Number(rungModal) > 0)) return null;
  const rm = Number(rungModal);
  if (rm === 1) return 'base';
  if (f.f2 != null && Number(f.f2) === rm) return 'dos';
  if (f.f3 != null && Number(f.f3) === rm) return 'tres';
  return null;
}

// ── Caras por peldaño (§10b.7 punto 2) ─────────────────────────────────────────────────────────

export const CARAS_PRINCIPAL = ['frente', 'reverso', 'lateral_izq', 'lateral_der', 'base'] as const;
export type Cara = (typeof CARAS_PRINCIPAL)[number];

/** En el piloto sólo se levanta la unidad principal (D23: la caja exterior queda fuera). */
export function carasRequeridas(): readonly Cara[] {
  return CARAS_PRINCIPAL;
}

export const MOTIVOS_SALTO = ['no_tiene_esa_cara', 'no_se_puede_girar', 'otro'] as const;
export type MotivoSalto = (typeof MOTIVOS_SALTO)[number];

// ── Apartado (§10b.3 punto 5) ──────────────────────────────────────────────────────────────────

export const APARTADO_MINUTOS = 30;
export const MAX_APARTADOS = 3;

export interface Apartado {
  by: string;
  /** ISO 8601. */
  until: string;
}

export function apartadoVivo(a: Apartado | null | undefined, ahora: Date): boolean {
  return !!a && new Date(a.until).getTime() > ahora.getTime();
}

export function nuevoApartado(userId: string, ahora: Date): Apartado {
  return { by: userId, until: new Date(ahora.getTime() + APARTADO_MINUTOS * 60_000).toISOString() };
}

export interface ApartadoDelUsuario {
  sheetId: string;
  until: string;
  conFotos: boolean;
}

/**
 * Antes de apartar uno nuevo: si la persona ya tiene `MAX_APARTADOS` vivos, se libera el más viejo
 * SIN fotos. Si todos tienen fotos, no se libera nada y no se aparta (que termine uno primero).
 */
export function apartadoALiberar(vivos: ApartadoDelUsuario[]): { liberar: string | null; bloqueado: boolean } {
  if (vivos.length < MAX_APARTADOS) return { liberar: null, bloqueado: false };
  const sinFotos = vivos.filter((v) => !v.conFotos).sort((a, b) => a.until.localeCompare(b.until));
  return sinFotos.length ? { liberar: sinFotos[0].sheetId, bloqueado: false } : { liberar: null, bloqueado: true };
}

// ── Qué se le responde a quien escanea ─────────────────────────────────────────────────────────

export type AccionEscaneo =
  /** Se aparta y se toman las fotos. */
  | 'capturar'
  /** El SKU ya tiene ficha publicada: «ya está, gracias». */
  | 'ya_esta'
  /** Ya se levantó y espera revisión: no se duplica. */
  | 'en_revision'
  /** Otra persona lo está levantando (apartado vivo). */
  | 'apartado_por_otro'
  /** Tiene 3 apartados con fotos: que termine uno. */
  | 'demasiados_apartados'
  /** El código no está en ninguna casilla de `kdii` de la sucursal: hallazgo (presolicitud en tramo 2). */
  | 'no_registrado'
  /** Dos o más SKUs comparten el código: va a Incidencias, no se captura. */
  | 'codigo_compartido'
  /** El código es de otro peldaño (p. ej. la caja exterior): en el piloto sólo la unidad principal (D23). */
  | 'otra_unidad'
  /** Sin dato de unidad más vendida: no se sabe qué fotografiar. */
  | 'sin_unidad_principal';

export interface EntradaEscaneo {
  resultado: ResultadoEscaneo;
  /** Peldaño principal del SKU resuelto (sólo si `resultado.tipo === 'ok'`). */
  principal: Peldano | null;
  /** Estado de la ficha VIGENTE del SKU (cualquier origen), o null si no hay. */
  estadoFicha: string | null;
  /** Apartado vivo o vencido del peldaño principal, si la ficha existe. */
  apartado: Apartado | null;
  userId: string;
  ahora: Date;
  /** Apartados vivos de esta persona en OTRAS fichas. */
  vivosDelUsuario: ApartadoDelUsuario[];
  /** Entró por el buscador y no por el código: se captura igual, pero nunca se publica sola. */
  porBusqueda?: boolean;
}

export interface DecisionEscaneo {
  accion: AccionEscaneo;
  /** Si hay que soltar un apartado propio antes de apartar éste. */
  liberar: string | null;
}

export function decidirEscaneo(e: EntradaEscaneo): DecisionEscaneo {
  const no = (accion: AccionEscaneo): DecisionEscaneo => ({ accion, liberar: null });
  if (e.resultado.tipo === 'desconocido') return no('no_registrado');
  if (e.resultado.tipo === 'ambiguo') return no('codigo_compartido');
  if (e.estadoFicha && ESTADOS_CON_FICHA.includes(e.estadoFicha)) return no('ya_esta');
  if (e.estadoFicha && ESTADOS_EN_REVISION.includes(e.estadoFicha)) return no('en_revision');
  if (!e.principal) return no('sin_unidad_principal');
  // Por el buscador no hay código que diga el peldaño: se levanta la unidad principal.
  if (!e.porBusqueda && e.resultado.resuelto.peldano !== e.principal) return no('otra_unidad');
  if (apartadoVivo(e.apartado, e.ahora) && e.apartado!.by !== e.userId) return no('apartado_por_otro');
  // Re-escanear lo que ya tengo apartado no cuenta como apartado nuevo.
  if (apartadoVivo(e.apartado, e.ahora) && e.apartado!.by === e.userId) return no('capturar');
  const { liberar, bloqueado } = apartadoALiberar(e.vivosDelUsuario);
  if (bloqueado) return no('demasiados_apartados');
  return { accion: 'capturar', liberar };
}

// ── Fotos (§7.1 `photos`) ──────────────────────────────────────────────────────────────────────

export interface FotoFicha {
  peldano: Peldano | null;
  cara: string;
  storage_key: string | null;
  sha256: string | null;
  captured_by: string;
  captured_at: string;
  saltada_motivo: MotivoSalto | null;
  /** Medido en el teléfono antes de subir (NP.7.L.8b): se guarda para calibrar el umbral con fotos reales. */
  calidad: { nitidez: number; contraste: number; version: string } | null;
  ancho: number | null;
  alto: number | null;
  /**
   * `[NP.7.0.9]` Lo que pesa la foto guardada (bytes, medido en el servidor DESPUÉS de quitar los
   * metadatos), para saber cuánto bucket y cuántos datos móviles cuesta cada ficha. Opcional porque las
   * fotos anteriores al 2026-11-04 no lo traen: ausente = no medido, nunca cero.
   */
  bytes?: number | null;
  por_busqueda: boolean;
}

/**
 * ¿La cara quedó resuelta? Con foto, o saltada con motivo — salvo el frente, que sólo se resuelve con foto
 * (`LEVANTAMIENTO_CARA_OBLIGATORIA`). Un salto del frente anterior a esa regla no cuenta: la pantalla lo
 * vuelve a pedir. Así ninguna ficha se completa sin al menos una foto real.
 */
export function caraResuelta(f: Pick<FotoFicha, 'cara' | 'storage_key' | 'saltada_motivo'>): boolean {
  return !!f.storage_key || (!!f.saltada_motivo && f.cara !== LEVANTAMIENTO_CARA_OBLIGATORIA);
}

/** Caras de la unidad principal ya resueltas (ver `caraResuelta`), por la persona que sea. */
export function carasResueltas(fotos: FotoFicha[], peldano: Peldano): Set<string> {
  return new Set(fotos.filter((f) => f.peldano === peldano && caraResuelta(f)).map((f) => f.cara));
}

/**
 * Estado tras recibir una foto: sigue `en_captura` hasta que estén todas las caras de la unidad
 * principal (tomadas o saltadas con motivo); entonces `fotos_tomadas`. En el piloto la IA está apagada
 * y nada se publica solo: de `fotos_tomadas` va a la bandeja «por revisar» de Catálogo (§10b.3 punto 4).
 */
export function estadoTrasFoto(fotos: FotoFicha[], peldano: Peldano): EstadoLevantamiento {
  const hechas = carasResueltas(fotos, peldano);
  return carasRequeridas().every((c) => hechas.has(c)) ? 'fotos_tomadas' : 'en_captura';
}

/**
 * ¿La unidad principal no tiene NI UNA foto? Una ficha nueva ya no puede llegar así (el frente no se salta),
 * pero sí las anteriores a esa regla: la primera captura en prod (2026-11-03) entró a «Por revisar» con las 5
 * caras saltadas y cero fotos. Por eso Catálogo no puede PUBLICAR una ficha así: se descarta o se pide otra foto.
 */
export function sinFotoReal(fotos: FotoFicha[], peldano: Peldano): boolean {
  return !fotos.some((f) => f.peldano === peldano && !!f.storage_key);
}

/** Motivos por los que la ficha va a revisión humana aunque la IA estuviera encendida (§10b.3 punto 4). */
export function motivosDeRevision(fotos: FotoFicha[], peldano: Peldano): string[] {
  const deEste = fotos.filter((f) => f.peldano === peldano);
  const motivos: string[] = [];
  if (deEste.some((f) => f.saltada_motivo)) motivos.push('caras_saltadas');
  if (deEste.some((f) => f.por_busqueda)) motivos.push('entro_por_busqueda');
  const shas = deEste.map((f) => f.sha256).filter((s): s is string => !!s);
  if (new Set(shas).size !== shas.length) motivos.push('foto_repetida');
  return motivos;
}

// ── Cómo se le nombra la unidad a la persona (nunca «PAQ» ni «Base») ───────────────────────────

const PALABRA: Record<string, string> = {
  PZA: 'pieza', PAQ: 'paquete', CJA: 'caja', BTO: 'bulto', CUB: 'cubeta', DSP: 'exhibidor', BOL: 'bolsa', KG: 'kilo',
};

/**
 * «paquete de 20», «pieza», «caja de 144». El rótulo de Kepler no dice el nivel físico (`CJA` puede ser
 * un estuche o un corrugado, §10b.7 punto 5): esto es sólo cómo se lee en pantalla, no una clasificación.
 */
export function nombreUnidad(rotulo: string | null | undefined, factor: number | null | undefined): string {
  const r = String(rotulo ?? '').trim().toUpperCase();
  const base = PALABRA[r] ?? (/^\d+$/.test(r) ? `${r} g` : r ? r.toLowerCase() : 'presentación');
  return factor != null && Number(factor) > 1 ? `${base} de ${Number(factor)}` : base;
}

// ── `[NP.7.L.3b]` Decisiones de Catálogo en la bandeja «por revisar» ───────────────────────────

export type DecisionRevision = 'publicar' | 'recapturar' | 'descartar';

export type ResultadoDecision =
  | { ok: true; status: EstadoLevantamiento | null; borrar: boolean }
  | { ok: false; motivo: string };

/**
 * Qué hace cada decisión. Sólo sobre fichas que esperan revisión. Recapturar y descartar piden nota:
 * quien levantó tiene que saber qué estuvo mal. Descartar es borrado lógico (`deleted_at`): la captura
 * no sirve, el SKU vuelve a sugerirse, y ni suma ni resta en el ranking.
 */
export function decidirRevision(estado: string, decision: string, nota: string | null | undefined): ResultadoDecision {
  if (!ESTADOS_EN_REVISION.includes(estado)) return { ok: false, motivo: 'Esta ficha ya no está en revisión.' };
  const conNota = String(nota ?? '').trim().length > 0;
  switch (decision) {
    case 'publicar':
      return { ok: true, status: 'publicada', borrar: false };
    case 'recapturar':
      return conNota ? { ok: true, status: 'recapturar', borrar: false } : { ok: false, motivo: 'Escribe qué hay que volver a fotografiar.' };
    case 'descartar':
      return conNota ? { ok: true, status: null, borrar: true } : { ok: false, motivo: 'Escribe por qué se descarta.' };
    default:
      return { ok: false, motivo: 'Decisión inválida.' };
  }
}
