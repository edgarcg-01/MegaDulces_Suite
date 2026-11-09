/**
 * `[EMB.56]` La guía de reparto — la hoja de ruta del chofer. El contrato HTTP (ADR-052).
 *
 * La imprime y la lleva el chofer, y **el chofer no cobra** (sólo el vendedor): por eso aquí no
 * viaja NINGÚN importe. Lo que cobra el vendedor va por la Guía de Cobranza (`[GT]`).
 *
 * Endpoints (permiso `LOGISTICS_GUIA_REPARTO_VER`, recortados al alcance de sucursal):
 *   · `GET /logistics/guia-reparto/viajes?fecha=YYYY-MM-DD` → `GuiaRepartoViajes`
 *   · `GET /logistics/guia-reparto/:sucursal/:guia`          → `GuiaRepartoHoja`
 *
 * Fuentes, todas en vivo sobre `kepler_ods` (FASE_EMB §8):
 *   · el viaje = la guía de embarque `kdm1.c86`; la parada = cliente + domicilio de entrega;
 *   · el orden de visita = `kdm_rutas2.c4` (vía `c85` → `kdudent.c13`), el que imprime Kepler;
 *   · el domicilio = `kdudent` (⛔ NO `kdm1.c33/c34`, que es el FISCAL);
 *   · la factura = `U-D-8` cuyo back-pointer (`doc_origen`) es el embarque, sin canceladas.
 */

/** Qué pasa con la factura de un embarque. Un traspaso o una carga a ruta no se facturan. */
export type GuiaRepartoFacturaEstado = 'facturado' | 'sin_factura' | 'no_se_factura' | 'no_aplica';

/** Un documento `U-D-41` dentro de la parada, con su pedido y sus facturas vigentes. */
export interface GuiaRepartoDocumento {
  serie: number;
  embarque_folio: string;
  embarque_folio_digital: string;
  pedido_folio_digital: string | null;
  /** Facturas `U-D-8` vigentes (no canceladas) que salieron de este embarque. Todas, no la primera. */
  facturas: Array<{ folio: string; folio_digital: string }>;
  factura_estado: GuiaRepartoFacturaEstado;
  /** Cajas cerradas (CJA/BTO) de los renglones del embarque. null = sin renglones. */
  cajas: number | null;
  /**
   * Cajas de paquetería armadas por el checador (`PQ n` / `P n` en la nota de almacén). NO se
   * calculan: dependen de cómo se acomodó (FASE_GP §2.5). null = la nota no lo dice.
   */
  paquetes_nota: number | null;
  kg: number | null;
}

/** Una parada = un cliente en un domicilio de entrega. Puede llevar varios embarques. */
export interface GuiaRepartoParada {
  /** Posición en la hoja, 1..n. */
  numero: number;
  /** El número que Kepler da a la parada (`kdm_rutas2.c4`). null = Kepler no lo tiene. */
  orden_visita: number | null;
  cliente_code: string | null;
  cliente_nombre: string | null;
  domicilio_calle: string | null;
  domicilio_ciudad: string | null;
  domicilio_telefono: string | null;
  /** El embarque no traía domicilio (`c85` vacío) y se supuso el 1. Se dice. */
  domicilio_supuesto: boolean;
  ruta_nombre: string | null;
  /** La nota de almacén SIN el conteo `CJ n PQ n UB n` (los bultos van en sus campos). null = no hay. */
  instruccion: string | null;
  cajas: number;
  /** Suma de `paquetes_nota`. null = ninguna nota de la parada lo dice. */
  paquetes: number | null;
  /** Sólo de renglones vendidos por kilo. null = ninguno. */
  kg: number | null;
  documentos: GuiaRepartoDocumento[];
}

export interface GuiaRepartoResumen {
  paradas: number;
  documentos: number;
  cajas: number;
  paquetes: number | null;
  kg: number | null;
  /** Paradas sin orden de visita en Kepler: van al final, nunca intercaladas a ciegas. */
  sin_orden: number;
  /** Paradas cuyo domicilio no está en el catálogo de Kepler. */
  sin_domicilio: number;
  /** Embarques a cliente que deberían tener factura y todavía no la tienen. */
  sin_factura: number;
}

export interface GuiaRepartoHoja {
  viaje: {
    sucursal: string;
    sucursal_nombre: string | null;
    guia: string;
    guia_digital: string;
    fecha: string | null;
  };
  unidad: { kepler_code: string | null; descripcion: string | null; placas: string | null };
  /** El chofer que Kepler trae en el embarque. Casi siempre null: Kepler lo deja vacío. */
  chofer_kepler: string | null;
  paradas: GuiaRepartoParada[];
  resumen: GuiaRepartoResumen;
  procedencia: Record<string, string>;
}

