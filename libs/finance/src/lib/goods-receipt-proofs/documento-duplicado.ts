/**
 * `[RE.42]` — **¿Este papel del proveedor ya se subió?** La identidad de un documento es
 * EMISOR + FOLIO, nunca el folio solo.
 *
 * Módulo puro, igual que `receipt-match.ts`: decide si se le cierra la puerta a un capturista, así
 * que cada veredicto tiene que poder explicarse con una regla y reproducirse en un test.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * EL CASO QUE LO MOTIVÓ (prod, 2026-10-20). La nota de venta `0666` de EL FAROLITO (entrada
 * `08/0000288`, $22,500, RFC impreso `CUMG660606M75`) no se podía subir: *"Este PDF ya está subido
 * en la entrada 01/0000589"*. Esa entrada es de DULCELICIAS, $1,150, RFC impreso `MEAM8008293J4`,
 * de otro mes. Lo único que compartían era el número `0666`.
 *
 * El dedup anterior comparaba el folio y "cuidaba" al proveedor con
 * `lower(proveedor_rfc) IN ('', ?)`: el RFC **de Kepler**, que viene vacío en el 42% de las
 * entradas (1,475 de 3,497 a 90 días). Con el RFC vacío, la guarda se apagaba y el folio chocaba
 * contra **cualquier** proveedor: había **394 folios comodín** guardados, 136 de ellos números
 * cortos como `0666` — justo lo que traen las notas de los proveedores chicos.
 * ⚠️ Cero colisiones guardadas NO prueba que no pase: el propio bloqueo impedía guardarlas.
 *
 * LAS SEÑALES DE EMISOR, medidas (2026-10-21) y ordenadas por cuánto aguantan:
 *   1. **`proveedor_code` de Kepler** de la entrada donde vive cada papel. De 147 proveedores que
 *      aparecen en varias sucursales, **143 conservan el código** (los 4 que no, son catálogo
 *      duplicado o sucursales internas). DULCELICIAS es `CD43` en las cuatro donde compra.
 *   2. **RFC impreso en el papel**, si tiene forma de RFC y NO es el nuestro. El OCR leyó
 *      `LOGL851014AQ5` (nosotros, el receptor) en **52 papeles de 12+ proveedores**, y también
 *      `LOGL851014AG5`: por eso el propio se reconoce con tolerancia de UN carácter.
 *   3. **Nombre** del proveedor. Sólo como evidencia a favor y nunca para bloquear: el nombre del
 *      papel casa con el de Kepler en el 76% (`receipt-match.ts`), o sea que falla 1 de cada 4.
 *
 * ⭐ LA REGLA: **bloquear exige prueba fuerte** (misma hoja por hash, o mismo folio con el mismo
 * emisor probado por 1 o 2). Lo que no se puede probar **se avisa, no se bloquea** (ADR-056: lo
 * desconocido se declara, nunca se resuelve como "coincide"). El aviso no detiene a nadie: el
 * expediente igual pasa por el revisor, que es la compuerta humana que ya existe.
 * ──────────────────────────────────────────────────────────────────────────────────────────
 */
import { parecidoNombre, rfcBienFormado, rfcComparable, UMBRAL_NOMBRE } from './receipt-match';

/** Un papel del proveedor con todo lo que se sabe de él. Cualquier campo puede faltar. */
export interface PapelProveedor {
  sha256?: string | null;
  /** Folio del proveedor leído del papel (remisión/factura). */
  folio?: string | null;
  /** RFC del EMISOR leído del papel. */
  rfc?: string | null;
  /** Nombre del emisor leído del papel. */
  nombre?: string | null;
  /** Total leído del papel. */
  total?: number | null;
  /** Proveedor de Kepler de la entrada donde vive (o a la que va) el papel. */
  proveedorCode?: string | null;
  proveedorNombre?: string | null;
}

export type NivelDuplicado = 'bloquea' | 'avisa' | 'distinto';
export type MotivoDuplicado =
  | 'misma_hoja'               // mismo hash: es el mismo archivo
  | 'mismo_emisor_mismo_folio' // emisor probado + mismo folio + importe compatible
  | 'mismo_folio_otro_importe' // emisor probado + mismo folio, pero el total leído difiere
  | 'emisor_sin_confirmar'     // mismo folio, y no hay con qué probar quién lo emitió
  | 'otro_emisor'              // mismo folio, de otro proveedor: no es duplicado
  | 'otro_importe'             // mismo folio, emisor desconocido, totales distintos: otro papel
  | 'otro_folio';              // ni hash ni folio coinciden

