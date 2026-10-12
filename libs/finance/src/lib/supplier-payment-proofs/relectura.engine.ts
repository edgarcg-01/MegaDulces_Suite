/**
 * `[AT.1]` — **La relectura desde el archivo guardado: qué se puede releer, y qué se hace con
 * lo que vuelve.** Reglas puras, sin base ni red, para poder probarlas de verdad.
 *
 * ## Por qué existe, medido en prod el 2026-10-12
 *
 * `[PC.6]` valida solo un comprobante cuando sus cuatro señales coinciden con el pago de Kepler,
 * **y la lectura es verificada** — o sea, la produjo el servidor y no vino en el request. La
 * verificación de `[PC.6]` es un recuerdo en memoria (`OcrReadingsService`): el endpoint de OCR
 * guarda lo que leyó indexado por el hash del archivo, y `attach` lo recupera segundos después.
 *
 * ⛔ Ese recuerdo **no sobrevive** a un reinicio, ni a una carga masiva, ni al día siguiente. Y eso
 * es exactamente lo que dejó parada la cola:
 *
 * | | medido |
 * |---|---|
 * | Comprobantes `recibido` | **1,259** |
 * | …con lectura verificada | **60** |
 * | …con las 4 señales en `ok` pero SIN lectura verificada | **187** |
 * | …sin ninguna señal calculada | **737** (todos del 2026-08-05, una sola carga) |
 *
 * ⭐⭐ O sea: **ninguno de los 189 que están en 4/4 se podía auto-validar**, y no por la regla de
 * las coincidencias sino porque nadie puede probar quién produjo su lectura. La cola no estaba
 * esperando gente: estaba esperando una lectura que el servidor pudiera firmar.
 *
 * ## La salida, que ya estaba construida y nadie había cableado acá
 *
 * `ObjectStorageService.getDataUri()` existe —literalmente— *«para re-correr OCR/Vision en el
 * servidor sobre un archivo ya subido (validación autoritativa, sin confiar en lo que reporta el
 * cliente)»*, y **1,199 de 1,199** comprobantes sin verificar tienen su archivo en el bucket.
 * Releer desde ahí no afloja la guarda de `[PC.6]`: la **cumple mejor** que el recuerdo en
 * memoria, porque el servidor baja los bytes que están guardados como evidencia y los lee él.
 *
 * ## ⛔ Lo que esto NO es (y el precedente que obliga a decirlo)
 *
 * `[GX.32]` retiró del módulo de gastos un cuadre donde **la visión firmaba la validación**
 * (`validated_by: 'Claude Vision'`): si el monto leído cuadraba, el expediente cerraba solo. Se
 * quitó por pedido del usuario y no vuelve.
 *
 * Acá la visión **no decide nada**. Produce una lectura; quien decide es el cruce exacto contra
 * **Kepler** en cuatro campos (`[PC.6]`, ya en prod, firmado `Sistema · 4 coincidencias`). Si la
 * relectura sale distinta y deja de cuadrar, el comprobante se queda `recibido` con sus señales
 * reales — la relectura puede DESCALIFICAR a uno que hoy aparenta 4/4, y eso es una función, no
 * un efecto colateral.
 */

import type { SupplierPaymentFields } from '@megadulces/platform-core';

/** Lo que el modelo de visión acepta. Cualquier otra cosa no se le manda. */
export const TIPOS_LEIBLES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'] as const;
export type TipoLeible = (typeof TIPOS_LEIBLES)[number];

/** La hoja de un comprobante, como vive en `files` (jsonb). */
export interface HojaGuardada {
  role?: string | null;
  url?: string | null;
  public_id?: string | null;
  kind?: string | null;
}

/**
 * La hoja que se relee: la del rol `comprobante` (la que liga el pago), **no** la del rol `gasto`
 * —que es la factura de lo comprado y se lee con otro extractor—. Sin `public_id` que parezca
 * llave del bucket no hay nada que bajar: una `url` http es un archivo legacy de Cloudinary, que
 * `getDataUri` rechaza a propósito.
 */
export function hojaRelegible(files: unknown): HojaGuardada | null {
  const lista = Array.isArray(files) ? (files as HojaGuardada[]) : [];
  const esLlave = (h: HojaGuardada) => {
    const k = String(h?.public_id ?? '').trim();
    return !!k && !/^https?:\/\//i.test(k);
  };
  return lista.find((h) => h?.role === 'comprobante' && esLlave(h)) ?? null;
}

/**
 * El tipo de contenido de un data URI, **sólo si el modelo lo sabe leer**. `null` si no.
 *
 * ⚠️ El módulo hermano castea el tipo con `as never` y le manda al modelo lo que venga. Un objeto
 * guardado sin `ContentType` sale como `application/octet-stream`, y eso es un 400 del proveedor
 * que acá se leería como «el comprobante es ilegible» — una falla de plomería disfrazada de
 * veredicto sobre el documento.
 */
export function tipoLeible(dataUri: string | null | undefined): TipoLeible | null {
  const m = /^data:([^;,]+)[;,]/.exec(String(dataUri ?? ''));
  if (!m) return null;
  const t = m[1].trim().toLowerCase();
  return (TIPOS_LEIBLES as readonly string[]).includes(t) ? (t as TipoLeible) : null;
}

/** El base64 de un data URI (sin el encabezado). Cadena vacía si no es un data URI. */
export function base64De(dataUri: string | null | undefined): string {
  const s = String(dataUri ?? '');
  const i = s.indexOf(',');
  return i > 0 && s.startsWith('data:') ? s.slice(i + 1) : '';
}

