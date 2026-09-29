import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { FinanzasMisGastosComponent } from './finanzas-mis-gastos.component';
import type { ExpenseProofsReport } from '../comprobaciones.service';

/**
 * `[GX.33]` Candado de **Mis gastos**, la pantalla de quien LEVANTA el gasto.
 *
 * Lo que cuida: que no afirme lo que no sabe. Un error de red no puede leerse como «no
 * levantaste nada» (eso manda a alguien a capturar de nuevo un gasto que ya mandó), los
 * contadores no pueden salir de contar la lista (viene acotada por `limit`), y el recorte
 * a lo propio no puede vivir acá.
 */

const FILA = (over: Partial<ExpenseProofsReport['rows'][number]> = {}) => ({
  id: 'p1', solicitante: 'PREVENCION', departamento: 'PREVENCION', departamento_code: null,
  sucursal: '01', fecha_gasto: '2026-09-25', folio_solicitud: '0049641', proveedor: 'CAPUFE',
  importe: 387.25, files: [], comentarios: null, status: 'recibida', validated_by: null,
  validated_at: null, motivo_rechazo: null, created_by: 'demo_captura',
  created_at: '2026-09-25T15:00:00.000Z', ...over,
}) as ExpenseProofsReport['rows'][number];

const REPORTE = (over: Partial<ExpenseProofsReport> = {}): ExpenseProofsReport => ({
  kpis: { total: 3, recibidas: 2, validadas: 1, rechazadas: 0, en_revision: 0 },
  rows: [FILA(), FILA({ id: 'p2', status: 'validada', folio_solicitud: '0049651' })],
  ...over,
});

