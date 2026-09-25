import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  FinanzasAprobacionGastosComponent, isoADiaLocal, sumarDias,
} from './finanzas-aprobacion-gastos.component';
import type { ExpedienteDelDia, GastosDelDia } from '../comprobaciones.service';

/**
 * `[GX.20]` Candado de la pantalla de **Aprobación de gastos**.
 *
 * Además de comprobar el comportamiento, **compila el template**: `tsc` no mira adentro de
 * una plantilla de Angular, y montar el componente es la única compuerta de este lado.
 *
 * Lo que cuida de fondo es lo que haría desaparecer trabajo o mostrar un número equivocado:
 * que una pestaña no se trague expedientes de otra, que «Todos» no esconda un estado que no
 * conocemos, que el día no se corra por zona horaria, y que un error no se lea como «no hay
 * nada que aprobar».
 */

const F = (over: Partial<ExpedienteDelDia> = {}): ExpedienteDelDia => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  folio_solicitud: '0009678',
  sucursal: '00',
  fecha_gasto: '2026-09-25',
  created_at: '2026-09-25',
  created_hora: '09:41',
  importe: 100,
  departamento: 'LOGISTICA',
  solicitante: 'LEONARDO CAZARES',
  concepto: 'Casetas ruta norte',
  proveedor: 'CAPUFE',
  clasificacion: 'fiscal',
  forma_pago: 'efectivo',
  forma_pago_detalle: 'caja chica',
  comentarios: null,
  created_by: 'maria.tesoreria',
  status: 'recibida',
  etapa: 'aprobar',
  motivo_rechazo: null,
  revision_nota: null,
  validated_by: null,
  validated_at: null,
  requiere_evidencia: true,
  tiene_evidencia: false,
  evidencia_en_vivo: true,
  files: [{ role: 'comprobante_1', url: 'https://ejemplo/x.jpg' }],
  ...over,
});

const DIA = (over: Partial<GastosDelDia> = {}): GastosDelDia => ({
  fecha: '2026-09-25',
  es_hoy: true,
  hoy: '2026-09-25',
  fecha_pedida: null,
  total: 4,
  monto_total: 460,
  etapas: {
    aprobar: { n: 2, monto: 150 },
    ejercer: { n: 1, monto: 300 },
    cerrado: { n: 1, monto: 10 },
    sin_etapa: { n: 0, monto: 0 },
  },
  filas: [
    F({ id: 'a1', status: 'recibida', etapa: 'aprobar', importe: 100, departamento: 'LOGISTICA' }),
    F({ id: 'a2', status: 'recibida', etapa: 'aprobar', importe: 50, departamento: 'SISTEMAS' }),
    F({ id: 'e1', status: 'aprobada', etapa: 'ejercer', importe: 300, tiene_evidencia: false }),
    F({ id: 'c1', status: 'validada', etapa: 'cerrado', importe: 10, validated_by: 'maria', tiene_evidencia: true }),
  ],
  aprobar: {
    total: 2, monto_total: 150,
    por_fecha: [{ clave: '2026-09-25', etiqueta: '2026-09-25', n: 2, monto: 150, ids: ['a1', 'a2'] }],
    por_departamento: [
      { clave: 'LOGISTICA', etiqueta: 'LOGISTICA', origen: 'capturado', n: 1, monto: 100, ids: ['a1'] },
      { clave: 'SISTEMAS', etiqueta: 'SISTEMAS', origen: 'capturado', n: 1, monto: 50, ids: ['a2'] },
    ],
  },
  dias_recientes: [
    { dia: '2026-09-25', n: 4, monto: 460, pendientes: 2 },
    { dia: '2026-09-24', n: 3, monto: 900, pendientes: 1 },
    { dia: '2026-09-23', n: 1, monto: 20, pendientes: 0 },
  ],
  pendientes_fuera_del_dia: { n: 0, monto: 0 },
  ...over,
});

