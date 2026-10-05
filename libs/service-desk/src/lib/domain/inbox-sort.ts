/**
 * `[MS.3.16]` El orden de la bandeja de atención, elegido por quien la mira. Funciones puras.
 *
 * El orden por omisión sigue siendo el de siempre —prioridad → vencimiento → antigüedad— porque es el que pone arriba
 * lo que hay que atender. Esto sólo agrega que se pueda **ordenar por una columna**, y se hace en el SERVIDOR, no en la
 * pantalla: la bandeja trae a lo más 100 de N solicitudes, y ordenar en el cliente esa porción diría «la más vieja» sobre
 * 100 filas que no son las más viejas.
 *
 * ⛔ **Lista cerrada.** El nombre de la columna llega por la URL y se arma dentro de un `ORDER BY` en crudo (Knex no
 * parametriza identificadores de orden), así que sólo se acepta lo que está en `COLUMNAS_ORDEN`; cualquier otra cosa es 400,
 * nunca se concatena. Lo mismo la dirección.
 *
 * Los vacíos (`NULL`) van SIEMPRE al final, ascendente o descendente: «sin ubicación» o «sin plazo» no es lo más chico ni lo
 * más grande, es la ausencia de dato, y que salga primero al invertir el orden esconde lo que sí tiene dato.
 *
 * Y el desempate es fijo (antigüedad, luego id): dos solicitudes iguales en la columna no cambian de lugar entre una carga y
 * la siguiente, que es lo que haría que la lista «baile» al refrescarla.
 */

export const COLUMNAS_ORDEN = ['folio', 'solicitud', 'reporto', 'ubicacion', 'prioridad', 'estado', 'atiende', 'plazo', 'alta'] as const;
export type ColumnaOrden = (typeof COLUMNAS_ORDEN)[number];
export type Direccion = 'asc' | 'desc';

export type ResultadoOrden =
  | { ok: true; columna: ColumnaOrden | null; direccion: Direccion }
  | { ok: false; motivo: string };

/** Valida lo que llega por la URL. Sin `sort` no hay orden elegido (`columna: null`) y manda el de siempre. */
export function validarOrden(sort: string | undefined, dir: string | undefined): ResultadoOrden {
  const s = (sort ?? '').trim();
  const d = (dir ?? '').trim().toLowerCase();
  if (d && d !== 'asc' && d !== 'desc') return { ok: false, motivo: 'dir debe ser asc o desc' };
  if (!s) return { ok: true, columna: null, direccion: 'asc' };
  if (!(COLUMNAS_ORDEN as readonly string[]).includes(s)) return { ok: false, motivo: `sort debe ser uno de: ${COLUMNAS_ORDEN.join(', ')}` };
  return { ok: true, columna: s as ColumnaOrden, direccion: (d || 'asc') as Direccion };
}

/** Prioridad como número: urgente 3 … baja 0 (ascendente = de menos a más urgente). */
const RANGO_PRIORIDAD = `CASE r.priority WHEN 'urgente' THEN 3 WHEN 'alta' THEN 2 WHEN 'media' THEN 1 ELSE 0 END`;
/** Estado en el orden en que vive un ticket. */
const RANGO_ESTADO = `CASE r.status WHEN 'nuevo' THEN 0 WHEN 'asignado' THEN 1 WHEN 'en_proceso' THEN 2 WHEN 'en_espera' THEN 3 WHEN 'resuelto' THEN 4 WHEN 'cerrado' THEN 5 ELSE 6 END`;

/**
 * La ubicación se ordena por lo que la pantalla MUESTRA («8 Esquinas», «Oficinas Corporativas»), no por su código («03», «OF»):
 * ordenar por código deja «La Piedad» antes de «8 Esquinas» y la columna parece desordenada. Los nombres vienen de constantes del
 * código (no del usuario) y aun así se escapan; un código sin nombre cae a sí mismo.
 */
const sql = (t: string): string => `'${t.replace(/'/g, "''")}'`;
function rangoUbicacion(nombres: Readonly<Record<string, string>>): string {
  const casos = Object.entries(nombres).map(([c, n]) => `WHEN ${sql(c)} THEN ${sql(n.toLowerCase())}`);
  return casos.length ? `CASE r.warehouse_code ${casos.join(' ')} ELSE lower(r.warehouse_code) END` : 'r.warehouse_code';
}

/**
 * Los fragmentos de `ORDER BY` para una columna, en crudo. SÓLO se llama con una columna ya validada (`ColumnaOrden`):
 * el tipo lo exige y `validarOrden` es quien lo produce.
 */
export function clausulasOrden(columna: ColumnaOrden, direccion: Direccion, nombresUbicacion: Readonly<Record<string, string>> = {}): string[] {
  const D = direccion === 'desc' ? 'DESC' : 'ASC';
  const principal: Record<ColumnaOrden, string> = {
    folio: `r.folio ${D}`,
    solicitud: `lower(r.title) ${D}`,
    reporto: `lower(coalesce(r.requester_name, '')) ${D}`,
    ubicacion: `${rangoUbicacion(nombresUbicacion)} ${D} NULLS LAST`,
    prioridad: `${RANGO_PRIORIDAD} ${D}`,
    estado: `${RANGO_ESTADO} ${D}`,
    atiende: `lower(coalesce(ua.nombre, ua.username)) ${D} NULLS LAST`,
    plazo: `r.due_at ${D} NULLS LAST`,
    alta: `r.created_at ${D}`,
  };
  // Desempate fijo: la antigüedad y, si aun así empatan, el id (la lista no baila entre cargas).
  return [principal[columna], 'r.created_at ASC', 'r.id ASC'];
}

/** La primera dirección que se prueba al pulsar una columna: lo que casi siempre se quiere ver primero. */
export function direccionInicial(columna: ColumnaOrden): Direccion {
  return columna === 'prioridad' || columna === 'alta' ? 'desc' : 'asc';
}
