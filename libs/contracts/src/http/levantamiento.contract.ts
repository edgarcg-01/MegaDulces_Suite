/**
 * `[NP.7]` Levantamiento del Catálogo digital: lo que viaja entre `/catalog/levantamiento` y la
 * pantalla `/levantamiento` (celular). Plan: `FASE_NP7_ALTA_DESDE_FOTOS.md` §10b.
 *
 * ⛔ LISTA BLANCA: quien captura (recepción, anaquel, caja) no ve costo, precio, margen, proveedor ni
 * lo que leyó la IA (§10b.2). Ningún tipo de aquí lleva esos campos, y el servidor arma la respuesta
 * campo por campo — nunca devuelve la fila ni `sheet`.
 */

export type LevantamientoPeldano = 'base' | 'dos' | 'tres';

/**
 * Lo que se pide de la unidad principal, en orden: las 5 caras (§10b.7 punto 2) y 3 ACERCAMIENTOS (tabla
 * nutrimental, información y código de barras). Los acercamientos son el primer feedback de quien captura
 * (2026-11-07): en la foto del reverso entera la tabla y los ingredientes no se alcanzan a leer. Todas se
 * toman o se saltan con motivo; sólo el frente es obligatorio.
 */
export const LEVANTAMIENTO_CARAS = [
  'frente', 'reverso', 'lateral_izq', 'lateral_der', 'base', 'tabla_nutricional', 'informacion', 'codigo_barras',
] as const;
export type LevantamientoCara = (typeof LEVANTAMIENTO_CARAS)[number];

/** Los acercamientos: no son caras del empaque sino una parte de él (su salto se pregunta distinto). */
export const LEVANTAMIENTO_ACERCAMIENTOS: readonly LevantamientoCara[] = ['tabla_nutricional', 'informacion', 'codigo_barras'];

/**
 * «Más detalles»: hasta 3 fotos LIBRES y opcionales (caducidad, sellos, una promoción impresa). No cuentan para
 * terminar la captura: se agregan desde «Enviado», sólo quien la terminó y dentro de `LEVANTAMIENTO_DETALLE_MINUTOS`.
 */
export const LEVANTAMIENTO_DETALLES = ['detalle_1', 'detalle_2', 'detalle_3'] as const;
export type LevantamientoDetalle = (typeof LEVANTAMIENTO_DETALLES)[number];
/** Cualquier foto de la ficha: una cara (o acercamiento) o un detalle. */
export type LevantamientoFotoCara = LevantamientoCara | LevantamientoDetalle;

/** Qué muestra el detalle: se elige con un toque (sin teclear en el camino normal); `otro` admite una nota. */
export const LEVANTAMIENTO_DETALLE_TIPOS = ['caducidad', 'sellos', 'promocion', 'otro'] as const;
export type LevantamientoDetalleTipo = (typeof LEVANTAMIENTO_DETALLE_TIPOS)[number];
export const LEVANTAMIENTO_DETALLE_NOTA_MAX = 60;
/** Ventana para agregar detalles después de terminar (la misma que dura un apartado). */
export const LEVANTAMIENTO_DETALLE_MINUTOS = 30;

/**
 * La cara que NO se salta: es la foto principal del catálogo y todo producto la tiene. Como es la primera,
 * toda ficha completa trae al menos una foto real. La primera captura en prod (2026-11-03) llegó a «Por
 * revisar» con las 5 caras saltadas y cero fotos.
 */
export const LEVANTAMIENTO_CARA_OBLIGATORIA: LevantamientoCara = 'frente';

export const LEVANTAMIENTO_MOTIVOS_SALTO = ['no_tiene_esa_cara', 'no_se_puede_girar', 'otro'] as const;
export type LevantamientoMotivoSalto = (typeof LEVANTAMIENTO_MOTIVOS_SALTO)[number];

/** Pantalla A: quién captura, en qué sucursal, cuánto falta y cómo va su semana. */
export interface LevantamientoContexto {
  branch_code: string;
  /** Siempre por nombre en pantalla; null si la sucursal no está en el catálogo de almacenes. */
  branch_name: string | null;
  /** De dónde salió: su perfil, su alcance, o la eligió porque su perfil no tiene sucursal (D25). */
  branch_source: 'perfil' | 'alcance' | 'elegida';
  user: { id: string; username: string | null; name: string | null };
  /** Productos de la sucursal (venta 90 d o existencia, sin promociones) cuya unidad principal no tiene ficha. */
  missing: number;
  /** El universo del que salen `missing` (para el %). */
  universe: number;
  week: {
    /** Fichas de esta persona publicadas esta semana (lunes a domingo, hora de México). */
    published: number;
    /** Fichas de esta persona que esperan revisión: nunca suman. */
    in_review: number;
    /** Lugar de la persona en su sucursal por publicadas; null si nadie ha publicado. */
    rank: number | null;
  };
  /** La lectura de la IA está encendida (D6). En el piloto, apagada: todo va a revisión. */
  ai_enabled: boolean;
}

