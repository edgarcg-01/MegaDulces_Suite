import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { provideHttpClient } from '@angular/common/http';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { FinanzasMisGastosComponent } from './finanzas-mis-gastos.component';
import type { ExpedienteDelDia, ExpenseProofsReport } from '../comprobaciones.service';
import { BuscadorGastosEstado } from '../components/buscador-gastos.estado';
import { PermissionsService } from '../../../core/services/permissions.service';

/**
 * `[GX.33]` / `[GX.97]` Candado de **Mis gastos**, la pantalla de quien LEVANTA el gasto.
 *
 * v2 (2026-11-06): una lista con un filtro por **a quién le toca** — Te toca · Esperan a Finanzas ·
 * Esperan a Kepler · Cerrados. Lo que cuida: que no afirme lo que no sabe (un error no es «no
 * levantaste nada», un corte se declara), que lo terminado salga aunque Kepler haya cancelado la
 * solicitud (`[GX.92]`), y que el recorte a lo propio no viva acá.
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
  rows: [FILA(), FILA({ id: 'p2', status: 'validada', folio_solicitud: '0049651', etapa: 'ejercido', gasto_folios: ['0008879'] })],
  ...over,
});

describe('FinanzasMisGastosComponent', () => {
  let fix: ComponentFixture<FinanzasMisGastosComponent>;
  let c: FinanzasMisGastosComponent;
  let http: HttpTestingController;
  let queryVale: string | null = null;

  beforeAll(() => registerLocaleData(localeEsMx));

  beforeEach(() => {
    queryVale = null;
    TestBed.configureTestingModule({
      imports: [FinanzasMisGastosComponent],
      // `[GX.41]` El router va de verdad: los botones son `routerLink` con queryParams, y con un
      // doble no se podría comprobar que el folio Y la sucursal viajan.
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), { provide: LOCALE_ID, useValue: 'es-MX' },
        BuscadorGastosEstado,
        { provide: ActivatedRoute, useValue: { snapshot: { get queryParamMap() { return convertToParamMap(queryVale ? { vale: queryVale } : {}); } } } }],
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
  const txt = () => fix.nativeElement.textContent as string;
  const ver = (filtro: string) => { c.elegir(filtro); fix.detectChanges(); };

  /**
   * ⭐ El recorte a lo propio lo hace el SERVIDOR (`/mine`, por token). Si esta pantalla
   * pidiera la colección y filtrara acá, un error suyo mostraría el gasto ajeno.
   */
  it('pide /mine, no la colección', () => {
    const req = montar();
    expect(req.request.method).toBe('GET');
    expect(req.request.url).toContain('/mine');
  });

  it('muestra lo levantado, con su folio y su proveedor', () => {
    montar();
    expect(txt()).toContain('0049641');
    expect(txt()).toContain('CAPUFE');
  });

  /** ⭐ La única acción primaria: antes «Mis gastos» no tenía entrada a la captura. */
  it('⭐ ofrece «Capturar gasto», que lleva a la captura', () => {
    montar();
    const a = fix.nativeElement.querySelector('a.mg-capturar') as HTMLAnchorElement;
    expect(a?.textContent).toContain('Capturar gasto');
    expect(a?.getAttribute('href')).toBe('/finanzas/gastos');
  });

  /** ⛔ Un error NO es «no levantaste nada»: esa afirmación manda a capturar de nuevo. */
  it('⛔ un error se dice, no se disfraza de lista vacía', () => {
    montar(null);
    expect(c.error()).not.toBe('');
    expect(txt()).toContain('No se pudieron cargar tus gastos');
    expect(txt()).not.toContain('Nada te toca');
  });

  describe('[GX.97] el filtro por a quién le toca', () => {
    const MEZCLA = () => REPORTE({
      rows: [
        FILA({ id: 'r1', status: 'rechazada', folio_solicitud: '0000001', motivo_rechazo: 'Falta la factura', sucursal: '02' }),
        FILA({ id: 'a1', status: 'aprobada', folio_solicitud: '0000002', provisional: true }),
        FILA({ id: 'e1', status: 'recibida', folio_solicitud: '0000003' }),
        FILA({ id: 'k1', status: 'validada', folio_solicitud: '0000004', etapa: 'autorizado', gasto_folios: [] }),
        FILA({ id: 'c1', status: 'validada', folio_solicitud: '0000005', etapa: 'cancelado_kepler', gasto_folios: [] }),
        FILA({ id: 'c2', status: 'validada', folio_solicitud: '0000006', etapa: 'ejercido', gasto_folios: ['0008879'] }),
      ],
      asignados: [{ sucursal: '00', folio: '0000007', fecha: '2026-10-01', importe: 100, solicita: 'X', destinatario: 'PROV ASIGNADO', concepto: 'C', estado: 'A', aplicada: false, vinculado_por: 'solicita' }],
    });

    it('cuenta cada lado, y el conteo va DENTRO del filtro', () => {
      montar(MEZCLA());
      expect(c.opciones().map((o) => [o.value, o.count])).toEqual([['tu', 3], ['finanzas', 1], ['kepler', 1], ['cerrado', 2]]);
    });

    it('arranca en lo que te toca, con la respuesta arriba', () => {
      montar(MEZCLA());
      expect(c.filtro()).toBe('tu');
      expect(txt()).toContain('Te tocan 3 vales.');
    });

    it('sin nada que te toque, arranca en el primer lado con algo (no obliga a dar un clic)', () => {
      montar(REPORTE({ rows: [FILA({ status: 'recibida' })] }));
      expect(c.filtro()).toBe('finanzas');
      expect(txt()).toContain('Nada te toca.');
    });

    it('el devuelto dice su motivo, en rojo, y ofrece capturarlo de nuevo con su folio y sucursal', () => {
      montar(MEZCLA());
      expect(txt()).toContain('Te lo devolvieron: Falta la factura. Captúralo de nuevo.');
      expect(fix.nativeElement.querySelector('.mg-mal')).not.toBeNull();
      const a = [...fix.nativeElement.querySelectorAll('a')].find((x) => (x as HTMLElement).textContent?.includes('Capturar de nuevo')) as HTMLAnchorElement;
      expect(a.getAttribute('href')).toContain('folio=0000001');
      expect(a.getAttribute('href')).toContain('sucursal=02');
    });

    it('el aprobado que debe la factura lo dice, y su botón es «Subir la factura»', () => {
      montar(MEZCLA());
      expect(txt()).toContain('Te toca subir la factura del pago');
      expect(txt()).toContain('Subir la factura');
    });

    it('[GX.46] el asignado no abre el visor (no tiene expediente); ofrece subir la evidencia', () => {
      montar(MEZCLA());
      const folios = [...fix.nativeElement.querySelectorAll('button.mg-folio')].map((b) => (b as HTMLElement).textContent?.trim());
      expect(folios).not.toContain('0000007');
      expect(txt()).toContain('0000007');
      expect(txt()).toContain('Falta que subas la evidencia');
    });

    it('lo revisado sin gasto espera a Kepler y dice a qué', () => {
      montar(MEZCLA());
      ver('kepler');
      expect(txt()).toContain('0000004');
      expect(txt()).toContain('Autorizada: falta generar el gasto en Kepler');
    });

    /** ⭐ El defecto medido: la solicitud cancelada no cerraba nunca. */
    it('⭐ lo revisado con la solicitud cancelada en Kepler está en Cerrados, y dice por qué', () => {
      montar(MEZCLA());
      ver('cerrado');
      expect(txt()).toContain('0000005');
      expect(txt()).toContain('Solicitud cancelada en Kepler');
      expect(txt()).toContain('0000006');
      expect(txt()).toContain('XA1001-0008879');
    });

    it('lo que sigue sin cerrar suma te toca + Finanzas + Kepler, nunca lo cerrado', () => {
      montar(MEZCLA());
      // 4 filas abiertas de 387.25 + el asignado de 100
      expect(c.sinCerrar()).toBeCloseTo(387.25 * 4 + 100, 2);
    });

    it('⛔ un estado que no sabe ubicar lo avisa', () => {
      montar(REPORTE({ rows: [FILA({ status: 'raro' })] }));
      expect(txt()).toContain('con un estado que esta pantalla no sabe ubicar');
    });
  });

  /** `[GX.95]` Un corte se DICE. Sin el campo (servidor viejo) no se afirma nada. */
  describe('[GX.95] los cortes declarados', () => {
    it('cerrados recortados: lo dice, con el total del servidor', () => {
      montar(REPORTE({ cerrados_truncados: true, kpis: { total: 400, recibidas: 0, validadas: 354, rechazadas: 0 } }));
      expect(txt()).toContain('hay 354 en total');
    });

    it('asignados recortados: lo dice', () => {
      montar(REPORTE({ asignados_truncados: true }));
      expect(txt()).toContain('Kepler te asignó más solicitudes de las que caben');
    });

    it('sin los campos no se afirma ni que está completa ni que está cortada', () => {
      montar(REPORTE());
      expect(c.cortes()).toEqual([]);
    });
  });

  describe('[GX.97] la búsqueda', () => {
    it('quien sólo captura tiene su caja; espera a que deje de escribir', () => {
      vi.useFakeTimers();
      try {
        TestBed.inject(PermissionsService).load({ FINANCE_EXPENSES_CAPTURAR: true }, 'capturista', 'jwt');
        montar();
        expect(fix.nativeElement.querySelector('input[type=search]')).not.toBeNull();
        c.escribir('pape');
        c.escribir('papeleria');
        http.expectNone((x) => x.url.includes('/mine'));
        vi.advanceTimersByTime(450);
        const req = http.expectOne((x) => x.url.includes('/mine'));
        expect(req.request.params.get('search')).toBe('papeleria');
        req.flush(REPORTE());
      } finally { vi.useRealTimers(); }
    });

    /** `[GX.88]` Quien aprueba ya tiene el buscador de arriba: una sola caja por pestaña. */
    /** `[GX.101]` Quien aprueba tiene el buscador de gastos junto al título: UNA caja, no dos. */
    it('⛔ quien aprueba tiene UNA caja: la del buscador de gastos, junto al título', () => {
      TestBed.inject(PermissionsService).load({ FINANCE_EXPENSES_COMPROBAR: true }, 'tesoreria', 'jwt');
      montar();
      const cajas = fix.nativeElement.querySelectorAll('input[type=search]');
      expect(cajas.length).toBe(1);
      expect((cajas[0] as HTMLElement).closest('.surf-page-head app-buscador-gastos')).not.toBeNull();
    });
  });

  /** `[GX.91]` La captura manda aquí con ?vale=<id> cuando el folio ya tenía un vale tuyo. */
  it('[GX.91] con ?vale=<id> abre ese vale (si es tuyo, o sea si vino en la lista)', () => {
    queryVale = 'p1';
    montar();
    expect(c.abierto()?.id).toBe('p1');
  });

  it('[GX.91] con ?vale de un vale que no es tuyo no abre nada', () => {
    queryVale = 'ajeno';
    montar();
    expect(c.abierto()).toBeNull();
  });

  /**
   * `[GX.73]` **El refresco en segundo plano.** Que refresque, que NO parpadee ni pise la lista
   * buena con un error, que no le cambie la fila a quien la está leyendo, que no se encimen dos
   * pedidos — y `[GX.97]` que un fallo se DIGA.
   */
  describe('[GX.73] el refresco en segundo plano', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const pedidoMine = () => http.expectOne((x) => x.url.includes('/finance/expenses/proofs/mine'));

    it('⭐ al minuto vuelve a pedir lo suyo y aplica el estado nuevo', () => {
      montar();
      vi.advanceTimersByTime(60_000);
      const req = pedidoMine();
      expect(c.cargando()).toBe(false); // sin aviso de carga: la lista no parpadea
      req.flush(REPORTE({ rows: [FILA({ status: 'aprobada' })] }));
      expect(c.filas()[0].status).toBe('aprobada');
    });

    it('⛔ con un vale abierto NO refresca (no le mueve la fila a quien la lee)', () => {
      montar();
      c.abrir(FILA());
      vi.advanceTimersByTime(60_000);
      http.expectNone((x) => x.url.includes('/mine'));
    });

    it('⛔ un refresco que falla NO pisa la lista buena, pero lo DICE', () => {
      montar();
      vi.advanceTimersByTime(60_000);
      pedidoMine().flush('boom', { status: 500, statusText: 'Server Error' });
      fix.detectChanges();
      expect(c.error()).toBe('');
      expect(c.filas().length).toBe(2);
      expect(txt()).toContain('No se pudo actualizar a las');
    });

    it('el siguiente refresco que sale bien quita el aviso', () => {
      montar();
      vi.advanceTimersByTime(60_000);
      pedidoMine().flush('boom', { status: 500, statusText: 'Server Error' });
      vi.advanceTimersByTime(60_000);
      pedidoMine().flush(REPORTE());
      expect(c.refrescoFallo()).toBeNull();
    });

    it('⛔ no encima dos refrescos: si el anterior sigue en vuelo, espera', () => {
      montar();
      vi.advanceTimersByTime(60_000);
      const primero = pedidoMine();
      vi.advanceTimersByTime(60_000);
      http.expectNone((x) => x.url.includes('/mine'));
      primero.flush(REPORTE());
    });
  });

  /**
   * `[GX.88]` **El buscador de gastos vive ARRIBA de las pestañas** (en el shell). En Mis gastos
   * sólo lo tiene quien aprueba; el vale elegido se abre aquí con lo que esta pantalla ofrece.
   */
  describe('[GX.88] el buscador de arriba', () => {
    const estado = () => TestBed.inject(BuscadorGastosEstado);
    const conPermiso = () => TestBed.inject(PermissionsService).load({ FINANCE_EXPENSES_COMPROBAR: true }, 'tesoreria', 'jwt');

    /** `[GX.101]` El encabezado (con la caja) se queda; lo de abajo se cambia por los resultados. */
    it('con una búsqueda activa, la lista se cambia por los resultados — el encabezado y el visor no', () => {
      conPermiso();
      montar();
      estado().busqueda.set('papeleria');
      fix.detectChanges();
      expect(c.buscandoArriba()).toBe(true);
      expect(fix.nativeElement.querySelector('.surf-page-head app-buscador-gastos')).not.toBeNull();
      expect(fix.nativeElement.querySelector('app-segmented')).toBeNull();
      expect(fix.nativeElement.querySelector('app-vale-gasto-peek')).not.toBeNull();
      estado().limpiar();
      fix.detectChanges();
      expect(fix.nativeElement.querySelector('app-segmented')).not.toBeNull();
    });

    it('⛔ quien sólo captura no busca: la pantalla nunca se esconde', () => {
      TestBed.inject(PermissionsService).load({ FINANCE_EXPENSES_CAPTURAR: true }, 'capturista', 'jwt');
      montar();
      estado().busqueda.set('papeleria');
      fix.detectChanges();
      expect(c.buscandoArriba()).toBe(false);
      expect(fix.nativeElement.querySelector('.surf-page-head')).not.toBeNull();
    });

    it('el vale elegido se abre aquí: se ve y se le puede sumar evidencia', () => {
      conPermiso();
      montar();
      estado().abrir({ id: 'x1', folio_solicitud: '0010287', status: 'aprobada', files: [] } as unknown as ExpedienteDelDia);
      expect(c.abierto()?.id).toBe('x1');
      expect(c.accionesDelVale()).toEqual(['agregar_evidencia']);
    });

    it('un rechazado elegido no ofrece sumar evidencia', () => {
      conPermiso();
      montar();
      estado().abrir({ id: 'x2', status: 'rechazada', files: [] } as unknown as ExpedienteDelDia);
      expect(c.accionesDelVale()).toEqual([]);
    });
  });

  /**
   * `[GX.106]` **La fecha en que se mandó, en vez de los días** (pedido del usuario, 2026-11-09: «lo de
   * días cámbialo por la fecha en que se mandó»). Los días quedan sólo para lo atorado, en palabras.
   */
  describe('[GX.106] la fecha en que se mandó', () => {
    const ASIGNADO = { sucursal: '00', folio: '0000007', fecha: '2026-10-01', importe: 100, solicita: 'X', destinatario: 'PROV ASIGNADO', concepto: 'C', estado: 'A', aplicada: false, vinculado_por: 'solicita' as const };
    const encabezados = () => [...fix.nativeElement.querySelectorAll('th')].map((t) => (t as HTMLElement).textContent?.trim());
    const fila = (folio: string) => [...fix.nativeElement.querySelectorAll('tbody tr')]
      .find((tr) => (tr as HTMLElement).textContent?.includes(folio)) as HTMLElement;
    const envio = (folio: string) => fila(folio).querySelector('.mg-c-env') as HTMLElement;
    const fecha = (folio: string) => envio(folio).querySelector('.mg-fecha')?.textContent?.trim();

    it('la columna dice «Se mandó» con la fecha; ya no hay «Días»', () => {
      montar(REPORTE({ rows: [FILA({ status: 'recibida', created_at: '2026-09-25T15:00:00.000Z' })] }));
      expect(encabezados()).toContain('Se mandó');
      expect(encabezados()).not.toContain('Días');
      expect(fecha('0049641')).toBe('25/09/26');
    });

    it('⛔ lo mandado en la noche es de ese día, no del siguiente (la marca llega en UTC)', () => {
      // 2026-10-02 03:30 UTC = 2026-10-01 21:30 en México.
      montar(REPORTE({ rows: [FILA({ status: 'recibida', created_at: '2026-10-02T03:30:00.000Z' })] }));
      expect(fecha('0049641')).toBe('01/10/26');
    });

    it('la fecha del gasto va rotulada; la solicitud de Kepler sin vale no la repite', () => {
      montar(REPORTE({
        rows: [FILA({ status: 'aprobada', fecha_gasto: '2026-09-20', created_at: '2026-09-25T15:00:00.000Z' })],
        asignados: [ASIGNADO],
      }));
      expect(fila('0049641').textContent).toContain('gastado el 20/09/26');
      expect(fecha('0049641')).toBe('25/09/26');
      expect(fecha('0000007')).toBe('01/10/26');
      expect(fila('0000007').textContent).not.toContain('gastado el');
    });

    it('[GX.108] la solicitud de Kepler capturada hoy con fecha vieja: «Se mandó» es la captura, y el documento sólo se muestra', () => {
      const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
      montar(REPORTE({ rows: [], asignados: [{ ...ASIGNADO, fecha: '2026-01-15', capturado: hoy }] }));
      const [a, m, d] = hoy.split('-');
      expect(fecha('0000007')).toBe(`${d}/${m}/${a.slice(2)}`);
      // ⛔ No «hace 300 días»: se mandó hoy.
      expect(envio('0000007').querySelector('.mg-atorado')).toBeNull();
      expect(fila('0000007').textContent).toContain('documento del 15/01/26');
    });

    it('[GX.108] sin fecha de captura (servidor viejo) se usa la del documento, y no se repite', () => {
      montar(REPORTE({ rows: [], asignados: [{ ...ASIGNADO, capturado: null }] }));
      expect(fecha('0000007')).toBe('01/10/26');
      expect(fila('0000007').textContent).not.toContain('documento del');
    });

    it('lo abierto de más de un mes dice cuántos días lleva, en palabras; lo reciente, no', () => {
      montar(REPORTE({ rows: [
        FILA({ id: 'v', status: 'recibida', folio_solicitud: '0000111', created_at: '2026-01-05T15:00:00.000Z' }),
        FILA({ id: 'n', status: 'recibida', folio_solicitud: '0000222', created_at: new Date().toISOString() }),
      ] }));
      expect(envio('0000111').querySelector('.mg-atorado')?.textContent).toMatch(/hace \d+ días/);
      expect(envio('0000222').querySelector('.mg-atorado')).toBeNull();
    });

    it('⛔ lo cerrado no está atorado aunque sea viejo', () => {
      montar(REPORTE({ rows: [FILA({ id: 'c', status: 'validada', folio_solicitud: '0000333', etapa: 'ejercido', gasto_folios: ['0008879'], created_at: '2026-01-05T15:00:00.000Z' })] }));
      ver('cerrado');
      expect(fecha('0000333')).toBe('05/01/26');
      expect(envio('0000333').querySelector('.mg-atorado')).toBeNull();
    });

    it('lo abierto va del que se mandó primero al último: por la fecha que se ve', () => {
      montar(REPORTE({ rows: [
        // El gasto de «a» es más viejo, pero «b» se mandó antes: manda la fecha en que se mandó.
        FILA({ id: 'a', status: 'recibida', folio_solicitud: '0000444', fecha_gasto: '2026-09-01', created_at: '2026-10-05T15:00:00.000Z' }),
        FILA({ id: 'b', status: 'recibida', folio_solicitud: '0000555', fecha_gasto: '2026-09-20', created_at: '2026-09-21T15:00:00.000Z' }),
      ] }));
      expect(c.visibles().map((f) => f.folio)).toEqual(['0000555', '0000444']);
    });
  });
});
