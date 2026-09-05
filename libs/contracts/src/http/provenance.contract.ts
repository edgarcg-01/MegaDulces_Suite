// [VP.2.1] Procedencia del wire — el vocabulario con el que una respuesta declara CON QUÉ se
// calculó, compartido por backend y frontend (ADR-052 / ADR-056).
//
// ── POR QUÉ VIVE ACÁ Y NO EN UN DOMINIO ──────────────────────────────────────────────────
// El tipo `Freshness` nació en `libs/commercial/src/lib/shared/freshness.ts` (fase OBS, 2026-09-02)
// y a los tres días ya estaba copiado a mano en `apps/view/.../tienda/etiquetas.service.ts`. Es el
// patrón que esta fase existe para cortar: un primitivo correcto, inventado en una rebanada, que
// nunca sube a un lugar compartido y se re-declara en cada consumidor hasta que las copias se
// separan en silencio (el dedup del sell-out llegó a 11 archivos así).
//
// El dominio conserva la LÓGICA (medir, componer, tolerancias); acá vive sólo la FORMA del wire,
// que es lo que los dos lados tienen que entender igual. Un cambio de forma es error de
// compilación en ambos, que es la garantía por la que existe este paquete.

import { z } from 'zod';

/**
 * El veredicto sobre un dato:
 *  · `fresh`   — medido y al día.
 *  · `stale`   — medido y viejo. Tiene una edad concreta que mostrar.
 *  · `unknown` — **no se pudo medir**. No es lo mismo que estar al día, y nunca se pinta como si
 *                lo fuera. Un booleano no puede expresar este tercer estado: ésa fue exactamente la
 *                falla que dejó muda a la etiquetera cuando la medición fallaba.
 */
export const FreshnessStatus = z.enum(['fresh', 'stale', 'unknown']);
export type FreshnessStatus = z.infer<typeof FreshnessStatus>;

/** Un eslabón de la cadena que produce un dato, con su edad y su veredicto. */
export const FreshnessInput = z.object({
  key: z.string(),
  label: z.string(),
  /** ISO del último avance real, o `null` si la fuente no reporta. */
  at: z.string().nullable(),
  age_human: z.string().nullable(),
  status: FreshnessStatus,
  /** Derivado de `status`: `true` salvo que sea `fresh`. Nunca se calcula aparte. */
  stale: z.boolean(),
});
export type FreshnessInput = z.infer<typeof FreshnessInput>;

/**
 * Frescura compuesta. `data_as_of` es el eslabón **más viejo** a propósito: una cadena es tan fresca
 * como su peor tramo, y quedarse con el mejor es cómo se dibuja un verde falso.
 *
 * No confundir con un `generated_at`: ése dice cuándo respondió el servidor, y un servidor que
 * contesta en 200 ms sobre datos de hace seis días lo reporta igual de fresco.
 */
export const Freshness = z.object({
  data_as_of: z.string().nullable(),
  status: FreshnessStatus,
  stale: z.boolean(),
  age_human: z.string().nullable(),
  /** Qué eslabón falla, para que el aviso nombre algo accionable y no sólo "hay rezago". */
  inputs: z.array(FreshnessInput),
});
export type Freshness = z.infer<typeof Freshness>;

/**
 * Cobertura declarada: qué parte del universo explica de verdad el número que se está publicando.
 *
 * `measured` es el campo que no puede faltar. Sin él, "no falta nada" y "nadie contó" se serializan
 * igual —ceros y arreglos vacíos— y el consumidor no tiene cómo distinguirlos. El sell-out por
 * vendedor devolvía dos arreglos vacíos con una nota de alcance fija: se leía como cobertura total
 * y nunca lo fue.
 */
export const Coverage = z.object({
  measured: z.boolean(),
  /** % del universo (importe, filas) que el cálculo sí explica. `null` cuando `measured` es false. */
  pct: z.number().nullable(),
  /** Qué quedó afuera y por qué, en palabras que el lector pueda accionar. */
  note: z.string(),
});
export type Coverage = z.infer<typeof Coverage>;
