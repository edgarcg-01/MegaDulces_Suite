import { construirMigas } from './layout-crumbs';

/**
 * `[MS.3.16]` La migaja deja volver. Antes sólo el espacio era enlace; estando en «Mesa de Servicio › Bandeja» no había forma de
 * regresar a la mesa sin abrir el menú.
 */
describe('[MS.3.16] construirMigas', () => {
  it('⭐ dentro de la Mesa de Servicio: el espacio vuelve a Mi trabajo y la MESA vuelve a su inicio', () => {
    const m = construirMigas('/servicio/bandeja');
    expect(m.map((x) => x.label)).toContain('Mesa de Servicio');
    const mesa = m.find((x) => x.label === 'Mesa de Servicio');
    expect(mesa?.link).toBe('/servicio');
    expect(mesa?.stay).toBe(false);
    expect(m[0].link).toBe('/projects');
    expect(m[0].stay).toBe(true);
  });

  it('también desde otras pantallas de la mesa (reportes, configuración)', () => {
    for (const u of ['/servicio/reportes', '/servicio/configuracion', '/servicio/solicitudes']) {
      expect(construirMigas(u).find((x) => x.label === 'Mesa de Servicio')?.link).toBe('/servicio');
    }
  });

  it('el enlace no depende de la query ni del fragmento', () => {
    expect(construirMigas('/servicio/bandeja?scope=mine&id=abc#x').find((x) => x.label === 'Mesa de Servicio')?.link).toBe('/servicio');
  });

  it('no repite un eslabón cuando espacio y proyecto se llaman igual', () => {
    const m = construirMigas('/administracion/usuarios');
    const etiquetas = m.map((x) => x.label);
    expect(new Set(etiquetas).size).toBe(etiquetas.length);
  });

  it('⛔ NEGATIVA — una URL fuera del mapa no inventa un enlace', () => {
    const m = construirMigas('/ruta-que-no-existe');
    for (const x of m) if (x.stay === false) expect(x.link).toBeNull();
  });
});

/**
 * `[AUD-A5]` El eslabón con `aria-current="page"` tiene que nombrar la pantalla en la que estás.
 *
 * Medido en prod el 2026-10-20: en `/comercial/comisiones` la migaja decía
 * «Comercial / Ventas / **Ventas por ruta**» — el nombre de OTRA pestaña del mismo sub-módulo.
 * La causa estaba en el ítem del sidebar, que se llamaba como su primera pestaña.
 *
 * ⚠️ `construirMigas` NO produce ese eslabón: lo pinta el layout con `currentPageTitle()`. Lo
 * que este bloque fija es la parte que sí le toca —que el proyecto resuelva— más la **prueba
 * negativa** de que el sub-módulo no se llame como una de sus partes, que es lo que falló.
 */
