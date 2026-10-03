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
  describe('[GX.65.5] las tres columnas', () => {
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

    /** Los folios que quedaron dentro de una columna, por id de columna. */
    const folios = (col: string) => [...fix.nativeElement.querySelectorAll('[data-col="' + col + '"] .mg-folio')]
      .map((e) => ((e as HTMLElement).textContent || '').trim());

    /** ⭐ `[GX.65.5]` Tres columnas, en el orden del trámite. Se fueron las cuatro pestañas. */
    it('son tres columnas, en orden, y ya no hay pestañas', () => {
      montar(CON_ETAPAS());
      const titulos = [...fix.nativeElement.querySelectorAll('.mg-col h2')].map((e) => (e as HTMLElement).textContent?.trim());
      expect(titulos).toEqual(['Solicitudes', 'Pendientes de comprobación', 'Expedientes']);
      expect(fix.nativeElement.querySelectorAll('.mg-etapa').length).toBe(0);
    });

    /**
     * Cada vale en UNA columna: el asignado, el que espera «Revisado» y el devuelto en
     * Solicitudes; los validados en Expedientes, sin importar qué diga Kepler de ellos.
     */
    it('cada vale cae en su columna, y en una sola', () => {
      montar(CON_ETAPAS());
      expect(folios('solicitudes').sort()).toEqual(['0001', '0006', '0009946']);
      expect(folios('comprobacion')).toEqual([]);
      expect(folios('expedientes').sort()).toEqual(['0002', '0003', '0004', '0005']);
      expect(fix.nativeElement.querySelectorAll('.mg-item').length).toBe(7);
    });

    /** ⭐ Lo que te toca va en rojo: el asignado y el devuelto. El que espera, no. */
    it('lo que te toca va marcado en rojo; lo que espera, no', () => {
      montar(CON_ETAPAS());
      const rojos = [...fix.nativeElement.querySelectorAll('.mg-item.rojo .mg-folio')]
        .map((e) => ((e as HTMLElement).textContent || '').trim()).sort();
      expect(rojos).toEqual(['0006', '0009946']);
      expect(c.teTocan()).toBe(2);
    });

    /** Camino B: el aprobado que debe su factura va a la columna 2, arriba. */
    it('el aprobado que debe la factura cae en Pendientes de comprobación', () => {
      montar({ ...REPORTE(), asignados: [],
        rows: [FILA({ id: 'z', status: 'aprobada', folio_solicitud: '0097020', provisional: true })],
      } as unknown as ExpenseProofsReport);
      expect(folios('comprobacion')).toEqual(['0097020']);
    });

    /**
     * ⛔ «Pagados» hoy siempre vacío, y lo DICE: el pago XD2601 no trae a qué gasto paga.
     * Dibujar un pagado sin esa liga sería inventar el dato.
     */
    it('⛔ «Pagados» vacío explica por qué, no dibuja pagos', () => {
      montar(CON_ETAPAS());
      const col = fix.nativeElement.querySelector('[data-col="expedientes"]') as HTMLElement;
      expect(col.textContent).toContain('XD2601 aún no se puede ligar');
    });

    /** Abajo se agrupa por la CLAVE de proveedor de Kepler (decisión del usuario). */
    it('lo que espera se agrupa por la clave de proveedor de Kepler', () => {
      montar({ ...REPORTE(), asignados: [], rows: [
        FILA({ id: 'r1', status: 'recibida', folio_solicitud: '0101', proveedor_clave: 'GS0044', proveedor_nombre: 'ACEROS' }),
        FILA({ id: 'r2', status: 'recibida', folio_solicitud: '0102', proveedor_clave: 'GS0044', proveedor_nombre: 'ACEROS' }),
      ] } as unknown as ExpenseProofsReport);
      const grupos = fix.nativeElement.querySelectorAll('[data-col="solicitudes"] .mg-grupo');
      expect(grupos.length).toBe(1);
      expect((grupos[0] as HTMLElement).textContent).toContain('GS0044');
      expect((grupos[0] as HTMLElement).querySelectorAll('.mg-item').length).toBe(2);
    });

    /** `[GX.65.3]` El gasto de Kepler se muestra como DATO, sin mover el vale. */
    it('el XA1001 ligado se muestra como dato', () => {
      montar({ ...REPORTE(), asignados: [], rows: [
        FILA({ id: 'v', status: 'validada', folio_solicitud: '0097012', gasto_folios: ['0097093'] }),
      ] } as unknown as ExpenseProofsReport);
      expect(fix.nativeElement.textContent).toContain('Kepler: XA1001-0097093');
      expect(folios('expedientes')).toEqual(['0097012']);
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

    /**
     * `[GX.54/55]` — **El vale aprobado que debe su comprobante también ofrece el camino.**
     *
     * ⛔ Reportado en pantalla: el vale decía «Aprobado» con el chip «te toca subir la factura
     * del pago»… y no había por dónde. El visor decía «este vale ya se resolvió» y la lista no
     * ofrecía nada. La tarea existía y el camino no.
     */
    describe('[GX.54/55] el vale que debe su factura', () => {
      const DEBE = () => ({
        ...REPORTE(),
        asignados: [],
        rows: [FILA({
          id: 'z', status: 'aprobada', folio_solicitud: '0097001', sucursal: '00',
          etapa: 'en_captura', etapa_label: 'En tramite', provisional: true,
        })],
      }) as unknown as ExpenseProofsReport;

      it('⭐ ofrece el botón, y dice que es la FACTURA', () => {
        montar(DEBE());
        const a = fix.nativeElement.querySelector('.mg-asig-b') as HTMLAnchorElement;
        expect(a).toBeTruthy();
        expect(a.textContent).toContain('Subir la factura');
        expect(a.getAttribute('href')).toContain('folio=0097001');
        expect(a.getAttribute('href')).toContain('sucursal=00');
      });

      /**
       * ⚠️ «Subir la evidencia» a secas se lee como que no se recibió nada — y la persona ya
       * subió algo. Lo que falta es la factura del pago, y el texto lo dice.
       */
      it('el chip nombra la factura, no «la evidencia»', () => {
        montar(DEBE());
        const txt = fix.nativeElement.textContent as string;
        expect(txt).toContain('te toca subir la factura del pago');
        expect(txt).not.toContain('te toca subir la evidencia');
      });

      /** Sin la marca, el mismo estado pide «la evidencia»: es el camino de siempre. */
      it('aprobado SIN deber factura dice «la evidencia»', () => {
        montar({
          ...REPORTE(), asignados: [],
          rows: [FILA({ id: 'z', status: 'aprobada', folio_solicitud: '0002', etapa: 'en_captura', provisional: false })],
        } as unknown as ExpenseProofsReport);
        const txt = fix.nativeElement.textContent as string;
        expect(txt).toContain('te toca subir la evidencia');
        expect((fix.nativeElement.querySelector('.mg-asig-b') as HTMLElement).textContent).toContain('Subir evidencia');
      });

      /**
       * ⛔ **La prueba negativa que sostiene el botón**: en cualquier otro estado NO se ofrece.
       * La captura sólo abre en modo evidencia sobre `aprobada`; ofrecerlo en un vale ya
       * cerrado llevaría a una pantalla que no deja hacer nada.
       */
      it.each(['recibida', 'validada', 'rechazada', 'revision'])('en «%s» NO se ofrece', (status) => {
        montar({
          ...REPORTE(), asignados: [],
          rows: [FILA({ id: 'z', status, folio_solicitud: '0003', etapa: 'en_captura', provisional: true })],
        } as unknown as ExpenseProofsReport);
        expect(fix.nativeElement.querySelector('.mg-asig-b')).toBeNull();
      });
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
     * `[GX.65.5]` La columna sale del ESTADO, no de la etapa de Kepler: un servidor que no
     * manda `etapa` igual ubica cada vale.
     */
    it('sin etapa resuelta, cada vale igual cae en su columna', () => {
      montar(REPORTE());
      expect(folios('solicitudes')).toEqual(['0049641']);
      expect(folios('expedientes')).toEqual(['0049651']);
    });

    /** ⛔ Un estado desconocido se DICE arriba; no se mete callado en una columna. */
    it('⛔ un estado que no sabe ubicar lo avisa', () => {
      montar({ ...REPORTE(), asignados: [], rows: [FILA({ id: 'x', status: 'inventado' })] } as unknown as ExpenseProofsReport);
      expect(c.fueraDeColumnas()).toBe(1);
      expect(fix.nativeElement.textContent).toContain('no sabe ubicar');
    });

    /** Un servidor viejo no manda `asignados`: no puede romper la pantalla. */
    it('sin el campo en la respuesta, la pantalla sigue viva', () => {
      montar(REPORTE());
      expect(c.asignados()).toEqual([]);
      expect(fix.nativeElement.querySelectorAll('.mg-item').length).toBe(2);
    });
  });
});
