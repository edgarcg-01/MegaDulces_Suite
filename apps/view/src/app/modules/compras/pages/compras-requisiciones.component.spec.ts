import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { MessageService } from 'primeng/api';
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

/**
 * `[RQ.9]` El doble de `ComprasService`. Arranca con TODO lo que la pantalla pide al montar:
 * desde RQ.9 eso incluye `filters()` (el catálogo de sucursales) y desde RQ.8 los lotes; los
 * dobles que sólo traían `listRequisitions` reventaban las 10 pruebas en ngOnInit sin decir nada útil.
 */
const SUCURSALES = [{ id: 'w1', code: '06', name: 'Canindo' }];
function apiFalsa(over: Record<string, unknown> = {}) {
  return {
    filters: () => of({ warehouses: SUCURSALES }),
    listRequisitions: () => of({ rows: [FILA], total: 1 }),
    listRequisitionBatches: () => of({ rows: [], total: 0, page: 1, pageSize: 25, disponible: true }),
    ...over,
  };
}

/**
 * `[RQ.8]` La pantalla abre «Por lote». Lo que miden estas pruebas —el ancla del folio, la casilla,
 * el clic de la fila— es la fila de REQUISICIÓN, que sólo existe en «Por documento».
 */
function porDocumento<T extends { componentInstance: ComprasRequisicionesComponent; detectChanges(): void }>(fix: T): T {
  fix.componentInstance.vista.set('documento');
  fix.detectChanges();
  return fix;
}

