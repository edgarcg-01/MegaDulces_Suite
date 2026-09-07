import { DocPresence } from './entradas.service';

/**
 * `[RE.28]` — **Qué es cada hoja del paquete, y qué le falta al expediente.**
 *
 * Estas reglas vivían dentro de `compras-entradas.component.ts` como miembros privados de la
 * clase, y ésa fue la causa —no el síntoma— de la regresión que abrió esta fase: la otra pantalla
 * de captura, `/compras/entradas`, no las tenía, así que **clavaba `role: 'factura'`** en todo lo
 * que subía. Desde el 2026-08-27, cuando esa worklist se volvió el camino principal, ninguna
 * evidencia pudo declarar la hoja interna:
 *
 *   · hasta el 27-ago: 129 comprobantes · **93 con hoja interna** · 63 con folio leído
 *   · desde el 27-ago:  56 comprobantes · **0** · **0**
 *
 * Y con eso quedaron muertos en origen los dos controles de `[RE.25]` y `[RE.26]`: `paquete_ok`
 * (¿el paquete trae NUESTRA hoja?) y `folio_interno` (¿esa hoja es de ESTA orden?). No fallaba el
 * OCR: la pantalla no podía decir qué era cada papel.
 *
 * Por eso viven acá, al lado de `receipt-verdict.ts` y con el mismo criterio: **se comparten las
 * REGLAS, no la superficie.** Las dos pantallas de captura resuelven trabajos distintos —bandeja
 * de N hojas para el que descarga el bonche del día, wizard de dos pasos para el que llega con un
 * papel suelto sin saber de qué entrada es— y esa diferencia está justificada. Lo que no puede
 * estar duplicado es qué cuenta como qué.
 *
 * Todas las funciones son **puras** y reciben las hojas como argumento: los dos wizards tienen
 * modelos de archivo distintos (`Hoja` y `AttachFile`) y el denominador común es `HojaConRol`.
 */

/** Lo mínimo que una hoja tiene que declarar para que estas reglas la puedan clasificar. */
export interface HojaConRol {
  /** El rol que le puso el capturista. Es lo que MANDA sobre lo que adivinó el OCR. */
  role: string;
  /** Tipos que el OCR detectó dentro de esta hoja (un PDF combinado trae varios). */
  ocrDocs?: string[] | null;
  /** Lo mismo pero con página y evidencia, para que el checklist no sea caja negra. */
  ocrDocsDetail?: DocPresence[] | null;
}

export type FuenteRecepcion = 'kepler' | 'wincaja';

/**
 * Rol declarado → tipo de documento del checklist.
 *
 * ⚠️ Un rol que no esté acá **no rompe nada visible**: simplemente deja de contar para
 * `paquete_ok`, en silencio. El smoke `test-newdb-receipt-roles` exige que todo rol presente en
 * los datos exista en este mapa.
 */
export const ROLE_TO_TYPE: Record<string, string> = {
  orden_entrada: 'aplica_orden_entrada',
  remision: 'remision',
  factura: 'factura',
  vale: 'vale',
  ticket: 'ticket',
  orden_recepcion: 'orden_recepcion',
};

/** Etiqueta legible por tipo, para el checklist y el resumen "detectado en el PDF". */
export const DOC_LABEL: Record<string, string> = {
  aplica_orden_entrada: 'Aplica Orden Entrada',
  factura: 'Factura',
  remision: 'Remisión',
  ticket: 'Ticket',
  orden_recepcion: 'Orden de recepción',
  vale: 'Vale',
  otro: 'Otra hoja',
};

/**
 * Qué documentos exige cada fuente.
 *
 * El enfoque es la **factura del proveedor**: es lo único obligatorio, porque es contra lo que se
 * compara el total que ya trae Kepler. La orden de entrada queda opcional — sirve para identificar
 * y para el control de folio, pero exigirla mandaría a revisión manual casi todo.
 */
export const REQUIRED_BY_SOURCE: Record<FuenteRecepcion, { keys: string[]; label: string; optional?: boolean }[]> = {
  kepler: [
    { keys: ['factura', 'remision'], label: 'Factura' },
    { keys: ['aplica_orden_entrada'], label: 'Orden de entrada', optional: true },
  ],
  wincaja: [
    { keys: ['factura', 'remision'], label: 'Factura' },
    { keys: ['aplica_orden_entrada'], label: 'Orden de entrada', optional: true },
    { keys: ['ticket'], label: 'Ticket', optional: true },
  ],
};

