import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { FinanzasAprobacionGastosComponent } from './finanzas-aprobacion-gastos.component';
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
  etapa: 'entrada',
  motivo_rechazo: null,
  revision_nota: null,
  validated_by: null,
  validated_at: null,
  requiere_evidencia: true,
  tiene_evidencia: false,
  evidencia_en_vivo: true,
  files: [{ role: 'comprobante_1', url: 'https://ejemplo/x.jpg', kind: 'image' }],
  ...over,
});

const DIA = (over: Partial<GastosDelDia> = {}): GastosDelDia => ({
  fecha: '2026-09-25',
  es_hoy: true,
  hoy: '2026-09-25',
  fecha_pedida: null,
  total: 5,
  monto_total: 485,
  etapas: {
    entrada: { n: 2, monto: 150 },
    aprobados: { n: 2, monto: 310 },
    rechazados: { n: 1, monto: 25 },
    sin_etapa: { n: 0, monto: 0 },
  },
  filas: [
    F({ id: 'a1', status: 'recibida', etapa: 'entrada', importe: 100, departamento: 'LOGISTICA' }),
    F({ id: 'a2', status: 'recibida', etapa: 'entrada', importe: 50, departamento: 'SISTEMAS' }),
    F({ id: 'e1', status: 'aprobada', etapa: 'aprobados', importe: 300, tiene_evidencia: false }),
    F({ id: 'c1', status: 'validada', etapa: 'aprobados', importe: 10, validated_by: 'maria', tiene_evidencia: true }),
    F({ id: 'r1', status: 'rechazada', etapa: 'rechazados', importe: 25, motivo_rechazo: 'falta el ticket' }),
  ],
  entrada: {
    total: 2, monto_total: 150,
    por_fecha: [{ clave: '2026-09-25', etiqueta: '2026-09-25', n: 2, monto: 150, ids: ['a1', 'a2'] }],
    por_departamento: [
      { clave: 'LOGISTICA', etiqueta: 'LOGISTICA', origen: 'capturado', n: 1, monto: 100, ids: ['a1'] },
      { clave: 'SISTEMAS', etiqueta: 'SISTEMAS', origen: 'capturado', n: 1, monto: 50, ids: ['a2'] },
    ],
  },
  pendientes_fuera_del_dia: { n: 0, monto: 0 },
  ...over,
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

  // El locale va como en `app.config.ts`. Sin esto el pipe de fecha corre en `en-US` y la
  // prueba comprobaria «Friday 25 de September» -- que no es lo que nadie ve en pantalla.
  beforeAll(() => registerLocaleData(localeEsMx));

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FinanzasAprobacionGastosComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: LOCALE_ID, useValue: 'es-MX' }],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('monta y arranca en la bandeja de entrada', () => {
    montar();
    expect(c.pestana()).toBe('entrada');
    expect(fix.nativeElement.textContent).toContain('Aprobación de gastos');
    const tabs = [...fix.nativeElement.querySelectorAll('.ap-tab-t')].map((e: Element) => e.textContent?.trim());
    expect(tabs).toEqual(['Bandeja de entrada', 'Aprobados', 'Rechazados']);
  });

  describe('las tres pestañas', () => {
    it('cada pestaña cuenta lo suyo', () => {
      montar();
      expect(c.conteo('entrada')).toEqual({ n: 2, monto: 150 });
      expect(c.conteo('aprobados')).toEqual({ n: 2, monto: 310 });
      expect(c.conteo('rechazados')).toEqual({ n: 1, monto: 25 });
    });

    /**
     * ⭐ Sin «Todos», los tres contadores son lo único que dice cuánto hubo. Si no suman el
     * día, hay expedientes que no aparecen en ninguna cuenta.
     */
    it('los tres contadores suman el día completo', () => {
      montar();
      const t = (['entrada', 'aprobados', 'rechazados'] as const).map((p) => c.conteo(p));
      expect(t.reduce((a, x) => a + x.n, 0)).toBe(5);
      expect(Math.round(t.reduce((a, x) => a + x.monto, 0) * 100) / 100).toBe(485);
    });

    it('la bandeja de entrada sólo muestra lo que espera decisión', () => {
      montar();
      expect(c.visibles().map((f) => f.id)).toEqual(['a1', 'a2']);
    });

    /** Los tres momentos del cierre viven juntos: la decisión fue una sola. */
    it('Aprobados junta lo que falta ejercer con lo ya cerrado', () => {
      montar();
      c.verPestana('aprobados');
      expect(c.visibles().map((f) => f.id)).toEqual(['e1', 'c1']);
    });

    it('Rechazados muestra lo rechazado, con su motivo', () => {
      montar();
      c.verPestana('rechazados');
      expect(c.visibles().map((f) => f.id)).toEqual(['r1']);
      fix.detectChanges();
      expect(fix.nativeElement.textContent).toContain('falta el ticket');
    });

    /**
     * ⛔ Un estado que el servidor no reconoció cae en `sin_etapa`. No aparece en ninguna
     * pestaña de trabajo — pero **tiene** que seguir existiendo en «Todos», o el expediente
     * no existiría en ninguna pantalla.
     */
    it('un estado desconocido no desaparece: entra por la bandeja de entrada, y marcado', () => {
      montar(DIA({
        total: 1, monto_total: 7,
        etapas: { entrada: { n: 0, monto: 0 }, aprobados: { n: 0, monto: 0 }, rechazados: { n: 0, monto: 0 }, sin_etapa: { n: 1, monto: 7 } },
        filas: [F({ id: 'raro', status: 'pagada', etapa: 'sin_etapa', importe: 7 })],
        entrada: { total: 0, monto_total: 0, por_fecha: [], por_departamento: [] },
      }));
      expect(c.visibles().map((f) => f.id)).toEqual(['raro']);
      // Y se CUENTA: si no, el renglón estaría en la lista y el contador diría 0.
      expect(c.conteo('entrada')).toEqual({ n: 1, monto: 7 });
      c.verPestana('aprobados');
      expect(c.visibles()).toEqual([]);
      c.verPestana('rechazados');
      expect(c.visibles()).toEqual([]);
      c.verPestana('entrada');
      fix.detectChanges();
      expect(fix.nativeElement.textContent).toContain('estado desconocido');
    });

    /** ⛔ Un estado desconocido NO ofrece botones: no se sabe qué se le puede hacer. */
    it('un estado desconocido no ofrece acciones', () => {
      montar(DIA({
        total: 1, monto_total: 7,
        etapas: { entrada: { n: 0, monto: 0 }, aprobados: { n: 0, monto: 0 }, rechazados: { n: 0, monto: 0 }, sin_etapa: { n: 1, monto: 7 } },
        filas: [F({ id: 'raro', status: 'pagada', etapa: 'sin_etapa', importe: 7 })],
        entrada: { total: 0, monto_total: 0, por_fecha: [], por_departamento: [] },
      }));
      expect(c.accionesDe(c.visibles()[0])).toEqual([]);
      c.abrir(c.visibles()[0]);
      fix.detectChanges();
      expect(fix.nativeElement.textContent).toContain('no hay nada que decidir');
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
      c.verPestana('aprobados');
      expect(c.grupo()).toBeNull();
      expect(c.visibles().map((f) => f.id)).toEqual(['e1', 'c1']);
    });

    it('un grupo que ya no existe no vacía la lista', () => {
      montar();
      c.grupo.set('FANTASMA');
      expect(c.visibles().map((f) => f.id)).toEqual(['a1', 'a2']);
    });
  });

  /**
   * La barra de navegación de días se retiró por pedido del usuario (2026-09-25). Lo que
   * queda es el candado de que la pantalla **sigue diciendo qué día muestra** y de que no
   * se calla lo que quedó afuera: sin barra, ese aviso es lo único que revela ese trabajo.
   */
  describe('la pantalla muestra HOY, y lo dice', () => {
    it('no hay controles para cambiar de día', () => {
      montar();
      const html = fix.nativeElement.innerHTML as string;
      expect(html).not.toContain('ap-rail');
      expect(html).not.toContain('type="date"');
      expect(fix.nativeElement.querySelectorAll('input[type=date]').length).toBe(0);
    });

    /** Una pantalla que dice «del día» sin decir cuál no se puede auditar. */
    it('nombra el día que está mostrando', () => {
      montar();
      expect(fix.nativeElement.textContent).toContain('viernes 25 de septiembre');
    });

    it('sólo pide hoy: nunca manda fecha', () => {
      const req = montar();
      expect(req.request.params.has('fecha')).toBe(false);
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
      // Ya no hay rail al que mandar a nadie: el aviso no puede prometer un control que no existe.
      expect(txt).not.toContain('rail');
    });

    it('ese aviso es de la pestaña que firma, no de las otras', () => {
      montar(DIA({ pendientes_fuera_del_dia: { n: 7, monto: 12_345.67 } }));
      c.verPestana('aprobados');
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
      expect(txt).not.toContain('Nada de este día espera');
    });

    it('un día sin movimiento lo dice con todas las letras', () => {
      montar(DIA({
        total: 0, monto_total: 0, filas: [],
        etapas: { entrada: { n: 0, monto: 0 }, aprobados: { n: 0, monto: 0 }, rechazados: { n: 0, monto: 0 }, sin_etapa: { n: 0, monto: 0 } },
        entrada: { total: 0, monto_total: 0, por_fecha: [], por_departamento: [] },
      }));
      expect(fix.nativeElement.textContent).toContain('no se levantó ningún gasto');
      // Y no manda a «probar otro día»: ya no hay cómo.
      expect(fix.nativeElement.textContent).not.toContain('otro día');
    });

    /** Las dos fechas son cosas distintas: cuándo se levantó y cuándo ocurrió el gasto. */
    it('cuando el gasto es de otro día, lo muestra aparte', () => {
      montar(DIA({ total: 1, filas: [F({ id: 'a1', created_at: '2026-09-25', fecha_gasto: '2026-09-18' })] }));
      expect(fix.nativeElement.textContent).toContain('gasto del 18/09/26');
    });

    it('marca el expediente que sigue esperando su evidencia', () => {
      montar(DIA({ total: 1, filas: [F({ id: 'e1', status: 'aprobada', etapa: 'aprobados', requiere_evidencia: true, tiene_evidencia: false })] }));
      c.verPestana('aprobados');
      fix.detectChanges();
      expect(fix.nativeElement.textContent).toContain('falta la evidencia');
    });
  });

  /**
   * ⛔ El renglón NO trae botones. Un «Aprobar» al pie de una tarjeta deja autorizar dinero
   * sin haber abierto el comprobante — que es justo lo que esta pantalla existe para evitar.
   */
  describe('el vale se abre, no se firma desde la lista', () => {
    const botonesDeFila = () =>
      [...fix.nativeElement.querySelectorAll('.ap-item button')].map((b: Element) => b.textContent?.trim());

    it('ningún renglón trae botones de decisión', () => {
      montar();
      expect(botonesDeFila()).toEqual([]);
      c.verPestana('aprobados');
      fix.detectChanges();
      expect(botonesDeFila()).toEqual([]);
    });

    it('el renglón se abre con clic, y también con el teclado', () => {
      montar();
      const fila = fix.nativeElement.querySelector('.ap-item') as HTMLElement;
      expect(fila.getAttribute('role')).toBe('button');
      expect(fila.getAttribute('tabindex')).toBe('0');
      fila.click();
      fix.detectChanges();
      expect(c.abierto()?.id).toBe('a1');
      c.cerrarSiHaceFalta(false);
      expect(c.abierto()).toBeNull();
      fila.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      fix.detectChanges();
      expect(c.abierto()?.id).toBe('a1');
    });

    it('el panel muestra el vale completo: importe, folio y sus datos', () => {
      montar();
      c.abrir(c.visibles()[0]);
      fix.detectChanges();
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('$100.00');
      expect(txt).toContain('0009678');
      expect(txt).toContain('Casetas ruta norte');
      expect(txt).toContain('Evidencia');
    });

    it('la decisión vive en el panel, y sale del estado del vale', () => {
      montar();
      c.abrir(c.visibles()[0]);                      // recibida
      expect(c.accionesDe(c.abierto()!)).toEqual(['aprobar', 'rechazar']);
      c.verPestana('aprobados');
      c.abrir(c.visibles()[0]);                      // aprobada
      expect(c.accionesDe(c.abierto()!)).toEqual(['comprobar', 'rechazar']);
      c.abrir(c.visibles()[1]);                      // validada
      expect(c.accionesDe(c.abierto()!)).toEqual([]);
      fix.detectChanges();
      expect(c.accionesDe(c.abierto())).toEqual([]);
    });

    /** ⛔ En Rechazados también se abre: mirar el vale no es lo mismo que poder cambiarlo. */
    it('un vale rechazado se abre igual, con su motivo, y sin botones', () => {
      montar();
      c.verPestana('rechazados');
      fix.detectChanges();
      (fix.nativeElement.querySelector('.ap-item') as HTMLElement).click();
      fix.detectChanges();
      expect(c.abierto()?.id).toBe('r1');
      expect(c.accionesDe(c.abierto()!)).toEqual([]);
      expect(fix.nativeElement.textContent).toContain('falta el ticket');
      expect(botonesDeFila()).toEqual([]);
    });

    /**
     * ⚠️ Lo que el visor MUESTRA (documentos, sanitización de PDF, «no se pudo mostrar»
     * vs «no hay archivos») se prueba en `vale-gasto-peek.component.spec.ts`: es un
     * componente compartido con el Historial. Acá se prueba el CABLEADO — que esta página
     * le pase el vale correcto y las acciones que corresponden.
     */
    it('le pasa al visor el vale abierto y las acciones de su estado', () => {
      montar();
      c.abrir(c.visibles()[0]);
      fix.detectChanges();
      const peek = fix.nativeElement.querySelector('app-vale-gasto-peek');
      expect(peek).not.toBeNull();
      expect(c.abierto()?.id).toBe('a1');
      expect(c.accionesDe(c.abierto())).toEqual(['aprobar', 'rechazar']);
    });

    it('sin vale abierto, no le pasa acciones a nadie', () => {
      montar();
      expect(c.abierto()).toBeNull();
      expect(c.accionesDe(null)).toEqual([]);
    });
  });

  describe('las acciones', () => {
    it('aprobar llama a su endpoint y recarga el día', () => {
      montar();
      c.abrir(c.visibles()[0]);
      c.aprobar(c.visibles()[0]);
      http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/a1/approve')).flush({ ok: true });
      http.expectOne((r) => r.url.includes('/del-dia')).flush(DIA());
      expect(c.actuando()).toBeNull();
      // El panel se cierra: el vale que se miraba ya no está en ese estado.
      expect(c.abierto()).toBeNull();
    });

    it('«dar por comprobado» es validate, el mismo que resuelve lo que no cuadró', () => {
      montar();
      c.verPestana('aprobados');
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
        total: 1, filas: [F({ id: 'c1', status: 'validada', etapa: 'aprobados', validated_by: 'maria' })],
        etapas: { entrada: { n: 0, monto: 0 }, aprobados: { n: 1, monto: 10 }, rechazados: { n: 0, monto: 0 }, sin_etapa: { n: 0, monto: 0 } },
        entrada: { total: 0, monto_total: 0, por_fecha: [], por_departamento: [] },
      }));
      c.verPestana('aprobados');
      c.abrir(c.visibles()[0]);
      fix.detectChanges();
      expect(c.accionesDe(c.abierto()!)).toEqual([]);
      expect(fix.nativeElement.textContent).toContain('no hay nada que decidir');
      expect(fix.nativeElement.textContent).toContain('Cerrado por maria');
    });
  });
});