describe('[GX.20] la fecha no se corre de día', () => {
  /**
   * ⭐ `new Date('2026-09-25')` es medianoche UTC; en México (−06:00) eso es el 24 a las
   * 18:00, y el pipe imprimiría «24 sep». Es la trampa que la Fase LC.16 ya pagó.
   */
  it('una fecha ISO se vuelve ESE día, no el anterior', () => {
    const d = isoADiaLocal('2026-09-25');
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(8); // septiembre
    expect(d?.getDate()).toBe(25);
  });

  it('lo que no es una fecha devuelve null en vez de una fecha inventada', () => {
    for (const v of ['', 'hoy', '25/09/2026', 'Thu Sep 24']) expect(isoADiaLocal(v)).toBeNull();
  });

  it('correr días respeta fin de mes y fin de año', () => {
    expect(sumarDias('2026-09-25', 1)).toBe('2026-09-26');
    expect(sumarDias('2026-09-25', -1)).toBe('2026-09-24');
    expect(sumarDias('2026-09-30', 1)).toBe('2026-10-01');
    expect(sumarDias('2026-01-01', -1)).toBe('2025-12-31');
    expect(sumarDias('2028-02-28', 1)).toBe('2028-02-29'); // bisiesto
  });

  /** ⚠️ El cambio de horario da días de 23 o 25 horas: moverse en UTC evita repetir o saltar uno. */
  it('el cambio de horario no repite ni saltea un día', () => {
    expect(sumarDias('2026-04-05', 1)).toBe('2026-04-06');
    expect(sumarDias('2026-10-25', 1)).toBe('2026-10-26');
  });

  it('una fecha ilegible se devuelve tal cual, no se inventa una', () => {
    expect(sumarDias('nada', 1)).toBe('nada');
  });
});

