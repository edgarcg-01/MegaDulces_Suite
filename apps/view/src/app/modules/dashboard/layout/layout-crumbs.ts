import { LANDING_ROUTE, entryLabel, resolveProjectForUrl, resolveSpaceForUrl } from '../../../core/constants/suite-map';

/** Un eslabón de la migaja. `link` es null cuando no hay a dónde volver (se pinta como texto). */
export interface Miga {
  label: string;
  link: string | null;
  /** El espacio vuelve a «Mi trabajo» con `stay`: una persona con una sola puerta también puede regresar a elegir. */
  stay: boolean;
}

/**
 * `[SN.4]` / `[MS.3.16]` La migaja sin la página: Espacio › Proyecto.
 *
 * Antes sólo el espacio era enlace; el proyecto («Mesa de Servicio», «Ventas»…) era texto, y estando dentro de una pantalla
 * del proyecto no había forma de volver a su inicio sin abrir el menú. Ahora el proyecto enlaza a su ruta raíz (que cada
 * proyecto resuelve con su guard de aterrizaje: la Mesa manda a la bandeja a quien atiende y a «Mis solicitudes» al resto).
 *
 * - Se deduplican las etiquetas iguales (Configuración de la suite es espacio y proyecto a la vez): queda el eslabón del
 *   espacio, que lleva a Mi trabajo.
 * - Un proyecto fuera del mapa de la suite (la etiqueta de siempre, «Trade Marketing») NO se inventa como enlace.
 */
export function construirMigas(url: string): Miga[] {
  const enMapa = resolveSpaceForUrl(url);
  const proyecto = resolveProjectForUrl(url);
  const espacio = enMapa?.space.label ?? null;
  const etiquetaProyecto = enMapa ? entryLabel(enMapa.entry) : (proyecto?.label ?? 'Trade Marketing');

  const out: Miga[] = [];
  if (espacio) out.push({ label: espacio, link: LANDING_ROUTE, stay: true });
  if (etiquetaProyecto && out[out.length - 1]?.label !== etiquetaProyecto) {
    out.push({ label: etiquetaProyecto, link: proyecto?.route || null, stay: false });
  }
  return out;
}