function montar() {
  TestBed.configureTestingModule({
    imports: [ComprasRequisicionesComponent],
    providers: [
      provideRouter([]),
      { provide: ComprasService, useValue: apiFalsa() },
    ],
  });
  return porDocumento(TestBed.createComponent(ComprasRequisicionesComponent));
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
        { provide: ComprasService, useValue: apiFalsa() },
      ],
      imports: [ComprasRequisicionesComponent],
    });
    TestBed.inject(MultitareaService).ponerModo('ventana');
    const fix = porDocumento(TestBed.createComponent(ComprasRequisicionesComponent));
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
        { provide: ComprasService, useValue: apiFalsa() },
      ],
      imports: [ComprasRequisicionesComponent],
    });
    const mt = TestBed.inject(MultitareaService);
    mt.registrarRutaDelArea(TestBed.inject(ActivatedRoute));
    mt.ponerModo('lado');
    const fix = porDocumento(TestBed.createComponent(ComprasRequisicionesComponent));

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
        { provide: ComprasService, useValue: apiFalsa() },
      ],
      imports: [ComprasRequisicionesComponent],
    });
    TestBed.inject(MultitareaService).ponerModo('lado'); // sin registrarRutaDelArea
    const fix = porDocumento(TestBed.createComponent(ComprasRequisicionesComponent));
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

    // `[RQ.4]` La celda 1 es la casilla de selección y la 2 el folio, así que "otra celda"
    // es la 3. Antes era la 2 y el test seguía pasando por casualidad: medía el folio.
    const otraCelda = fix.nativeElement.querySelector('tr.rq-row > td:nth-child(3)') as HTMLElement;
    expect(otraCelda).toBeTruthy();
    otraCelda.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(filaNavego).toBe(1);
  });

  /**
   * `[RQ.4]` Misma familia que la negativa del folio: marcar para el lote NO puede navegar.
   * Si lo hiciera, elegir tres requisiciones sería imposible — la primera te saca de la lista.
   */
  it('NEGATIVA: marcar la casilla de selección no abre la requisición', () => {
    const fix = montar();
    const comp = fix.componentInstance;
    let filaNavego = 0;
    comp.open = () => { filaNavego++; };
    fix.detectChanges();

    const chk = fix.nativeElement.querySelector('tr.rq-row > td.rq-chk input') as HTMLInputElement;
    expect(chk).toBeTruthy();
    chk.click();
    fix.detectChanges();

    expect(filaNavego).toBe(0);
    expect(comp.sel().has(FILA.id)).toBe(true);
  });

  /**
   * `[RQ.11]` La vista de arranque la decide el DATO, no una constante. Medido en prod el
   * 2026-10-06: 0 lotes y 619 requisiciones viejas, así que abrir agrupado mostraría 619
   * «lotes» de un documento sin folio — la misma lista con una columna de más. Por eso abre
   * por DOCUMENTO y se pasa a LOTE sola la primera vez que el servidor reporta `con_lote > 0`.
   *
   * ⚠️ Este bloque reemplaza a `[RQ.8] abre agrupado POR LOTE y pide los lotes de la pestaña`,
   * que afirmaba lo contrario y llevaba días en rojo SIN QUE SE VIERA: `Lint & test` corre
   * `--affected`, y como ningún push tocaba a la vez el componente y el spec, no se ejecutaban
   * juntos. Falló al primer PR que sí los puso en el mismo conjunto. El spec pedía además
   * `source_type`, que `[RQ.11]` quitó a propósito de esa llamada: el lote es la unidad del
   * «Armar» y abarca compra Y traspaso, así que filtrarlo por la pestaña lo cortaba a la mitad
   * (65 de 83 lotes mezclan los dos tipos).
   */
  function montarConLotes(conLote: number) {
    let pedido: { source_type?: string } | null = null;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ComprasService, useValue: apiFalsa({
          listRequisitionBatches: (q: { source_type?: string }) => {
            pedido = q;
            return of({ rows: [], total: 0, page: 1, pageSize: 25, disponible: true, con_lote: conLote });
          },
        }) },
      ],
      imports: [ComprasRequisicionesComponent],
    });
    const fix = TestBed.createComponent(ComprasRequisicionesComponent);
    fix.detectChanges();
    return { fix, pedido: () => pedido };
  }

  it('[RQ.11] sin lotes reales abre por DOCUMENTO — agrupar no aportaría nada', () => {
    const { fix } = montarConLotes(0);
    expect(fix.componentInstance.vista()).toBe('documento');
    expect(fix.componentInstance['lotesReales']()).toBe(0);
  });

  it('[RQ.11] con lotes reales se pasa sola a LOTE', () => {
    const { fix } = montarConLotes(3);
    expect(fix.componentInstance.vista()).toBe('lote');
    // En «Por lote» no hay filas de requisición sueltas: es la otra vista.
    expect(anclaDelFolio(fix)).toBeNull();
  });

  it('[RQ.11] NEGATIVA: los lotes NO se piden filtrados por la pestaña', () => {
    const { pedido } = montarConLotes(0);
    expect(pedido()).not.toBeNull();
    expect(pedido()?.source_type).toBeUndefined();
  });

  describe('[RQ.9] el catálogo de sucursales', () => {
    it('sale de /filters y llena el selector', () => {
      const fix = montar();
      expect(fix.componentInstance['almacenes']()).toEqual(SUCURSALES);
    });

    it('si /filters falla, la bandeja carga igual y lo avisa — no se calla', () => {
      TestBed.configureTestingModule({
        providers: [
          provideRouter([]),
          { provide: ComprasService, useValue: apiFalsa({ filters: () => throwError(() => new Error('503')) }) },
        ],
        imports: [ComprasRequisicionesComponent],
      });
      const fix = TestBed.createComponent(ComprasRequisicionesComponent);
      const toast = fix.debugElement.injector.get(MessageService);
      const avisos: Array<{ severity?: string; summary?: string }> = [];
      vi.spyOn(toast, 'add').mockImplementation((m) => { avisos.push(m); });
      porDocumento(fix);

      expect(fix.componentInstance['almacenes']()).toEqual([]);
      expect(avisos).toContainEqual(expect.objectContaining({ severity: 'warn', summary: 'Sin catálogo de sucursales' }));
      expect(anclaDelFolio(fix)).not.toBeNull(); // la lista de requisiciones salió igual
    });
  });

  describe('segmentación en pestañas (Requerimientos a Proveedor vs Traspaso)', () => {
    it('inicia por defecto en la pestaña supplier y consulta con source_type: supplier', () => {
      let ultParams: any = null;
      TestBed.configureTestingModule({
        providers: [
          provideRouter([]),
          {
            provide: ComprasService,
            useValue: apiFalsa({
              listRequisitions: (q: any) => {
                ultParams = q;
                return of({ rows: [FILA], total: 1 });
              },
            }),
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
            useValue: apiFalsa({
              listRequisitions: (q: any) => {
                ultParams = q;
                return of({ rows: [], total: 0 });
              },
            }),
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

/**
 * `[PQ.1]` Aprobada ≠ escrita en Kepler. Medido en prod el 2026-10-23: 680 `approved` sin
 * documento en el ERP por $19.05 M se veían idénticas a una entregada. Tres ausencias que no
 * son la misma (ADR-056), una casilla que las cuenta y un drill que pone el filtro A LA VISTA.
 */
describe('[PQ.1] aprobada ≠ escrita en Kepler', () => {
  afterEach(() => TestBed.resetTestingModule());

  const APROBADA = (over: Record<string, unknown>) => ({ ...FILA, id: '9f3c1a2b-0000-4000-8000-0000000000a1', folio: 'RQ-2026-00900', estado: 'approved', ...over });
  const RESUMEN_APROBADAS = (over: Record<string, unknown> = {}) => [{
    estado: 'approved', n: 10, monto: 100000, dias_prom: 5, dias_max: 25, n_mas_30: 0, monto_mas_30: 0,
    n_kepler: 3, n_kepler_error: 2, n_sin_empujar: 5, monto_sin_kepler: 70000, dias_max_sin_kepler: 25, ...over,
  }];

  function montarCon(rows: unknown[], resumen: unknown[] = [], capturar?: (q: any) => void) {
    TestBed.configureTestingModule({
      imports: [ComprasRequisicionesComponent],
      providers: [provideRouter([]), {
        provide: ComprasService,
        useValue: apiFalsa({ listRequisitions: (q: any) => { capturar?.(q); return of({ rows, total: rows.length, resumen }); } }),
      }],
    });
    return porDocumento(TestBed.createComponent(ComprasRequisicionesComponent));
  }

  it('tres ausencias, tres etiquetas: salió · salió mal · sin empujar', () => {
    const c = montarCon([]).componentInstance;
    // `[PQ.25]` Sin el código de sucursal: «00» no le dice a nadie que es CEDIS (la sucursal ya
    // está en su columna, por nombre).
    expect(c.keplerLabel(APROBADA({ kepler_sucursal: '00', kepler_folio: '0003114', kepler_error: null }) as any)).toBe('en Kepler 0003114');
    expect(c.keplerSev(APROBADA({ kepler_folio: '0003114' }) as any)).toBe('secondary');
    expect(c.keplerLabel(APROBADA({ kepler_folio: null, kepler_error: 'Kepler (sucursal 04) no conoce al proveedor CA027' }) as any)).toBe('no salió a Kepler');
    expect(c.keplerSev(APROBADA({ kepler_folio: null, kepler_error: 'x' }) as any)).toBe('danger');
    expect(c.keplerLabel(APROBADA({ kepler_folio: null, kepler_error: null }) as any)).toBe('sin empujar a Kepler');
    expect(c.keplerSev(APROBADA({ kepler_folio: null, kepler_error: null }) as any)).toBe('warn');
  });

  it('NEGATIVA: una fila sin las columnas (servidor viejo) dice «sin medir», no «sin empujar»', () => {
    const c = montarCon([]).componentInstance;
    expect(c.keplerLabel(APROBADA({}) as any)).toBe('Kepler: sin medir');
  });

  it('la aprobada que no salió dice POR QUÉ, escrito en la fila; la pendiente no dice nada de Kepler', () => {
    // `[PQ.25]`/`[PQ.28]` Lo de Kepler dejó de ser una pastilla con el motivo en un `title`: va en
    // su columna «En Kepler», con el motivo completo a la vista, y el estado es texto.
    const fix = montarCon([APROBADA({ kepler_folio: null, kepler_error: 'Kepler (sucursal 04) no conoce al proveedor CA027' }), FILA]);
    const texto = (fix.nativeElement as HTMLElement).textContent ?? '';
    expect(texto).toContain('no salió a Kepler');
    expect(texto).toContain('no conoce al proveedor CA027');
    const kepCeldas = Array.from((fix.nativeElement as HTMLElement).querySelectorAll('td.rq-kepcell')).map((td) => td.textContent?.trim() ?? '');
    expect(kepCeldas.some((t) => t.includes('no salió a Kepler'))).toBe(true);
    // NEGATIVA: la pendiente no tiene nada que decir de Kepler.
    expect(kepCeldas.filter((t) => /Kepler/.test(t)).length).toBe(1);
  });

  it('la casilla cuenta las aprobadas SIN documento, con su desglose y su monto', () => {
    const fix = montarCon([], RESUMEN_APROBADAS());
    const k = fix.componentInstance.kpis().find((x) => x.label === 'Aprobadas sin documento en Kepler')!;
    expect(k.value).toBe(7);                 // 10 aprobadas − 3 en Kepler
    expect(k.tone).toBe('warn');
    expect(k.sub).toContain('2 salió mal');
    expect(k.sub).toContain('5 sin empujar');
    expect(k.sub).toContain('25 d');
    expect(k.drill).toBe('kepler_sin_documento');
  });

  it('NEGATIVA: sin el desglose del servidor la casilla dice «sin medir», nunca 0', () => {
    const fix = montarCon([], RESUMEN_APROBADAS({ n_kepler: undefined, n_kepler_error: undefined, n_sin_empujar: undefined }));
    const k = fix.componentInstance.kpis().find((x) => x.label === 'Aprobadas sin documento en Kepler')!;
    expect(k.value).toBe('—');
    expect(k.format).toBe('text');
    expect(k.sub).toContain('sin medir');
  });

  it('el drill pone el filtro, lo manda al servidor y lo deja a la vista para quitarlo', () => {
    let ult: any = null;
    const fix = montarCon([], RESUMEN_APROBADAS(), (q) => { ult = q; });
    fix.componentInstance.onDrill('kepler_sin_documento');
    fix.detectChanges();
    expect(ult?.kepler).toBe('sin_documento');
    expect(ult?.estado).toBe('approved');
    expect(fix.nativeElement.textContent).toContain('aprobadas sin documento en Kepler');
    fix.componentInstance.quitarKepler();
    fix.detectChanges();
    expect(ult?.kepler).toBeUndefined();
  });

  it('NEGATIVA: un drill ajeno no toca el filtro', () => {
    let ult: any = null;
    const fix = montarCon([], [], (q) => { ult = q; });
    fix.componentInstance.onDrill('otra_cosa');
    expect(ult?.kepler).toBeUndefined();
    expect(fix.componentInstance.fKepler).toBeNull();
  });
});


describe('[PQ.14] el apagado de Kepler es un estado de la bandeja, no una falla por fila', () => {
  afterEach(() => TestBed.resetTestingModule());

  const APROBADA = (over: Record<string, unknown>) => ({ ...FILA, id: '9f3c1a2b-0000-4000-8000-0000000000b1', folio: 'RQ-2026-00901', estado: 'approved', kepler_folio: null, ...over });
  const RESUMEN = (over: Record<string, unknown> = {}) => [{
    estado: 'approved', n: 10, monto: 100000, dias_prom: 5, dias_max: 25, n_mas_30: 0, monto_mas_30: 0,
    n_kepler: 1, n_kepler_error: 6, n_kepler_apagado: 5, n_sin_empujar: 3, monto_sin_kepler: 90000, dias_max_sin_kepler: 25, ...over,
  }];
  function montarCon(rows: unknown[], resumen: unknown[] = []) {
    TestBed.configureTestingModule({
      imports: [ComprasRequisicionesComponent],
      providers: [provideRouter([]), { provide: ComprasService, useValue: apiFalsa({ listRequisitions: () => of({ rows, total: rows.length, resumen }) }) }],
    });
    return porDocumento(TestBed.createComponent(ComprasRequisicionesComponent));
  }

  it('los dos textos reales del apagado se etiquetan «Kepler apagado», en gris, no en rojo', () => {
    const c = montarCon([]).componentInstance;
    for (const motivo of ['KEPLER_PUSH_URL sin configurar', 'La escritura a Kepler de la sucursal 00 está apagada (falta KEPLER_PUSH_URL_00)']) {
      const r = APROBADA({ kepler_error: motivo }) as never;
      expect(c.keplerApagado(r)).toBe(true);
      expect(c.keplerLabel(r)).toBe('Kepler apagado');
      expect(c.keplerSev(r)).toBe('secondary');
      expect(c.keplerTitle(r)).toContain('No es una falla de esta requisición');
    }
  });

  it('NEGATIVA: una falla real sigue en rojo, y una escrita en Kepler no es «apagado» aunque el texto lo diga', () => {
    const c = montarCon([]).componentInstance;
    expect(c.keplerApagado(APROBADA({ kepler_error: 'Kepler (sucursal 04) no conoce al proveedor CA027' }) as never)).toBe(false);
    expect(c.keplerSev(APROBADA({ kepler_error: 'Kepler (sucursal 04) no conoce al proveedor CA027' }) as never)).toBe('danger');
    expect(c.keplerApagado(APROBADA({ kepler_folio: '0003114', kepler_error: 'apagada' }) as never)).toBe(false);
  });

  it('la casilla separa «salió mal» del apagado, y la cinta lo dice una sola vez con su conteo', () => {
    const fix = montarCon([], RESUMEN());
    const c = fix.componentInstance;
    const casilla = c.kpis().find((k) => k.label === 'Aprobadas sin documento en Kepler')!;
    expect(casilla.sub).toContain('1 salió mal');
    expect(casilla.sub).toContain('5 con Kepler apagado');
    const cinta = fix.nativeElement.querySelector('.rq-apagado') as HTMLElement;
    expect(cinta).not.toBeNull();
    expect(cinta.textContent).toContain('La escritura a Kepler está apagada');
    expect(cinta.textContent).toContain('5 aprobada(s)');
  });

  it('NEGATIVA: sin apagado no hay cinta, y sin el desglose del servidor «salió mal» son los errores tal cual', () => {
    const fix = montarCon([], RESUMEN({ n_kepler_apagado: 0 }));
    expect(fix.nativeElement.querySelector('.rq-apagado')).toBeNull();
    TestBed.resetTestingModule();
    const viejo = montarCon([], RESUMEN({ n_kepler_apagado: undefined }));
    const casilla = viejo.componentInstance.kpis().find((k) => k.label === 'Aprobadas sin documento en Kepler')!;
    expect(casilla.sub).toContain('6 salió mal');
    expect(casilla.sub).not.toContain('con Kepler apagado');
  });

  it('llega desde Pedido con el lote en ?q= y la bandeja abre buscándolo', () => {
    TestBed.configureTestingModule({
      imports: [ComprasRequisicionesComponent],
      providers: [provideRouter([]), { provide: ComprasService, useValue: apiFalsa({ listRequisitions: () => of({ rows: [], total: 0, resumen: [] }) }) },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ q: 'RQ-LOTE-7' }) } } }],
    });
    const fix = TestBed.createComponent(ComprasRequisicionesComponent);
    fix.detectChanges();
    expect(fix.componentInstance.fBuscar).toBe('RQ-LOTE-7');
  });
});

describe('[PQ.15] aprobar un lote completo de golpe, desde su fila', () => {
  afterEach(() => TestBed.resetTestingModule());
  const LOTE = (over: Record<string, unknown> = {}) => ({
    lote: '7a1b2c3d-0000-4000-8000-00000000000a', batch_folio: 'RQ-LOTE-2026-00141', documentos: 10, compras: 0, traspasos: 10,
    almacenes: 6, proveedores: 0, renglones: 73, monto: 281201, created_at: '2026-10-26T14:02:00Z', dias: 0,
    estado: 'pending_approval', pendientes: 10, autor: 'arizbeth_gonzalez', ...over,
  });
  type Llamada = { list?: Record<string, unknown>; bulk?: [string[], string, string | null] };
  function montar(lote: Record<string, unknown>, pendientesEnServidor = 3, llamadas: Llamada[] = [], permiso = true) {
    TestBed.configureTestingModule({
      imports: [ComprasRequisicionesComponent],
      providers: [provideRouter([]), { provide: ComprasService, useValue: apiFalsa({
        listRequisitionBatches: () => of({ rows: [lote], total: 1, page: 1, pageSize: 25, disponible: true, con_lote: 1 }),
        listRequisitions: (q: Record<string, unknown>) => {
          llamadas.push({ list: q });
          const rows = Array.from({ length: pendientesEnServidor }, (_, i) => ({ ...FILA, id: `9f3c1a2b-0000-4000-8000-0000000000${(10 + i).toString(16)}`, folio: `RQ-${i}` }));
          return of({ rows, total: rows.length, resumen: [] });
        },
        bulkRequisiciones: (ids: string[], accion: string, motivo: string | null) => { llamadas.push({ bulk: [ids, accion, motivo] }); return of({ pedidas: ids.length, hechas: ids.length, ok: ids, fallas: [] }); },
      }) }],
    });
    const fix = TestBed.createComponent(ComprasRequisicionesComponent);
    fix.componentInstance.canAutorizar = permiso;
    fix.detectChanges();
    fix.componentInstance.vista.set('lote');
    fix.detectChanges();
    return fix;
  }
  const boton = (fix: { nativeElement: HTMLElement }, texto: RegExp) =>
    Array.from(fix.nativeElement.querySelectorAll('button')).find((b) => texto.test(b.textContent || '')) as HTMLButtonElement | undefined;

  it('el lote con pendientes ofrece «Aprobar lote (N)»; el primer clic pide confirmación y el segundo manda al servidor SOLO los pendientes del lote', () => {
    const llamadas: Llamada[] = [];
    const fix = montar(LOTE(), 3, llamadas);
    const b = boton(fix, /Aprobar lote \(10\)/);
    expect(b).toBeDefined();
    b!.click(); fix.detectChanges();
    expect(llamadas.filter((l) => l.bulk)).toEqual([]);          // todavía nada: pide confirmación
    const si = boton(fix, /Sí, aprobar 10/);
    expect(si).toBeDefined();
    si!.click(); fix.detectChanges();
    const list = llamadas.find((l) => l.list && l.list['batch_id'])!.list!;
    expect(list['batch_id']).toBe('7a1b2c3d-0000-4000-8000-00000000000a');
    expect(list['estado']).toBe('pending_approval');
    expect(list['pageSize']).toBe(200);
    const bulk = llamadas.find((l) => l.bulk)!.bulk!;
    expect(bulk[0].length).toBe(3);
    expect(bulk[1]).toBe('approve');
    expect(fix.componentInstance.loteAConfirmar()).toBeNull();
  });

  it('NEGATIVA: sin pendientes no hay botón', () => {
    const fix = montar(LOTE({ pendientes: 0, estado: 'approved' }));
    expect(boton(fix, /Aprobar lote/)).toBeUndefined();
  });

  it('NEGATIVA: sin permiso de autorizar no hay botón', () => {
    const fix = montar(LOTE(), 3, [], false);
    expect(boton(fix, /Aprobar lote/)).toBeUndefined();
  });

  it('NEGATIVA: un lote con más de 200 pendientes no manda nada y lo dice (tope del servidor)', () => {
    const llamadas: Llamada[] = [];
    const fix = montar(LOTE({ pendientes: 201, documentos: 201 }), 201, llamadas);
    fix.componentInstance.aprobarLote(LOTE({ pendientes: 201, documentos: 201 }) as never);
    // La bandeja pide su propia lista al abrir; lo que NO debe existir es la lectura del lote ni el bulk.
    expect(llamadas.filter((l) => l.bulk || (l.list && l.list['batch_id']))).toEqual([]);
  });

  it('Cancelar en la confirmación no manda nada', () => {
    const llamadas: Llamada[] = [];
    const fix = montar(LOTE(), 3, llamadas);
    boton(fix, /Aprobar lote/)!.click(); fix.detectChanges();
    boton(fix, /^\s*Cancelar\s*$/)!.click(); fix.detectChanges();
    expect(llamadas.filter((l) => l.bulk)).toEqual([]);
    expect(boton(fix, /Aprobar lote \(10\)/)).toBeDefined();
  });
});

describe('[PQ.18] la pestaña «Pedidos de sucursal»', () => {
  afterEach(() => TestBed.resetTestingModule());
  const PEDIDO = (over: Record<string, unknown> = {}) => ({ ...FILA, id: '9f3c1a2b-0000-4000-8000-0000000000c1', folio: 'RQ-2026-01500', requested_by_branch: true, source_type: 'supplier', ...over });

  function montar(params: Record<string, string>, over: Record<string, unknown> = {}, pedidos: Array<Record<string, unknown>> = []) {
    TestBed.configureTestingModule({
      imports: [ComprasRequisicionesComponent],
      providers: [provideRouter([]),
        { provide: ComprasService, useValue: apiFalsa({
          listRequisitions: (q: Record<string, unknown>) => { pedidos.push(q); return of({ rows: [PEDIDO()], total: q['pageSize'] === 1 ? 4 : 1, resumen: [] }); },
          ...over,
        }) },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(params) } } }],
    });
    const fix = TestBed.createComponent(ComprasRequisicionesComponent);
    fix.detectChanges();
    fix.componentInstance.vista.set('documento');
    fix.detectChanges();
    return fix;
  }

  it('?tab=sucursal abre la pestaña y pide compras Y traspasos que pidió una sucursal (sin source_type)', () => {
    const pedidos: Array<Record<string, unknown>> = [];
    const fix = montar({ tab: 'sucursal' }, {}, pedidos);
    expect(fix.componentInstance.tab()).toBe('sucursal');
    const lista = pedidos.filter((p) => p['pageSize'] === 50).pop()!;
    expect(lista['de_sucursal']).toBe(true);
    expect(lista['source_type']).toBeUndefined();
  });

  it('el enlace viejo ?de_sucursal=1 también aterriza en la pestaña', () => {
    expect(montar({ de_sucursal: '1' }).componentInstance.tab()).toBe('sucursal');
  });

  it('NEGATIVA: en «Requerimientos a Proveedor» NO se filtra por sucursal y sí por tipo', () => {
    const pedidos: Array<Record<string, unknown>> = [];
    montar({}, {}, pedidos);
    const lista = pedidos.filter((p) => p['pageSize'] === 50).pop()!;
    expect(lista['de_sucursal']).toBeUndefined();
    expect(lista['source_type']).toBe('supplier');
  });

  it('la pestaña dice cuántos esperan respuesta (consulta de pendientes, 1 fila)', () => {
    const pedidos: Array<Record<string, unknown>> = [];
    const fix = montar({}, {}, pedidos);
    const conteo = pedidos.find((p) => p['pageSize'] === 1)!;
    expect(conteo['de_sucursal']).toBe(true);
    expect(conteo['estado']).toBe('pending_approval');
    expect(fix.componentInstance.pendientesSuc()).toBe(4);
    expect((fix.nativeElement as HTMLElement).querySelector('.rq-tab-n')?.textContent?.trim()).toBe('4');
  });

  it('NEGATIVA: si el conteo falla la pestaña dice «·» (no se pudo contar), nunca 0', () => {
    const fix = montar({}, {
      listRequisitions: (q: Record<string, unknown>) => (q['pageSize'] === 1 ? throwError(() => new Error('500')) : of({ rows: [], total: 0, resumen: [] })),
    });
    expect(fix.componentInstance.pendientesSuc()).toBeNull();
    expect((fix.nativeElement as HTMLElement).querySelector('.rq-tab-n')?.textContent?.trim()).toBe('·');
  });

  it('«Qué pide»: la compra nombra al proveedor; el traspaso, la sucursal origen POR NOMBRE', () => {
    const c = montar({ tab: 'sucursal' }).componentInstance;
    expect(c.quePide(PEDIDO() as never)).toBe('Compra a Dulces del Norte');
    expect(c.quePide(PEDIDO({ source_type: 'branch', source_warehouse_id: 'w1' }) as never)).toBe('Traspaso desde Canindo');
    // NEGATIVA: un origen fuera del catálogo no se pinta como código.
    expect(c.quePide(PEDIDO({ source_type: 'branch', source_warehouse_id: 'w-x' }) as never)).toBe('Traspaso desde origen sin nombre');
  });
});

