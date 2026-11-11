/**
 * `[MCP.18]` **Justificantes**: el motivo de cada cambio a un pedido de preventa, y quién lo ve.
 *
 * Un justificante es un MOTIVO de un catálogo corto (más una nota opcional; obligatoria en «Otro»),
 * guardado con quién y cuándo, y visible para los otros dos roles del mismo pedido: la vendedora ve
 * por qué el surtidor o la caja quitaron algo; el surtidor y la caja ven por qué la vendedora lo
 * corrigió o lo canceló. Lo que se guardó sin motivo (datos de antes, o el texto que el sistema
 * escribía solo) se dice «Sin motivo registrado»: nunca se inventa uno.
 *
 * Dónde se guarda (sin migración):
 *  · corregir (reabrir) y cancelar → `commercial.order_status_history.reason`, como texto
 *    «Etiqueta» o «Etiqueta: nota» (la etiqueta sale de este catálogo);
 *  · lo que quita o recorta el surtidor → `reason`/`reason_note` en cada renglón de `presale_picks.report`;
 *  · lo que quita la caja → `reason`/`reason_note` en cada renglón de `presale_picks.review`.
 *
 * ⭐ Las decisiones de David viven AQUÍ, una constante cada una, para poder revertirlas en un lugar
 * (D1…D5 de `docs/MODULOS/preventa-justificantes.md`).
 */

/** Una opción del catálogo de motivos. */
export interface MotivoOpcion {
  key: string;
  label: string;
}

/** El motivo como viaja de la pantalla al servidor. */
export interface MotivoElegido {
  reason_code: string;
  /** Nota libre; obligatoria si el motivo es «Otro». */
  note?: string | null;
}

/** La nota más larga que se acepta (medido en prod: `orders.notes` máx. 114, p95 93 en 30 días). */
export const NOTA_MOTIVO_MAX = 200;
export const MOTIVO_OTRO = 'otro';

/** D2 · Por qué la vendedora corrige (reabre) un pedido agendado. 19 de 31 correcciones medidas SUBIERON el total. */
export const MOTIVOS_CORREGIR: readonly MotivoOpcion[] = [
  { key: 'agregar', label: 'El cliente quiere agregar productos' },
  { key: 'quitar', label: 'El cliente quiere quitar productos' },
  { key: 'cantidad', label: 'Me equivoqué de cantidad o unidad' },
  { key: 'producto', label: 'Me equivoqué de producto' },
  { key: 'fecha', label: 'Cambiar la fecha de entrega' },
  { key: 'entrega', label: 'Cambiar las indicaciones o la forma de entrega' },
  { key: MOTIVO_OTRO, label: 'Otro motivo' },
];

/** D2 · Por qué la vendedora cancela un pedido que ya estaba agendado. */
export const MOTIVOS_CANCELAR: readonly MotivoOpcion[] = [
  { key: 'ya_no_quiere', label: 'El cliente ya no lo quiere' },
  { key: 'sin_pago', label: 'El cliente no tiene con qué pagar o no tiene crédito' },
  { key: 'sin_existencia', label: 'No hay lo que pidió' },
  { key: 'cliente_equivocado', label: 'Me equivoqué de cliente' },
  { key: 'duplicado', label: 'Pedido duplicado' },
  { key: 'error_captura', label: 'Lo capturé por error' },
  { key: MOTIVO_OTRO, label: 'Otro motivo' },
];

/** D2 · Por qué el surtidor quita o recorta un renglón. */
export const MOTIVOS_SURTIDO: readonly MotivoOpcion[] = [
  { key: 'sin_existencia', label: 'No había en la sucursal' },
  { key: 'no_localizado', label: 'El sistema dice que hay, pero no lo encontré' },
  { key: 'presentacion', label: 'No había en la presentación que pidió (caja, paquete, pieza)' },
  { key: 'danado', label: 'Dañado o caducado' },
  { key: 'lo_pidio_quitar', label: 'Lo pidió quitar el vendedor o el cliente' },
  { key: MOTIVO_OTRO, label: 'Otro motivo' },
];

/** D2 · Por qué la caja deja menos de lo que surtió el surtidor. */
export const MOTIVOS_CAJA: readonly MotivoOpcion[] = [
  { key: 'no_venia', label: 'No venía en el carrito' },
  { key: 'equivocado', label: 'Venía otro producto o presentación' },
  { key: 'danado', label: 'Dañado o caducado' },
  { key: 'lo_pidio_quitar', label: 'Lo pidió quitar el vendedor o el cliente' },
  { key: MOTIVO_OTRO, label: 'Otro motivo' },
];

/**
 * D4 · El motivo que ya viene marcado. Es lo que dice el botón que se tocó («Faltante» / «No había
 * nada» al surtir; «No hay» en caja), así que el caso común no cuesta ningún toque más.
 */
export const MOTIVO_SURTIDO_POR_OMISION = 'sin_existencia';
export const MOTIVO_CAJA_POR_OMISION = 'no_venia';

/**
 * D1 · Hasta cuándo la vendedora puede «Corregir» (reabrir) un pedido agendado.
 * Medido en prod (30 días): de 35 correcciones, 15 fueron con el surtido empezado, 11 ya surtido y 4
 * ya revisado en caja; las que subieron el total después de surtir agregaron $2,235.98 que nadie surtió.
 */
export type PoliticaCorregir = 'permitir' | 'hasta_que_empiece_el_surtido' | 'hasta_que_termine_el_surtido';
export const POLITICA_CORREGIR: PoliticaCorregir = 'hasta_que_empiece_el_surtido';

