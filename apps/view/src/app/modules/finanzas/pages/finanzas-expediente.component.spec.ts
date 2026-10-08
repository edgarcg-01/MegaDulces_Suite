import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MessageService } from 'primeng/api';
import {
  DEPARTAMENTO_SIN, type RespuestaExpediente, type TransferenciaGasto, type ValeExpediente, type VeredictoProtocolo,
} from '@megadulces/contracts';
import { FinanzasExpedienteComponent } from './finanzas-expediente.component';

/**
 * `[GX.59]` — **El Expediente**: los vales de todas las personas, agrupados por persona.
 *
 * ## Qué se prueba, y qué NO
 * La regla del protocolo se prueba en `libs/contracts` y la calcula el **servidor**: esta
 * pantalla la muestra. Lo que puede fallar acá es la **lectura**: que el nombre salga, que lo
 * que no se midió se declare, y que cada botón aparezca sólo cuando hay algo que hacer con él.
 *
 * `[GX.65.2]` La comprobación de Kepler dejó de ser forzosa: su botón y su banda se fueron,
 * y las pruebas de abajo vigilan que no vuelvan.
 */
const veredicto = (
  etapa: VeredictoProtocolo['etapa'],
  faltan: { id: string; label: string; detalle: string }[] = [],
): VeredictoProtocolo => ({ etapa, faltan: faltan as never, medido: etapa !== 'sin_medir' });

const FALTA_KEPLER = {
  id: 'comprobacion_kepler', label: 'Falta la comprobación de Kepler',
  detalle: 'El gasto no tiene su comprobación (XA1001) capturada.',
};
const FALTA_FACTURA = {
  id: 'factura_del_gasto', label: 'Falta la factura del gasto',
  detalle: 'Se aprobó con una cotización o prefactura.',
};

const VALE = (over: Partial<ValeExpediente> = {}): ValeExpediente => ({
  id: 'v1', folio_solicitud: '0009946', sucursal: '00', departamento: 'LOGISTICA',
  proveedor: 'ESTACION TAVISA', clasificacion: 'no_comprobable', status: 'validada',
  importe: 1583.86, provisional: false, fecha_gasto: '2026-09-28', created_dia: '2026-09-28',
  motivo_rechazo: null, comprobacion_kepler: true, comprobacion_folio: 'XA1001-0001',
  roles: ['comprobante_1'], protocolo: veredicto('completo'),
  gasto_folios: ['0097092'],
  transferencias: [],
  ...over,
});

const REPORTE = (over: Partial<RespuestaExpediente> = {}): RespuestaExpediente => ({
  filtro: { desde: null, hasta: null, departamento: null },
  departamentos: [
    { departamento: 'LOGISTICA', vales: 2 },
    { departamento: 'SISTEMAS', vales: 1 },
    { departamento: null, vales: 1 },
  ],
  personas: [
    {
      clave: 'david_cisneros', username: 'david_cisneros', nombre: 'David Cisneros Ramírez',
      areas: ['SISTEMAS'],
      total: 2, monto: 3000, completos: 1, incompletos: 1, en_captura: 0, sin_medir: 0,
      vales: [
        VALE(),
        VALE({ id: 'v2', folio_solicitud: '0009947', protocolo: veredicto('incompleto', [FALTA_KEPLER]), comprobacion_kepler: false, comprobacion_folio: null }),
      ],
    },
    {
      // ⛔ El caso REAL y mayoritario: el expediente guarda el nombre tecleado, no un
      // username. Medido: de 155 vales, solo 66 traen `created_by` que coincida con el padron.
      clave: 'Leonardo Cazares', username: null, nombre: null, areas: ['LOGISTICA'],
      total: 1, monto: 500, completos: 1, incompletos: 0, en_captura: 0, sin_medir: 0,
      vales: [VALE({ id: 'v3', folio_solicitud: '0009948' })],
    },
  ],
  total: { personas: 2, vales: 3, completos: 2, incompletos: 1, en_captura: 0, sin_medir: 0, monto: 3500 },
  personas_sin_usuario: 1,
  comprobaciones_medidas: true,
  truncado: false,
  ...over,
});

