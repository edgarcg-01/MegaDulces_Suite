import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { BuscadorGastosComponent } from './buscador-gastos.component';
import { BuscadorGastosEstado } from './buscador-gastos.estado';
import { PermissionsService } from '../../../core/services/permissions.service';
import type { ExpedienteDelDia, ResultadoBusquedaGastos } from '../comprobaciones.service';

/**
 * `[GX.88]` **El buscador de gastos**, compartido por Aprobación, Historial y Expediente.
 * Pedido del usuario (2026-10-30): folios, nombre, quién lo levantó, quién lo aprobó, y las
 * solicitudes de Kepler que nunca se subieron. Sólo para quien tiene permiso de aprobar.
 */
const V = (over: Partial<ExpedienteDelDia> = {}): ExpedienteDelDia => ({
  id: 'v1', folio_solicitud: '0010287', sucursal: '00', fecha_gasto: '2026-10-12', created_at: '2026-10-12',
  created_hora: '10:00', importe: 72899.91, departamento: 'COMPRAS', solicitante: 'SOLICITANTE DEMO',
  concepto: 'Mantenimiento', proveedor: 'PROVEEDOR DEMO', clasificacion: 'fiscal', forma_pago: 'efectivo',
  forma_pago_detalle: null, comentarios: null, created_by: 'demo.capturista', status: 'aprobada', etapa: 'aprobados',
  motivo_rechazo: null, revision_nota: null, validated_by: 'DEMO APROBADOR', validated_at: null,
  requiere_evidencia: true, tiene_evidencia: false, evidencia_en_vivo: false, files: [], ...over,
});

const RES = (over: Partial<ResultadoBusquedaGastos> = {}): ResultadoBusquedaGastos => ({
  q: 'papeleria',
  vales: [V(), V({ id: 'v2', folio_solicitud: '0009001', status: 'validada' })],
  vales_truncado: false,
  sin_vale: [{ sucursal: '00', folio: '0010570', fecha: '2026-10-28', importe: 1234.5,
    solicitante: 'FINANZAS', beneficiario: 'PROVEEDOR X', concepto: 'Fletes', estado: 'F' }],
  sin_vale_truncado: false,
  solicitudes_desde: '2026-08-21',
  ...over,
});

