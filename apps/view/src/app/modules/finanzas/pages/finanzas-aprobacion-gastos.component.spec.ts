import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { FinanzasAprobacionGastosComponent } from './finanzas-aprobacion-gastos.component';
import type { ExpedienteAtrasado, ExpedienteDelDia, GastosDelDia, ResultadoBusquedaGastos } from '../comprobaciones.service';
import { AuthService, type JwtPayload } from '../../../core/services/auth.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { BuscadorGastosEstado } from '../components/buscador-gastos.estado';

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

/** `[GX.88]` Un vale de OTRO día que sigue abierto. Por omisión, aprobado esperando su evidencia. */
const A = (over: Partial<ExpedienteAtrasado> = {}): ExpedienteAtrasado => ({
  ...F({ status: 'aprobada', etapa: 'aprobados', importe: 300, created_at: '2026-09-20', tiene_evidencia: false }),
  dias_atraso: 5,
  falta: { texto: 'Aprobado: espera que quien lo levantó suba la evidencia.', toca: 'levanto' },
  ...over,
} as ExpedienteAtrasado);

const DIA = (over: Partial<GastosDelDia> = {}): GastosDelDia => ({
  fecha: '2026-09-25',
  es_hoy: true,
  hoy: '2026-09-25',
  fecha_pedida: null,
  total: 4,
  monto_total: 185,
  etapas: {
    entrada: { n: 2, monto: 150 },
    aprobados: { n: 1, monto: 10 },
    rechazados: { n: 1, monto: 25 },
    sin_etapa: { n: 0, monto: 0 },
  },
  filas: [
    F({ id: 'a1', status: 'recibida', etapa: 'entrada', importe: 100, departamento: 'LOGISTICA' }),
    F({ id: 'a2', status: 'recibida', etapa: 'entrada', importe: 50, departamento: 'SISTEMAS' }),
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
  entrada_truncada: false,
  atrasados: [A({ id: 'e1', status: 'aprobada', etapa: 'aprobados', importe: 300, tiene_evidencia: false })],
  atrasados_total: { n: 1, monto: 300 },
  atrasados_truncada: false,
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
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: LOCALE_ID, useValue: 'es-MX' }, BuscadorGastosEstado],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('monta y arranca en la bandeja de hoy', () => {
    montar();
    expect(c.pestana()).toBe('entrada');
    expect(fix.nativeElement.textContent).toContain('Aprobación de gastos');
    const tabs = [...fix.nativeElement.querySelectorAll('.ap-tab-t')].map((e: Element) => e.textContent?.trim());
    // `[GX.60]` Lo aprobado y lo rechazado DESAPARECEN de esta pantalla (se mudaron al
    // Expediente). `[GX.88]` Se suma «Atrasados»: lo de días anteriores que sigue abierto.
    expect(tabs).toEqual(['Bandeja de hoy', 'Atrasados']);
  });

  describe('[GX.88] las dos pestañas: hoy y atrasados', () => {
    it('cada pestaña cuenta lo suyo', () => {
      montar();
      expect(c.conteo('entrada')).toEqual({ n: 2, monto: 150 });
      expect(c.conteo('atrasados')).toEqual({ n: 1, monto: 300 });
    });

    it('la bandeja sólo muestra lo de HOY que espera decisión', () => {
      montar();
      // c1 (validada) y r1 (rechazada) son de hoy pero ya se decidieron: no son trabajo.
      expect(c.visibles().map((f) => f.id)).toEqual(['a1', 'a2']);
    });

    it('Atrasados muestra lo de otros días, en el orden del servidor', () => {
      montar(DIA({
        atrasados: [
          A({ id: 'viejo', created_at: '2026-08-25', dias_atraso: 31 }),
          A({ id: 'menos', created_at: '2026-09-24', dias_atraso: 1 }),
        ],
        atrasados_total: { n: 2, monto: 600 },
      }));
      c.verPestana('atrasados');
      // El servidor ya los manda del más viejo al más nuevo: la pantalla no los reordena.
      expect(c.visibles().map((f) => f.id)).toEqual(['viejo', 'menos']);
    });

    /**
     * ⛔ El contador de Atrasados es el TOTAL real, no los renglones que llegaron. Si la lista se
     * cortó, contar renglones diría menos de lo que hay — y lo que no se cuenta no se atiende.
     */
    it('⛔ el contador de Atrasados es el total, aunque la lista venga cortada', () => {
      montar(DIA({ atrasados: [A({ id: 'x' })], atrasados_total: { n: 7, monto: 2100 }, atrasados_truncada: true }));
      expect(c.conteo('atrasados')).toEqual({ n: 7, monto: 2100 });
      c.verPestana('atrasados');
      fix.detectChanges();
      expect(fix.nativeElement.textContent).toContain('Se muestran 1 de 7 atrasados');
    });

    /**
     * ⛔ Un estado que el servidor no reconoció cae en `sin_etapa`. Tiene que seguir existiendo:
     * entra por la bandeja, contado y marcado.
     */
    it('un estado desconocido no desaparece: entra por la bandeja, y marcado', () => {
      montar(DIA({
        total: 1, monto_total: 7,
        etapas: { entrada: { n: 0, monto: 0 }, aprobados: { n: 0, monto: 0 }, rechazados: { n: 0, monto: 0 }, sin_etapa: { n: 1, monto: 7 } },
        filas: [F({ id: 'raro', status: 'pagada', etapa: 'sin_etapa', importe: 7 })],
        entrada: { total: 0, monto_total: 0, por_fecha: [], por_departamento: [] },
      }));
      expect(c.visibles().map((f) => f.id)).toEqual(['raro']);
      // Y se CUENTA: si no, el renglón estaría en la lista y el contador diría 0.
      expect(c.conteo('entrada')).toEqual({ n: 1, monto: 7 });
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

    /** Arrastrarlo a Atrasados dejaría la lista recortada sin que se vea por qué. */
    it('se suelta al cambiar de pestaña', () => {
      montar();
      c.grupo.set('LOGISTICA');
      c.verPestana('atrasados');
      expect(c.grupo()).toBeNull();
      expect(c.visibles().map((f) => f.id)).toEqual(['e1']);
    });

    it('un grupo que ya no existe no vacía la lista', () => {
      montar();
      c.grupo.set('FANTASMA');
      expect(c.visibles().map((f) => f.id)).toEqual(['a1', 'a2']);
    });
  });

  /**
   * La barra de navegación de días se retiró por pedido del usuario (2026-09-25). `[GX.88]` no
   * la devuelve: lo de otros días se ve en Atrasados, sin tener que adivinar en qué día hay trabajo.
   */
  describe('la pantalla no ofrece controles de día', () => {
    it('no hay controles para cambiar de día', () => {
      montar();
      const html = fix.nativeElement.innerHTML as string;
      expect(html).not.toContain('ap-rail');
      expect(html).not.toContain('type="date"');
      expect(fix.nativeElement.querySelectorAll('input[type=date]').length).toBe(0);
    });

    /** ⛔ NEGATIVA de `[GX.67]`: el encabezado no vuelve a anunciar un día con nombre. */
    it('⛔ el encabezado no nombra un día: dice los dos alcances', () => {
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
   * `[GX.88]` **Lo de días pasados vive en Atrasados.**
   *
   * Pedido del usuario (2026-10-30): *«un apartado en aprobar en donde estén los atrasados en
   * orden, que te diga cuáles son los que se quedaron atrasados»*. Antes (`[GX.67]`) sólo lo
   * SIN FIRMAR de otro día entraba a la bandeja, mezclado con lo de hoy; lo ya aprobado o con el
   * comprobante por revisar no aparecía en ningún lado (medido en prod: 5 vales, $78,804.91).
   */
  describe('[GX.88] los atrasados', () => {
    const CON_VIEJOS = () => DIA({
      hoy: '2026-09-25',
      etapas: { entrada: { n: 1, monto: 100 }, aprobados: { n: 0, monto: 0 },
        rechazados: { n: 0, monto: 0 }, sin_etapa: { n: 0, monto: 0 } },
      filas: [F({ id: 'hoy1', importe: 100, created_at: '2026-09-25', folio_solicitud: 'DEHOY' })],
      entrada: { total: 1, monto_total: 100, por_fecha: [], por_departamento: [] },
      atrasados: [
        A({ id: 'viejo1', status: 'recibida', etapa: 'entrada', importe: 50, created_at: '2026-07-01', folio_solicitud: 'DEJULIO',
          dias_atraso: 86, falta: { texto: 'Falta firmarlo: aprobarlo o rechazarlo.', toca: 'aprueba' } }),
        A({ id: 'prov1', status: 'aprobada', provisional: true, importe: 300, created_at: '2026-09-24', folio_solicitud: 'PROV',
          dias_atraso: 1, falta: { texto: 'Se aprobó como provisional: falta el comprobante definitivo para cerrarlo.', toca: 'levanto' } }),
      ],
      atrasados_total: { n: 2, monto: 350 },
    });

    it('lo de otro día NO se mezcla con la bandeja de hoy', () => {
      montar(CON_VIEJOS());
      expect(c.visibles().map((f) => f.id)).toEqual(['hoy1']);
      expect(fix.nativeElement.textContent).not.toContain('DEJULIO');
    });

    /** ⭐ El candado central: el vale de julio se VE en Atrasados y se puede abrir para decidirlo. */
    it('⭐ aparece en Atrasados y se puede ABRIR para firmarlo', () => {
      montar(CON_VIEJOS());
      c.verPestana('atrasados');
      fix.detectChanges();
      expect(fix.nativeElement.textContent).toContain('DEJULIO');
      (fix.nativeElement.querySelector('.ap-item') as HTMLElement).click();
      fix.detectChanges();
      expect(c.abierto()?.id).toBe('viejo1');
      expect(c.accionesDe(c.abierto())).toEqual(['aprobar', 'rechazar']);
    });

    /** El aprobado de otro día también: es lo que antes no aparecía en ningún lado. */
    it('⭐ el aprobado provisional de otro día se ve y ofrece darlo por comprobado', () => {
      montar(CON_VIEJOS());
      c.verPestana('atrasados');
      const prov = c.visibles().find((f) => f.id === 'prov1');
      expect(prov).toBeDefined();
      expect(c.accionesDe(prov ?? null)).toEqual(['comprobar', 'rechazar']);
    });

    it('cada atrasado dice cuántos días lleva, qué le falta y a quién le toca', () => {
      montar(CON_VIEJOS());
      c.verPestana('atrasados');
      fix.detectChanges();
      const filas = [...fix.nativeElement.querySelectorAll('.ap-atraso')].map((e: Element) => e.textContent?.replace(/\s+/g, ' ').trim());
      expect(filas[0]).toContain('86 días');
      expect(filas[0]).toContain('Falta firmarlo');
      expect(filas[0]).toContain('te toca');
      expect(filas[1]).toContain('1 día');
      expect(filas[1]).toContain('espera a quien lo levantó');
    });

    it('los días se dicen en palabras, y una fecha ilegible no se pinta como 0', () => {
      montar();
      expect(c.diasTexto(0)).toBe('hoy');
      expect(c.diasTexto(1)).toBe('1 día');
      expect(c.diasTexto(18)).toBe('18 días');
      expect(c.diasTexto(null)).toBe('sin fecha');
    });

    it('el renglón viejo muestra su día de captura; el de hoy no', () => {
      montar(CON_VIEJOS());
      expect(fix.nativeElement.querySelectorAll('.ap-dia-chip').length).toBe(0); // bandeja: sólo hoy
      c.verPestana('atrasados');
      fix.detectChanges();
      const chips = Array.from(fix.nativeElement.querySelectorAll('.ap-dia-chip')) as HTMLElement[];
      expect(chips.map((x) => x.textContent?.trim())).toEqual(['01/07/26', '24/09/26']);
    });

    /** ⛔ `hoy` sale del SERVIDOR. Con el reloj del navegador, otra zona marca mal los días. */
    it('«hoy» lo decide el servidor, no el navegador', () => {
      montar(CON_VIEJOS());
      expect(c.hoy()).toBe('2026-09-25');
      montar(DIA({ hoy: '2026-01-02', filas: [], etapas: { entrada: { n: 0, monto: 0 },
        aprobados: { n: 0, monto: 0 }, rechazados: { n: 0, monto: 0 }, sin_etapa: { n: 0, monto: 0 } } }));
      expect(c.hoy()).toBe('2026-01-02');
    });

    it('el subtítulo declara los dos alcances: hoy en la bandeja, lo anterior en Atrasados', () => {
      montar(CON_VIEJOS());
      const sub = fix.nativeElement.querySelector('.surf-page-sub')?.textContent as string;
      expect(sub).toContain('hoy');
      expect(sub).toContain('Atrasados');
    });

    it('sin atrasados, la pestaña lo dice con todas las letras', () => {
      montar(DIA({ atrasados: [], atrasados_total: { n: 0, monto: 0 } }));
      c.verPestana('atrasados');
      fix.detectChanges();
      expect(fix.nativeElement.textContent).toContain('No se quedó nada atrasado');
    });

    /**
     * ⛔ Medido en local el 2026-10-30: la view nueva contra una API sin actualizar. La respuesta
     * no trae `atrasados` y la plantilla tronaba al leer `atrasados_total.n`: Angular dejaba de
     * responder y «los clics no funcionaban». Lo mismo pasaría en prod si la view sale antes que la
     * API. La pantalla no truena, y tampoco dice «no hay»: dice que no se midió.
     */
    it('⛔ con una API vieja (sin atrasados) no truena: los declara sin medir, nunca 0', () => {
      const vieja = DIA() as unknown as Record<string, unknown>;
      delete vieja['atrasados']; delete vieja['atrasados_total']; delete vieja['atrasados_truncada'];
      montar(vieja as unknown as GastosDelDia);
      expect(c.atrasadosMedidos()).toBe(false);
      c.verPestana('atrasados');
      fix.detectChanges();
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('no se puede saber si hay');
      expect(txt).not.toContain('No se quedó nada atrasado');
      expect(txt).toContain('sin medir');
      // Y la pantalla sigue viva: el clic en un renglón de la bandeja abre el vale.
      c.verPestana('entrada');
      fix.detectChanges();
      (fix.nativeElement.querySelector('.ap-item') as HTMLElement).click();
      fix.detectChanges();
      expect(c.abierto()?.id).toBe('a1');
    });
  });

  describe('lo que la pantalla no puede callar', () => {
    /**
     * ⛔ La bandeja de hoy vacía NO puede leerse como «no hay nada pendiente»: si hay atrasados,
     * se dice dónde están.
     */
    it('⛔ hoy vacío con atrasados: dice que lo anterior está en Atrasados', () => {
      montar(DIA({
        total: 0, monto_total: 0, filas: [],
        etapas: { entrada: { n: 0, monto: 0 }, aprobados: { n: 0, monto: 0 }, rechazados: { n: 0, monto: 0 }, sin_etapa: { n: 0, monto: 0 } },
        entrada: { total: 0, monto_total: 0, por_fecha: [], por_departamento: [] },
        atrasados: [A({ id: 'x' })], atrasados_total: { n: 1, monto: 300 },
      }));
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('Hoy no hay nada esperando tu firma');
      expect(txt).toContain('Lo de días anteriores está en Atrasados');
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
      expect(fix.nativeElement.textContent).toContain('Hoy no hay nada esperando tu firma');
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
      expect(txt).not.toContain('no hay nada esperando');
    });

    it('una bandeja vacía sin atrasados lo dice, sin mandar a otro lado', () => {
      montar(DIA({
        total: 0, monto_total: 0, filas: [],
        etapas: { entrada: { n: 0, monto: 0 }, aprobados: { n: 0, monto: 0 }, rechazados: { n: 0, monto: 0 }, sin_etapa: { n: 0, monto: 0 } },
        entrada: { total: 0, monto_total: 0, por_fecha: [], por_departamento: [] },
        atrasados: [], atrasados_total: { n: 0, monto: 0 },
      }));
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('Hoy no hay nada esperando tu firma');
      // El subtítulo siempre nombra Atrasados; lo que no puede hacer es el recuadro de vacío.
      expect(fix.nativeElement.querySelector('.ap-vacio')?.textContent).not.toContain('está en Atrasados');
    });

    /** Las dos fechas son cosas distintas: cuándo se levantó y cuándo ocurrió el gasto. */
    it('cuando el gasto es de otro día, lo muestra aparte', () => {
      montar(DIA({ total: 1, filas: [F({ id: 'a1', created_at: '2026-09-25', fecha_gasto: '2026-09-18' })] }));
      expect(fix.nativeElement.textContent).toContain('gasto del 18/09/26');
    });

    it('marca el expediente que sigue esperando su evidencia', () => {
      montar();
      c.verPestana('atrasados');
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
      c.verPestana('atrasados');
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
      c.verPestana('atrasados');
      c.abrir(c.visibles()[0]);                      // aprobada (de otro día)
      expect(c.accionesDe(c.abierto()!)).toEqual(['comprobar', 'rechazar']);
      // Lo cerrado ya no está en ninguna pestaña (`[GX.60]`); se abre desde el buscador. Sin acciones.
      c.abrir(F({ id: 'c1', status: 'validada', etapa: 'aprobados', validated_by: 'maria' }));
      expect(c.accionesDe(c.abierto()!)).toEqual([]);
      fix.detectChanges();
      expect(c.accionesDe(c.abierto())).toEqual([]);
    });

    /**
     * ⛔ Un rechazado también se abre (hoy, desde el buscador): mirar el vale no es lo mismo que
     * poder cambiarlo.
     */
    it('un vale rechazado se abre igual, con su motivo, y sin botones', () => {
      montar();
      c.abrir(F({ id: 'r1', status: 'rechazada', etapa: 'rechazados', motivo_rechazo: 'falta el ticket' }));
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
      expect(fix.nativeElement.textContent).toContain('Bandeja de hoy');
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
      c.verPestana('atrasados');
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
      montar();
      // Lo cerrado sólo se alcanza desde el buscador (`[GX.88]`): se abre igual, sin acciones.
      c.abrir(F({ id: 'c1', status: 'validada', etapa: 'aprobados', validated_by: 'maria' }));
      fix.detectChanges();
      expect(c.accionesDe(c.abierto()!)).toEqual([]);
      const txt = fix.nativeElement.textContent as string;
      expect(txt).toContain('no hay nada que decidir');
      expect(txt).toContain('Cerrado por');
      expect(txt).toContain('maria');
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

  /**
   * `[GX.73]` **La bandeja se refresca sola.** Reporte: quien aprueba no veía llegar los vales
   * nuevos hasta recargar. Lo que se cuida: que refresque sin parpadear, que NO le borre el filtro
   * de departamento a quien está trabajando (`cargar()` sí lo borra), que no refresque encima de
   * un vale abierto o de una firma en vuelo, y que un fallo no pise la bandeja buena.
   */
  describe('[GX.73] el refresco en segundo plano', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const pedidos = () => ({
      dia: http.expectOne((r) => r.url.includes('/finance/expenses/proofs/del-dia')),
      reap: http.expectOne((r) => r.url.includes('/reaperturas/pendientes')),
    });

    it('⭐ al minuto vuelve a pedir el día y las reaperturas, sin aviso de carga', () => {
      montar();
      vi.advanceTimersByTime(60_000);
      const { dia, reap } = pedidos();
      expect(c.cargando()).toBe(false);
      dia.flush(DIA({ total: 6 }));
      reap.flush([]);
      expect(c.datos()?.total).toBe(6);
    });

    it('⭐ conserva el filtro de departamento (cargar() lo borra; el refresco no)', () => {
      montar();
      c.grupo.set('LOGISTICA');
      vi.advanceTimersByTime(60_000);
      const { dia, reap } = pedidos();
      dia.flush(DIA());
      reap.flush([]);
      expect(c.grupo()).toBe('LOGISTICA');
    });

    it('si el departamento elegido ya no tiene nada, suelta el filtro (no deja atrapado)', () => {
      montar();
      c.grupo.set('SISTEMAS');
      vi.advanceTimersByTime(60_000);
      const { dia, reap } = pedidos();
      dia.flush(DIA({ entrada: { total: 1, monto_total: 100, por_fecha: [], por_departamento: [
        { clave: 'LOGISTICA', etiqueta: 'LOGISTICA', origen: 'capturado', n: 1, monto: 100, ids: ['a1'] },
      ] } }));
      reap.flush([]);
      expect(c.grupo()).toBeNull();
    });

    it('⛔ con un vale abierto NO refresca', () => {
      montar();
      c.abrir(F({ id: 'a1', status: 'recibida' }));
      vi.advanceTimersByTime(60_000);
      http.expectNone((r) => r.url.includes('/del-dia'));
    });

    it('⛔ con una firma en vuelo NO refresca', () => {
      montar();
      c.actuando.set('a1');
      vi.advanceTimersByTime(60_000);
      http.expectNone((r) => r.url.includes('/del-dia'));
    });

    it('⛔ un refresco que falla NO pisa la bandeja ni muestra error', () => {
      montar();
      vi.advanceTimersByTime(60_000);
      const { dia, reap } = pedidos();
      dia.flush('boom', { status: 500, statusText: 'Server Error' });
      reap.flush([]);
      expect(c.error()).toBe('');
      expect(c.datos()?.total).toBe(4);
    });
  });
  /**
   * `[GX.88]` **El buscador de gastos vive ARRIBA de las pestañas** (en el shell, que provee su
   * estado). Sus reglas se prueban en su propio spec; acá, el cableado con esta pantalla.
   */
  describe('[GX.88] el buscador de arriba (cableado)', () => {
    const estado = () => TestBed.inject(BuscadorGastosEstado);
    const conPermiso = () => TestBed.inject(PermissionsService).load({ FINANCE_EXPENSES_COMPROBAR: true }, 'tesoreria', 'jwt');

    it('con una búsqueda activa arriba, la pantalla se esconde entera — el visor no', () => {
      conPermiso();
      montar();
      estado().busqueda.set('papeleria');
      fix.detectChanges();
      expect(c.buscandoArriba()).toBe(true);
      expect(fix.nativeElement.querySelector('.ap-tabs')).toBeNull();
      expect(fix.nativeElement.querySelector('.surf-page-head')).toBeNull();
      expect(fix.nativeElement.querySelector('app-vale-gasto-peek')).not.toBeNull();
      estado().limpiar();
      fix.detectChanges();
      expect(fix.nativeElement.querySelector('.ap-tabs')).not.toBeNull();
    });

    /** ⭐ En Aprobación el vale elegido se DECIDE: se abre con las acciones de su estado. */
    it('⭐ el vale elegido en el buscador se abre aquí, con las decisiones de su estado', () => {
      conPermiso();
      montar();
      estado().abrir(F({ id: 'v1', folio_solicitud: '0010287', status: 'aprobada', etapa: 'aprobados' }));
      fix.detectChanges();
      expect(c.abierto()?.id).toBe('v1');
      expect(c.accionesDe(c.abierto())).toEqual(['comprobar', 'rechazar']);
    });

    /** Después de decidir sobre un vale encontrado, su renglón tiene que decir el estado nuevo. */
    it('al recargar, la búsqueda abierta también se pone al día', () => {
      conPermiso();
      montar();
      estado().busqueda.set('papeleria');
      c.cargar();
      http.expectOne((r) => r.url.includes('/del-dia')).flush(DIA());
      http.expectOne((r) => r.url.includes('/reaperturas/pendientes')).flush([]);
      http.expectOne((r) => r.url.includes('/finance/expenses/proofs/buscar')).flush(
        { q: 'papeleria', vales: [], vales_truncado: false, sin_vale: [], sin_vale_truncado: false, solicitudes_desde: null });
    });
  });
});
