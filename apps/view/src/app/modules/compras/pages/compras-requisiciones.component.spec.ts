import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ComprasRequisicionesComponent } from './compras-requisiciones.component';
import { ComprasService } from '../compras.service';
import { MultitareaService } from '../../../core/services/multitarea.service';

/**
 * `[MT.1]` + `[MT.3]` — la cadena completa, renderizada.
 *
 * Por qué hace falta ADEMÁS de lo que ya hay. `drilldown-links.spec` mira el
 * FUENTE (hay un `<a routerLink>`) y el compilador de plantillas mira que
 * compile; `multitarea.service.spec` mira el servicio AISLADO. Ninguno de los
 * tres prueba lo único que al usuario le importa: que el ancla renderizada
 * tenga un **`href` de verdad** y que la preferencia le mueva el `target`.
 *
 * El `href` es el punto. Es lo que hace que el navegador ofrezca Ctrl+clic,
 * clic central, "Abrir en pestaña nueva" y el preview de la URL al pasar el
 * mouse — o sea, todo lo que ADR-078 persigue. Un `[routerLink]` sobre un
 * elemento que no es `<a>` navega igual y no da NADA de eso; ese defecto
 * estaba vivo en `comercial-inventory-sessions` y se veía idéntico en pantalla.
 *
 * Se monta esta pantalla y no otra porque es la más barata (123 líneas, una
 * sola dependencia que doblar). La cadena que ejercita es la misma en las 11.
 */

const FILA = {
  id: '9f3c1a2b-0000-4000-8000-000000000001',
  folio: 'RQ-2026-00042',
  estado: 'pending_approval',
  target_basis: 'reorder',
  total_lines: 3,
  total_units: 120,
  total_cost: 4580,
  notes: null,
  created_at: '2026-09-22T10:00:00Z',
  approved_at: null,
  warehouse_code: 'MD-CENTRAL',
  warehouse_name: 'CEDIS',
  supplier_name: 'Dulces del Norte',
};

function montar() {
  TestBed.configureTestingModule({
    imports: [ComprasRequisicionesComponent],
    providers: [
      provideRouter([]),
      { provide: ComprasService, useValue: { listRequisitions: () => of({ rows: [FILA], total: 1 }) } },
    ],
  });
  const fix = TestBed.createComponent(ComprasRequisicionesComponent);
  fix.detectChanges();
  return fix;
}

/** El ancla del folio, que es la celda que identifica la fila. */
function anclaDelFolio(fix: ReturnType<typeof montar>): HTMLAnchorElement | null {
  const anclas = Array.from(
    fix.nativeElement.querySelectorAll('a'),
  ) as HTMLAnchorElement[];
  return anclas.find((a) => a.textContent?.includes(FILA.folio)) ?? null;
}