export type FuenteEmisor = 'proveedor_kepler' | 'rfc_papel' | 'nombre';

export interface VeredictoDuplicado {
  nivel: NivelDuplicado;
  motivo: MotivoDuplicado;
  /** Con qué se decidió quién emitió cada papel. `null` = no se pudo saber. */
  emisor: FuenteEmisor | null;
}

export interface OpcionesDuplicado {
  /** Nuestro RFC (`fiscal.issuer_config`): leído en un papel, es el RECEPTOR, no el emisor. */
  rfcPropio?: string | null;
  /** Diferencia de importe por debajo de la cual dos totales son el mismo. */
  tolerancia?: number;
}

/** Largo mínimo del núcleo del folio. Por debajo, "12" o "7" chocan entre cualquiera. */
export const FOLIO_MINIMO = 3;

/**
 * Núcleo comparable del folio: sólo sus dígitos, sin ceros a la izquierda. `0666`, `666`,
 * `No. 0666` y `A-0666` dan `666`. `null` si queda corto.
 *
 * Es deliberadamente laxo: un núcleo igual sólo BUSCA candidatos — quien decide es el emisor.
 * ⛔ El SQL de `findDuplicate` lo replica con `ltrim(regexp_replace(x, '\D', '', 'g'), '0')`; si
 * cambias uno, cambia el otro (hay un test que fija los casos).
 */
export function folioNucleo(s?: string | null): string | null {
  if (!s) return null;
  const n = String(s).replace(/\D/g, '').replace(/^0+/, '');
  return n.length >= FOLIO_MINIMO ? n : null;
}

/** ¿Es nuestro RFC? Con tolerancia de UN carácter: el OCR ya leyó `…AG5` por `…AQ5`. */
export function esRfcPropio(rfc?: string | null, propio?: string | null): boolean {
  const a = rfcComparable(rfc);
  const b = rfcComparable(propio);
  if (!a || !b || a.length !== b.length) return false;
  let distintos = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++distintos > 1) return false;
  return true;
}

/** RFC del papel utilizable como emisor: con forma de RFC y que no sea el nuestro. */
function rfcEmisor(p: PapelProveedor, propio?: string | null): string | null {
  if (!rfcBienFormado(p.rfc) || esRfcPropio(p.rfc, propio)) return null;
  return rfcComparable(p.rfc);
}

const codigo = (s?: string | null) => (s || '').trim().toUpperCase() || null;

/**
 * ¿Lo emitió el mismo proveedor? `true`/`false` sólo con prueba; `null` = no se sabe.
 *
 * El código de Kepler manda. Si los códigos difieren pero los dos papeles traen el MISMO RFC
 * de emisor, se cree al RFC: es el proveedor dado de alta dos veces (MY FEST `CM038`/`CM043`), y
 * una factura repetida entre sus dos códigos es justo el duplicado que hay que atrapar.
 */
export function mismoEmisor(
  a: PapelProveedor, b: PapelProveedor, rfcPropio?: string | null,
): { igual: boolean | null; fuente: FuenteEmisor | null } {
  const ra = rfcEmisor(a, rfcPropio);
  const rb = rfcEmisor(b, rfcPropio);
  const ca = codigo(a.proveedorCode);
  const cb = codigo(b.proveedorCode);
  if (ca && cb) {
    if (ca === cb) return { igual: true, fuente: 'proveedor_kepler' };
    if (ra && rb && ra === rb) return { igual: true, fuente: 'rfc_papel' };
    return { igual: false, fuente: 'proveedor_kepler' };
  }
  if (ra && rb) return { igual: ra === rb, fuente: 'rfc_papel' };
  // El nombre sólo suma: un parecido bajo puede ser el OCR, y callarse sería peor que avisar.
  const nombresA = [a.nombre, a.proveedorNombre].filter(Boolean);
  const nombresB = [b.nombre, b.proveedorNombre].filter(Boolean);
  for (const x of nombresA) {
    for (const y of nombresB) {
      const s = parecidoNombre(x, y);
      if (s != null && s >= UMBRAL_NOMBRE) return { igual: true, fuente: 'nombre' };
    }
  }
  return { igual: null, fuente: null };
}

