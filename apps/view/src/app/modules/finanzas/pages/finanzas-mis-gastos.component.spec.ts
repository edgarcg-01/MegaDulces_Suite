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
  describe('[GX.39] la etapa de ejercicio', () => {
    const CON_ETAPAS = (): ExpenseProofsReport => ({
      kpis: { total: 4, recibidas: 1, validadas: 2, rechazadas: 0, en_revision: 0 },
      etapas_de_la_pagina: { en_captura: 1, por_ejercer: 1, ejercido: 1, sin_medir: 1 },
      rows: [
        FILA({ id: 'a', status: 'recibida', folio_solicitud: '0001', etapa: 'en_captura', etapa_label: 'En trámite', etapa_explicacion: 'Tu gasto esta en tramite con nosotros.' }),
        FILA({ id: 'b', status: 'validada', folio_solicitud: '0002', etapa: 'por_ejercer', etapa_label: 'Por ejercer', etapa_explicacion: 'Aprobado. Esta esperando a que apliquen el gasto en Kepler.' }),
        FILA({ id: 'c', status: 'validada', folio_solicitud: '0003', etapa: 'ejercido', etapa_label: 'Ejercido', etapa_explicacion: 'Tu gasto se aprobo y se ejercio: el dinero salio.' }),
        FILA({ id: 'd', status: 'validada', folio_solicitud: '0004', etapa: 'sin_medir', etapa_label: 'Sin medir', etapa_explicacion: 'Todavia no podemos ver el estado en Kepler.' }),
      ],
    });

    it('pinta las secciones con su cuenta', () => {
      montar(CON_ETAPAS());
      const chips = [...fix.nativeElement.querySelectorAll('.mg-etapa')].map((e) => (e as HTMLElement).textContent?.trim());
      expect(chips.some((t) => t?.startsWith('Todos') && t.includes('4'))).toBe(true);
      expect(chips.some((t) => t?.startsWith('Por ejercer') && t.includes('1'))).toBe(true);
      expect(chips.some((t) => t?.startsWith('Ejercido') && t.includes('1'))).toBe(true);
    });

    it('al abrir «Por ejercer» sólo quedan los de esa etapa', () => {
      montar(CON_ETAPAS());
      c.seccion.set('por_ejercer');
      fix.detectChanges();
      expect(fix.nativeElement.querySelectorAll('.mg-item').length).toBe(1);
      expect(fix.nativeElement.textContent).toContain('0002');
      expect(fix.nativeElement.textContent).not.toContain('0003');
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
     * ⛔ El caso que sostiene la fase: **«sin medir» no puede leerse como «por ejercer»**.
     * Decir «esperando a Kepler» sobre algo que no pudimos mirar es afirmar que Kepler no lo
     * aplicó — y lo único cierto es que no lo sabemos (ADR-056).
     */
    it('«sin medir» es su propia sección y no cae en «por ejercer»', () => {
      montar(CON_ETAPAS());
      c.seccion.set('por_ejercer');
      fix.detectChanges();
      expect(fix.nativeElement.textContent).not.toContain('0004');
      c.seccion.set('sin_medir');
      fix.detectChanges();
      expect(fix.nativeElement.querySelectorAll('.mg-item').length).toBe(1);
      expect(fix.nativeElement.textContent).toContain('0004');
    });

    /**
     * ⚠️ Una pestaña permanente en 0 enseña a ignorarla, y el día que tenga algo nadie la
     * mira. «Sin medir» y «Cancelado en Kepler» sólo aparecen si hay alguno.
     */
    it('no pinta las secciones excepcionales cuando están vacías', () => {
      montar(REPORTE());
      const chips = [...fix.nativeElement.querySelectorAll('.mg-etapa')].map((e) => (e as HTMLElement).textContent?.trim() || '');
      expect(chips.some((t) => t.startsWith('Sin medir'))).toBe(false);
      expect(chips.some((t) => t.startsWith('Cancelado'))).toBe(false);
    });

    /**
     * ⚠️ «Esta sección no tiene nada» y «no levantaste nada» son afirmaciones DISTINTAS. La
     * segunda sobre alguien que sí levantó gastos lo manda a capturarlos de nuevo.
     */
    it('una sección vacía no dice que no levantaste nada', () => {
      montar(CON_ETAPAS());
      c.seccion.set('cancelado_kepler');
      fix.detectChanges();
      const txt = fix.nativeElement.textContent as string;
      expect(txt).not.toContain('Todavía no levantaste');
      expect(txt).toContain('en las otras etapas');
    });

    /**
     * ⛔ **La prueba que encontró el defecto en esta misma pantalla.** Con un servidor que no
     * manda `etapa`, la barra salía «En trámite 0 · Por ejercer 0 · Ejercido 0» — que AFIRMA
     * que medimos y dio cero, cuando no medimos nada. Es el mismo error que la fase existe
     * para arreglar, cometido en la pantalla que lo arregla. La barra entera desaparece.
     */
    it('sin una sola etapa resuelta, la barra de secciones NO se pinta', () => {
      montar(REPORTE());
      expect(fix.nativeElement.querySelectorAll('.mg-etapa').length).toBe(0);
      const txt = fix.nativeElement.textContent as string;
      expect(txt).not.toContain('Por ejercer');
      expect(txt).not.toContain('Ejercido');
    });

    /** Y basta con que UNA fila la traiga: no hace falta que todas estén resueltas. */
    it('con una sola fila resuelta, la barra aparece', () => {
      montar({ ...REPORTE(), rows: [FILA({ id: 'x', etapa: 'ejercido', etapa_label: 'Ejercido' })] });
      expect(fix.nativeElement.querySelectorAll('.mg-etapa').length).toBeGreaterThan(0);
    });
  });

  /**
   * `[GX.41]` — **«Te tocan a vos»: los vales que Kepler le asignó por la caja «Solicita».**
   *
   * ⛔ El recorte lo hace el SERVIDOR, por el `username` del token. Esta pantalla **no
   * filtra**: si lo hiciera, un error suyo le mostraría a alguien el vale de otro y se vería
   * igual de bien — el defecto que GX.34 ya cerró para la lista de abajo. Por eso las pruebas
   * mandan lo que el servidor devolvió y verifican **qué se pinta**, no a quién se elige.
   */
  describe('[GX.41] los vales asignados desde Kepler', () => {
    const ASIG = (over: Record<string, unknown> = {}) => ({
      sucursal: '00', folio: '0009946', fecha: '2026-09-28', importe: 1583.86,
      solicita: 'DEMO_CAPTURA', destinatario: 'ESTACION DE SERVICIO TAVISA',
      concepto: 'COMBUSTIBLE', estado: 'N', aplicada: false, vinculado_por: 'solicita',
      ...over,
    });
    const CON_ASIG = (asignados: unknown[], rows = REPORTE().rows) => ({
      ...REPORTE(), rows, asignados,
    }) as unknown as ExpenseProofsReport;

    it('pinta el vale asignado con su folio, destinatario e importe', () => {
      montar(CON_ASIG([ASIG()]));
      const s = fix.nativeElement.querySelector('.mg-asig');
      expect(s).toBeTruthy();
      const txt = (s as HTMLElement).textContent || '';
      expect(txt).toContain('0009946');
      expect(txt).toContain('ESTACION DE SERVICIO TAVISA');
      expect(txt).toContain('1,583.86');
    });

    /** ⭐ Un clic: el folio y la plaza viajan en la URL, no hay que teclearlos de nuevo. */
    it('el botón lleva a la captura con el folio Y la sucursal puestos', () => {
      montar(CON_ASIG([ASIG()]));
      const a = fix.nativeElement.querySelector('.mg-asig-b') as HTMLAnchorElement;
      expect(a).toBeTruthy();
      expect(a.getAttribute('href')).toContain('folio=0009946');
      // ⛔ Sin la sucursal, 373 folios viven en más de una plaza y se abriría el de otra tienda.
      expect(a.getAttribute('href')).toContain('sucursal=00');
    });

    it('sin asignados no pinta la sección (una caja vacía permanente enseña a ignorarla)', () => {
      montar(REPORTE());
      expect(fix.nativeElement.querySelector('.mg-asig')).toBeNull();
    });

    /**
     * ⚠️ «No levantaste nada» y «tenés 3 esperando» son afirmaciones distintas. La primera,
     * sobre alguien que tiene pendientes arriba, lo manda a buscar donde no es.
     */
    it('con asignados, el vacío de abajo NO dice que no levantó nada', () => {
      montar(CON_ASIG([ASIG(), ASIG({ folio: '0009947' })], []));
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('que te asignaron en Kepler');
      expect(txt).toContain('2');
    });

    /** Sin asignados el mensaje vuelve a ser el de siempre: no se le inventa un pendiente. */
    it('sin asignados y sin gastos, el vacío es el de siempre', () => {
      montar({ ...REPORTE(), rows: [], asignados: [] } as unknown as ExpenseProofsReport);
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('Todavía no levantaste');
      expect(txt).not.toContain('que te asignaron en Kepler');
    });

    /** Un vale ya ejercido en Kepler se marca: sigue necesitando evidencia, pero el dinero salió. */
    it('el que Kepler ya aplicó viene marcado', () => {
      montar(CON_ASIG([ASIG({ aplicada: true })]));
      expect((fix.nativeElement.querySelector('.mg-asig') as HTMLElement).textContent)
        .toContain('Ya ejercido en Kepler');
    });

    /** Un servidor viejo no manda `asignados`: no puede romper la pantalla. */
    it('sin el campo en la respuesta, la pantalla sigue viva', () => {
      montar(REPORTE());
      expect(c.asignados()).toEqual([]);
      expect(fix.nativeElement.querySelectorAll('.mg-item').length).toBe(2);
    });
  });
});
