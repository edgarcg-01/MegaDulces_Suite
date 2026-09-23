import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[MT.1]` — los drill-downs abren en otra pestaña.
 *
 * Qué invariante cuida: **el salto de una lista a su detalle es un `<a routerLink>`,
 * no un `(click)` sobre un `<tr>` o un `<button>`.** Sólo un ancla con `href` real
 * acepta Ctrl+clic, clic central, "Abrir en pestaña nueva" y preview de la URL al
 * pasar el mouse — que es lo único que hace posible trabajar con dos ventanas
 * (ADR-078). El clic de fila se conserva; el ancla es lo que se agrega.
 *
 * ⚠️ **Lo que esto NO prueba.** Es una compuerta sobre el FUENTE, del mismo tipo
 * que `landing-guards.spec.ts`: verifica la forma, no el comportamiento. Que el
 * ancla resuelva a la URL correcta, que `RouterLink` esté en los `imports` del
 * componente y que la expresión tipe, lo comprueba el **compilador de plantillas
 * de Angular en `nx build view`** — un componente standalone con `routerLink` sin
 * importar `RouterLink` no compila. Las dos mitades juntas son la cobertura; esta
 * sola no alcanza y por eso se dice.
 *
 * Existe porque el defecto se re-introduce sin querer: la forma cómoda de agregar
 * una lista es `<tr (click)="abrir(r)">`, y se ve idéntica en pantalla.
 */

const SRC = join(__dirname, '../../modules');

/** Los saltos convertidos, con la ruta que cada uno abre. */
const DRILLDOWNS: ReadonlyArray<{ archivo: string; ruta: string; que: string }> = [
  // lista → detalle
  { archivo: 'compras/pages/compras-ordenes.component.ts', ruta: "'/compras/ordenes', r.id", que: 'orden de compra' },
  { archivo: 'compras/pages/compras-requisiciones.component.ts', ruta: "'/compras/requisiciones', r.id", que: 'requisición' },
  { archivo: 'comercial/pages/comercial-orders.component.ts', ruta: "'/comercial/orders', o.id", que: 'pedido' },
  { archivo: 'comercial/pages/comercial-inventory-sessions.component.ts', ruta: "'/almacen/inventory/sessions', c.id", que: 'sesión de inventario' },
  { archivo: 'logistica/pages/logistica-shipments.component.ts', ruta: "'/logistica/shipments', s.id", que: 'embarque' },
  { archivo: 'comercial/pages/comercial-expiry-reviews.component.ts', ruta: 'r.id', que: 'revisión de caducidad' },
  // entre módulos: lo que se abre al lado para cotejar
  { archivo: 'finanzas/pages/finanzas-cartera.component.ts', ruta: "'/comercial/documentos'", que: 'documento desde cartera' },
  { archivo: 'compras/pages/compras-costo-neto.component.ts', ruta: "'/compras/descuentos'", que: 'descuentos desde costo neto' },
  { archivo: 'finanzas/pages/finanzas-pagos-comprobantes.component.ts', ruta: "'/compras/descuentos'", que: 'descuentos desde pagos' },
  { archivo: 'finanzas/pages/finanzas-solicitudes.component.ts', ruta: "'/finanzas/egresos/detalle'", que: 'gasto desde solicitudes' },
  { archivo: 'logistica/pages/logistica-auditoria-ruta.component.ts', ruta: "'/dashboard/routes'", que: 'historial de ruta' },
];

/** Los "Volver" de las pantallas de detalle: con clic central abren la lista al lado. */
const VOLVER: ReadonlyArray<{ archivo: string; ruta: string }> = [
  { archivo: 'compras/pages/compras-orden-detalle.component.ts', ruta: 'routerLink="/compras/ordenes"' },
  { archivo: 'compras/pages/compras-requisicion-detalle.component.ts', ruta: 'routerLink="/compras/requisiciones"' },
  { archivo: 'comercial/pages/comercial-egreso-detalle.component.ts', ruta: 'routerLink="/finanzas/egresos"' },
  { archivo: 'comercial/pages/comercial-expiry-review-detail.component.ts', ruta: 'routerLink=".."' },
];

const leer = (archivo: string) => readFileSync(join(SRC, archivo), 'utf8');

/** ¿Hay un `<a …[routerLink]…>` que apunte a esta ruta? */
function hayAnclaA(fuente: string, ruta: string): boolean {
  return new RegExp(`<a\\b[^>]*\\[routerLink\\]="\\[${escapar(ruta)}\\]"`).test(fuente);
}

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('[MT.1] los drill-downs son enlaces de verdad', () => {
  describe('lista → detalle y saltos entre módulos', () => {
    for (const d of DRILLDOWNS) {
      it(`${d.que}: abre con <a routerLink>, no con un click suelto`, () => {
        expect(hayAnclaA(leer(d.archivo), d.ruta)).toBe(true);
      });
    }
  });

  describe('los "Volver" de las pantallas de detalle', () => {
    for (const v of VOLVER) {
      it(`${v.archivo.split('/').pop()}: vuelve con un ancla`, () => {
        expect(new RegExp(`<a\\b[^>]*${escapar(v.ruta)}`).test(leer(v.archivo))).toBe(true);
      });
    }
  });

  /**
   * NEGATIVA — que la compuerta sepa ponerse roja.
   *
   * Sin esto, `hayAnclaA` podría estar mal escrita (un `.test()` que siempre da
   * true, una ruta que matchea de más) y las 15 de arriba se pondrían verdes sin
   * mirar nada. Se le da el fuente REAL con el ancla revertida a `<button>` —
   * exactamente la regresión que la compuerta existe para atrapar — y tiene que
   * fallar.
   */
  it('NEGATIVA: revertir un ancla a <button> pone la compuerta en rojo', () => {
    const real = leer('compras/pages/compras-ordenes.component.ts');
    expect(hayAnclaA(real, "'/compras/ordenes', r.id")).toBe(true);

    const revertido = real.replace(
      /<a class="surf-cell-link"([^>]*)>/,
      '<button type="button"$1>',
    );
    expect(revertido).not.toBe(real); // el sabotaje se aplicó de verdad
    expect(hayAnclaA(revertido, "'/compras/ordenes', r.id")).toBe(false);
  });

  /**
   * El ancla vive DENTRO de una fila que también navega, así que su clic tiene
   * que frenarse: sin `stopPropagation` el manejador de la fila corre igual y se
   * navega dos veces (y con `pSelectableRow`, además se selecciona).
   */
  it('el ancla dentro de una fila clickeable frena la propagación', () => {
    const conFila = [
      'compras/pages/compras-ordenes.component.ts',
      'compras/pages/compras-requisiciones.component.ts',
      'comercial/pages/comercial-orders.component.ts',
      'comercial/pages/comercial-inventory-sessions.component.ts',
      'logistica/pages/logistica-shipments.component.ts',
      'comercial/pages/comercial-expiry-reviews.component.ts',
      'compras/pages/compras-costo-neto.component.ts',
    ];
    const sinFreno = conFila.filter((f) => !/<a class="surf-cell-link"[^>]*\$event\.stopPropagation\(\)/.test(leer(f)));
    expect(sinFreno).toEqual([]);
  });
});
