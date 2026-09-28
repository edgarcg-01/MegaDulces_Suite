import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { provideHttpClient } from '@angular/common/http';
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
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: LOCALE_ID, useValue: 'es-MX' }],
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
});