describe('[GX.88] BuscadorGastosComponent', () => {
  let fix: ComponentFixture<BuscadorGastosComponent>;
  let c: BuscadorGastosComponent;
  let http: HttpTestingController;

  const montar = (permisos: Record<string, boolean> = { FINANCE_EXPENSES_COMPROBAR: true }) => {
    TestBed.inject(PermissionsService).load(permisos, 'tesoreria', 'jwt');
    fix = TestBed.createComponent(BuscadorGastosComponent);
    c = fix.componentInstance;
    fix.detectChanges();
  };
  const pedido = () => http.expectOne((r) => r.url.includes('/finance/expenses/proofs/buscar'));
  const buscar = (q: string) => { c.escribir(q); c.buscarYa(); };
  const txt = () => fix.nativeElement.textContent as string;
  const estado = () => TestBed.inject(BuscadorGastosEstado);

  beforeAll(() => registerLocaleData(localeEsMx));
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [BuscadorGastosComponent],
      // El estado lo provee el shell de Gastos; aquí, el módulo de prueba (la misma instancia que inyecta el componente).
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: LOCALE_ID, useValue: 'es-MX' }, BuscadorGastosEstado],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  /** ⛔ NEGATIVA: sin permiso de aprobar no hay buscador (el servidor además da 403). */
  it('⛔ sin permiso de aprobar no aparece, y nunca dice que está buscando', () => {
    montar({ FINANCE_EXPENSES_VER: true });
    expect(c.puedeBuscar()).toBe(false);
    expect(fix.nativeElement.querySelector('input')).toBeNull();
    c.escribir('papeleria');
    expect(c.buscando()).toBe(false); // la página no esconde lo suyo por un buscador que no existe
    http.expectNone((r) => r.url.includes('/buscar'));
  });

  it('con permiso de aprobar aparece', () => {
    montar();
    expect(fix.nativeElement.querySelector('input[type=search]')).not.toBeNull();
  });

  it('busca en el servidor y pinta vales y solicitudes sin vale por separado', () => {
    montar();
    buscar('papeleria');
    const req = pedido();
    expect(req.request.params.get('q')).toBe('papeleria');
    req.flush(RES());
    fix.detectChanges();
    expect(txt()).toContain('0010287');
    expect(txt()).toContain('cerrado por DEMO APROBADOR');
    expect(txt()).toContain('Solicitudes de Kepler sin vale');
    expect(txt()).toContain('0010570');
    expect(txt()).toContain('sin vale en la Suite');
    expect(txt()).toContain('aplicada en Kepler');
    // Dice desde cuándo busca en Kepler: antes de la Suite, «sin vale» no es pendiente.
    expect(txt()).toContain('21/08/26');
  });

  it('al elegir un vale lo pasa al estado: qué se hace con él lo decide la pantalla de la pestaña', () => {
    montar();
    const elegidos: ExpedienteDelDia[] = [];
    estado().aperturas$.subscribe((v) => elegidos.push(v));
    buscar('papeleria');
    pedido().flush(RES());
    fix.detectChanges();
    (fix.nativeElement.querySelector('.bg-item[role=button]') as HTMLElement).click();
    expect(elegidos.map((v) => v.id)).toEqual(['v1']);
    // La solicitud sin vale no se abre: no hay expediente que mirar.
    expect(fix.nativeElement.querySelector('.bg-sinvale')?.getAttribute('role')).toBeNull();
  });

  it('una búsqueda muy corta no consulta, y lo dice', () => {
    montar();
    buscar('a');
    http.expectNone((r) => r.url.includes('/buscar'));
    fix.detectChanges();
    expect(txt()).toContain('Escribe al menos 2 letras');
  });

  it('un solo dígito sí busca: es un folio', () => {
    montar();
    buscar('7');
    pedido().flush(RES({ q: '7', vales: [], sin_vale: [] }));
  });

  /** ⛔ Un error NO se lee como «no hay resultados»: son dos afirmaciones distintas. */
  it('⛔ un error se dice, no se disfraza de búsqueda vacía', () => {
    montar();
    buscar('papeleria');
    pedido().flush('boom', { status: 500, statusText: 'Server Error' });
    fix.detectChanges();
    expect(txt()).toContain('No se pudo buscar');
    expect(txt()).not.toContain('Ningún vale coincide');
  });

  it('sin resultados lo dice con todas las letras', () => {
    montar();
    buscar('zz-no-existe');
    pedido().flush(RES({ q: 'zz-no-existe', vales: [], sin_vale: [] }));
    fix.detectChanges();
    expect(txt()).toContain('Ningún vale coincide con «zz-no-existe»');
    expect(txt()).toContain('Ninguna solicitud sin vale coincide');
  });

  it('⛔ una lista cortada lo declara', () => {
    montar();
    buscar('gasolina');
    pedido().flush(RES({ vales_truncado: true, sin_vale_truncado: true }));
    fix.detectChanges();
    expect(txt()).toContain('Hay más vales que coinciden');
    expect(txt()).toContain('Puede haber más solicitudes');
  });

  /** ⛔ Una respuesta vieja que llega tarde no puede pisar la de la búsqueda nueva. */
  it('⛔ una respuesta vieja no pisa a la nueva', () => {
    montar();
    buscar('pape');
    const vieja = pedido();
    buscar('papeleria');
    const nueva = pedido();
    nueva.flush(RES({ q: 'papeleria' }));
    vieja.flush(RES({ q: 'pape', vales: [] }));
    expect(c.resultado()?.q).toBe('papeleria');
  });

  it('limpiar deja de buscar (la página vuelve a lo suyo)', () => {
    montar();
    buscar('papeleria');
    pedido().flush(RES());
    c.limpiar();
    expect(c.buscando()).toBe(false);
    expect(c.resultado()).toBeNull();
  });

  it('espera a que dejes de escribir: una consulta, no una por tecla', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      montar();
      c.escribir('ca');
      c.escribir('caz');
      c.escribir('papeleria');
      http.expectNone((r) => r.url.includes('/buscar'));
      vi.advanceTimersByTime(400);
      pedido().flush(RES());
    } finally { vi.useRealTimers(); }
  });

  it('rebuscar repite la búsqueda abierta; sin búsqueda no consulta', () => {
    montar();
    estado().rebuscar();
    http.expectNone((r) => r.url.includes('/buscar'));
    buscar('papeleria');
    pedido().flush(RES());
    estado().rebuscar();
    pedido().flush(RES());
  });

  it('conArchivos pone los archivos nuevos en el vale encontrado', () => {
    montar();
    buscar('papeleria');
    pedido().flush(RES());
    estado().conArchivos('v1', [{ role: 'adicional', url: 'https://firmada' }]);
    expect(c.resultado()?.vales[0].files).toEqual([{ role: 'adicional', url: 'https://firmada' }]);
  });
});