describe('[MT] el drill-down renderizado', () => {
  afterEach(() => {
    localStorage.removeItem('mt.detallesAparte.v1');
    TestBed.resetTestingModule();
  });

  it('el folio es un ANCLA con href resuelto — no un div con click', () => {
    const a = anclaDelFolio(montar());
    expect(a).not.toBeNull();
    expect(a!.tagName).toBe('A');
    // El href real es lo que habilita Ctrl+clic y "Abrir en pestaña nueva".
    expect(a!.getAttribute('href')).toBe(`/compras/requisiciones/${FILA.id}`);
  });

  it("en modo 'aqui' (el default) no hay target: navega dentro del SPA", () => {
    const a = anclaDelFolio(montar());
    expect(a!.hasAttribute('target')).toBe(false);
  });

  it("en modo 'ventana' el navegador lo abre aparte", () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ComprasService, useValue: { listRequisitions: () => of({ rows: [FILA], total: 1 }) } },
      ],
      imports: [ComprasRequisicionesComponent],
    });
    TestBed.inject(MultitareaService).ponerModo('ventana');
    const fix = TestBed.createComponent(ComprasRequisicionesComponent);
    fix.detectChanges();
    const a = anclaDelFolio(fix);
    expect(a!.getAttribute('target')).toBe('_blank');
    // El href NO cambia: la preferencia elige dónde abre, no a dónde va.
    expect(a!.getAttribute('href')).toBe(`/compras/requisiciones/${FILA.id}`);
  });

  /**
   * `[MT.5]` LA prueba de la pantalla partida: el enlace lleva el detalle al
   * outlet `panel`, o sea AL LADO, dejando intacto lo que hay a la izquierda.
   * Es lo que separa "hay un panel en el layout" de "el drill-down lo usa".
   */
  it("en modo 'lado' el enlace apunta al panel, no reemplaza la pantalla", () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ComprasService, useValue: { listRequisitions: () => of({ rows: [FILA], total: 1 }) } },
      ],
      imports: [ComprasRequisicionesComponent],
    });
    const mt = TestBed.inject(MultitareaService);
    mt.registrarRutaDelArea(TestBed.inject(ActivatedRoute));
    mt.ponerModo('lado');
    const fix = TestBed.createComponent(ComprasRequisicionesComponent);
    fix.detectChanges();

    const href = anclaDelFolio(fix)!.getAttribute('href')!;
    expect(href).toContain('panel:');
    expect(href).toContain(`compras/requisiciones/${FILA.id}`);
    // Y NO es la navegación normal, que reemplazaría la pantalla.
    expect(href).not.toBe(`/compras/requisiciones/${FILA.id}`);
  });

  /**
   * Sin la ruta del área registrada (el layout es quien la da), el modo 'lado'
   * no puede armar el enlace. Cae a la navegación normal en vez de romperse:
   * **un enlace que no navega es peor que uno que navega distinto**.
   */
  it("modo 'lado' SIN el layout montado cae a la navegación de siempre", () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ComprasService, useValue: { listRequisitions: () => of({ rows: [FILA], total: 1 }) } },
      ],
      imports: [ComprasRequisicionesComponent],
    });
    TestBed.inject(MultitareaService).ponerModo('lado'); // sin registrarRutaDelArea
    const fix = TestBed.createComponent(ComprasRequisicionesComponent);
    fix.detectChanges();
    expect(anclaDelFolio(fix)!.getAttribute('href')).toBe(`/compras/requisiciones/${FILA.id}`);
  });

  /**
   * NEGATIVA — el ancla vive dentro de una fila que también navega.
   *
   * Sin `stopPropagation`, un clic en el folio dispara ADEMÁS el manejador de la
   * fila: se navega dos veces. Con la preferencia prendida es peor, porque la
   * fila navega en ESTA ventana mientras el ancla abre otra — terminás con la
   * pantalla cambiada de abajo del mouse y una ventana nueva encima.
   */
  it('NEGATIVA: el clic en el folio no dispara además el clic de la fila', () => {
    const fix = montar();
    const comp = fix.componentInstance;
    let filaNavego = 0;
    comp.open = () => { filaNavego++; };
    fix.detectChanges();

    const a = anclaDelFolio(fix)!;
    // `preventDefault` para que jsdom no intente navegar de verdad; lo que se
    // mide es si el evento LLEGA a la fila, no si el ancla funciona.
    a.addEventListener('click', (e) => e.preventDefault());
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(filaNavego).toBe(0);
  });

  it('y el clic en OTRA celda de la fila sí navega — no se rompió lo que ya andaba', () => {
    const fix = montar();
    const comp = fix.componentInstance;
    let filaNavego = 0;
    comp.open = () => { filaNavego++; };
    fix.detectChanges();

    const otraCelda = fix.nativeElement.querySelector('tr.rq-row > td:nth-child(2)') as HTMLElement;
    expect(otraCelda).toBeTruthy();
    otraCelda.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(filaNavego).toBe(1);
  });

  describe('segmentación en pestañas (Requerimientos a Proveedor vs Traspaso)', () => {
    it('inicia por defecto en la pestaña supplier y consulta con source_type: supplier', () => {
      let ultParams: any = null;
      TestBed.configureTestingModule({
        providers: [
          provideRouter([]),
          {
            provide: ComprasService,
            useValue: {
              listRequisitions: (q: any) => {
                ultParams = q;
                return of({ rows: [FILA], total: 1 });
              },
            },
          },
        ],
        imports: [ComprasRequisicionesComponent],
      });
      const fix = TestBed.createComponent(ComprasRequisicionesComponent);
      fix.detectChanges();

      expect(fix.componentInstance.tab()).toBe('supplier');
      expect(ultParams?.source_type).toBe('supplier');
    });

    it('al cambiar a branch consulta con source_type: branch', () => {
      let ultParams: any = null;
      TestBed.configureTestingModule({
        providers: [
          provideRouter([]),
          {
            provide: ComprasService,
            useValue: {
              listRequisitions: (q: any) => {
                ultParams = q;
                return of({ rows: [], total: 0 });
              },
            },
          },
        ],
        imports: [ComprasRequisicionesComponent],
      });
      const fix = TestBed.createComponent(ComprasRequisicionesComponent);
      fix.detectChanges();

      fix.componentInstance.onTabChange('branch');
      fix.detectChanges();

      expect(fix.componentInstance.tab()).toBe('branch');
      expect(ultParams?.source_type).toBe('branch');
    });
  });
});

