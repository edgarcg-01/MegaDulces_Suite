import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { RespuestaExpediente, ValeExpediente, VeredictoProtocolo } from '@megadulces/contracts';
import { FinanzasExpedienteComponent } from './finanzas-expediente.component';

/**
 * `[GX.59]` — **El Expediente**: los vales de todas las personas, agrupados por persona.
 *
 * ## Qué se prueba, y qué NO
 * La regla del protocolo se prueba en `libs/contracts` y la calcula el **servidor**: esta
 * pantalla la muestra. Lo que puede fallar acá es la **lectura**: que el nombre salga, que lo
 * que no se midió se declare, y que cada botón aparezca sólo cuando hay algo que hacer con él.
 *
 * ⛔ Un botón «Comprobación de Kepler» sobre un vale que ya la tiene manda a alguien a
 * capturar dos veces la misma; uno que no aparece cuando falta deja el trámite trabado sin que
 * nadie sepa dónde apretar. Las dos fallas se ven igual de bien en pantalla.
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
  ...over,
});

const REPORTE = (over: Partial<RespuestaExpediente> = {}): RespuestaExpediente => ({
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

  describe('los dos botones', () => {
    /** ⭐ El forzoso: aparece exactamente cuando falta la comprobación de Kepler. */
    it('ofrece «Comprobación de Kepler» sólo al vale que la debe', () => {
      montar();
      c.seleccion.set('david_cisneros');
      fix.detectChanges();
      const botones = [...fix.nativeElement.querySelectorAll('.exp-acc a')]
        .map((a: Element) => (a.textContent || '').trim());
      expect(botones.filter((t) => t.includes('Comprobación de Kepler')).length).toBe(1);
    });

    it('⛔ NO lo ofrece al vale que ya la tiene: mandaría a capturarla dos veces', () => {
      expect(c.necesitaKepler(VALE())).toBe(false);
      expect(c.necesitaKepler(VALE({ protocolo: veredicto('incompleto', [FALTA_KEPLER]) }))).toBe(true);
    });

    /** La factura se le pide sólo a quien quedó debiendo: al resto sería inventarle una deuda. */
    it('«Subir la factura» sólo a quien se aprobó con cotización', () => {
      expect(c.necesitaFactura(VALE())).toBe(false);
      expect(c.necesitaFactura(VALE({
        provisional: true, protocolo: veredicto('incompleto', [FALTA_FACTURA]),
      }))).toBe(true);
    });

    /** ⛔ Sin folio no hay a dónde ir: un botón que lleva a una pantalla en blanco es peor. */
    it('sin folio no se ofrece ningún botón', () => {
      const sinFolio = VALE({ folio_solicitud: null, protocolo: veredicto('incompleto', [FALTA_KEPLER, FALTA_FACTURA]), provisional: true });
      expect(c.necesitaKepler(sinFolio)).toBe(false);
      expect(c.necesitaFactura(sinFolio)).toBe(false);
    });

    /** El de Kepler lleva al folio puesto, no a una lista de 10,082 para buscarlo a mano. */
    it('el botón de Kepler viaja con el folio', () => {
      montar();
      c.seleccion.set('david_cisneros');
      fix.detectChanges();
      const a = [...fix.nativeElement.querySelectorAll('.exp-acc a')]
        .find((x: Element) => (x.textContent || '').includes('Comprobación de Kepler')) as HTMLAnchorElement;
      expect(a.getAttribute('href')).toContain('folio=0009947');
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
     * ⭐⭐ **La prueba que sostiene el módulo.** Sin la tabla de comprobaciones ningún vale
     * puede salir completo. Pintar eso como «nadie comprobó» acusaría a 19 personas por una
     * consulta que no corrió. La banda lo dice ARRIBA, no en un pie.
     */
    it('declara que no se midió, y lo dice arriba', () => {
      montar(REPORTE({ comprobaciones_medidas: false }));
      const aviso = fix.nativeElement.querySelector('.exp-aviso') as HTMLElement;
      expect(aviso).toBeTruthy();
      // Dice la CAUSA, que es lo accionable: falta la tabla, no falta la gente.
      expect(aviso.textContent).toContain('no se pudo preguntar');
      expect(aviso.textContent).toContain('tabla de comprobaciones');
      // ⚠️ Aca habia un `not.toContain('nadie comprobo')` y daba rojo contra el texto
      // correcto: la banda usa esa frase DENTRO de una negacion («no dice que nadie
      // comprobo»). Buscar una frase suelta no distingue una afirmacion de su contrario;
      // lo que de verdad importa es que el titular diga «Sin medir».
      expect((aviso.querySelector('strong') as HTMLElement).textContent).toContain('Sin medir');
    });

    /** ⛔ Con la medición hecha, la banda NO se pinta: una alarma que grita siempre se ignora. */
    it('medida la comprobación, la banda desaparece', () => {
      montar();
      expect(fix.nativeElement.querySelector('.exp-aviso')).toBeNull();
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
});
