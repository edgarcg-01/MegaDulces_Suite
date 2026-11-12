/**
 * `[GP.9.1]` Seguimiento de la cotización después de «Pedido en Kepler» — reglas PURAS.
 *
 * El vendedor manda la cotización a Kepler y hasta hoy ahí se le perdía: no sabía si el pedido ya
 * se surtió, se embarcó o se facturó sin llamarle al almacén. Esto arma la cadena con lo que Kepler
 * YA registra (pedido `U-D-40` → embarque `U-D-41` → factura `U-D-8`, ligados por el apuntador
 * `c37/c38/c39` del documento hijo) y lo que el piso marque en la Suite (olas de GP), sin copiar nada.
 *
 * Lo que Kepler NO guarda se declara, no se rellena (medido 2026-11-12, FASE_GP §2.3):
 *  · **No hay hora por etapa.** Surtido y checado sólo dicen «hecho» por el estatus del pedido; la
 *    hora existe sólo si el piso los marcó en la Suite.
 *  · **Quién es una CLAVE, no un nombre** (`c100/c102/c103` del pedido, `c80/c81/c82` del embarque):
 *    el catálogo de responsables no está en el ODS. Se muestra como clave de Kepler, y un hueco
 *    (en 30 días, 56 de 98 pedidos de cotización sin surtidor) se dice «Kepler no registró quién».
 */

/** El orden en que Kepler avanza el estatus del pedido (`kdm1.c11`), medido en 7,837 pedidos de 90 días. */
export const ESTATUS_PEDIDO = ['CREADO', 'AUTORIZADO', 'SURTIDO', 'CHECADO', 'EMBARCADO'] as const;

export type ClavePaso = 'pedido' | 'autorizado' | 'surtido' | 'checado' | 'embarcado' | 'facturado';

export interface DocumentoPaso {
  documento: string;
  fecha: string | null;
  cancelado: boolean;
  importe: number | null;
}

export interface PasoSeguimiento {
  clave: ClavePaso;
  titulo: string;
  hecho: boolean;
  /** `YYYY-MM-DD` o `YYYY-MM-DD HH:MM`. null = Kepler no guarda la hora de esta etapa. */
  cuando: string | null;
  /** Quién, con su fuente: nombre si lo marcó la Suite, «clave X en Kepler» si sólo está la clave. */
  quien: string | null;
  /** true = el paso está hecho y nadie registró quién lo hizo. */
  sin_responsable: boolean;
  documentos: DocumentoPaso[];
}

export interface HallazgoSeguimiento {
  titulo: string;
  resumen: string;
  importe: number | null;
  severidad: string | null;
}

export interface SeguimientoCotizacion {
  /** false = la cotización todavía no se manda a Kepler: no hay nada que seguir. */
  en_kepler: boolean;
  /** true = tiene folio, pero la réplica de Kepler aún no trae el pedido (llega en minutos). */
  pendiente_replica: boolean;
  pedido: {
    sucursal: string; sucursal_nombre: string; documento: string; estatus: string | null;
    /** Qué tan probado está que este pedido ES el de la cotización (ver `identidadDelPedido`). */
    identidad: IdentidadPedido;
  } | null;
  pasos: PasoSeguimiento[];
  hallazgos: HallazgoSeguimiento[];
  leido_en: string;
}

// ── Lo que llega de la base (crudo) ────────────────────────────────────────────────────────────

export interface PedidoCrudo {
  serie: number;
  folio: string;
  fecha: string;
  hora: string | null;
  estatus: string | null;
  resp_surtido: string | null;
  resp_checado: string | null;
  resp_embarque: string | null;
  /** `c10`, el cliente del pedido en Kepler. */
  cliente: string | null;
  /** `c24` (Comentarios) trae el código de la cotización: Kepler lo copia al escribir el pedido. */
  trae_cotizacion: boolean;
}

/**
 * `confirmada` = el pedido trae el código de la cotización en sus comentarios.
 * `por_folio`  = no lo trae, pero es del mismo cliente: la liga es el folio que guardó la Suite.
 * `dudosa`     = no lo trae y es de OTRO cliente: alguien lo editó en Kepler, o el folio no es el mismo
 *                pedido. Medido 2026-11-12: 2 de 109 (COT-2026-00016, -00174) y 1 de contado cambiado
 *                a cliente con nombre (-00219). Se muestra con aviso, nunca como si fuera seguro.
 * La factura a OTRO cliente sobre un pedido de CONTADO es normal (se factura a nombre del que pide).
 */
export type IdentidadPedido = 'confirmada' | 'por_folio' | 'dudosa';

export function identidadDelPedido(p: Pick<PedidoCrudo, 'cliente' | 'trae_cotizacion'>, clienteCotizacion: string | null): IdentidadPedido {
  if (p.trae_cotizacion) return 'confirmada';
  return (p.cliente ?? '').trim() === (clienteCotizacion ?? '').trim() ? 'por_folio' : 'dudosa';
}

export interface EmbarqueCrudo {
  serie: number;
  folio: string;
  fecha: string;
  resp_surtido: string | null;
  resp_checado: string | null;
  resp_embarque: string | null;
  importe: number | null;
}

export interface FacturaCruda {
  serie: number;
  folio: string;
  fecha: string;
  hora: string | null;
  cancelada: boolean;
  importe: number | null;
}

/** El paso de piso registrado en la Suite (olas de GP). Nombres ya resueltos. */
export interface PisoCrudo {
  surtio: string | null;
  surtido_at: string | null;
  checo: string | null;
  checado_at: string | null;
}