/** Un producto sugerido para levantar: nombre y presentación, nunca precio. */
export interface LevantamientoSugerido {
  sku: string;
  name: string;
  /** La unidad principal, como la nombra Kepler (`PAQ`, `PZA`…) — informativo. */
  unit_label: string | null;
  /** Unidades base de la unidad principal (p. ej. 20 en un empaque de 20); null si no se sabe. */
  unit_factor: number | null;
}

export interface LevantamientoSugeridosRespuesta {
  rows: LevantamientoSugerido[];
  /** Cuántos hay en total (la lista se pagina; nunca se topa en silencio). */
  total: number;
}

export interface LevantamientoEscaneoDto {
  /** Lo que leyó el lector (o tecleó la persona). */
  code?: string;
  /** Si entró por el buscador: el SKU elegido (no hay código que confirme el peldaño). */
  sku?: string;
}

export type LevantamientoAccion =
  | 'capturar'
  | 'ya_esta'
  | 'en_revision'
  | 'apartado_por_otro'
  | 'demasiados_apartados'
  | 'no_registrado'
  | 'codigo_compartido'
  | 'otra_unidad'
  | 'sin_unidad_principal';

export interface LevantamientoEscaneoRespuesta {
  action: LevantamientoAccion;
  /** Texto para la persona, en tuteo, listo para mostrar. */
  message: string;
  code: string | null;
  sku: string | null;
  name: string | null;
  /** Peldaño del código escaneado y su rótulo/factor de Kepler TAL CUAL (B0). */
  scanned: { rung: LevantamientoPeldano; label: string | null; factor: number | null } | null;
  /** La unidad que se fotografía (la principal) y su rótulo/factor de Kepler. */
  principal: { rung: LevantamientoPeldano; label: string | null; factor: number | null } | null;
  /** Ficha apartada para esta persona (sólo con `capturar`). */
  sheet_id: string | null;
  faces: LevantamientoCara[];
  /** Caras ya resueltas (tomadas o saltadas), por si retoma una captura. */
  faces_done: LevantamientoCara[];
  /** De ésas, las que se SALTARON con motivo: cuentan como resueltas, nunca como fotos. */
  faces_skipped: LevantamientoCara[];
  /** Hasta cuándo está apartado (ISO). */
  reserved_until: string | null;
  /** Con `codigo_compartido`: los productos que comparten el código. */
  candidates: Array<{ sku: string; name: string | null }>;
}

/** Medición de la foto hecha en el teléfono antes de subir (NP.7.L.8b). */
export interface LevantamientoCalidadFoto {
  /** Varianza del laplaciano sobre la imagen reducida: baja = borrosa o movida. */
  sharpness: number;
  /** Desviación estándar de la luminancia: baja = lente sucio, neblina o poca luz. */
  contrast: number;
  /** Versión del medidor y del umbral (para recalibrar con fotos reales). */
  version: string;
}

export interface LevantamientoFotoRespuesta {
  sheet_id: string;
  face: LevantamientoFotoCara;
  /** Estado de la ficha tras esta foto. */
  status: string;
  faces_done: LevantamientoCara[];
  faces_skipped: LevantamientoCara[];
  /** Los detalles que ya tiene la ficha (no cuentan para terminar). */
  details_done: LevantamientoDetalle[];
  complete: boolean;
}

export interface LevantamientoSaltoDto {
  face: LevantamientoCara;
  reason: LevantamientoMotivoSalto;
}

/** Fila del buscador de respaldo (NP.7.L.10): lista blanca, sin precio ni venta. */
export interface LevantamientoBusquedaFila {
  sku: string;
  name: string;
  content: string | null;
  barcode: string | null;
  /** Ya tiene ficha publicada: no hace falta levantarlo. */
  has_sheet: boolean;
}

// ── `[NP.7.L.3b]` Bandeja «Por revisar» de Catálogo ──────────────────────────────────────────────

/** Por qué una ficha espera a una persona (la IA está apagada en el piloto: todas esperan). */
export type RevisionMotivo = 'sin_analizar' | 'caras_saltadas' | 'entro_por_busqueda' | 'foto_repetida';

export const REVISION_MOTIVO_TEXTO: Record<RevisionMotivo, string> = {
  sin_analizar: 'Sin lectura de la IA',
  caras_saltadas: 'Fotos saltadas', // desde L.18 también los acercamientos se saltan: no todas son caras
  entro_por_busqueda: 'Entró por búsqueda',
  foto_repetida: 'Foto repetida',
};

export interface RevisionFoto {
  face: string;
  /** URL firmada de corta vida (sólo para revisar; no se publica con ella). null si la cara se saltó. */
  url: string | null;
  skipped_reason: string | null;
  sharpness: number | null;
  /** Sólo en un detalle (`detalle_n`): qué dice quien lo tomó que muestra. */
  detail?: { kind: LevantamientoDetalleTipo; note: string | null } | null;
}