/**
 * ¿`nuevo` es un duplicado de `existente`? Ver la regla en la cabecera.
 *
 * | emisor          | importe            | veredicto                            |
 * |-----------------|--------------------|--------------------------------------|
 * | (mismo hash)    | —                  | bloquea · misma_hoja                 |
 * | probado igual   | igual o sin leer   | bloquea · mismo_emisor_mismo_folio   |
 * | probado igual   | distinto           | avisa · mismo_folio_otro_importe     |
 * | sin saber (o sólo nombre) | igual o sin leer | avisa · emisor_sin_confirmar |
 * | sin saber (o sólo nombre) | distinto         | distinto · otro_importe      |
 * | probado distinto| —                  | distinto · otro_emisor               |
 */
export function veredictoDuplicado(
  nuevo: PapelProveedor, existente: PapelProveedor, opts: OpcionesDuplicado = {},
): VeredictoDuplicado {
  const sha = (nuevo.sha256 || '').trim();
  if (sha && sha === (existente.sha256 || '').trim()) {
    return { nivel: 'bloquea', motivo: 'misma_hoja', emisor: null };
  }
  const fa = folioNucleo(nuevo.folio);
  if (!fa || fa !== folioNucleo(existente.folio)) return { nivel: 'distinto', motivo: 'otro_folio', emisor: null };

  const { igual, fuente } = mismoEmisor(nuevo, existente, opts.rfcPropio);
  if (igual === false) return { nivel: 'distinto', motivo: 'otro_emisor', emisor: fuente };

  const tol = Math.max(opts.tolerancia ?? 1, 0);
  const ta = nuevo.total != null && Number.isFinite(Number(nuevo.total)) ? Number(nuevo.total) : null;
  const tb = existente.total != null && Number.isFinite(Number(existente.total)) ? Number(existente.total) : null;
  const otroImporte = ta != null && tb != null && Math.abs(ta - tb) > tol;

  if (igual === true && fuente !== 'nombre') {
    return otroImporte
      ? { nivel: 'avisa', motivo: 'mismo_folio_otro_importe', emisor: fuente }
      : { nivel: 'bloquea', motivo: 'mismo_emisor_mismo_folio', emisor: fuente };
  }
  // Emisor sin probar (o sólo parecido de nombre, que no alcanza): el importe desempata. El mismo
  // papel leído dos veces da el mismo total; si difieren, es otro documento con el mismo número.
  return otroImporte
    ? { nivel: 'distinto', motivo: 'otro_importe', emisor: fuente }
    : { nivel: 'avisa', motivo: 'emisor_sin_confirmar', emisor: fuente };
}

/**
 * Los candidatos: cada (evidencia, hoja) con el mismo hash o el mismo núcleo de folio, con el
 * proveedor de Kepler de la entrada donde vive. `vigente` = `[RE.31]`: esa entrada SIGUE en Kepler.
 * Vive acá, y no en el servicio, para que `test-newdb-goods-receipt-dedup.js` corra ESTE texto.
 *
 * Bindings, en orden: `[sha, sha, nucleo, nucleo, nucleo, nucleo, tenant_id]`.
 *
 * - `LEFT JOIN LATERAL` a las hojas, para no perder evidencias viejas que sólo traen el folio a
 *   nivel de evidencia.
 * - ⛔ El `ltrim(regexp_replace(...))` replica `folioNucleo()`; el test los compara.
 * - ⛔ Primero los candidatos (CTE MATERIALIZED) y DESPUÉS la vista, fila por fila:
 *   `analytics.erp_goods_receipts` es una vista pesada y un `LEFT JOIN` directo la calcula entera
 *   — medido en prod: **11.7 s** por hoja. Así: **129 ms** (la versión con `EXISTS` de antes, 84).
 * - ⚠️ `analytics.*` lleva el tenant EXPLÍCITO: ahí el RLS no manda.
 */