export interface HallazgoCrudo {
  titulo: string;
  resumen: string;
  importe: number | null;
  severity: string | null;
  status: string | null;
}

/** Estados de un hallazgo que ya no piden atención (el resto se muestra). */
const HALLAZGO_CERRADO = new Set(['resuelto', 'resolved', 'descartado', 'dismissed', 'cerrado', 'closed']);

const pad2 = (n: number) => String(n).padStart(2, '0');
export const docPedido = (serie: number, folio: string) => `UD40${pad2(serie)}-${folio}`;
export const docEmbarque = (serie: number, folio: string) => `UD41${pad2(serie)}-${folio}`;
export const docFactura = (serie: number, folio: string) => `UD08${pad2(serie)}-${folio}`;

/** Clave de Kepler en cero (`0`, `00`, `00000`) o vacía = sin capturar. */
export function claveCapturada(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' || /^0+$/.test(t) ? null : t;
}

const conHora = (fecha: string, hora: string | null) => {
  const h = (hora ?? '').trim();
  return /^\d{1,2}:\d{2}/.test(h) ? `${fecha} ${h.slice(0, 5)}` : fecha;
};

/** `2026-11-12T20:15:00.000Z` → `2026-11-12 14:15` en hora de la Ciudad de México. */
export function horaMx(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')} ${v('hour') === '24' ? '00' : v('hour')}:${v('minute')}`;
}

function quienDe(suite: string | null, ...claves: Array<string | null>): string | null {
  if (suite) return suite;
  const c = claves.map(claveCapturada).find(Boolean);
  return c ? `clave ${c} en Kepler` : null;
}

/**
 * Arma los pasos. Un paso está hecho si el estatus del pedido ya lo pasó, **o** si hay un documento
 * posterior que lo prueba (un embarque prueba el surtido y el checado aunque el estatus diga otra cosa;
 * la Suite marcó el surtido aunque Kepler no lo haya capturado todavía).
 */
export function armarPasos(
  pedido: PedidoCrudo,
  embarques: EmbarqueCrudo[],
  facturas: FacturaCruda[],
  piso: PisoCrudo | null,
): PasoSeguimiento[] {
  const idx = ESTATUS_PEDIDO.indexOf((pedido.estatus ?? '').toUpperCase() as (typeof ESTATUS_PEDIDO)[number]);
  const embarcado = idx >= 4 || embarques.length > 0;
  const vivas = facturas.filter((f) => !f.cancelada);
  const e0 = embarques[0] ?? null;

  const paso = (clave: ClavePaso, titulo: string, hecho: boolean, cuando: string | null, quien: string | null, documentos: DocumentoPaso[] = []): PasoSeguimiento => ({
    clave, titulo, hecho, cuando: hecho ? cuando : null, quien: hecho ? quien : null,
    sin_responsable: hecho && !quien && (clave === 'surtido' || clave === 'checado' || clave === 'embarcado'),
    documentos,
  });

  const surtido = idx >= 2 || embarcado || !!piso?.surtido_at;
  const checado = idx >= 3 || embarcado || !!piso?.checado_at;

  return [
    paso('pedido', 'Pedido en Kepler', true, conHora(pedido.fecha, pedido.hora), null,
      [{ documento: docPedido(pedido.serie, pedido.folio), fecha: pedido.fecha, cancelado: false, importe: null }]),
    paso('autorizado', 'Autorizado', idx >= 1 || surtido, null, null),
    paso('surtido', 'Surtido', surtido, horaMx(piso?.surtido_at ?? null),
      quienDe(piso?.surtio ?? null, pedido.resp_surtido, e0?.resp_surtido ?? null)),
    paso('checado', 'Checado', checado, horaMx(piso?.checado_at ?? null),
      quienDe(piso?.checo ?? null, pedido.resp_checado, e0?.resp_checado ?? null)),
    paso('embarcado', 'Embarcado', embarcado, e0?.fecha ?? null,
      quienDe(null, e0?.resp_embarque ?? null, pedido.resp_embarque),
      embarques.map((e) => ({ documento: docEmbarque(e.serie, e.folio), fecha: e.fecha, cancelado: false, importe: e.importe }))),
    paso('facturado', 'Facturado', vivas.length > 0, vivas[0] ? conHora(vivas[0].fecha, vivas[0].hora) : null, null,
      facturas.map((f) => ({ documento: docFactura(f.serie, f.folio), fecha: f.fecha, cancelado: f.cancelada, importe: f.importe }))),
  ];
}

export function hallazgosAbiertos(rows: HallazgoCrudo[]): HallazgoSeguimiento[] {
  return rows
    .filter((h) => !HALLAZGO_CERRADO.has((h.status ?? '').toLowerCase()))
    .map((h) => ({ titulo: h.titulo, resumen: h.resumen, importe: h.importe, severidad: h.severity }));
}

/** Las llaves con que `TlmkRevisionService` (AX.22.2) guarda sus hallazgos para esta cadena. */
export function llavesHallazgo(sucursal: string, pedido: PedidoCrudo, embarques: EmbarqueCrudo[]): string[] {
  return [
    `tlmk_caja|${sucursal}|40|${pedido.serie}|${pedido.folio}`,
    ...embarques.flatMap((e) => [`tlmk_caja|${sucursal}|41|${e.serie}|${e.folio}`, `tlmk_fac_emb|${sucursal}|${e.serie}|${e.folio}`]),
  ];
}
