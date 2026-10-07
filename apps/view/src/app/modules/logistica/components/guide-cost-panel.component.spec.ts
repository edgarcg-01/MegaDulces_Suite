import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { GuideCostPanelComponent } from './guide-cost-panel.component';
import { GuideCostList, GuideCostRow } from '../logistica.service';

/**
 * `[UIM.2]` — **La tabla de guías tiene que decir algo en un teléfono.**
 *
 * Nueve columnas de costo no entran en 390 px. La salida del repo es `.dt-scope` en el
 * contenedor + `.dt-stack` en la tabla: entonces cada celda baja como un renglón propio, con su
 * rótulo pintado por `::before { content: attr(data-label) }`.
 *
 * ── ⛔ Por qué esto necesita una prueba y no alcanza con `check:tables` ──────────────────────
 * Esa compuerta sólo mira que las dos CLASES aparezcan en el texto del archivo. No puede ver
 * dos cosas, y las dos pasaron de verdad acá:
 *
 *  1. **La clase puesta donde no llega al DOM.** `styleClass` en `<p-table>` lo retiró PrimeNG
 *     v22 (es lo que viene avisando `check:primeng`): se escribe, no falla, no advierte, y la
 *     clase nunca aparece en la página. El gate se ponía VERDE sobre una tabla que en el
 *     teléfono seguía igual de rota. Por eso `.dt-stack` va en `class=` del host.
 *  2. **Celdas sin rótulo.** Con las clases puestas y sin `data-label`, el teléfono muestra una
 *     columna de nueve valores pelados —sin decir cuál es el costo directo y cuál el
 *     prorrateado—, que es peor que el scroll horizontal.
 *
 * Y `role="cell"` no es adorno: al dejar de ser `display: table-cell`, la celda PIERDE su rol
 * implícito y el lector de pantalla encuentra filas sin celdas adentro.
 */

const guia = (over: Partial<GuideCostRow> = {}): GuideCostRow => ({
  dia: '2026-09-30',
  sucursal: '01',
  guia: 'G-0001',
  canal: 'cliente',
  paradas: 9,
  mercancia: 120000,
  costo: 4500,
  costo_directo: 3000,
  costo_prorrateado: 1500,
  costo_por_parada: 500,
  costo_estado: 'atribuido',
  costo_motivo: null,
  conceptos: 7,
  origen_peor: 'atribuido',
  pct_admin: 33,
  transporte_clave: 'T-1',
  unidades: 1,
  ...over,
});

const lista = (guias: GuideCostRow[]): GuideCostList => ({
  guias,
  totales: {
    guias: guias.length, guias_con_costo: guias.length, paradas: 9,
    costo: 4500, mercancia: 120000, costo_por_parada: 500,
    costo_directo: 3000, costo_prorrateado: 1500, pct_prorrateado: 33,
    mostradas: guias.length, truncado: false,
  },
  mercancia: { valor: 120000, naturaleza: 'movida', nota: 'Lo que vale lo movido.' },
  retorno: { erosion_pct: 3.75, pesos_movidos_por_peso_gastado: 26.6, nota: 'No es margen.' },
  cobertura: { measured: true, pct: 100, note: 'Todas las guías del rango.' },
  margen_declarado: { disponible: false, motivo: 'Falta el costo de la mercancía.', requiere: 'COGS por guía' },
});

function montar(filas: GuideCostRow[]) {
  TestBed.configureTestingModule({
    imports: [GuideCostPanelComponent],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(GuideCostPanelComponent);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges(); // dispara ngOnInit -> cargar()

  // Las dos peticiones salen juntas; se responden por URL y no por orden de llegada.
  http.expectOne((r) => r.url.endsWith('/erp-shipments/costs/filtros'))
    .flush({ conceptos: [], sucursales: [], unidades: [] });
  http.expectOne((r) => r.url.endsWith('/erp-shipments/costs')).flush(lista(filas));
  fixture.detectChanges();
  return { fixture, http, comp: fixture.componentInstance };
}

describe('[UIM.2] GuideCostPanelComponent · la tabla apila en teléfono', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
  });

  /**
   * ⚠️ `p-table` con `[scrollable]="true"` monta el cuerpo en un ciclo posterior: con un solo
   * `detectChanges()` el encabezado ya está y las FILAS todavía no.
   */
  it('monta y pinta la tabla (esto es lo que compila el template — tsc no lo hace)', async () => {
    const { fixture } = montar([guia()]);
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('G-0001');
  });

  it('⭐ el contenedor establece la consulta y la tabla declara que apila', async () => {
    const { fixture } = montar([guia()]);
    await fixture.whenStable();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // Sin `.dt-scope` la consulta de contenedor no tiene contra qué medir: el CSS es inerte.
    expect(host.querySelector('.gc-master.dt-scope')).toBeTruthy();
    // ⭐ NEGATIVA del defecto 1: la clase se busca EN EL DOM, no en el archivo. Si vuelve a
    //    escribirse como `styleClass` de <p-table>, esto da null y la prueba se pone roja.
    expect(host.querySelector('.dt-stack')).toBeTruthy();
  });

  it('⭐ cada celda baja CON su rótulo y con su rol', async () => {
    const { fixture } = montar([guia()]);
    await fixture.whenStable();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const celdas = Array.from(host.querySelectorAll('tbody > tr > td'));
    expect(celdas.length).toBe(9);
    for (const td of celdas) {
      expect(td.getAttribute('role')).toBe('cell');
      // `.dt-id` sube al tope sin rótulo: sucursal · guía se explica solo.
      expect(td.classList.contains('dt-id') || !!td.getAttribute('data-label')).toBe(true);
    }

    // Los rótulos son los del encabezado, no un invento: si alguien renombra una columna y
    // olvida el data-label, el teléfono rotula con el nombre viejo y nadie se entera.
    const encabezados = Array.from(host.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim());
    const rotulos = celdas.map((td) => td.getAttribute('data-label')).filter((x): x is string => !!x);
    expect(rotulos.length).toBe(8); // las 9 menos la identidad
    for (const r of rotulos) expect(encabezados).toContain(r);
  });

  /**
   * El apilado no puede cambiar lo que la pantalla AFIRMA. `costo === null` se sigue leyendo
   * "sin medir" y nunca `$0.00`: cero dice que el viaje fue gratis, no que nadie lo midió.
   */
  it('⛔ apilar no convierte «sin medir» en «$0.00»', async () => {
    const { fixture } = montar([guia({ costo: null, costo_estado: 'no_medido', costo_motivo: 'Sin pólizas en el canal-día' })]);
    await fixture.whenStable();
    fixture.detectChanges();
    const texto = (fixture.nativeElement as HTMLElement).textContent || '';
    expect(texto).toContain('sin medir');
  });
});