/**
 * ¿La lectura que volvió dice ALGO? Mismo criterio que el endpoint de OCR (`runOcr`): sirve si
 * trae monto, fecha, concepto o clave de rastreo.
 *
 * ⛔⛔ Esta es la guarda que impide el peor desenlace. `extractSupplierPayment` **se traga sus
 * excepciones y devuelve todos los campos en `null`** — sin API key, con el modelo caído o con un
 * PDF que no se pudo decodificar, el retorno es idéntico al de un documento en blanco. Persistir
 * eso borraría la lectura que ya está guardada y dejaría las cuatro señales en `sin_dato`, o sea
 * que una caída del proveedor se vería como *«los comprobantes no se entienden»* y además
 * **destruiría evidencia**. Una lectura vacía no se escribe nunca: se declara `ilegible` y la
 * fila se queda exactamente como estaba.
 */
export function lecturaSirve(f: Partial<SupplierPaymentFields> | null | undefined): boolean {
  if (!f) return false;
  return f.monto != null || !!f.fecha || !!f.concepto || !!f.clave_rastreo;
}

/** Los campos de los que salen las cuatro señales de `[PC.6]`. */
export const CAMPOS_QUE_DECIDEN = ['monto', 'fecha', 'cuenta_origen', 'beneficiario'] as const;
export type CampoQueDecide = (typeof CAMPOS_QUE_DECIDEN)[number];

const texto = (v: unknown): string => String(v ?? '').trim();

/**
 * El día `YYYY-MM-DD`, venga como texto o como `Date`.
 *
 * ⚠️ `pg` devuelve una columna `date` como objeto `Date` en UTC-medianoche; en hora de México eso
 * renderiza el día ANTERIOR. Comparar la lectura vieja (que llega como `Date`) contra la nueva
 * (texto del modelo) con `String()` marcaría como «cambió» a todas las fechas del mundo.
 */
const dia = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(texto(v));
  return m ? m[1] : texto(v);
};

/** El importe comparable: `numeric` de pg llega como texto (`"1234.50"`), el modelo como número. */
const importe = (v: unknown): string => {
  if (v == null || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : texto(v);
};

/**
 * En qué se diferencia la relectura de lo que estaba guardado, **sólo en los campos que deciden**.
 *
 * ⭐ No es cosmética: es la única medición que dice si la lectura que trajo la carga masiva del
 * 2026-08-05 era confiable. Si la relectura coincide con la vieja, el archivo confirma lo
 * capturado; si no, lo guardado no describía al documento — y eso hay que poder contarlo en vez
 * de pisarlo en silencio.
 */
export function camposQueCambiaron(
  vieja: Partial<Record<CampoQueDecide, unknown>> | null | undefined,
  nueva: Partial<Record<CampoQueDecide, unknown>> | null | undefined,
): CampoQueDecide[] {
  const norm = (c: CampoQueDecide, v: unknown) => (c === 'monto' ? importe(v) : c === 'fecha' ? dia(v) : texto(v));
  return CAMPOS_QUE_DECIDEN.filter((c) => norm(c, vieja?.[c]) !== norm(c, nueva?.[c]));
}

/** Por qué un comprobante no se pudo releer. Cada motivo se cuenta aparte, nunca un total mudo. */
export type MotivoNoRelegible = 'sin_hoja' | 'sin_archivo' | 'tipo_no_leible' | 'ilegible';

export interface ResultadoRelectura {
  /** Cuántos comprobantes entraron a la pasada. */
  revisados: number;
  /** Lecturas que el servidor produjo y persistió (`lectura_verificada = true`). */
  releidos: number;
  /** De los releídos, cuántos cambiaron en algún campo que decide. */
  cambiaron: number;
  /** Comprobantes que ganaron sus cuatro señales (antes no tenían ninguna). */
  clasificados: number;
  /** Comprobantes que se validaron solos en esta pasada. */
  validados: number;
  /** Por qué no se pudo releer, desglosado. */
  no_relegibles: Record<MotivoNoRelegible, number>;
  /** Fallas acumuladas. Una pasada con fallas NO reporta `ok` (ADR-053). */
  errores: string[];
  ms: number;
}

export const SIN_RELEER: Record<MotivoNoRelegible, number> = {
  sin_hoja: 0, sin_archivo: 0, tipo_no_leible: 0, ilegible: 0,
};

/** Un resultado vacío, para arrancar una pasada sin repetir la forma en cada llamador. */
export function pasadaVacia(): ResultadoRelectura {
  return {
    revisados: 0, releidos: 0, cambiaron: 0, clasificados: 0, validados: 0,
    no_relegibles: { ...SIN_RELEER }, errores: [], ms: 0,
  };
}

/**
 * El latido mide **entrega**, no «la pasada corrió» (ADR-053): lo entregado son las lecturas que
 * el servidor firmó. Una pasada que revisa comprobantes y no relee **ninguno** no está bien,
 * aunque no haya tirado una excepción — es justo el caso que `run-prod-feeds` declaraba `ok` con
 * 6 de sus 53 pasos caídos.
 *
 * ⛔ `revisados === 0` NO es error: es la cola vacía, que es el estado al que esto tiende.
 */
export function veredictoPasada(r: ResultadoRelectura): 'ok' | 'error' {
  if (r.errores.length) return 'error';
  if (r.revisados > 0 && r.releidos === 0) return 'error';
  return 'ok';
}

/** La nota del latido: lo entregado y lo que no se pudo, siempre con su motivo. */
export function notaPasada(r: ResultadoRelectura): string {
  const no = (Object.entries(r.no_relegibles) as [MotivoNoRelegible, number][])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`);
  return [
    `${r.releidos}/${r.revisados} releidos`,
    `${r.clasificados} clasificados`,
    `${r.validados} validados solos`,
    `${r.cambiaron} cambiaron de lectura`,
    no.length ? `sin releer: ${no.join(', ')}` : null,
  ].filter(Boolean).join(' · ');
}
