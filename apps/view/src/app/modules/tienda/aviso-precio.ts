import type { PriceChangeNoticeDto } from '@megadulces/contracts';

/**
 * `[ETQ-AVISOS.2]` Cómo se lee en la campana un aviso de cambios de precio.
 *
 * Función pura (el reloj entra por parámetro) para poder probar el texto sin tocar la hora del
 * sistema: «ayer» y «hoy» son lo que decide si el aviso se lee como urgente o como historia.
 */
export interface AvisoPrecio {
  title: string;
  message: string;
  severity: 'info' | 'warn';
  route: string;
}

/** Un día (`YYYY-MM-DD`) en hora de México. */
function diaMx(ahora: Date, offset: number): string {
  const d = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const dia = (fecha: string, ahora: Date): string =>
  fecha === diaMx(ahora, 0) ? 'hoy' : fecha === diaMx(ahora, -1) ? 'ayer' : `el ${fecha}`;

export function avisoDePrecio(n: PriceChangeNoticeDto, ahora: Date = new Date()): AvisoPrecio {
  const tienda = n.plaza_nombre || `Tienda ${n.plaza}`;
  const cuando = dia(n.fecha, ahora);
  const uno = n.productos === 1;
  // Un precio que el ERP dejó en blanco es lo único que hace que la etiqueta salga SIN PRECIO: sube la urgencia.
  const severity = n.sin_precio > 0 ? 'warn' : 'info';
  const route = `/tienda/etiquetas/cambios?plaza=${encodeURIComponent(n.plaza)}&fecha=${encodeURIComponent(n.fecha)}`;

  if (n.origen === 'compras') {
    const nota = n.nota ? ` «${n.nota}»` : '';
    return {
      title: `Compras te mandó los cambios de precio · ${tienda}`,
      message: `${n.enviado_por || 'Compras'}: ${n.productos} ${uno ? 'producto' : 'productos'} de ${cuando}.${nota}`,
      severity,
      route,
    };
  }

  const detalle = [
    n.suben ? `${n.suben} ${n.suben === 1 ? 'sube' : 'suben'}` : '',
    n.bajan ? `${n.bajan} ${n.bajan === 1 ? 'baja' : 'bajan'}` : '',
    n.sin_precio ? `${n.sin_precio} sin precio` : '',
  ].filter(Boolean).join(', ');
  return {
    title: `Cambios de precio · ${tienda}`,
    message: `${n.productos} ${uno ? 'producto cambió' : 'productos cambiaron'} de precio ${cuando} (${detalle}). Revisa qué etiquetas reimprimir.`,
    severity,
    route,
  };
}
