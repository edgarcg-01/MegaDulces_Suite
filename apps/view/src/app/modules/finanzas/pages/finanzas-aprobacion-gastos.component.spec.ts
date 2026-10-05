import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { FinanzasAprobacionGastosComponent } from './finanzas-aprobacion-gastos.component';
import type { ExpedienteDelDia, GastosDelDia } from '../comprobaciones.service';
import { AuthService, type JwtPayload } from '../../../core/services/auth.service';

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
  entrada_de_otros_dias: { n: 0, monto: 0 },
  entrada_truncada: false,
  ...over,
});

describe('FinanzasAprobacionGastosComponent', () => {
  let fix: ComponentFixture<FinanzasAprobacionGastosComponent>;
  let c: FinanzasAprobacionGastosComponent;
  let http: HttpTestingController;

  /**
   * Montar dispara DOS viajes: el día y las reaperturas que le toca decidir a quien mira
   * (`[GX.29]`). Van separados a propósito — el día es de HOY y las reaperturas de
   * cualquier fecha — así que la prueba responde los dos.
   */
  const montar = (d: GastosDelDia | null = DIA(), reap: unknown[] = []) => {
    fix = TestBed.createComponent(FinanzasAprobacionGastosComponent);
    c = fix.componentInstance;
    const req = http.expectOne((r) => r.url.includes('/finance/expenses/proofs/del-dia'));
    if (d) req.flush(d); else req.flush('boom', { status: 500, statusText: 'Server Error' });
    http.expectOne((r) => r.url.includes('/reaperturas/pendientes')).flush(reap);
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
    // `[GX.60]` UNA sola pestana. Pedido del usuario: lo aprobado y lo rechazado DESAPARECEN
    // para que la seccion quede siempre limpia. Lo decidido no se perdio -- se mudo al
    // Expediente (`[GX.59]`), que es donde ahora se mira el tramite completo.
    expect(tabs).toEqual(['Bandeja de entrada']);
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
  describe('la pantalla no ofrece controles de día', () => {
    /**
     * ⚠️ Sigue sin haber barra de días, y `[GX.67]` lo refuerza en vez de contradecirlo: con
     * pendientes repartidos en ~25 días, una barra obliga a adivinar en cuál hay trabajo. La
     * bandeja los trae todos, así que no hay nada que elegir.
     */
    it('no hay controles para cambiar de día', () => {
      montar();
      const html = fix.nativeElement.innerHTML as string;
      expect(html).not.toContain('ap-rail');
      expect(html).not.toContain('type="date"');
      expect(fix.nativeElement.querySelectorAll('input[type=date]').length).toBe(0);
    });

    /**
     * ⛔ NEGATIVA de `[GX.67]`: el encabezado **no puede volver a anunciar un día**. Decía
     * «Los levantamientos del viernes 25 de septiembre» sobre una lista que ahora trae julio
     * — sería la misma mentira al revés, y es la frase que describía el defecto.
     */
    it('⛔ el encabezado ya NO nombra un día: la lista no es de un día', () => {
      montar();
      const txt = fix.nativeElement.textContent as string;
      expect(txt).not.toContain('viernes 25 de septiembre');
      expect(txt).not.toContain('Los levantamientos del');
    });

    it('sólo pide hoy: nunca manda fecha', () => {
      const req = montar();
      expect(req.request.params.has('fecha')).toBe(false);
    });
  });

  /**
   * `[GX.67]` **La bandeja no se acota por día.**
   *
   * Pedido del usuario (2026-10-05): *«sólo se pueden autorizar los que se levanten del día,
   * cambialo a que también se puedan pasado»*.
   *
   * ⛔ Lo que había antes era peor que un filtro: la pantalla **sabía** que había trabajo de
   * otros días —lo avisaba con su monto— y no daba ninguna forma de llegar a él, porque la
   * barra de días se había retirado el 2026-09-25. Medido en la base local el 2026-10-05:
   * **78 esperando firma en ~25 días y cero levantados hoy**, o sea la bandeja salía vacía.
   */
  describe('[GX.67] se autoriza lo de días pasados, no sólo lo de hoy', () => {
    /** Un vale viejo y uno de hoy, en la misma lista. */
    const CON_VIEJOS = () => DIA({
      hoy: '2026-09-25',
      etapas: { entrada: { n: 2, monto: 150 }, aprobados: { n: 0, monto: 0 },
        rechazados: { n: 0, monto: 0 }, sin_etapa: { n: 0, monto: 0 } },
      filas: [
        F({ id: 'hoy1', importe: 100, created_at: '2026-09-25', folio_solicitud: 'DEHOY' }),
        F({ id: 'viejo1', importe: 50, created_at: '2026-07-01', folio_solicitud: 'DEJULIO' }),
      ],
      entrada: { total: 2, monto_total: 150, por_fecha: [], por_departamento: [] },
      entrada_de_otros_dias: { n: 1, monto: 50 },
    });

    /** ⭐ El candado central: el vale de julio se VE y se puede abrir para decidirlo. */
    it('un vale levantado hace meses aparece en la bandeja', () => {
      montar(CON_VIEJOS());
      expect(c.visibles().map((f) => f.id)).toEqual(['hoy1', 'viejo1']);
      expect(fix.nativeElement.textContent).toContain('DEJULIO');
    });

    it('⭐ y se puede ABRIR para firmarlo, igual que el de hoy', () => {
      montar(CON_VIEJOS());
      const viejo = c.visibles().find((f) => f.id === 'viejo1')!;
      c.abrir(viejo);
      fix.detectChanges();
      // Que se abra es lo que habilita autorizarlo: no se firma desde la lista.
      expect(c.abierto()?.id).toBe('viejo1');
    });

    /**
     * ⚠️ En una lista mezclada, un vale de julio y uno de hace diez minutos se ven igual si
     * sólo se muestra la hora. El día aparece **sólo cuando no es hoy**, para no repetir en
     * cada renglón lo que ya dice el encabezado.
     */
    it('el renglón viejo muestra su día de captura; el de hoy no', () => {
      montar(CON_VIEJOS());
      const chips = Array.from(fix.nativeElement.querySelectorAll('.ap-dia-chip')) as HTMLElement[];
      expect(chips.length).toBe(1);
      expect(chips[0].textContent!.trim()).toBe('01/07/26');
    });

    /** ⛔ `hoy` sale del SERVIDOR. Con el reloj del navegador, otra zona marca mal los días. */
    it('«hoy» lo decide el servidor, no el navegador', () => {
      montar(CON_VIEJOS());
      expect(c.hoy()).toBe('2026-09-25');
      montar(DIA({ hoy: '2026-01-02', filas: [], etapas: { entrada: { n: 0, monto: 0 },
        aprobados: { n: 0, monto: 0 }, rechazados: { n: 0, monto: 0 }, sin_etapa: { n: 0, monto: 0 } } }));
      expect(c.hoy()).toBe('2026-01-02');
    });

    /** El encabezado ya no puede prometer un día: la lista trae cualquiera. */
    it('el subtítulo declara el alcance, no una fecha', () => {
      montar(CON_VIEJOS());
      const sub = fix.nativeElement.querySelector('.surf-page-sub')!.textContent as string;
      expect(sub).toContain('cualquier fecha');
      expect(sub).not.toContain('Los levantamientos del');
    });
  });

  describe('lo que la pantalla no puede callar', () => {
    /**
     * ⭐ El aviso cambió de significado con `[GX.67]`: antes decía «hay trabajo que NO ves»,
     * ahora es contexto de lo que SÍ estás viendo. Lo que no puede volver a decir es que la
     * pantalla muestra sólo hoy — sería falso, y es la frase que describía el defecto.
     */
    it('dice cuántos vienen de días anteriores, y que se pueden autorizar', () => {
      montar(DIA({ entrada_de_otros_dias: { n: 7, monto: 12_345.67 } }));
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('7');
      expect(txt).toContain('$12,345.67');
      expect(txt).toContain('se pueden autorizar igual');
      // ⛔ NEGATIVA: la frase del defecto no puede volver.
      expect(txt).not.toContain('sólo hoy');
    });

    /**
     * ⛔ Una lista cortada en silencio se lee igual que una lista completa — y acá «completa»
     * significa «ya no hay nada que firmar», que es la conclusión contraria a la verdadera.
     */
    it('declara que la lista llegó al tope y hay más', () => {
      montar(DIA({ entrada_truncada: true }));
      expect(fix.nativeElement.textContent).toContain('hay más esperando firma');
    });

    it('y NO lo dice cuando la lista vino completa', () => {
      montar(DIA({ entrada_truncada: false }));
      expect(fix.nativeElement.textContent).not.toContain('hay más esperando firma');
    });

    /**
     * ⛔ El vacío se mide con la BANDEJA, no con `total`. Con `total` —que incluye lo ya
     * decidido del día— la pantalla diría «hay gastos» sobre una bandeja vacía.
     */
    it('dice que no hay nada que firmar aunque el día tenga gastos ya decididos', () => {
      montar(DIA({
        total: 3, monto_total: 300,
        etapas: { entrada: { n: 0, monto: 0 }, aprobados: { n: 3, monto: 300 },
          rechazados: { n: 0, monto: 0 }, sin_etapa: { n: 0, monto: 0 } },
        filas: [F({ id: 'ya1', status: 'validada', etapa: 'aprobados', importe: 300 })],
        entrada: { total: 0, monto_total: 0, por_fecha: [], por_departamento: [] },
      }));
      expect(fix.nativeElement.textContent).toContain('No hay nada esperando tu firma');
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

    /**
     * `[GX.67]` La bandeja vacía ya no significa «hoy no se levantó nada» —significa **no hay
     * nada esperando firma, de ninguna fecha**, que es una afirmación mucho más fuerte y la
     * única que la pantalla puede sostener ahora.
     */
    it('una bandeja vacía lo dice con todas las letras', () => {
      montar(DIA({
        total: 0, monto_total: 0, filas: [],
        etapas: { entrada: { n: 0, monto: 0 }, aprobados: { n: 0, monto: 0 }, rechazados: { n: 0, monto: 0 }, sin_etapa: { n: 0, monto: 0 } },
        entrada: { total: 0, monto_total: 0, por_fecha: [], por_departamento: [] },
        entrada_de_otros_dias: { n: 0, monto: 0 },
      }));
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('No hay nada esperando tu firma');
      // Y no manda a «probar otro día»: ya no hay cómo, y tampoco haría falta.
      expect(txt).not.toContain('otro día');
      // ⛔ NEGATIVA: no puede volver a decir que el problema es el DÍA.
      expect(txt).not.toContain('no se levantó ningún gasto');
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

  /**
   * `[GX.29]` **Lo que te piden reabrir.** Va fuera de las tres pestañas porque no es una
   * etapa del día: es de cualquier fecha y de una sola persona — la que firmó ese vale.
   */
  describe('las reaperturas que te toca decidir', () => {
    const REAP = {
      id: 's1', motivo: 'llegó la factura definitiva', solicita: 'tania',
      created_at: '2026-09-26T10:00:00Z', proof_id: 'a1', folio_solicitud: '0071199',
      proveedor: 'OXXO', status: 'validada', importe: 340,
    };

    /** ⭐ Un panel vacío permanente enseña a saltearlo: sin nada que decidir, no se pinta. */
    it('sin solicitudes, el panel no existe', () => {
      montar();
      expect(fix.nativeElement.querySelector('.ap-reap')).toBeNull();
    });

    it('con una solicitud, la muestra con su motivo y su monto', () => {
      montar(DIA(), [REAP]);
      const panel = fix.nativeElement.querySelector('.ap-reap');
      expect(panel).not.toBeNull();
      expect(panel.textContent).toContain('Te piden reabrir un vale');
      expect(panel.textContent).toContain('llegó la factura definitiva');
      expect(panel.textContent).toContain('0071199');
      expect(panel.textContent).toContain('lo pide tania');
    });

    it('conceder la reapertura la manda y recarga', () => {
      montar(DIA(), [REAP]);
      c.decidirReapertura(REAP, true);
      const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/reaperturas/s1/decidir'));
      expect(req.request.body).toEqual({ aprueba: true, nota: undefined });
      req.flush({ proof_id: 'a1', reabierto: true });
      http.expectOne((r) => r.url.includes('/del-dia')).flush(DIA());
      http.expectOne((r) => r.url.includes('/reaperturas/pendientes')).flush([]);
      expect(c.actuando()).toBeNull();
    });

    /**
     * ⭐ Negar sin decir por qué deja a quien pidió sin nada que corregir: vuelve a pedir
     * lo mismo, y la bandeja de quien firma se hace eterna.
     */
    it('negar sin motivo no manda nada', () => {
      montar(DIA(), [REAP]);
      const orig = globalThis.prompt;
      globalThis.prompt = () => '';
      try { c.decidirReapertura(REAP, false); } finally { globalThis.prompt = orig; }
      http.expectNone((r) => r.method === 'POST');
    });

    it('negar con motivo lo manda', () => {
      montar(DIA(), [REAP]);
      const orig = globalThis.prompt;
      globalThis.prompt = () => 'ese vale ya cerró con su factura';
      try { c.decidirReapertura(REAP, false); } finally { globalThis.prompt = orig; }
      const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/reaperturas/s1/decidir'));
      expect(req.request.body).toEqual({ aprueba: false, nota: 'ese vale ya cerró con su factura' });
      req.flush({ proof_id: 'a1', reabierto: false });
      http.expectOne((r) => r.url.includes('/del-dia')).flush(DIA());
      http.expectOne((r) => r.url.includes('/reaperturas/pendientes')).flush([]);
    });

    /**
     * ⚠️ Que falle la consulta de reaperturas NO puede impedir firmar los gastos de hoy:
     * son dos preguntas distintas y una no depende de la otra.
     */
    it('si las reaperturas fallan, el día se sigue viendo', () => {
      fix = TestBed.createComponent(FinanzasAprobacionGastosComponent);
      c = fix.componentInstance;
      http.expectOne((r) => r.url.includes('/del-dia')).flush(DIA());
      http.expectOne((r) => r.url.includes('/reaperturas/pendientes'))
        .flush('boom', { status: 500, statusText: 'Server Error' });
      fix.detectChanges();
      expect(c.error()).toBe('');
      expect(c.reaperturas()).toEqual([]);
      expect(fix.nativeElement.textContent).toContain('Bandeja de entrada');
    });
  });

  describe('las acciones', () => {
    it('aprobar llama a su endpoint y recarga el día', () => {
      montar();
      c.abrir(c.visibles()[0]);
      c.aprobar({ vale: c.visibles()[0], provisional: false, comprobante_esperado_at: null });
      const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/a1/approve'));
      // ⭐ Sin marca, el cuerpo va VACÍO. Mandar `provisional: false` escribiría la
      // columna en cada aprobación normal, y un vale que nunca fue provisional quedaría
      // tocado por esta pantalla sin que nadie lo haya dicho.
      expect(req.request.body).toEqual({});
      req.flush({ ok: true });
      http.expectOne((r) => r.url.includes('/del-dia')).flush(DIA());
      http.expectOne((r) => r.url.includes('/reaperturas/pendientes')).flush([]);
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
      http.expectOne((r) => r.url.includes('/reaperturas/pendientes')).flush([]);
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
      http.expectOne((r) => r.url.includes('/reaperturas/pendientes')).flush([]);
    });

    it('si la acción falla, la fila se desbloquea y no se recarga el día en falso', () => {
      montar();
      c.aprobar({ vale: c.visibles()[0], provisional: false, comprobante_esperado_at: null });
      http.expectOne((r) => r.url.endsWith('/a1/approve')).flush({ message: 'ya no está recibida' }, { status: 400, statusText: 'Bad Request' });
      expect(c.actuando()).toBeNull();
      http.expectNone((r) => r.url.includes('/del-dia'));
    });

    /**
     * `[GX.30]` **La marca provisional.** El dinero sale igual; lo que cambia es que la
     * deuda documental queda declarada en vez de confundirse con un vale ya cerrado.
     */
    it('aprobar como provisional manda la marca y su fecha', () => {
      montar();
      c.aprobar({ vale: c.visibles()[0], provisional: true, comprobante_esperado_at: '2026-10-15' });
      const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/a1/approve'));
      expect(req.request.body).toEqual({ provisional: true, comprobante_esperado_at: '2026-10-15' });
      req.flush({ ok: true });
      http.expectOne((r) => r.url.includes('/del-dia')).flush(DIA());
      http.expectOne((r) => r.url.includes('/reaperturas/pendientes')).flush([]);
    });

    /**
     * ⚠️ Sin fecha NO se manda el campo: la pone el servidor (15 días). Mandar cadena
     * vacía haría que la columna quede en NULL y la deuda no envejezca nunca — o sea,
     * declarada pero invisible, que es peor que no declararla.
     */
    it('provisional sin fecha deja que la ponga el servidor', () => {
      montar();
      c.aprobar({ vale: c.visibles()[0], provisional: true, comprobante_esperado_at: null });
      const req = http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/a1/approve'));
      expect(req.request.body).toEqual({ provisional: true });
      req.flush({ ok: true });
      http.expectOne((r) => r.url.includes('/del-dia')).flush(DIA());
      http.expectOne((r) => r.url.includes('/reaperturas/pendientes')).flush([]);
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
  /**
   * `[GX.65.4a]` **Nadie decide sobre su propio vale.** El servidor lo niega; la pantalla no
   * ofrece el botón y dice por qué. Sin la etiqueta, el vale abriría sin botones y parecería roto.
   */
  describe('[GX.65.4a] el vale propio', () => {
    const comoUsuario = (username: string, full_name?: string) =>
      TestBed.inject(AuthService).user.set({ sub: 'u1', username, full_name, exp: 0, iat: 0 } as JwtPayload & { full_name?: string });

    it('a su dueño no le ofrece Revisado ni Rechazar', () => {
      comoUsuario('maria.tesoreria');
      montar();
      expect(c.esMio(F({ created_by: 'maria.tesoreria' }))).toBe(true);
      expect(c.accionesDe(F({ status: 'recibida', created_by: 'maria.tesoreria' }))).toEqual([]);
    });

    /** ⛔ Prueba NEGATIVA: el vale de OTRA persona sigue ofreciendo decidir. */
    it('⛔ al vale de otra persona sí le ofrece decidir', () => {
      comoUsuario('jesus.carrillo', 'Jesús Carrillo');
      montar();
      expect(c.esMio(F({ created_by: 'maria.tesoreria' }))).toBe(false);
      expect(c.accionesDe(F({ status: 'recibida', created_by: 'maria.tesoreria' }))).toEqual(['aprobar', 'rechazar']);
    });

    it('lo reconoce aunque el vale guarde el nombre completo y no el username', () => {
      comoUsuario('jesus.carrillo', 'Jesús Carrillo');
      montar();
      expect(c.esMio(F({ created_by: 'JESÚS  CARRILLO' }))).toBe(true);
    });

    it('en la lista dice «Es tuyo: lo revisa otra persona»', () => {
      comoUsuario('maria.tesoreria');
      montar();
      // El fixture del día trae vales con created_by 'maria.tesoreria'.
      expect(fix.nativeElement.textContent).toContain('Es tuyo: lo revisa otra persona.');
    });

    it('sin sesión no marca nada como propio (lo decide el servidor)', () => {
      montar();
      expect(c.esMio(F({ created_by: 'maria.tesoreria' }))).toBe(false);
    });
  });
});