export interface RevisionFicha {
  id: string;
  sku: string;
  name: string | null;
  branch_code: string;
  branch_name: string | null;
  /** La unidad que se fotografió (la principal) y su rótulo/factor de Kepler TAL CUAL. */
  rung: LevantamientoPeldano | null;
  unit_label: string | null;
  unit_factor: number | null;
  /** Lo que se escaneó (null si entró por el buscador). */
  scanned_code: string | null;
  /** Los códigos que Kepler tiene para esa unidad, en esa sucursal. */
  kepler_codes: string[];
  status: string;
  reasons: RevisionMotivo[];
  captured_by: string | null;
  captured_at: string;
  photos: RevisionFoto[];
}

export interface RevisionBandeja {
  /** Conteo por motivo sobre TODA la bandeja (no sólo la página). Una ficha puede tener varios. */
  counts: Record<RevisionMotivo, number>;
  /** Las fichas que cumplen el filtro (el motivo elegido). */
  total: number;
  /** TODA la bandeja, sin filtro: «Todas» y el KPI no dependen del motivo que se esté viendo. */
  total_all: number;
  rows: RevisionFicha[];
}

export type RevisionDecision = 'publicar' | 'recapturar' | 'descartar';

export interface RevisionDecisionDto {
  decision: RevisionDecision;
  /** Obligatoria para recapturar y descartar: quien levantó tiene que saber por qué. */
  note?: string;
}

export interface RevisionDecisionRespuesta {
  id: string;
  status: string;
}

// ── `[NP.7.L.5]` Catálogo digital › Publicadas (primer corte de Cobertura) ─────────────────────────

/**
 * La cobertura de UNA sucursal, en vivo (derive-no-copy): el MISMO universo que la pantalla A del
 * levantamiento (`UNIVERSO_LEVANTAMIENTO_SQL`), así «faltan» da el mismo número en las dos (plan §10b.3).
 * Medido el 2026-11-04 en Padre Hidalgo (sólo lectura): universo 4,230 · publicadas 7 · 0.888 % de la venta.
 */
export interface CoberturaLevantamiento {
  branch_code: string;
  branch_name: string | null;
  /** SKUs del universo (venta 90 d o existencia en la sucursal, sin promociones). */
  universe: number;
  /** De ésos, con su unidad principal publicada (`publicada`, `conciliada` o `con_diferencias`). */
  published: number;
  /** universe − published: el mismo «faltan» de la pantalla A. */
  missing: number;
  /** MÉTRICA L: % de la venta de 90 d (en pesos) de la sucursal que cubren los publicados. null = venta 0 o no medible. */
  sales_share_pct: number | null;
  /** Cuándo se calculó (en vivo, al pedirlo). */
  measured_at: string;
}

/** Una ficha publicada: lo que se ve en Catálogo digital › Publicadas. Sin costo, precio, margen ni venta por SKU. */
export interface FichaPublicada {
  id: string;
  sku: string;
  name: string | null;
  branch_code: string;
  branch_name: string | null;
  rung: LevantamientoPeldano | null;
  unit_label: string | null;
  unit_factor: number | null;
  scanned_code: string | null;
  kepler_codes: string[];
  captured_by: string | null;
  captured_at: string;
  /** Quién la publicó y cuándo (de `sheet.revisiones` / `sheet.publicada`). null en fichas anteriores al registro. */
  published_by: string | null;
  published_at: string | null;
  /** Fotos de la unidad principal, con URL firmada de corta vida (como la bandeja). */
  photos: RevisionFoto[];
  /**
   * La lectura de la IA: `apagada` mientras `NP7_AI_ENABLED` no sea `true` (D6) · `sin_leer` encendida y sin
   * propuesta vigente · `leida` cuando `ai_raw.propuesta` existe Y es de las fotos actuales (todas las fotos reales
   * de la unidad principal con lectura `ok`: `fichaLista` del worker; una recapturada con la propuesta de las fotos
   * viejas es `sin_leer`). La pantalla nunca dibuja una lectura que no hay.
   * ⚠️ `sin_leer` incluye la ficha con una lectura que NO quedó `ok` (inválida, incompleta, error al preparar): no se
   * relee sola (deuda (f) del worker) y el rostro de esa foto es NO MEDIDO, nunca «sin rostro». Y `leida` tampoco
   * dice «sin rostro» de la foto entera: `rostro_visible` se juzga sobre el recorte que viajó (deuda (a), NP.7.F.3).
   */
  ai_reading: 'apagada' | 'sin_leer' | 'leida';
}

export interface FichasPublicadas {
  coverage: CoberturaLevantamiento;
  /** Fichas publicadas que cumplen la búsqueda, en TODA la red (no sólo la página). */
  total: number;
  rows: FichaPublicada[];
}
