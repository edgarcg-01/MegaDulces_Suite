import {
  ALMACEN_AREAS,
  ANALISIS_BI_TAB,
  almacenLandingCandidates,
  almacenTabsForUrl,
} from './almacen-tabs';

/**
 * El tab de **Análisis BI** cruza las áreas: se alcanza desde cualquier pantalla
 * del almacén sin volver al sidebar. Las aserciones de acá son las cuatro formas
 * en que ese cruce puede salir mal, cada una con su prueba negativa.
 */
describe('almacen-tabs · el tab de Análisis BI cruza las áreas', () => {
  const esBi = (t: { route: string }) => t.route === ANALISIS_BI_TAB.route;

  /** Una URL representativa por área visible — las que un rol abre de verdad. */
  const URLS_POR_AREA: Record<string, string> = {
    inventario: '/almacen/inventory/existencia',
    conteo: '/almacen/inventory/sessions',
    control: '/almacen/cuadre',
    entrada: '/almacen/inventory/recepcion-sesiones',
  };

  for (const [area, url] of Object.entries(URLS_POR_AREA)) {
    it(`${area}: la barra termina en Análisis BI`, () => {
      const tabs = almacenTabsForUrl(url);
      expect(tabs.filter(esBi).length).toBe(1);
      expect(tabs[tabs.length - 1]).toEqual(ANALISIS_BI_TAB);
    });
  }

  it('el área de BI NO lo repite: su propia pantalla (Panorama) ya está', () => {
    const tabs = almacenTabsForUrl('/almacen/analisis-bi');
    expect(tabs.filter(esBi).length).toBe(1);
    expect(tabs.length).toBe(1);
  });

  // Prueba negativa 1 — sin esto, el operario ve una barra a media tarima.
  it('las pantallas de FOCO siguen sin barra', () => {
    for (const url of ['/almacen/anden', '/almacen/inventory/count']) {
      expect(almacenTabsForUrl(url)).toEqual([]);
    }
  });

  // Prueba negativa 2 — una URL fuera de toda área no estrena barra de un solo tab.
  it('una URL sin área no devuelve barra', () => {
    expect(almacenTabsForUrl('/almacen/movimientos')).toEqual([]);
  });

  // Prueba negativa 3 — la razón por la que BI NO vive dentro de `area.tabs`: si
  // viviera ahí, un rol con sólo ALMACEN_BI_VER haría que el item "Inventario" del
  // sidebar aterrizara en /almacen/analisis-bi, duplicando el item de BI.
  it('BI no es candidata de aterrizaje de ningún área ajena', () => {
    for (const area of ALMACEN_AREAS) {
      if (area.key === 'analisis-bi') continue;
      expect(almacenLandingCandidates(area).some(esBi)).toBe(false);
    }
  });
});
