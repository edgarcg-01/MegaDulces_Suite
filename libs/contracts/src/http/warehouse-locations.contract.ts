/**
 * `[UB.1]` Ubicaciones de mercancía (Fase UB, ADR-090) — el código y la forma del catálogo.
 *
 * **El código** (decisión de Francisco, 2026-10-08) son 5 caracteres:
 *
 * ```
 *   B  A  05  3
 *   │  │  │   └─ nivel dentro del rack: 1–6
 *   │  │  └───── rack: 01–99
 *   │  └──────── pasillo: A–Z (sin Ñ: ver abajo)
 *   └─────────── zona general: T = tienda · B = bodega
 * ```
 *
 * Vive en `contracts` y no en el backend ni en la pantalla porque lo usan los DOS: la API valida
 * antes de guardar, la base lo vuelve a exigir con un CHECK, y la pantalla avisa mientras se
 * teclea. Una sola regla, tres compuertas — si cada lado tuviera su copia, la primera vez que una
 * cambiara la otra rechazaría códigos buenos (o aceptaría malos) sin que nadie lo notara.
 *
 * **Sin Ñ (revisión del PR, 2026-10-08):** el escáner del Andén (`normalizeBinCode`) y el código de
 * barras del cartel (CODE128) sólo leen ASCII, así que una ubicación `BÑ053` se podía dar de alta
 * pero nunca escanear. Si un almacén tiene un pasillo Ñ, se le asigna otra letra.
 *
 * Las otras familias del mismo catálogo (carretas `C`, espera `E`, contenedores `K`, estibas) NO
 * siguen esta regla: tienen su propio prefijo y no llevan pasillo/rack/nivel.
 */

/** Zona general de una ubicación: tienda o bodega. */
export type LocationZone = 'T' | 'B';

/** Familias del catálogo. `legado` = lo que existía antes de la Fase UB (código libre). */
export type LocationFamily = 'ubicacion' | 'carreta' | 'espera' | 'contenedor' | 'estiba' | 'legado';

/** Tipo de uso de una ubicación (FASE_UB §3). */
export type LocationKind =
  | 'surtido'
  | 'reserva'
  | 'tienda_piso'
  | 'tienda_cabecera'
  | 'recepcion'
  | 'cuarentena'
  | 'merma';

/** Estado. Nunca se borra: se bloquea o se da de baja (FASE_UB §7). */
export type LocationStatus = 'activa' | 'bloqueada' | 'baja';

export const LOCATION_KINDS: ReadonlyArray<{ key: LocationKind; label: string }> = [
  { key: 'surtido', label: 'Surtido (lugar fijo)' },
  { key: 'reserva', label: 'Reserva (excedente)' },
  { key: 'tienda_piso', label: 'Tienda · piso' },
  { key: 'tienda_cabecera', label: 'Tienda · cabecera' },
  { key: 'recepcion', label: 'Recepción' },
  { key: 'cuarentena', label: 'Cuarentena' },
  { key: 'merma', label: 'Merma' },
];

export const LOCATION_LEVEL_MAX = 6;
export const LOCATION_RACK_MAX = 99;

/**
 * La regla del código. La misma expresión va en el CHECK de la base
 * (`20261008*_ub1_ubicaciones_catalogo`): si se cambia acá, se cambia allá.
 */
export const LOCATION_CODE_RE = /^([TB])([A-Z])(0[1-9]|[1-9][0-9])([1-6])$/;

export interface LocationCodeParts {
  zona: LocationZone;
  pasillo: string;
  rack: number;
  nivel: number;
}

export type LocationCodeParse =
  | { ok: true; code: string; parts: LocationCodeParts }
  | { ok: false; code: string; motivo: string };

/** Normaliza lo que alguien tecleó o escaneó: mayúsculas, sin espacios ni guiones. */
export function normalizeLocationCode(raw: string | null | undefined): string {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/[\s\-_.]/g, '');
}

/**
 * Lee un código y dice por qué no sirve, en palabras que entienda quien lo tecleó.
 * `BA5 3` → normaliza a `BA53` → "le falta un dígito al rack".
 */