describe('[AB.32] rechazar lo que pidió una sucursal exige motivo', () => {
  const DE_SUCURSAL = { ...FILA, id: '9f3c1a2b-0000-4000-8000-000000000002', folio: 'RQ-2026-00043', requested_by_branch: true };
  function montarConSucursal(bulk: (ids: string[], accion: string, motivo: string | null) => unknown) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ComprasRequisicionesComponent],
      providers: [
        provideRouter([]),
        { provide: ComprasService, useValue: apiFalsa({
          listRequisitions: () => of({ rows: [FILA, DE_SUCURSAL], total: 2 }),
          bulkRequisiciones: bulk,
        }) },
      ],
    });
    return porDocumento(TestBed.createComponent(ComprasRequisicionesComponent));
  }

  it('la fila de sucursal se marca, y con una marcada el rechazo no sale sin motivo', () => {
    const llamadas: Array<[string[], string, string | null]> = [];
    const fix = montarConSucursal((ids, accion, motivo) => { llamadas.push([ids, accion, motivo]); return of({ pedidas: 1, hechas: 1, ok: ids, fallas: [] }); });
    const c = fix.componentInstance;
    expect((fix.nativeElement as HTMLElement).textContent).toContain('DE SUCURSAL');
    c.marcar(DE_SUCURSAL.id, true);
    expect(c.marcadasDeSucursal()).toBe(1);
    c.abrirRechazo();
    c.confirmarRechazo();                 // sin motivo
    expect(llamadas).toEqual([]);
    c.motivoRechazo.set('  la matriz no tiene  ');
    c.confirmarRechazo();
    expect(llamadas).toEqual([[[DE_SUCURSAL.id], 'reject', 'la matriz no tiene']]);
  });

  it('una de Compras se sigue rechazando sin motivo', () => {
    const llamadas: Array<[string[], string, string | null]> = [];
    const c = montarConSucursal((ids, accion, motivo) => { llamadas.push([ids, accion, motivo]); return of({ pedidas: 1, hechas: 1, ok: ids, fallas: [] }); }).componentInstance;
    c.marcar(FILA.id, true);
    expect(c.marcadasDeSucursal()).toBe(0);
    c.abrirRechazo();
    c.confirmarRechazo();
    expect(llamadas).toEqual([[[FILA.id], 'reject', null]]);
  });
});