describe('[GX.59] FinanzasExpedienteComponent', () => {
  let fix: ReturnType<typeof TestBed.createComponent<FinanzasExpedienteComponent>>;
  let c: FinanzasExpedienteComponent;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FinanzasExpedienteComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    fix = TestBed.createComponent(FinanzasExpedienteComponent);
    c = fix.componentInstance;
    http = TestBed.inject(HttpTestingController);
  });

  const montar = (r: RespuestaExpediente = REPORTE()) => {
    fix.detectChanges();
    http.expectOne((q) => q.url.endsWith('/expediente')).flush(r);
    fix.detectChanges();
  };

  const txt = () => fix.nativeElement.textContent as string;

  it('pide el expediente al abrir', () => {
    fix.detectChanges();
    const req = http.expectOne((q) => q.url.endsWith('/expediente'));
    expect(req.request.method).toBe('GET');
    req.flush(REPORTE());
  });

  describe('las personas', () => {
    /** ⭐ Lo que pidió el usuario, literal: nombre completo **además** del username. */
    it('muestra el nombre completo Y el username', () => {
      montar();
      const rail = fix.nativeElement.querySelector('.exp-rail') as HTMLElement;
      expect(rail.textContent).toContain('David Cisneros Ramírez');
      expect(rail.textContent).toContain('david_cisneros');
    });

    /**
     * ⛔ **Quien no está en el padrón se DECLARA.** Rellenar el hueco con el username
     * disfrazado de persona inventaría un dato: el nombre no existe, y la pantalla lo dice.
     */
    /**
     * ⛔⛔ **El caso que casi se construye mal.** El pedido decia «con su nombre completo
     * ademas de su username», y al medir los datos NINGUNO de los dos campos del expediente
     * es un username confiable: `solicitante` es el AREA de Kepler (1 de 155 coincide) y
     * `created_by` lo es solo en 66 de 155 — el resto trae el nombre tecleado.
     *
     * Asi que el username se DECLARA cuando existe. Rellenarlo con la clave fingiria un
     * vinculo con el padron que no hay, y es justo el dato con el que alguien le escribiria
     * a esa persona.
     */
    it('a quien no esta en el padron lo declara, no le inventa un username', () => {
      montar();
      const sinUser = fix.nativeElement.querySelectorAll('.exp-sinnom');
      expect(sinUser.length).toBe(1);
      expect((sinUser[0] as HTMLElement).textContent).toContain('sin usuario');
      // Y la clave real sigue a la vista: el dato no se pierde, se nombra.
      expect((fix.nativeElement.querySelector('.exp-rail') as HTMLElement).textContent)
        .toContain('Leonardo Cazares');
    });

    /** Y se dice CUANTAS, para que el hueco tenga tamano en vez de ser una sorpresa. */
    it('dice cuantas personas no estan ligadas a un usuario', () => {
      montar();
      expect(txt()).toContain('1 de 2 personas no están ligadas');
    });

    it('arranca con una persona elegida: la pantalla no abre vacía', () => {
      montar();
      expect(c.persona()?.clave).toBe('david_cisneros');
    });

    /**
     * ⚠️ El filtro es una SEÑAL y lo lee un `computed`. Como campo plano quedaría congelado
     * y escribir en el buscador no filtraría nada — el defecto de GX.22 y CG.22.
     */
    it('⭐ escribir en el buscador filtra de verdad', () => {
      montar();
      expect(c.personasFiltradas().length).toBe(2);
      c.filtro.set('cisneros');
      expect(c.personasFiltradas().length).toBe(1);
      c.filtro.set('leonardo');
      expect(c.personasFiltradas().map((p) => p.clave)).toEqual(['Leonardo Cazares']);
    });

    /** Si el filtro deja fuera a la elegida, se cae a la primera que quedó: nunca al vacío. */
    it('con el filtro puesto, la selección no queda huérfana', () => {
      montar();
      c.seleccion.set('david_cisneros');
      c.filtro.set('leonardo');
      expect(c.persona()?.clave).toBe('Leonardo Cazares');
    });
  });

  describe('los botones', () => {
    /**
     * ⛔ `[GX.65.2]` El botón forzoso «Comprobación de Kepler» se retiró con la regla. Esta es
     * la prueba negativa: el fixture TODAVÍA trae un vale con «falta la comprobación» (como lo
     * mandaría un servidor viejo), y aun así el botón no aparece.
     */
    it('⛔ ya no ofrece «Comprobación de Kepler», ni con un veredicto viejo que la pida', () => {
      montar();
      c.seleccion.set('david_cisneros');
      fix.detectChanges();
      const botones = [...fix.nativeElement.querySelectorAll('.exp-acc a, .exp-acc button')]
        .map((a: Element) => (a.textContent || '').trim());
      expect(botones.some((t) => t.includes('Comprobación de Kepler'))).toBe(false);
      // Y el resto de la ficha sigue ahí: no se fue el footer entero.
      expect(botones.some((t) => t.includes('Ver el vale'))).toBe(true);
    });

    it('el método del botón forzoso ya no existe', () => {
      expect((c as unknown as Record<string, unknown>)['necesitaKepler']).toBeUndefined();
    });

    /** La factura se le pide sólo a quien quedó debiendo: al resto sería inventarle una deuda. */
    it('«Subir la factura» sólo a quien se aprobó con cotización', () => {
      expect(c.necesitaFactura(VALE())).toBe(false);
      expect(c.necesitaFactura(VALE({
        provisional: true, protocolo: veredicto('incompleto', [FALTA_FACTURA]),
      }))).toBe(true);
    });

    /** ⛔ Sin folio no hay a dónde ir: un botón que lleva a una pantalla en blanco es peor. */
    it('sin folio no se ofrece la factura', () => {
      const sinFolio = VALE({ folio_solicitud: null, protocolo: veredicto('incompleto', [FALTA_KEPLER, FALTA_FACTURA]), provisional: true });
      expect(c.necesitaFactura(sinFolio)).toBe(false);
    });
  });

  /**
   * `[GX.62]` — **Los tres números del soporte documental.**
   *
   * El usuario lo pidió así: el expediente debe CONTENER la solicitud `XA1501`, el gasto
   * `XA1001` y el pago `XD2601`. Los dos primeros ya se pueden mostrar; el tercero todavía no
   * (el pago no dice qué gasto paga — `c37='0'` en el 100%, `c39` vacío).
   */
  describe('[GX.62] los números del expediente', () => {
    it('muestra la solicitud y el gasto, con su prefijo', () => {
      montar();
      // ⚠️ Sobre TODAS las cabeceras, no la primera: el orden pone arriba lo que falta
      // cerrar, asi que el primer vale no es el primero de la lista que trae el servidor.
      const cab = [...fix.nativeElement.querySelectorAll('.exp-vale-h')]
        .map((e: Element) => e.textContent || '').join(' ');
      expect(cab).toContain('XA1501-0009946');
      expect(cab).toContain('XA1501-0009947');
      expect(cab).toContain('XA1001-0097092');
    });

    /**
     * ⭐ **El gasto es una LISTA, no un folio.** Medido en GX.15: 165 solicitudes tienen 2
     * gastos, 10 tienen 3 y 2 tienen 4. Un campo singular mostraría uno arbitrario y
     * escondería el resto sin un solo error.
     */
    it('⭐ si la solicitud tiene varios gastos, salen TODOS', () => {
      montar(REPORTE({
        personas: [{
          clave: 'x', username: 'x', nombre: 'X', areas: [],
          total: 1, monto: 1, completos: 1, incompletos: 0, en_captura: 0, sin_medir: 0,
          vales: [VALE({ gasto_folios: ['0097092', '0097093', '0097094'] })],
        }],
      }));
      const h = fix.nativeElement.querySelector('.exp-vale-h') as HTMLElement;
      for (const g of ['0097092', '0097093', '0097094']) expect(h.textContent).toContain(g);
    });

    /** ⛔ Sin gasto se DECLARA: un hueco mudo se lee como que el trámite terminó. */
    it('sin gasto aplicado lo dice, no deja el hueco', () => {
      montar(REPORTE({
        personas: [{
          clave: 'x', username: 'x', nombre: 'X', areas: [],
          total: 1, monto: 1, completos: 0, incompletos: 0, en_captura: 1, sin_medir: 0,
          vales: [VALE({ gasto_folios: [], protocolo: veredicto('en_captura', [{ id: 'firma', label: 'Falta la firma', detalle: 'Espera en la bandeja.' }]) })],
        }],
      }));
      expect(txt()).toContain('sin gasto aplicado');
      // Sin gasto no hay transferencia que buscar: no se agrega un segundo «sin».
      expect(txt()).not.toContain('sin transferencia');
    });

    /**
     * `[GX.75]` **El tercer número: la transferencia `XD2601`** que pagó el gasto (Kepler `kdm5`).
     * Lo que puede mentir: sumar una cancelada como pagado, o pintar «sin transferencia» cuando
     * no se pudo medir.
     */
    describe('[GX.75] la transferencia XD2601', () => {
      const conVale = (v: Partial<ValeExpediente>) => REPORTE({
        personas: [{
          clave: 'x', username: 'x', nombre: 'X', areas: [],
          total: 1, monto: 1, completos: 1, incompletos: 0, en_captura: 0, sin_medir: 0,
          vales: [VALE(v)],
        }],
      });
      const T = (o: Partial<TransferenciaGasto> = {}): TransferenciaGasto => ({
        gasto_folio: '0097092', folio: '0022034', fecha: '2026-09-25', importe: 1583.86, aplicado: 1583.86, cancelada: false, ...o,
      });

      it('⭐ sale en la cadena después del gasto, con lo transferido y su fecha', () => {
        montar(conVale({ transferencias: [T()] }));
        const h = fix.nativeElement.querySelector('.exp-vale-h') as HTMLElement;
        expect(h.textContent).toMatch(/XA1501-0009946[\s\S]*XA1001-0097092[\s\S]*XD2601-0022034/);
        expect(txt()).toContain('transferido $1,583.86 el 25/09/2026');
      });

      it('un gasto pagado en varias transferencias las muestra todas y suma lo aplicado', () => {
        montar(conVale({ transferencias: [T({ folio: '0022034', aplicado: 1000 }), T({ folio: '0022035', aplicado: 583.86, fecha: '2026-09-26' })] }));
        expect(txt()).toContain('XD2601-0022034');
        expect(txt()).toContain('XD2601-0022035');
        expect(txt()).toContain('transferido $1,583.86 el 26/09/2026');
      });

      it('⛔ la cancelada se tacha, se avisa y NO suma', () => {
        montar(conVale({ transferencias: [T({ aplicado: 500 }), T({ folio: '0022099', aplicado: 1083.86, cancelada: true })] }));
        const chip = [...fix.nativeElement.querySelectorAll('.exp-folio.pago')]
          .find((e: Element) => e.textContent?.includes('0022099')) as HTMLElement;
        expect(chip.classList).toContain('cancelada');
        expect(chip.getAttribute('title')).toContain('CANCELADA');
        expect(txt()).toContain('transferido $500.00');
        expect(txt()).toContain('1 transferencia cancelada en Kepler');
      });

      it('con gasto y sin transferencia lo dice', () => {
        montar(conVale({ transferencias: [] }));
        expect(txt()).toContain('sin transferencia');
        expect(txt()).not.toContain('transferido');
      });

      it('⛔ null = no se midió: lo declara, no dice «sin transferencia»', () => {
        montar(conVale({ transferencias: null }));
        expect(txt()).toContain('transferencia sin medir');
        expect(txt()).not.toContain('sin transferencia');
        expect(fix.nativeElement.querySelector('.exp-folio.pago')).toBeNull();
      });
    });

    /**
     * ⭐⭐ **El expediente imprimible de GX.15 estaba construido y era INALCANZABLE.**
     * Endpoint, servicio con Chromium, método en el cliente — y cero botones en todo el
     * repo que lo llamaran. Esta prueba existe para que no vuelva a quedarse sin puerta.
     */
    it('⭐ el botón del PDF existe y pide el expediente', () => {
      montar();
      const btn = [...fix.nativeElement.querySelectorAll('.exp-acc button')]
        .find((b: Element) => (b.textContent || '').includes('Expediente en PDF')) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      btn.click();
      const req = http.expectOne((q) => q.url.includes('/expediente/') && q.url.includes('/pdf'));
      expect(req.request.responseType).toBe('blob');
      req.flush(new Blob(['%PDF-1.4']));
    });

    /** Mientras arma el PDF lo dice y no se encola otro: armarlo tarda. */
    it('no se encolan dos PDF del mismo vale', () => {
      montar();
      const vale = c.persona()!.vales[0];
      c.verExpediente(vale);
      expect(c.pdfCargando()).toBe(vale.id);
      c.verExpediente(vale);   // segundo clic: no debe salir otra petición
      http.expectOne((q) => q.url.includes('/pdf')).flush(new Blob(['%PDF']));
    });

    /**
     * ⭐ `[GX.70]` Si el PDF falla, el aviso dice POR QUÉ. El cuerpo del error llega como
     * Blob (la petición es `responseType: 'blob'`) y antes nadie lo leía: un 404 de alcance
     * y una falla del motor de PDF se veían igual, «No se pudo armar el expediente».
     */
    it('⭐ si el PDF falla, el aviso trae el motivo del servidor', async () => {
      montar();
      const toast = fix.debugElement.injector.get(MessageService);
      const avisos: Array<{ severity?: string; summary?: string; detail?: string }> = [];
      vi.spyOn(toast, 'add').mockImplementation((m) => { avisos.push(m); });

      c.verExpediente(c.persona()!.vales[0]);
      http.expectOne((q) => q.url.includes('/pdf')).flush(
        new Blob([JSON.stringify({ statusCode: 404, message: 'la solicitud 0009946 no está dentro de tu alcance' })],
          { type: 'application/json' }),
        { status: 404, statusText: 'Not Found' });

      await vi.waitFor(() => expect(avisos.length).toBe(1));
      expect(avisos[0].severity).toBe('error');
      expect(avisos[0].detail).toContain('0009946');
      expect(avisos[0].detail).toContain('no está dentro de tu alcance');
      expect(c.pdfCargando()).toBeNull();   // el botón se vuelve a habilitar
    });

    /** Si el cuerpo no trae motivo legible, igual avisa — nunca se queda callado. */
    it('sin motivo legible en el cuerpo, avisa igual con el folio', async () => {
      montar();
      const toast = fix.debugElement.injector.get(MessageService);
      const avisos: Array<{ detail?: string }> = [];
      vi.spyOn(toast, 'add').mockImplementation((m) => { avisos.push(m); });

      c.verExpediente(c.persona()!.vales[0]);
      http.expectOne((q) => q.url.includes('/pdf')).flush(new Blob(['<html>502</html>']),
        { status: 502, statusText: 'Bad Gateway' });

      await vi.waitFor(() => expect(avisos.length).toBe(1));
      expect(avisos[0].detail).toContain('0009946');
    });

    /** ⛔ Sin folio o sin sucursal no hay expediente que armar. */
    it('sin folio no pide nada', () => {
      montar();
      c.verExpediente(VALE({ folio_solicitud: null }));
      expect(c.pdfCargando()).toBeNull();
      http.expectNone((q) => q.url.includes('/pdf'));
    });
  });

  describe('lo que no se pudo medir', () => {
    /**
     * ⛔ `[GX.65.2]` La banda «sin la tabla de comprobaciones ningún vale puede salir
     * completo» se retiró: con la comprobación fuera de la regla, esa frase sería FALSA.
     * Prueba negativa: aunque el servidor diga que no la midió, la banda no aparece.
     */
    it('⛔ sin la tabla de comprobaciones ya NO pinta la banda (sería falsa)', () => {
      montar(REPORTE({ comprobaciones_medidas: false }));
      expect(fix.nativeElement.querySelector('.exp-aviso')).toBeNull();
      expect(fix.nativeElement.textContent).not.toContain('ningún vale');
    });

    /** Un mosaico en cero ensucia el tablero y entrena a ignorarlo: sin casos, no se pinta. */
    it('el KPI de «sin medir» sólo sale cuando hay alguno', () => {
      montar();
      const kpis = fix.nativeElement.querySelector('.exp-kpis') as HTMLElement;
      expect(kpis.textContent).not.toContain('Sin medir');
    });

    it('y SÍ sale cuando los hay', () => {
      montar(REPORTE({
        total: { personas: 2, vales: 3, completos: 1, incompletos: 1, en_captura: 0, sin_medir: 1, monto: 3500 },
      }));
      const kpis = fix.nativeElement.querySelector('.exp-kpis') as HTMLElement;
      expect(kpis.textContent).toContain('Sin medir');
    });
  });

  describe('el orden', () => {
    /**
     * Lo que hay que atender, arriba. Ordenado por fecha, el único vale trabado se esconde
     * entre treinta cerrados — que es exactamente cómo un pendiente se vuelve eterno.
     */
    it('⭐ los vales sin cerrar van primero', () => {
      montar();
      c.seleccion.set('david_cisneros');
      const orden = c.valesOrdenados().map((v) => v.protocolo.etapa);
      expect(orden[0]).toBe('incompleto');
      expect(orden[orden.length - 1]).toBe('completo');
    });
  });

  describe('el tablero', () => {
    it('publica los totales que manda el servidor, sin recalcularlos', () => {
      montar();
      const kpis = fix.nativeElement.querySelector('.exp-kpis') as HTMLElement;
      expect(kpis.textContent).toContain('2');   // personas
      expect(kpis.textContent).toContain('3');   // vales
    });

    it('avisa cuando la lista viene cortada', () => {
      montar(REPORTE({ truncado: true }));
      expect(txt()).toContain('tope de filas');
    });

    /** Un servidor caído no puede dejar la pantalla cargando para siempre. */
    it('un error se muestra, no se traga', () => {
      fix.detectChanges();
      http.expectOne((q) => q.url.endsWith('/expediente'))
        .flush({ message: 'no autorizado' }, { status: 403, statusText: 'Forbidden' });
      fix.detectChanges();
      expect(c.cargando()).toBe(false);
      expect(txt()).toContain('no autorizado');
    });
  });

  /**
   * `[GX.72]` **Los filtros: fechas de levantamiento y departamento.** Los aplica el SERVIDOR,
   * así que lo que se vigila es (1) que viajen bien, (2) que la pantalla no mienta sobre qué
   * contó y (3) que una respuesta vieja no pise a la nueva.
   */
  describe('[GX.72] los filtros', () => {
    const pedido = () => http.expectOne((q) => q.url.endsWith('/expediente'));

    it('la primera carga no manda filtros', () => {
      fix.detectChanges();
      const req = pedido();
      expect(req.request.params.has('desde')).toBe(false);
      expect(req.request.params.has('hasta')).toBe(false);
      expect(req.request.params.has('departamento')).toBe(false);
      req.flush(REPORTE());
    });

    it('la barra de filtros está en pantalla con fechas y departamento', () => {
      montar();
      const barra = fix.nativeElement.querySelector('.exp-filtros') as HTMLElement;
      expect(barra).toBeTruthy();
      expect(barra.querySelectorAll('input[type="date"]').length).toBe(2);
      expect(barra.textContent).toContain('Levantado desde');
      expect(barra.textContent).toContain('Departamento');
    });

    it('cambiar las fechas vuelve a pedir con desde y hasta', () => {
      montar();
      c.cambiarFecha('desde', '2026-09-01');
      pedido().flush(REPORTE());
      c.cambiarFecha('hasta', '2026-09-30');
      const req = pedido();
      expect(req.request.params.get('desde')).toBe('2026-09-01');
      expect(req.request.params.get('hasta')).toBe('2026-09-30');
      req.flush(REPORTE());
    });

    it('el departamento viaja tal cual; «Sin departamento» viaja con su valor propio', () => {
      montar();
      const sin = c.opcionesDepartamento().find((o) => o.label.startsWith('Sin departamento'));
      expect(sin?.value).toBe(DEPARTAMENTO_SIN);
      c.cambiarDepartamento('LOGISTICA');
      expect(pedido().request.params.get('departamento')).toBe('LOGISTICA');
      c.cambiarDepartamento(DEPARTAMENTO_SIN);
      expect(pedido().request.params.get('departamento')).toBe(DEPARTAMENTO_SIN);
    });

    it('las opciones dicen cuántos vales trae cada departamento', () => {
      montar();
      expect(c.opcionesDepartamento().map((o) => o.label))
        .toEqual(['LOGISTICA · 2', 'SISTEMAS · 1', 'Sin departamento · 1']);
    });

    /** Si lo elegido no está en el periodo nuevo, el selector no puede quedar en blanco. */
    it('el departamento elegido que ya no aparece se conserva con 0', () => {
      montar();
      c.cambiarDepartamento('RRHH');
      pedido().flush(REPORTE());
      expect(c.opcionesDepartamento()[0]).toEqual({ label: 'RRHH · 0', value: 'RRHH' });
    });

    /** ⛔ Dos cambios seguidos: la respuesta del primero NO puede pisar al segundo. */
    it('⛔ un filtro nuevo cancela la petición anterior', () => {
      montar();
      c.cambiarFecha('desde', '2026-09-01');
      const viejo = pedido();
      c.cambiarFecha('desde', '2026-09-15');
      expect(viejo.cancelled).toBe(true);
      const nuevo = pedido();
      expect(nuevo.request.params.get('desde')).toBe('2026-09-15');
      nuevo.flush(REPORTE());
    });

    /** ⛔ Con el rango al revés no se pide nada: se dice junto a las fechas. */
    it('⛔ rango al revés: no consulta y lo avisa', () => {
      montar();
      c.cambiarFecha('desde', '2026-10-07');
      pedido().flush(REPORTE());
      c.cambiarFecha('hasta', '2026-10-01');
      http.expectNone((q) => q.url.endsWith('/expediente'));
      fix.detectChanges();
      expect(txt()).toContain('posterior');
    });

    /** El rótulo sale del filtro que DEVOLVIÓ el servidor: lo que dice es lo que se contó. */
    it('el rótulo dice el periodo y el departamento que contó el servidor', () => {
      montar(REPORTE({ filtro: { desde: '2026-09-01', hasta: '2026-09-30', departamento: 'LOGISTICA' } }));
      expect(txt()).toContain('del 01/09/2026 al 30/09/2026');
      expect(txt()).toContain('departamento LOGISTICA');
    });

    it('sin filtro no hay rótulo que aclarar', () => {
      montar();
      expect(c.resumenFiltro()).toBeNull();
      expect(fix.nativeElement.querySelector('.exp-f-resumen')).toBeNull();
    });

    it('cero vales con filtro lo dice, en vez de «elegí una persona»', () => {
      montar(REPORTE({
        filtro: { desde: '2026-01-01', hasta: '2026-01-31', departamento: null },
        personas: [],
        total: { personas: 0, vales: 0, completos: 0, incompletos: 0, en_captura: 0, sin_medir: 0, monto: 0 },
        personas_sin_usuario: 0,
      }));
      expect(txt()).toContain('Ningún vale con estos filtros');
      expect(txt()).not.toContain('Elegí una persona');
    });

    it('«Limpiar filtros» vuelve a pedir sin ninguno', () => {
      montar();
      c.cambiarDepartamento('SISTEMAS');
      pedido().flush(REPORTE());
      fix.detectChanges();
      const btn = [...fix.nativeElement.querySelectorAll('button')]
        .find((b: Element) => (b.textContent || '').includes('Limpiar filtros')) as HTMLButtonElement;
      expect(btn).toBeTruthy();
      btn.click();
      const req = pedido();
      expect(req.request.params.has('departamento')).toBe(false);
      expect(c.hayFiltro()).toBe(false);
      req.flush(REPORTE());
    });
  });

  /**
   * `[GX.73]` **El expediente se refresca solo**, con el filtro vigente. Se cuida que lleve el
   * filtro, que no parpadee, que no refresque mientras se arma un PDF, y que una respuesta de
   * OTRO filtro (cambió mientras volaba) se descarte: publicarla mostraría KPIs de un periodo
   * con el rótulo de otro.
   */
  describe('[GX.73] el refresco en segundo plano', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // ⚠️ El componente del `beforeEach` de afuera nació con el reloj REAL: su encuesta no
      // responde a `advanceTimersByTime`. Se descarta —respondiendo su pedido inicial, que si no
      // quedaría colgado y `montar` encontraría dos— y se crea otro ya con el reloj simulado.
      http.match((q) => q.url.endsWith('/expediente')).forEach((r) => r.flush(REPORTE()));
      fix.destroy();
      fix = TestBed.createComponent(FinanzasExpedienteComponent);
      c = fix.componentInstance;
    });
    afterEach(() => vi.useRealTimers());
    const pedido = () => http.expectOne((q) => q.url.endsWith('/expediente'));

    it('⭐ al minuto vuelve a pedir CON el filtro vigente, sin aviso de carga', () => {
      montar();
      c.cambiarDepartamento('LOGISTICA');
      pedido().flush(REPORTE());
      vi.advanceTimersByTime(60_000);
      const req = pedido();
      expect(c.cargando()).toBe(false);
      expect(req.request.params.get('departamento')).toBe('LOGISTICA');
      req.flush(REPORTE({ total: { ...REPORTE().total, vales: 9 } }));
      expect(c.datos()?.total.vales).toBe(9);
    });

    it('conserva la persona elegida si sigue en el resultado', () => {
      montar();
      c.seleccion.set('Leonardo Cazares');
      vi.advanceTimersByTime(60_000);
      pedido().flush(REPORTE());
      expect(c.seleccion()).toBe('Leonardo Cazares');
    });

    it('⛔ mientras se arma un PDF NO refresca', () => {
      montar();
      c.pdfCargando.set('v1');
      vi.advanceTimersByTime(60_000);
      http.expectNone((q) => q.url.endsWith('/expediente'));
    });

    it('⛔ si el filtro cambió mientras volaba, la respuesta vieja se descarta', () => {
      montar();
      vi.advanceTimersByTime(60_000);
      const viejo = pedido();
      c.cambiarDepartamento('SISTEMAS');
      const nuevo = pedido();
      const delNuevo = REPORTE({ filtro: { desde: null, hasta: null, departamento: 'SISTEMAS' } });
      nuevo.flush(delNuevo);
      viejo.flush(REPORTE({ total: { ...REPORTE().total, vales: 99 } }));
      expect(c.datos()?.total.vales).not.toBe(99);
      expect(c.datos()?.filtro.departamento).toBe('SISTEMAS');
    });

    it('⛔ un refresco que falla NO pisa el expediente ni muestra error', () => {
      montar();
      vi.advanceTimersByTime(60_000);
      pedido().flush({ message: 'boom' }, { status: 500, statusText: 'Server Error' });
      expect(c.error()).toBeNull();
      expect(c.datos()?.total.vales).toBe(3);
    });
  });
});