/**
 * D4 · ¿El servidor rechaza el cambio sin motivo? Decisión de David (2026-11-11): **sí, en los tres
 * roles**. Sin motivo es un 400 y no se escribe nada:
 *  · «Corregir» de la vendedora;
 *  · cancelar un pedido AGENDADO (confirmado o por aprobar) que es suyo (Comercial cancelando el de
 *    otra persona queda fuera: su pantalla no pide motivo y en 30 días hubo 0 casos);
 *  · cada renglón que el surtidor quita o recorta;
 *  · cada renglón que la caja deja por debajo de lo que surtió el surtidor.
 * El texto fijo que mandaban las pantallas de antes («Cancelado por el vendedor») NO cuenta como motivo.
 * `false` lo vuelve opcional en los cuatro (queda «Sin motivo registrado»).
 */
export const MOTIVO_OBLIGATORIO_EN_SERVIDOR = true;

/**
 * Lo que se le dice a quien manda un cambio sin motivo: casi siempre es una pantalla vieja en caché
 * (la app nueva siempre lo pide), así que se le dice cómo salir.
 */
export const AVISO_PANTALLA_VIEJA = 'Si tu pantalla no te lo pide, ciérrala y vuelve a abrirla para tener la versión nueva.';

/** Lo que el sistema escribía solo en `order_status_history.reason`: no es el motivo de nadie. */
export const TEXTOS_SIN_MOTIVO: readonly string[] = ['reabierto para corregir', 'cancelado por el vendedor'];
export const SIN_MOTIVO_REGISTRADO = 'Sin motivo registrado';

/** La etiqueta de un motivo; `null` si la clave no es del catálogo. */
export function etiquetaDeMotivo(catalogo: readonly MotivoOpcion[], key: string | null | undefined): string | null {
  return catalogo.find((o) => o.key === key)?.label ?? null;
}

/** «Etiqueta» o «Etiqueta: nota». Una clave que ya no está en el catálogo se muestra tal cual, entre comillas. */
export function textoDeMotivo(catalogo: readonly MotivoOpcion[], key: string, nota?: string | null): string {
  const base = etiquetaDeMotivo(catalogo, key) ?? `«${key}»`;
  const n = String(nota ?? '').trim();
  return n ? `${base}: ${n}` : base;
}

/** ¿El motivo es válido? Devuelve el error en palabras, o `null`. */
export function errorDeMotivo(catalogo: readonly MotivoOpcion[], m: Partial<MotivoElegido> | null | undefined): string | null {
  const key = typeof m?.reason_code === 'string' ? m.reason_code.trim() : '';
  if (!key) return 'Elige el motivo.';
  if (!etiquetaDeMotivo(catalogo, key)) return `El motivo «${key}» no está en la lista.`;
  if (m?.note != null && typeof m.note !== 'string') return 'La nota del motivo tiene que ser texto.';
  const nota = String(m?.note ?? '').trim();
  if (nota.length > NOTA_MOTIVO_MAX) return `La nota del motivo pasa de ${NOTA_MOTIVO_MAX} caracteres.`;
  if (key === MOTIVO_OTRO && !nota) return 'Con «Otro motivo» escribe cuál fue.';
  return null;
}

/** El motivo guardado en la historia del pedido, para mostrarlo; `null` = sin motivo registrado. */
export function motivoDeHistoria(reason: string | null | undefined): string | null {
  const t = String(reason ?? '').trim();
  if (!t || TEXTOS_SIN_MOTIVO.includes(t.toLowerCase())) return null;
  return t;
}

/** Quién hizo el cambio. `other` = alguien que no es la vendedora del pedido (Comercial, un administrador). */
export type JustificationActor = 'seller' | 'picker' | 'cashier' | 'other';
/**
 * Qué cambió: `reopened` la vendedora lo corrigió · `cancelled` se canceló · `removed` el surtidor lo
 * quitó · `trimmed` el surtidor surtió menos · `not_in_cart` la caja dejó menos de lo que surtió el surtidor.
 */
export type JustificationAction = 'reopened' | 'cancelled' | 'removed' | 'trimmed' | 'not_in_cart';

/** Un cambio al pedido con su motivo, como lo ven los otros roles. */
export interface OrderJustification {
  actor: JustificationActor;
  action: JustificationAction;
  /** Nombre de quien lo hizo; `null` = no se sabe. */
  by_name: string | null;
  /** ISO 8601; `null` = no se sabe. */
  at: string | null;
  /** Producto del renglón; `null` = el pedido entero. */
  product_name: string | null;
  /** Cantidades en palabras («1 de 2 CJA»); `null` en lo que es del pedido entero. */
  detail: string | null;
  /** El motivo para mostrar; `null` = sin motivo registrado. */
  reason: string | null;
}

const ACTOR: Record<JustificationActor, string> = { seller: 'Vendedor', picker: 'Surtidor', cashier: 'Caja', other: 'Otra área' };

/** Las tres piezas de un justificante en palabras, igual en las dos apps. */
export function textoDeJustificante(j: OrderJustification): { quien: string; que: string; motivo: string } {
  const prod = j.product_name ?? 'el producto';
  const det = j.detail ? ` (${j.detail})` : '';
  const que = j.action === 'reopened' ? 'Corrigió el pedido'
    : j.action === 'cancelled' ? 'Canceló el pedido'
    : j.action === 'removed' ? `Quitó ${prod}${det}`
    : j.action === 'trimmed' ? `Surtió menos de ${prod}${det}`
    : `Dejó menos de ${prod}${det}`;
  const quien = j.by_name?.trim() ? `${ACTOR[j.actor]} · ${j.by_name.trim()}` : ACTOR[j.actor];
  return { quien, que, motivo: j.reason ?? SIN_MOTIVO_REGISTRADO };
}
