import { warehouseName, type AutoabastoVieneDoc, type ConsolaSurtidoResponse } from '@megadulces/contracts';
import type { EntradaRow } from '../compras/entradas.service';

/**
 * `[AB.44]` «Pendientes de la sucursal» — la parte pura: qué cuenta como pendiente DE LA SUCURSAL, en
 * qué orden y qué dice el veredicto. La pantalla lee los endpoints dueños; esto decide.
 *
 * Pendiente = algo que la propia sucursal tiene que HACER. Lo que espera a otra área (una requisición
 * por aprobar, un pedido de traspaso que la matriz todavía no embarca) se ve, pero no suma.
 */

export type SeccionId = 'llega' | 'entradas' | 'surtido';

/** Los cuatro estados de una sección. Ninguno se confunde con «cero». */
export type EstadoSeccion<T> =
  | { estado: 'sin_permiso' }
  | { estado: 'cargando' }
  | { estado: 'error'; mensaje: string }
  | { estado: 'ok'; data: T };

export interface Pendiente {
  /** Llave estable para `track`. */
  clave: string;
  /** Qué es, en palabras de la sucursal. */
  titulo: string;
  /** Folio o identificador que se busca en Kepler o en la Suite. */
  folio: string;
  /** De quién viene o de qué se trata (origen, proveedor, destinos). */
  detalle: string;
  /** Días esperando. `null` = sin fecha. */
  dias: number | null;
  /** Importe, si el documento lo trae. */
  monto: number | null;
  /** Qué hacer, en una frase. */
  accion: string;
}

export interface Seccion {
  id: SeccionId;
  titulo: string;
  /** Dónde se resuelve: la pantalla que abre el botón de la sección. */
  ruta: string;
  queryParams?: Record<string, string>;
  rutaLabel: string;
  pendientes: Pendiente[];
  /** Lo que se ve pero no es trabajo de la sucursal (espera a otra área). Una línea, no filas. */
  informativo: string | null;
  /** Cuántos hay en total, cuando la lista vino recortada (entradas pagina). */
  total: number;
}

const DIA_MS = 86_400_000;

/** `AAAA-MM-DD` de hoy en hora de México. */
export function hoyMx(ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
}