describe('FinanzasMisGastosComponent', () => {
  let fix: ComponentFixture<FinanzasMisGastosComponent>;
  let c: FinanzasMisGastosComponent;
  let http: HttpTestingController;

  beforeAll(() => registerLocaleData(localeEsMx));

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FinanzasMisGastosComponent],
      // `[GX.41]` El router va de verdad: el botón «Subir evidencia» es un `routerLink` con
      // queryParams, y con un doble no se podría comprobar que el folio Y la sucursal viajan.
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), { provide: LOCALE_ID, useValue: 'es-MX' }],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  const montar = (r: ExpenseProofsReport | null = REPORTE()) => {
    fix = TestBed.createComponent(FinanzasMisGastosComponent);
    c = fix.componentInstance;
    const req = http.expectOne((x) => x.url.includes('/finance/expenses/proofs/mine'));
    if (r) req.flush(r); else req.flush('boom', { status: 500, statusText: 'Server Error' });
    fix.detectChanges();
    return req;
  };

  /**
   * ⭐ El recorte a lo propio lo hace el SERVIDOR (`/mine`, por token). Si esta pantalla
   * pidiera la colección y filtrara acá, un error suyo mostraría el gasto ajeno — y nadie
   * se enteraría, porque se vería igual de bien.
   */
  it('pide /mine, no la colección', () => {
    const req = montar();
    expect(req.request.method).toBe('GET');
    expect(req.request.url).toContain('/mine');
    expect(req.request.url).not.toContain('/historial');
  });

  it('muestra lo levantado, con su folio y su proveedor', () => {
    montar();
    const txt = fix.nativeElement.textContent as string;
    expect(txt).toContain('0049641');
    expect(txt).toContain('CAPUFE');
    expect(fix.nativeElement.querySelectorAll('.mg-item').length).toBe(2);
  });

  /**
   * ⚠️ Los contadores salen de `kpis` del servidor, NO de contar `filas()`: la lista viene
   * acotada por `limit`, así que contarla le diría «tenés 200» al que tiene 340.
   */
  it('los contadores salen del servidor, no de contar la lista', () => {
    montar(REPORTE({
      kpis: { total: 340, recibidas: 300, validadas: 38, rechazadas: 2, en_revision: 0 },
      rows: [FILA()],
    }));
    expect(c.kpis()).toEqual({ recibidas: 300, validadas: 38, rechazadas: 2 });
    expect(fix.nativeElement.querySelectorAll('.mg-item').length).toBe(1);
  });

  /** Cada estado se nombra desde el lado de quien capturó, no del que firma. */
  it('«aprobada» le dice al capturista que todavía le toca algo', () => {
    montar(REPORTE({ rows: [FILA({ status: 'aprobada' })] }));
    const txt = fix.nativeElement.textContent as string;
    expect(txt).toContain('Aprobado');
    expect(txt).toContain('te toca subir la evidencia');
  });

  /** El motivo va completo: es exactamente lo que hay que corregir para volver a mandarlo. */
  it('un rechazo muestra su motivo', () => {
    montar(REPORTE({ rows: [FILA({ status: 'rechazada', motivo_rechazo: 'la foto no se lee' })] }));
    const txt = fix.nativeElement.textContent as string;
    expect(txt).toContain('Te lo devolvieron');
    expect(txt).toContain('la foto no se lee');
  });

  /**
   * ⭐ Un error NO se pinta como «no levantaste nada»: es otra afirmación, y la equivocada
   * manda a alguien a capturar de nuevo un gasto que ya había mandado.
   */
  it('un error se dice, no se disfraza de lista vacía', () => {
    montar(null);
    expect(c.error()).toContain('No se pudieron cargar');
    expect(fix.nativeElement.textContent).not.toContain('Todavía no levantaste');
  });

  /** ⚠️ Un rechazo deja de verse a las 24 h: si no se dice, se lee como que se perdió. */
  it('el vacío avisa que los rechazos caducan', () => {
    montar(REPORTE({ kpis: { total: 0, recibidas: 0, validadas: 0, rechazadas: 0, en_revision: 0 }, rows: [] }));
    expect(fix.nativeElement.textContent).toContain('deja de verse a las 24 h');
  });

  it('el buscador viaja al servidor', () => {
    montar();
    c.q = 'CAPUFE';
    c.cargar();
    const req = http.expectOne((x) => x.url.includes('/mine') && x.params.get('search') === 'CAPUFE');
    req.flush(REPORTE());
  });

  /**
   * `[GX.39]` — **«Por ejercer» y «Ejercido»: la etapa que decide Kepler.**
   *
   * Pedido del usuario: después de la luz verde, el vale espera a que apliquen el gasto en
   * Kepler, y cuando eso pasa se le avisa que «se aprobó y se ejerció».
   *
   * ⛔ Lo que esta pantalla NO puede hacer es **calcular la etapa**. La decide el servidor con
   * `etapaDeEjercicio()` del contrato compartido; si acá se dedujera de `status`, habría dos
   * reglas y un vale diría «por ejercer» del lado del campo y otra cosa del lado de
   * Aprobación. Por eso las pruebas mandan la etapa YA RESUELTA y verifican que se muestre —
   * no que se infiera.
   */
  /**
   * `[GX.39/43/46/47]` — **Las pestañas y la lista unificada.**
   *
   * Tres cambios encadenados, todos por pedido del usuario:
   *  · el cuadro naranja de vales asignados se retiró; sus vales **bajaron a la lista**;
   *  · la `A` de Kepler («Autorización de Sol Gasto») es su propia etapa;
   *  · las pestañas se agruparon a **cuatro**: Todos / En trámite / Rechazados / Por ejercer.
   *
   * ⛔ El recorte a lo propio lo sigue haciendo el SERVIDOR. Esta pantalla no filtra por
   * persona: si lo hiciera, un error suyo mostraría el vale de otro y se vería igual de bien.
   */
  describe('[GX.46/47] la lista y sus cuatro pestañas', () => {
    const ASIG = (over: Record<string, unknown> = {}) => ({
      sucursal: '00', folio: '0009946', fecha: '2026-09-28', importe: 1583.86,
      solicita: 'DEMO_CAPTURA', destinatario: 'ESTACION DE SERVICIO TAVISA',
      concepto: 'COMBUSTIBLE', estado: 'N', aplicada: false, vinculado_por: 'solicita',
      ...over,
    });

    /** Una fila por etapa, para que cada pestaña tenga exactamente lo suyo. */
    const CON_ETAPAS = (asignados: unknown[] = [ASIG()]) => ({
      kpis: { total: 5, recibidas: 1, validadas: 3, rechazadas: 1, en_revision: 0 },
      asignados,
      rows: [
        FILA({ id: 'a', status: 'recibida', folio_solicitud: '0001', etapa: 'en_captura', etapa_label: 'En tramite' }),
        FILA({ id: 'b', status: 'validada', folio_solicitud: '0002', etapa: 'por_ejercer', etapa_label: 'Por autorizar' }),
        FILA({ id: 'c', status: 'validada', folio_solicitud: '0003', etapa: 'ejercido', etapa_label: 'Ejercido', etapa_explicacion: 'Tu gasto se aprobo y se ejercio: el dinero salio.' }),
        FILA({ id: 'd', status: 'validada', folio_solicitud: '0004', etapa: 'sin_medir', etapa_label: 'Sin medir', etapa_explicacion: 'Todavia no podemos ver el estado en Kepler.' }),
        FILA({ id: 'e', status: 'validada', folio_solicitud: '0005', etapa: 'autorizado', etapa_label: 'Autorizado en Kepler' }),
        FILA({ id: 'f', status: 'rechazada', folio_solicitud: '0006', etapa: 'rechazada', etapa_label: 'Devuelto', motivo_rechazo: 'La foto no se lee.' }),
      ],
    }) as unknown as ExpenseProofsReport;

    const chips = () => [...fix.nativeElement.querySelectorAll('.mg-etapa')]
      .map((e) => ((e as HTMLElement).textContent || '').trim().replace(/\s+/g, ' '));

    /** ⭐ Cuatro, ni una más: siete pestañas para 26 renglones parten la lista en pedazos. */
    it('son exactamente las cuatro pestañas pedidas, en orden', () => {
      montar(CON_ETAPAS());
      expect(chips().map((s) => s.replace(/ \d+$/, ''))).toEqual(['Todos', 'En trámite', 'Rechazados', 'Por ejercer']);
    });

    /**
     * El agrupado es **de qué lado está parado el vale**: lo asignado y lo que sigue de este
     * lado van juntos; lo firmado que espera a Kepler va junto.
     */
    it('cada pestaña cuenta lo que le toca', () => {
      montar(CON_ETAPAS());
      const n = (etiqueta: string) => {
        const c2 = chips().find((s) => s.startsWith(etiqueta)) || '';
        return c2.slice(etiqueta.length).trim();
      };
      expect(n('Todos')).toBe('7');          // 1 asignado + 6 expedientes
      expect(n('En trámite')).toBe('2');     // el asignado + el que espera firma
      expect(n('Rechazados')).toBe('1');
      expect(n('Por ejercer')).toBe('3');    // por_ejercer + autorizado + sin_medir
    });

    /**
     * ⚠️ **Lo que no entra en ninguna pestaña se puede contar**, para poder decirlo en vez de
     * esconderlo: `ejercido` y `cancelado_kepler` sólo se ven en «Todos».
     */
    it('lo que queda fuera de las pestañas se sabe cuánto es', () => {
      montar(CON_ETAPAS());
      expect(c.fueraDePestanas()).toBe(1);   // el ejercido
    });

    it('al abrir «Por ejercer» quedan los tres que esperan a Kepler', () => {
      montar(CON_ETAPAS());
      c.seccion.set('por_ejercer');
      fix.detectChanges();
      const txt = fix.nativeElement.textContent as string;
      expect(fix.nativeElement.querySelectorAll('.mg-item').length).toBe(3);
      expect(txt).toContain('0002');
      expect(txt).toContain('0005');
      expect(txt).toContain('0004');
      // ⛔ El ejercido NO: ya salió el dinero, no está «por ejercer».
      expect(txt).not.toContain('0003');
    });

    it('«En trámite» junta el vale asignado con el que espera firma', () => {
      montar(CON_ETAPAS());
      c.seccion.set('en_tramite');
      fix.detectChanges();
      expect(fix.nativeElement.querySelectorAll('.mg-item').length).toBe(2);
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('0009946');
      expect(txt).toContain('0001');
    });

    /** ⭐ El vale de Kepler ya NO vive en un cuadro aparte: es una fila más. */
    it('[GX.46] el vale asignado se pinta en la lista, sin cuadro propio', () => {
      montar(CON_ETAPAS());
      expect(fix.nativeElement.querySelector('.mg-asig')).toBeNull();
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('0009946');
      expect(txt).toContain('ESTACION DE SERVICIO TAVISA');
      expect(txt).toContain('Falta tu evidencia');
    });

    /**
     * ⛔ **El asignado no se puede abrir**: no tiene expediente, así que el visor mostraría
     * una ficha vacía. En su lugar ofrece el camino para crearlo.
     */
    it('[GX.46] el asignado no abre el visor; ofrece subir la evidencia', () => {
      montar(CON_ETAPAS());
      const a = fix.nativeElement.querySelector('.mg-asig-b') as HTMLAnchorElement;
      expect(a).toBeTruthy();
      expect(a.getAttribute('href')).toContain('folio=0009946');
      // ⛔ Con la sucursal: 373 folios viven en más de una plaza.
      expect(a.getAttribute('href')).toContain('sucursal=00');
    });

    it('el que Kepler ya aplicó viene marcado', () => {
      montar(CON_ETAPAS([ASIG({ aplicada: true })]));
      expect(fix.nativeElement.textContent).toContain('Ya ejercido en Kepler');
    });

    /** ⭐ La frase textual del pedido, y sólo sobre el que se ejerció. */
    it('al ejercido le dice que el dinero salió; al que espera, no', () => {
      montar(CON_ETAPAS());
      const notas = [...fix.nativeElement.querySelectorAll('.mg-it-nota.ok')].map((e) => (e as HTMLElement).textContent || '');
      expect(notas.length).toBe(1);
      expect(notas[0]).toContain('ejerci');
      expect(notas[0]).toContain('dinero');
    });

    /**
     * ⛔ **La prueba que encontró un defecto en esta misma pantalla.** Con un servidor que no
     * manda `etapa`, la barra salía con todas las pestañas en 0 — que AFIRMA que medimos y
     * dio cero, cuando no medimos nada.
     */
    it('sin una sola etapa resuelta, la barra de pestañas NO se pinta', () => {
      montar(REPORTE());
      expect(fix.nativeElement.querySelectorAll('.mg-etapa').length).toBe(0);
    });

    /** Un servidor viejo no manda `asignados`: no puede romper la pantalla. */
    it('sin el campo en la respuesta, la pantalla sigue viva', () => {
      montar(REPORTE());
      expect(c.asignados()).toEqual([]);
      expect(fix.nativeElement.querySelectorAll('.mg-item').length).toBe(2);
    });
  });
});
