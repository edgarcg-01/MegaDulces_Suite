import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MessageService, ConfirmationService } from 'primeng/api';
import { NEVER, of } from 'rxjs';
import { ComercialInventoryAbcComponent } from './comercial-inventory-abc.component';
import { ComercialService } from '../comercial.service';

/**
 * `[IC.24]` La selección del conteo — y **la compuerta que faltaba**.
 *
 * ⛔ **Nada local atrapa un error de TIPO en una plantilla de Angular.** `check:templates` valida
 * que el literal esté entero y que el CSS parsee; `tsc -p apps/view/tsconfig.app.json` **no mira
 * plantillas**; y `nx build` —el único que corre `strictTemplates`— está prohibido en local. Esta
 * pantalla se entregó con `$event.data` tipado como `T | T[] | undefined` (PrimeNG lo declara así
 * porque `[(selection)]` admite single y múltiple) y **las tres compuertas locales dieron verde**.
 * Lo encontró el CI.
 *
 * ⚠️ **Y montar el componente NO cierra ese hueco**, aunque lo parezca: se midió. El `TestBed`
 * compila la plantilla en JIT, así que atrapa errores de *binding* y de sintaxis, pero **no**
 * aplica `strictTemplates`. Mutando la firma de `abrirDetalle` de vuelta a la estrecha, la prueba
 * de «monta» **siguió en verde** y sólo se pusieron rojas las tres negativas de abajo. O sea: lo
 * que protege acá es el **comportamiento**, no el tipo. El tipo lo sigue atrapando sólo el CI, y
 * eso queda **declarado como hueco**, no tapado con una prueba que no lo cubre.
 *
 * Lo que sí se vigila: `abrirDetalle` estrecha la unión con una **guarda**, no con un `as`. Un
 * cast habría compilado y, el día que alguien ponga `selectionMode="multiple"`, la ficha mostraría
 * el porqué de un **arreglo** — o sea `undefined` en cada campo, que en pantalla se lee como
 * «este producto no tiene historia».
 */
describe('ComercialInventoryAbcComponent · [IC.24] la selección del conteo', () => {
  const SVC = {
    listWarehouses: () => of([]),
    abcSummary: () => NEVER,
    listAbc: () => NEVER,
    cycleDue: () => NEVER,
    countSelection: () => NEVER,
    countSelectionDetail: () => NEVER,
    refreshAbc: () => NEVER,
    generateCycleFolios: () => NEVER,
  };

  async function montar() {
    await TestBed.configureTestingModule({
      imports: [ComercialInventoryAbcComponent],
      providers: [
        provideRouter([]),
        MessageService,
        ConfirmationService,
        { provide: ComercialService, useValue: SVC },
      ],
    }).compileComponents();
    const fix = TestBed.createComponent(ComercialInventoryAbcComponent);
    fix.detectChanges();
    return fix;
  }

  // ⚠️ Esto NO es la compuerta de tipos — se midió que no lo es (ver la cabecera). Sirve para que
  //    un binding roto o una directiva sin importar se caigan acá y no en el CI.
  it('la plantilla compila en JIT (atrapa bindings rotos, NO tipos: ver la cabecera)', async () => {
    const fix = await montar();
    expect(fix.componentInstance).toBeTruthy();
  });

  it('abre en la selección: es la pregunta operativa, no el catálogo', async () => {
    const fix = await montar();
    expect(fix.componentInstance.view()).toBe('seleccion');
    expect(fix.componentInstance.views[0].value).toBe('seleccion');
  });

  describe('abrirDetalle · la unión que PrimeNG entrega', () => {
    const fila = { product_id: 'p1', sku: 'X', nombre: 'Producto' } as never;

    it('con una fila, abre su ficha', async () => {
      const fix = await montar();
      fix.componentInstance.abrirDetalle(fila);
      expect(fix.componentInstance.detalleDe()?.product_id).toBe('p1');
    });

    // PRUEBA NEGATIVA 1 — `undefined` llega de verdad: PrimeNG lo declara en el tipo del evento.
    it('NEGATIVA: con `undefined` NO deja la ficha anterior en pantalla', async () => {
      const fix = await montar();
      fix.componentInstance.abrirDetalle(fila);
      fix.componentInstance.abrirDetalle(undefined);
      expect(fix.componentInstance.detalleDe()).toBeNull();
      expect(fix.componentInstance.detalle()).toBeNull();
    });

    // PRUEBA NEGATIVA 2 — el día que alguien ponga `selectionMode="multiple"`, esto sigue
    // mostrando una ficha real y no los campos vacíos de un arreglo.
    it('NEGATIVA: con un ARREGLO toma la primera fila, no el arreglo', async () => {
      const fix = await montar();
      fix.componentInstance.abrirDetalle([fila] as never);
      expect(fix.componentInstance.detalleDe()?.product_id).toBe('p1');
    });

    it('NEGATIVA: con un arreglo VACÍO no inventa una ficha', async () => {
      const fix = await montar();
      fix.componentInstance.abrirDetalle(fila);
      fix.componentInstance.abrirDetalle([] as never);
      expect(fix.componentInstance.detalleDe()).toBeNull();
    });
  });

  /**
   * Medido en Padre Hidalgo: el sobrante carga **3.4× el dinero de la merma** ($4,246,558 contra
   * $1,248,543). Es producto que está y el sistema no sabe — no es una buena noticia, y pintarlo
   * en verde enseñaría a pasarlo de largo.
   */
  it('`sobra` NO se pinta como algo bueno', async () => {
    const fix = await montar();
    const sev = fix.componentInstance.sevPatron('sobra');
    expect(sev).not.toBe('success');
    expect(sev).toBe('warn');
    expect(fix.componentInstance.sevPatron('merma')).toBe('danger');
    // Y la ausencia de patrón no se confunde con un patrón.
    expect(fix.componentInstance.sevPatron(null)).toBe('secondary');
  });
});