/** Días entre dos fechas `AAAA-MM-DD` (o ISO: se toma el día en México). `null` si falta una. */
export function diasEntre(desde: string | null | undefined, hoy: string): number | null {
  if (!desde) return null;
  const d = desde.length > 10 ? hoyMx(new Date(desde)) : desde;
  const a = Date.parse(`${d}T00:00:00Z`);
  const b = Date.parse(`${hoy}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / DIA_MS));
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

/**
 * Lo que te va a llegar. Pendiente de la sucursal:
 *  · el EMBARQUE sin su recepción en Kepler (`U-A-50`): la mercancía salió hacia ti y Kepler no la
 *    tiene recibida. Se captura allá (la Suite no escribe en Kepler);
 *  · la requisición que Compras RECHAZÓ: hay que leer el motivo y decidir.
 * Lo demás (pedido abierto en la matriz, plan de Compras, requisición por aprobar o aprobada) espera a
 * otra área: se resume en una línea.
 */
export function seccionLlega(documentos: AutoabastoVieneDoc[]): Seccion {
  const pendientes: Pendiente[] = [];
  let pedidos = 0;
  let conCompras = 0;
  for (const d of documentos) {
    if (d.tipo === 'embarque') {
      pendientes.push({
        clave: `emb:${d.origen}:${d.serie}:${d.folio}`,
        titulo: 'Traspaso sin recibir en Kepler',
        folio: d.folio,
        detalle: `De ${warehouseName(d.origen) || 'una sucursal sin nombre'} · ${plural(d.renglones, 'producto', 'productos')}`,
        dias: d.dias,
        monto: d.monto,
        accion: 'Captura la recepción en Kepler',
      });
    } else if (d.tipo === 'requisicion' && d.estado === 'RECHAZADA') {
      pendientes.push({
        clave: `req:${d.id ?? d.folio}`,
        titulo: 'Compras rechazó tu requisición',
        folio: d.folio,
        detalle: d.motivo ? `Motivo: ${d.motivo}` : 'Compras no escribió el motivo',
        dias: d.dias,
        monto: d.monto,
        accion: 'Revisa el motivo y vuelve a pedir si hace falta',
      });
    } else if (d.tipo === 'pedido') {
      pedidos++;
    } else {
      conCompras++;
    }
  }
  const partes: string[] = [];
  if (pedidos) partes.push(`${plural(pedidos, 'pedido de traspaso', 'pedidos de traspaso')} en la matriz, sin embarcar`);
  if (conCompras) partes.push(`${plural(conCompras, 'requisición', 'requisiciones')} con Compras`);
  return {
    id: 'llega',
    titulo: 'Lo que te va a llegar',
    ruta: '/almacen/autoabasto',
    rutaLabel: 'Abrir Autoabasto',
    pendientes: ordenar(pendientes),
    informativo: partes.length ? `Además, esperando a otra área: ${partes.join(' · ')}.` : null,
    total: pendientes.length,
  };
}

/**
 * Entradas sin comprobante: la orden de entrada de Kepler sin la remisión subida. `total` es el del
 * servidor (lo filtrado), no el de la página: si la lista vino recortada, la sección lo dice.
 */
export function seccionEntradas(rows: EntradaRow[], total: number, hoy: string, sucursal: string | null, desde: string): Seccion {
  const pendientes = rows.map((r) => ({
    clave: `ent:${r.sucursal}:${r.folio}`,
    titulo: 'Entrada sin comprobante',
    folio: r.folio,
    detalle: r.proveedor_nombre || r.proveedor_code || 'Proveedor sin nombre',
    dias: diasEntre(r.receipt_date, hoy),
    monto: r.monto == null ? null : Number(r.monto),
    accion: 'Sube la remisión',
  }));
  return {
    id: 'entradas',
    titulo: 'Entradas sin comprobante',
    ruta: '/compras/entradas',
    // El mismo universo que se contó aquí: sucursal, sin comprobante y la misma ventana.
    queryParams: { ...(sucursal ? { suc: sucursal } : {}), estado: 'pendiente', from: desde },
    rutaLabel: 'Abrir Entradas',
    pendientes: ordenar(pendientes),
    informativo: null,
    total: Math.max(total, pendientes.length),
  };
}

/** Surtidos: las olas abiertas o en surtido, y los pedidos autorizados en Kepler que nadie ha armado. */
export function seccionSurtido(c: ConsolaSurtidoResponse, hoy: string): Seccion {
  const pendientes = c.olas
    .filter((o) => o.status === 'abierta' || o.status === 'en_surtido')
    .map((o) => ({
      clave: `ola:${o.id}`,
      titulo: o.status === 'en_surtido' ? 'Surtido a medias' : 'Surtido sin empezar',
      folio: o.code,
      detalle: [
        o.prioridad === 1 ? 'Urgente' : null,
        o.destinos.length ? `Para ${o.destinos.join(', ')}` : null,
        o.assigned_nombre ? `Lo trae ${o.assigned_nombre}` : 'Nadie lo ha tomado',
      ].filter(Boolean).join(' · '),
      dias: diasEntre(o.created_at, hoy),
      monto: null,
      accion: o.status === 'en_surtido' ? 'Termínalo o libéralo' : 'Asígnalo o tómalo',
    }));
  const porArmar = c.por_armar?.pedidos ?? 0;
  return {
    id: 'surtido',
    titulo: 'Surtidos',
    ruta: '/almacen/surtido-consola',
    rutaLabel: 'Abrir la consola de surtido',
    pendientes: ordenar(pendientes),
    informativo: porArmar ? `Además, ${plural(porArmar, 'pedido autorizado', 'pedidos autorizados')} en Kepler sin armar en un surtido.` : null,
    total: pendientes.length,
  };
}

/** Lo más viejo primero: lo que lleva más días esperando es lo que más urge. Sin fecha, al final. */
function ordenar(p: Pendiente[]): Pendiente[] {
  return [...p].sort((a, b) => (b.dias ?? -1) - (a.dias ?? -1) || a.folio.localeCompare(b.folio));
}

/** Días del pendiente más viejo de una sección. `null` = no tiene pendientes con fecha. */
export function masViejo(s: Seccion): number | null {
  return s.pendientes.reduce<number | null>((m, p) => (p.dias != null && (m == null || p.dias > m) ? p.dias : m), null);
}

/** Las secciones con pendientes primero, ordenadas por su pendiente más viejo; las que están al día, abajo. */
export function ordenarSecciones(s: Seccion[]): Seccion[] {
  return [...s].sort((a, b) => (b.total > 0 ? 1 : 0) - (a.total > 0 ? 1 : 0) || (masViejo(b) ?? -1) - (masViejo(a) ?? -1));
}

export interface Veredicto {
  /** Pendientes de la sucursal en las secciones que se pudieron leer. */
  total: number;
  /** Días del más viejo. */
  masViejo: number | null;
  /** Secciones que la persona ve y no se pudieron leer: el total NO las incluye. */
  sinLeer: number;
  /** Secciones que todavía cargan. */
  cargando: number;
}

export function veredicto(estados: EstadoSeccion<Seccion>[]): Veredicto {
  let total = 0;
  let viejo: number | null = null;
  let sinLeer = 0;
  let cargando = 0;
  for (const e of estados) {
    if (e.estado === 'error') sinLeer++;
    else if (e.estado === 'cargando') cargando++;
    else if (e.estado === 'ok') {
      total += e.data.total;
      const v = masViejo(e.data);
      if (v != null && (viejo == null || v > viejo)) viejo = v;
    }
  }
  return { total, masViejo: viejo, sinLeer, cargando };
}