describe('FinanzasAprobacionGastosComponent', () => {
  let fix: ComponentFixture<FinanzasAprobacionGastosComponent>;
  let c: FinanzasAprobacionGastosComponent;
  let http: HttpTestingController;

  const montar = (d: GastosDelDia | null = DIA()) => {
    fix = TestBed.createComponent(FinanzasAprobacionGastosComponent);
    c = fix.componentInstance;
    const req = http.expectOne((r) => r.url.includes('/finance/expenses/proofs/del-dia'));
    if (d) req.flush(d); else req.flush('boom', { status: 500, statusText: 'Server Error' });
    fix.detectChanges();
    return req;
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FinanzasAprobacionGastosComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('monta y arranca en la pestaña que espera firma', () => {
    montar();
    expect(c.pestana()).toBe('aprobar');
    expect(fix.nativeElement.textContent).toContain('Aprobación de gastos');
  });

  it('el primer pedido es HOY: no manda fecha, porque el día lo decide el servidor', () => {
    const req = montar();
    expect(req.request.params.has('fecha')).toBe(false);
  });

  describe('las tres pestañas', () => {
    it('cada pestaña cuenta lo suyo, y «Todos» cuenta el día entero', () => {
      montar();
      expect(c.conteo('aprobar')).toEqual({ n: 2, monto: 150 });
      expect(c.conteo('ejercer')).toEqual({ n: 1, monto: 300 });
      expect(c.conteo('todos')).toEqual({ n: 4, monto: 460 });
    });

    it('Aprobar sólo muestra lo que espera firma', () => {
      montar();
      expect(c.visibles().map((f) => f.id)).toEqual(['a1', 'a2']);
    });

    it('Ejercer muestra lo aprobado que todavía no cierra', () => {
      montar();
      c.verPestana('ejercer');
      expect(c.visibles().map((f) => f.id)).toEqual(['e1']);
    });

    it('Todos muestra el día entero, incluido lo ya cerrado', () => {
      montar();
      c.verPestana('todos');
      expect(c.visibles().map((f) => f.id)).toEqual(['a1', 'a2', 'e1', 'c1']);
    });

    /**
     * ⛔ Un estado que el servidor no reconoció cae en `sin_etapa`. No aparece en ninguna
     * pestaña de trabajo — pero **tiene** que seguir existiendo en «Todos», o el expediente
     * no existiría en ninguna pantalla.
     */
    it('«Todos» no esconde un estado desconocido', () => {
      montar(DIA({
        total: 1, monto_total: 7,
        etapas: { aprobar: { n: 0, monto: 0 }, ejercer: { n: 0, monto: 0 }, cerrado: { n: 0, monto: 0 }, sin_etapa: { n: 1, monto: 7 } },
        filas: [F({ id: 'raro', status: 'pagada', etapa: 'sin_etapa', importe: 7 })],
        aprobar: { total: 0, monto_total: 0, por_fecha: [], por_departamento: [] },
      }));
      expect(c.visibles()).toEqual([]);              // Aprobar
      c.verPestana('ejercer');
      expect(c.visibles()).toEqual([]);
      c.verPestana('todos');
      expect(c.visibles().map((f) => f.id)).toEqual(['raro']);
      fix.detectChanges();
      expect(fix.nativeElement.textContent).toContain('estado desconocido');
    });
  });

  describe('el filtro por departamento', () => {
    it('recorta la lista de lo que se firma', () => {
      montar();
      c.grupo.set('LOGISTICA');
      expect(c.visibles().map((f) => f.id)).toEqual(['a1']);
    });

    /** Arrastrarlo a otra pestaña dejaría la lista recortada sin que se vea por qué. */
    it('se suelta al cambiar de pestaña', () => {
      montar();
      c.grupo.set('LOGISTICA');
      c.verPestana('ejercer');
      expect(c.grupo()).toBeNull();
      expect(c.visibles().map((f) => f.id)).toEqual(['e1']);
    });

    it('un grupo que ya no existe no vacía la lista', () => {
      montar();
      c.grupo.set('FANTASMA');
      expect(c.visibles().map((f) => f.id)).toEqual(['a1', 'a2']);
    });
  });

  describe('moverse de día', () => {
    it('el día anterior pide esa fecha', () => {
      montar();
      c.mover(-1);
      const req = http.expectOne((r) => r.url.includes('/del-dia') && r.params.get('fecha') === '2026-09-24');
      req.flush(DIA({ fecha: '2026-09-24', es_hoy: false }));
      expect(c.fechaActiva()).toBe('2026-09-24');
    });

    /** No hay levantamientos de mañana, y una pantalla vacía se leería como «no hay nada». */
    it('no se puede pasar de hoy', () => {
      montar();
      c.mover(1);
      http.expectNone((r) => r.url.includes('/del-dia'));
      expect(c.fechaActiva()).toBe('2026-09-25');
    });

    it('«ir a hoy» vuelve a pedir sin fecha', () => {
      montar(DIA({ fecha: '2026-09-20', es_hoy: false }));
      c.irAHoy();
      const req = http.expectOne((r) => r.url.includes('/del-dia'));
      expect(req.request.params.has('fecha')).toBe(false);
      req.flush(DIA());
    });

    it('pedir el día que ya se está viendo no dispara otro viaje', () => {
      montar();
      c.irADia('2026-09-25');
      http.expectNone((r) => r.url.includes('/del-dia'));
    });
  });

  describe('lo que la pantalla no puede callar', () => {
    /**
     * ⭐ Acotar por día no puede esconder trabajo: si quedaron firmas pendientes de otros
     * días, la pestaña que firma lo dice con su monto.
     */
    it('avisa cuando otros días esperan firma', () => {
      montar(DIA({ pendientes_fuera_del_dia: { n: 7, monto: 12_345.67 } }));
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('7');
      expect(txt).toContain('$12,345.67');
    });

    it('ese aviso es de la pestaña que firma, no de las otras', () => {
      montar(DIA({ pendientes_fuera_del_dia: { n: 7, monto: 12_345.67 } }));
      c.verPestana('todos');
      fix.detectChanges();
      expect(fix.nativeElement.textContent).not.toContain('esperando firma');
    });

    /** Un parámetro roto no puede verse igual que un día sin movimiento. */
    it('declara que la fecha pedida era ilegible', () => {
      montar(DIA({ fecha_pedida: '25/09/2026' }));
      expect(fix.nativeElement.textContent).toContain('no es una fecha');
    });

    /**
     * ⛔ Un error NO se pinta como «ese día no se levantó nada»: es otra afirmación, y la
     * equivocada deja dinero esperando sin que nadie lo sepa.
     */
    it('un error se dice, no se disfraza de día vacío', () => {
      montar(null);
      const txt = fix.nativeElement.textContent as string;
      expect(c.error()).toBeTruthy();
      expect(txt).toContain('No se pudo cargar el día');
      expect(txt).not.toContain('no se levantó ningún gasto');
    });

    it('un día sin movimiento lo dice con todas las letras', () => {
      montar(DIA({
        total: 0, monto_total: 0, filas: [],
        etapas: { aprobar: { n: 0, monto: 0 }, ejercer: { n: 0, monto: 0 }, cerrado: { n: 0, monto: 0 }, sin_etapa: { n: 0, monto: 0 } },
        aprobar: { total: 0, monto_total: 0, por_fecha: [], por_departamento: [] },
      }));
      expect(fix.nativeElement.textContent).toContain('no se levantó ningún gasto');
    });

    /** Las dos fechas son cosas distintas: cuándo se levantó y cuándo ocurrió el gasto. */
    it('cuando el gasto es de otro día, lo muestra aparte', () => {
      montar(DIA({ filas: [F({ id: 'a1', created_at: '2026-09-25', fecha_gasto: '2026-09-18' })] }));
      expect(fix.nativeElement.textContent).toContain('gasto del 18/09/26');
    });

    it('marca el expediente que sigue esperando su evidencia', () => {
      montar(DIA({ filas: [F({ id: 'e1', status: 'aprobada', etapa: 'ejercer', requiere_evidencia: true, tiene_evidencia: false })] }));
      c.verPestana('ejercer');
      fix.detectChanges();
      expect(fix.nativeElement.textContent).toContain('falta la evidencia');
    });
  });

  describe('las acciones', () => {
    it('aprobar llama a su endpoint y recarga el día', () => {
      montar();
      c.aprobar(c.visibles()[0]);
      http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/a1/approve')).flush({ ok: true });
      http.expectOne((r) => r.url.includes('/del-dia')).flush(DIA());
      expect(c.actuando()).toBeNull();
    });

    it('«dar por comprobado» es validate, el mismo que resuelve lo que no cuadró', () => {
      montar();
      c.verPestana('ejercer');
      c.darPorComprobado(c.visibles()[0]);
      http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/e1/validate')).flush({ ok: true });
      http.expectOne((r) => r.url.includes('/del-dia')).flush(DIA());
    });

    /** Sin motivo, quien capturó recibe un «no» sin saber qué corregir. */
    it('rechazar sin motivo no manda nada', () => {
      montar();
      const orig = globalThis.prompt;
      globalThis.prompt = () => '';
      try { c.rechazar(c.visibles()[0]); } finally { globalThis.prompt = orig; }
      http.expectNone((r) => r.method === 'POST');
    });

    it('rechazar con motivo lo manda', () => {
      montar();
      const orig = globalThis.prompt;
      globalThis.prompt = () => 'falta el ticket';
      try { c.rechazar(c.visibles()[0]); } finally { globalThis.prompt = orig; }
      const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/a1/reject'));
      expect(req.request.body).toEqual({ motivo: 'falta el ticket' });
      req.flush({ ok: true });
      http.expectOne((r) => r.url.includes('/del-dia')).flush(DIA());
    });

    it('si la acción falla, la fila se desbloquea y no se recarga el día en falso', () => {
      montar();
      c.aprobar(c.visibles()[0]);
      http.expectOne((r) => r.url.endsWith('/a1/approve')).flush({ message: 'ya no está recibida' }, { status: 400, statusText: 'Bad Request' });
      expect(c.actuando()).toBeNull();
      http.expectNone((r) => r.url.includes('/del-dia'));
    });

    /** Lo cerrado no ofrece botones: no hay nada que hacerle. */
    it('un expediente cerrado no trae acciones', () => {
      montar(DIA({
        total: 1, filas: [F({ id: 'c1', status: 'validada', etapa: 'cerrado', validated_by: 'maria' })],
        etapas: { aprobar: { n: 0, monto: 0 }, ejercer: { n: 0, monto: 0 }, cerrado: { n: 1, monto: 10 }, sin_etapa: { n: 0, monto: 0 } },
        aprobar: { total: 0, monto_total: 0, por_fecha: [], por_departamento: [] },
      }));
      c.verPestana('todos');
      fix.detectChanges();
      expect(fix.nativeElement.textContent).toContain('sin acciones pendientes');
      expect(fix.nativeElement.textContent).toContain('Cerrado por maria');
    });
  });
});
