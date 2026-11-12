/**
 * `[PGP.110b]` **Lo que la ingesta manda en UN insert, sin llaves repetidas.**
 *
 * Un `INSERT … ON CONFLICT DO UPDATE` no admite la misma llave dos veces en el mismo comando:
 * Postgres aborta el comando entero («ON CONFLICT DO UPDATE command cannot affect row a second
 * time»). Desde `[PGP.23]` las ligas del REP se guardan con `.merge()`, y desde ese día un solo REP
 * con la llave repetida tumbaba su lote **y el resto del paquete**.
 *
 * ⛔ Medido en prod el 2026-11-11: la descarga de recibidas del 27-oct anunció 16,845 CFDI y dejó
 * 650 en la base. Sus 5 paquetes terminaron en error, y cada uno tenía exactamente UN REP que
 * relaciona varios documentos con `IdDocumento` en ceros y parcialidad 1. Los 166 REP del lote que
 * se cayó quedaron guardados SIN sus ligas (CFDI y ligas iban en transacciones distintas), y el
 * reintento del job volvió a pedir el paquete al SAT, que lo negó por «Máximo de descargas».
 */

/** Un `IdDocumento` en ceros no identifica ninguna factura: no hay con qué ligarlo. */
export const UUID_EN_CEROS = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

/** La llave única de `fiscal.cfdi_payment_links` (tenant, REP, documento, parcialidad). */
export interface LlaveDeLiga {
  tenant_id: string;
  rep_uuid: string;
  docto_uuid: string | null;
  num_parcialidad: number;
}

/** La llave tal como la compara la restricción UNIQUE de la tabla (texto exacto). */
export function llaveDeLiga(f: LlaveDeLiga): string {
  return `${f.tenant_id}|${f.rep_uuid}|${f.docto_uuid}|${f.num_parcialidad}`;
}

/**
 * Las ligas que sí se pueden insertar juntas: fuera las que no dicen a qué documento pagan (vacío o
 * en ceros) y, de una llave repetida, la primera. Devuelve cuántas quitó de cada clase para que la
 * ingesta lo DECLARE en su log en vez de perderlas en silencio.
 */
export function ligasParaInsertar<T extends LlaveDeLiga>(filas: readonly T[]): { ligas: T[]; sinDocumento: number; repetidas: number } {
  const vistas = new Set<string>();
  const ligas: T[] = [];
  let sinDocumento = 0;
  let repetidas = 0;
  for (const f of filas) {
    if (!f.docto_uuid || UUID_EN_CEROS.test(f.docto_uuid)) { sinDocumento++; continue; }
    const k = llaveDeLiga(f);
    if (vistas.has(k)) { repetidas++; continue; }
    vistas.add(k);
    ligas.push(f);
  }
  return { ligas, sinDocumento, repetidas };
}

/**
 * Los CFDI de un lote, uno por `(tenant, uuid)`: el mismo choque aplica al `merge(['xml'])` de
 * `fiscal.cfdis` si un ZIP trae el mismo comprobante dos veces. Gana el último (es el mismo XML).
 */
export function cfdisUnicos<T extends { tenant_id: string; uuid: string }>(filas: readonly T[]): { cfdis: T[]; repetidos: number } {
  const porLlave = new Map<string, T>();
  for (const f of filas) porLlave.set(`${f.tenant_id}|${f.uuid}`, f);
  return { cfdis: [...porLlave.values()], repetidos: filas.length - porLlave.size };
}