/** Un viaje en la lista del chofer: lo justo para reconocer el suyo. Sin importes. */
export interface GuiaRepartoViaje {
  sucursal: string;
  guia: string;
  guia_digital: string;
  fecha: string | null;
  /** Clientes en un domicilio de entrega (las paradas de la hoja), NO embarques: uno puede llevar varios. */
  paradas: number;
  unidad_descripcion: string | null;
  unidad_placas: string | null;
  destinos_texto: string | null;
  /**
   * Por qué este viaje le sale a un chofer (null cuando la lista no se filtró por chofer):
   *  · `embarque` — almacén lo capturó como chofer en la salida por embarque (la fuente buena);
   *  · `unidad`   — el embarque no trae chofer y él es el asignado a la unidad. Respaldo: la unidad de
   *    Kepler no siempre es el camión que salió (FASE_EMB §8), así que se le dice.
   */
  asignado_por: 'embarque' | 'unidad' | null;
}

/**
 * Quién ve qué viaje (PM, 2026-11-09): **cada chofer, sólo los suyos**; quien ya ve embarques
 * (`LOGISTICS_SHIPMENTS_VER`), todos los de su alcance, para reimprimirle la guía al chofer.
 */
export interface GuiaRepartoFiltro {
  /** true = sólo los viajes del chofer que entró. */
  por_chofer: boolean;
  chofer_nombre: string | null;
  /**
   * Por qué un chofer no puede ver viajes, aunque los haya:
   *  · `sin_ficha_de_chofer` — su usuario no está ligado a una ficha del padrón de choferes;
   *  · `sin_clave_kepler` — su ficha no trae la clave de chofer de Kepler.
   * null = el filtro corrió (la lista puede salir vacía porque ese día no tiene viajes).
   */
  motivo: 'sin_ficha_de_chofer' | 'sin_clave_kepler' | null;
}

/** Cómo se pide la lista o la guía: todos los viajes del alcance, o sólo los de un usuario chofer. */
export type GuiaRepartoQuien = { todos: true } | { todos: false; user_id: string | null };

export interface GuiaRepartoViajes {
  fecha: string;
  rows: GuiaRepartoViaje[];
  filtro: GuiaRepartoFiltro;
}

/**
 * Buscar una guía por su número, para reimprimirla. El número es por sucursal: puede haber varios
 * viajes con el mismo (la `0000969` está en Padre Hidalgo y en CEDIS), y se muestran para escoger.
 * `guia` null = lo tecleado no es un número de guía.
 */
export interface GuiaRepartoBusqueda {
  guia: string | null;
  rows: GuiaRepartoViaje[];
  filtro: GuiaRepartoFiltro;
}

/**
 * Lo que se teclea → el número de guía como lo guarda Kepler (7 dígitos con ceros a la izquierda).
 * Liberal en la FORMA (Postel): «969», «0000969», «G-969», « 969 » dan lo mismo. Estricto en el
 * significado: sin dígitos, o con más de 7, no es una guía (null) y no se adivina.
 */
export function normalizarNumeroDeGuia(texto: string | null | undefined): string | null {
  const digitos = (texto ?? '').replace(/\D/g, '');
  if (!digitos || digitos.length > 7 || /^0+$/.test(digitos)) return null;
  return digitos.padStart(7, '0');
}

/** La parte del conteo de bultos que almacén escribe en la nota: `CJ 4`, `PQ 1`, `P 10`, `UB 3`. */
const CONTEO_DE_BULTOS = /\b(?:CJ|PQ|P|UB)\s*\d+\b/gi;

/**
 * Las cajas de paquetería que la nota dice (`PQ 9`, `P 10`; varias se suman). null = no lo dice.
 * Es lo que contó el checador, no un cálculo: se publica como «según almacén».
 */
export function paquetesDeLaNota(nota: string | null | undefined): number | null {
  if (!nota) return null;
  const ns = [...nota.matchAll(/\b(?:PQ|P)\s*(\d+)\b/gi)].map((m) => Number(m[1]));
  return ns.length ? ns.reduce((a, n) => a + n, 0) : null;
}

/**
 * La instrucción para el chofer = la nota de almacén sin el conteo de bultos. Lo demás se respeta
 * tal cual (`LAS VELAS SOLIDOS SON AZUL…`). Vacía después de limpiar → null.
 */
export function instruccionDeLaNota(nota: string | null | undefined): string | null {
  if (!nota) return null;
  const limpia = nota
    .replace(CONTEO_DE_BULTOS, ' ')
    .split('|')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');
  return limpia || null;
}