export function parseLocationCode(raw: string | null | undefined): LocationCodeParse {
  const code = normalizeLocationCode(raw);
  const m = LOCATION_CODE_RE.exec(code);
  if (m) {
    return {
      ok: true,
      code,
      parts: { zona: m[1] as LocationZone, pasillo: m[2], rack: Number(m[3]), nivel: Number(m[4]) },
    };
  }
  if (!code) return { ok: false, code, motivo: 'Escribe el código de la ubicación, por ejemplo BA053.' };
  if (code.length !== 5) {
    return { ok: false, code, motivo: `El código lleva 5 caracteres (escribiste ${code.length}): zona, pasillo, 2 dígitos de rack y el nivel. Ejemplo: BA053.` };
  }
  if (code[0] !== 'T' && code[0] !== 'B') {
    return { ok: false, code, motivo: 'La primera letra es la zona: T (tienda) o B (bodega).' };
  }
  if (!/[A-Z]/.test(code[1])) return { ok: false, code, motivo: 'La segunda letra es el pasillo (A, B, C…, sin Ñ: el código de barras no la lee).' };
  if (!/^\d\d$/.test(code.slice(2, 4)) || code.slice(2, 4) === '00') {
    return { ok: false, code, motivo: 'El rack va en 2 dígitos, del 01 al 99.' };
  }
  return { ok: false, code, motivo: `El último dígito es el nivel, del 1 al ${LOCATION_LEVEL_MAX}.` };
}

/** Arma el código desde sus partes. Lanza si las partes no forman un código válido. */
export function formatLocationCode(p: LocationCodeParts): string {
  const code = `${p.zona}${p.pasillo}${String(p.rack).padStart(2, '0')}${p.nivel}`;
  if (!LOCATION_CODE_RE.test(code)) throw new Error(`Partes inválidas para un código de ubicación: ${code}`);
  return code;
}

/** Cómo se lee en voz alta: "Bodega · pasillo A · rack 05 · nivel 3". */
export function describeLocationCode(p: LocationCodeParts): string {
  return `${p.zona === 'T' ? 'Tienda' : 'Bodega'} · pasillo ${p.pasillo} · rack ${String(p.rack).padStart(2, '0')} · nivel ${p.nivel}`;
}

/** Posición del pasillo en el orden de recorrido (A = 1). */
export function aisleOrder(pasillo: string): number {
  return pasillo.toUpperCase().charCodeAt(0) - 64;
}

/**
 * Orden de recorrido por defecto (hoja de surtido): zona → pasillo → rack → nivel.
 * Tienda antes que bodega, porque es lo que se ve primero al entrar. Se puede corregir por
 * ubicación con `pick_sequence` cuando el recorrido físico no sigue el alfabeto.
 */
export function defaultPickSequence(p: LocationCodeParts): number {
  return (p.zona === 'T' ? 0 : 1) * 1_000_000 + Math.round(aisleOrder(p.pasillo) * 2) * 10_000 + p.rack * 10 + p.nivel;
}

// ── Respuestas HTTP ────────────────────────────────────────────────────────────────────────────

export interface WarehouseLocationRow {
  id: string;
  warehouse_id: string;
  warehouse_code: string;
  code: string;
  label: string | null;
  familia: LocationFamily;
  zona: LocationZone | null;
  pasillo: string | null;
  rack: number | null;
  nivel: number | null;
  tipo: LocationKind | null;
  estado: LocationStatus;
  motivo_estado: string | null;
  pick_sequence: number | null;
  /** Renglones de `stock_lot_locations` con cantidad > 0 en esta ubicación (no suma unidades distintas). */
  renglones_con_cantidad: number;
  updated_at: string;
}

export interface WarehouseLocationsSummary {
  total: number;
  activas: number;
  bloqueadas: number;
  bajas: number;
  /** Ubicaciones con el formato nuevo (familia `ubicacion`). */
  con_formato: number;
  /** Lo que existía antes de la Fase UB con código libre. */
  legado: number;
  con_contenido: number;
}

export interface WarehouseLocationsAlcance {
  todas: boolean;
  /** Almacenes visibles para quien consulta (ScopeService, proyecto Almacén). */
  almacenes: Array<{ id: string; code: string; name: string }>;
}

export interface WarehouseLocationsResponse {
  alcance: WarehouseLocationsAlcance;
  /** Almacén consultado; `null` si quien consulta no tiene ninguno a la vista. */
  warehouse: { id: string; code: string; name: string } | null;
  resumen: WarehouseLocationsSummary;
  ubicaciones: WarehouseLocationRow[];
}

export interface CreateWarehouseLocationBody {
  warehouse_id: string;
  code: string;
  tipo?: LocationKind | null;
  label?: string | null;
}