export const SQL_CANDIDATOS_DUPLICADO = `WITH c AS MATERIALIZED (
  SELECT p.sucursal, p.folio, p.proveedor_nombre, p.ocr_proveedor,
         p.ocr_folio AS p_folio, p.ocr_rfc AS p_rfc, p.ocr_monto::float8 AS p_total,
         e->>'sha256' AS f_sha, e->>'role' AS f_role, e->>'ocr_folio' AS f_folio,
         e->>'ocr_rfc' AS f_rfc, e->>'ocr_total' AS f_total
    FROM finance.goods_receipt_proofs p
    LEFT JOIN LATERAL jsonb_array_elements(COALESCE(p.files, '[]'::jsonb)) e ON true
   WHERE (? <> '' AND e->>'sha256' = ?)
      OR (? <> '' AND ltrim(regexp_replace(COALESCE(p.ocr_folio, ''), '\\D', '', 'g'), '0') = ?)
      OR (? <> '' AND (e->>'role') IN ('remision', 'factura')
                  AND ltrim(regexp_replace(COALESCE(e->>'ocr_folio', ''), '\\D', '', 'g'), '0') = ?)
   LIMIT 200)
SELECT c.*, g.proveedor_code, (g.folio IS NOT NULL) AS vigente
  FROM c
  LEFT JOIN LATERAL (
    SELECT x.proveedor_code, x.folio FROM analytics.erp_goods_receipts x
     WHERE x.tenant_id = ? AND x.sucursal = c.sucursal AND x.folio = c.folio LIMIT 1
  ) g ON true`;

/** Una fila de `SQL_CANDIDATOS_DUPLICADO`. */
export interface FilaCandidataDup {
  sucursal: string; folio: string; proveedor_nombre: string | null; ocr_proveedor: string | null;
  p_folio: string | null; p_rfc: string | null; p_total: number | null;
  f_sha: string | null; f_role: string | null; f_folio: string | null; f_rfc: string | null; f_total: string | null;
  proveedor_code: string | null; vigente: boolean;
}

/**
 * De una fila candidata, los papeles a comparar: la hoja (si trae hash o folio) y el folio a
 * nivel de evidencia (lo que tienen las evidencias anteriores a RE.5.2). El folio de la hoja sólo
 * cuenta si es remisión/factura: el de la orden de entrada es NUESTRO, no del proveedor.
 */
export function papelesDeFila(r: FilaCandidataDup): PapelProveedor[] {
  const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const base = { nombre: r.ocr_proveedor, proveedorCode: r.proveedor_code, proveedorNombre: r.proveedor_nombre };
  const out: PapelProveedor[] = [];
  if (r.f_sha || r.f_folio) {
    out.push({
      ...base, sha256: r.f_sha,
      folio: r.f_role === 'remision' || r.f_role === 'factura' ? r.f_folio : null,
      rfc: r.f_rfc || r.p_rfc, total: num(r.f_total) ?? num(r.p_total),
    });
  }
  if (r.p_folio) out.push({ ...base, folio: r.p_folio, rfc: r.p_rfc, total: num(r.p_total) });
  return out;
}

const RANGO: Record<NivelDuplicado, number> = { bloquea: 2, avisa: 1, distinto: 0 };

/** El más grave de varios veredictos (bloquea > avisa > distinto). */
export function masGrave<T extends { nivel: NivelDuplicado }>(xs: T[]): T | null {
  let peor: T | null = null;
  for (const x of xs) if (x.nivel !== 'distinto' && (!peor || RANGO[x.nivel] > RANGO[peor.nivel])) peor = x;
  return peor;
}

const pesos = (n: number) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

/** El texto para la pantalla: dice dónde vive el otro papel y por qué se decidió así. */
export function mensajeDuplicado(h: {
  motivo: MotivoDuplicado; sucursal: string; folio: string; proveedor?: string | null;
  folioPapel?: string | null; monto?: number | null; montoNuevo?: number | null;
}): string {
  const donde = `la entrada ${h.sucursal}/${h.folio}${h.proveedor ? ` (${h.proveedor})` : ''}`;
  const folio = h.folioPapel ? `El folio ${h.folioPapel}` : 'Ese folio';
  switch (h.motivo) {
    case 'misma_hoja':
      return `Este PDF ya está subido en ${donde}. No se vuelve a guardar.`;
    case 'mismo_emisor_mismo_folio':
      return `${folio} de este mismo proveedor ya está subido en ${donde}. No se vuelve a guardar.`;
    case 'mismo_folio_otro_importe':
      return `${folio} ya está en ${donde}, del mismo proveedor, pero con otro importe`
        + `${h.monto != null && h.montoNuevo != null ? ` (${pesos(h.monto)} contra ${pesos(h.montoNuevo)})` : ''}.`
        + ' Revisa que no sea la misma factura antes de enviar.';
    case 'emisor_sin_confirmar':
      return `${folio} también aparece en ${donde}${h.monto != null ? `, por ${pesos(h.monto)}` : ''}.`
        + ' No se pudo confirmar si es el mismo proveedor: revisa que no sea la misma factura.';
    default:
      return '';
  }
}