/**
 * Opciones del selector de rol, por fuente.
 *
 * Tienen que **cubrir todo tipo del checklist** de su fuente: si un requerido no se puede marcar a
 * mano, queda imposible de cumplir cuando el OCR no lo reconoce, y Guardar se traba sin salida.
 */
export const ROLE_OPTS_KEPLER = [
  { label: 'Aplica orden entrada', value: 'orden_entrada' },
  { label: 'Factura', value: 'factura' },
  { label: 'Otra evidencia', value: 'evidencia' },
];
export const ROLE_OPTS_WINCAJA = [
  { label: 'Ticket de compra', value: 'ticket' },
  { label: 'Orden de recepción', value: 'orden_recepcion' },
  { label: 'Aplica orden entrada', value: 'orden_entrada' },
  { label: 'Remisión/Factura', value: 'remision' },
  { label: 'Otra evidencia', value: 'evidencia' },
];

export const roleOptsFor = (fuente: FuenteRecepcion) => (fuente === 'wincaja' ? ROLE_OPTS_WINCAJA : ROLE_OPTS_KEPLER);

/**
 * El origen de la recepción define el set de documentos.
 *
 * CEDIS (`md_00`) y las plazas `wincaja_*` reciben por **Wincaja** (ticket + orden de recepción +
 * aplica OE); las sucursales Kepler (`md_01`–`md_05`), por **Kepler**.
 */
export function receptionSource(sourceBranch?: string | null): FuenteRecepcion {
  const sb = (sourceBranch || '').toLowerCase();
  return sb.startsWith('wincaja') || sb === 'md_00' ? 'wincaja' : 'kepler';
}

/** Tipos cubiertos = rol declarado ∪ lo que el OCR detectó (packet-aware). */
export function coveredTypes(hojas: readonly HojaConRol[]): Set<string> {
  const s = new Set<string>();
  for (const h of hojas) {
    const t = ROLE_TO_TYPE[h.role];
    if (t) s.add(t);
    for (const d of h.ocrDocs || []) s.add(d);
  }
  return s;
}

export interface RenglonChecklist {
  label: string;
  ok: boolean;
  optional: boolean;
  /** Cómo se cumplió: `auto` = lo leyó el OCR (con página y evidencia) · `manual` = rol declarado. */
  via: 'auto' | 'manual' | null;
  page: number | null;
  evidence: string | null;
}

/**
 * `[RE.pkt.1]` Checklist auditable: cada requerido dice **cómo** se cumplió, para que no sea una
 * palomita de caja negra.
 */
export function checklist(hojas: readonly HojaConRol[], fuente: FuenteRecepcion): RenglonChecklist[] {
  const cov = coveredTypes(hojas);
  const ocrByType = new Map<string, DocPresence>();
  for (const h of hojas) for (const d of h.ocrDocsDetail || []) if (!ocrByType.has(d.type)) ocrByType.set(d.type, d);
  const manualTypes = new Set<string>();
  for (const h of hojas) { const t = ROLE_TO_TYPE[h.role]; if (t) manualTypes.add(t); }

  return REQUIRED_BY_SOURCE[fuente].map((g) => {
    const auto = g.keys.map((k) => ocrByType.get(k)).find((d): d is DocPresence => !!d) || null;
    const manual = g.keys.some((k) => manualTypes.has(k));
    return {
      label: g.label,
      ok: g.keys.some((k) => cov.has(k)),
      optional: !!g.optional,
      via: (auto ? 'auto' : manual ? 'manual' : null) as 'auto' | 'manual' | null,
      page: auto?.page ?? null,
      evidence: auto?.evidence ?? null,
    };
  });
}

/** Sólo los REQUERIDOS faltantes. Los opcionales informan, no bloquean. */
export function missingGroups(hojas: readonly HojaConRol[], fuente: FuenteRecepcion): RenglonChecklist[] {
  return checklist(hojas, fuente).filter((c) => !c.ok && !c.optional);
}

/**
 * `[RE.pkt.1]` Todo lo que el OCR reconoció, con página y prueba, dedup por (tipo, página). Es el
 * "recibo" de que un PDF combinado trae lo que dice traer.
 */
export function detectedDocs(hojas: readonly HojaConRol[]): { type: string; label: string; page: number | null; evidence: string | null }[] {
  const seen = new Set<string>();
  const out: { type: string; label: string; page: number | null; evidence: string | null }[] = [];
  for (const h of hojas) for (const d of h.ocrDocsDetail || []) {
    const key = `${d.type}|${d.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: d.type, label: DOC_LABEL[d.type] || d.type, page: d.page, evidence: d.evidence });
  }
  return out.sort((a, b) => (a.page ?? 99) - (b.page ?? 99));
}
