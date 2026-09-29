import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { FinanzasCapturarGastoComponent } from './finanzas-capturar-gasto.component';

/**
 * [GX.17] **El botón tiene que decir por qué está apagado.**
 *
 * Acá vivía una lista de faltantes («Cómo se pagó» / «La foto del comprobante») que se
 * retiró por pedido del usuario. Lo que esa lista hacía —explicar por qué «Enviar a
 * aprobación» está deshabilitado— pasó a la ETIQUETA del botón, porque el `title` de un
 * botón deshabilitado no se lee: no hay hover en táctil y varios navegadores ni lo
 * muestran.
 *
 * Si alguien vuelve a poner un texto fijo en el botón, esto se pone rojo. Un botón apagado
 * sin motivo visible es el mismo callejón que un botón que no hace nada — que es,
 * literalmente, lo que se reportó de la cámara en esta misma pantalla.
 */
describe('[GX.17] FinanzasCapturarGastoComponent · qué dice el botón', () => {
  let comp: FinanzasCapturarGastoComponent;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FinanzasCapturarGastoComponent],
      // `[GX.41]` La pantalla inyecta `ActivatedRoute` para poder abrirse con el folio ya
      // puesto desde «Mis gastos». Sin el router, TODO este archivo se cae -- que es como
      // se descubrió: inyectar una dependencia nueva rompe cada spec del componente.
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    comp = TestBed.createComponent(FinanzasCapturarGastoComponent).componentInstance;
    http = TestBed.inject(HttpTestingController);
  });

  /**
   * [GX.19] Ya no hay paso de «tipo de gasto»: la clasificacion se fija sola al elegir la
   * solicitud. El primer faltante real es el METODO DE PAGO, que es una de las dos cosas
   * que Kepler no tiene y esta pantalla existe para juntar.
   */
  it('el primer faltante es como se pago', () => {
    comp.clasificacion.set('no_comprobable');
    expect(comp.enviarLabel()).toContain('Cómo se pagó');
  });

  it('elegido el tipo, nombra el primer faltante de la compuerta', () => {
    comp.clasificacion.set('no_fiscal_comprobable');
    // La compuerta es `faltaParaMandar()`, la MISMA función que devuelve el 400 del backend:
    // el botón no inventa su propia idea de qué falta.
    expect(comp.enviarLabel()).toContain('Falta');
  });

  /**
   * ⭐ La prueba negativa de la que se retiró: mientras algo falte, el texto NUNCA puede ser
   * la acción a secas. Si lo fuera, el botón quedaría gris y mudo.
   */
  /**
   * ⭐ `[GX.44]` **Con SÓLO la cotización se puede mandar.**
   *
   * Pedido textual: *«solo debe de tener un archivo de evidencia ya sea foto o un doc, debe
   * dejarlo enviar, al igual una cotizacion»*. Antes, sin un `comprobante_*` el botón no se
   * encendía **nunca**: quien sólo tenía la cotización de lo que iba a comprar se quedaba
   * trabado y el gasto no entraba al sistema.
   *
   * ⛔ Esta prueba existe porque el arreglo vive en `libs/contracts` y esta pantalla lo
   * consume de rebote: si alguien vuelve a exigir el comprobante acá —o deja de pasarle los
   * roles de cotización a la compuerta— el botón se apaga otra vez y nada más se entera.
   */
  it('[GX.44] con sólo una cotización el botón se enciende', () => {
    comp.clasificacion.set('no_comprobable');
    comp.formaPago.set('efectivo');
    comp.names.set({ cotizacion: 'cotizacion-proveedor.pdf' });
    expect(comp.faltan().map((f) => f.id)).toEqual([]);
  });

  /** ⛔ Pero sin NINGÚN archivo sigue apagado: lo que cambió es qué cuenta, no si hace falta. */
  it('[GX.44] sin ningún archivo sigue faltando algo', () => {
    comp.clasificacion.set('no_comprobable');
    comp.formaPago.set('efectivo');
    comp.names.set({});
    expect(comp.faltan().map((f) => f.id)).toEqual(['evidencia']);
  });

  it('mientras falte algo, el botón no dice «Enviar a aprobación»', () => {
    expect(comp.puedeEnviar()).toBe(false);
    expect(comp.enviarLabel()).not.toBe('Enviar a aprobación');
  });

  /**
   * [GX.22] **Escribir el dato del pago tiene que DESBLOQUEAR el boton.**
   *
   * No lo hacia: `formaPagoDetalleV` era una propiedad plana y la leia el `computed` de la
   * compuerta, que solo se recalcula cuando cambia una SENAL. Elegias Transferencia,
   * escribias la referencia, y el boton seguia diciendo «Falta: El dato del pago» -- el
   * gasto no se podia enviar. Se destapo probando «Otro» en el navegador.
   *
   * Vale para las CUATRO formas que piden dato (tarjeta, transferencia, cheque, otro).
   */
  it('escribir el dato del pago desbloquea el boton', () => {
    comp.clasificacion.set('no_comprobable');
    comp.formaPago.set('transferencia');
    expect(comp.enviarLabel()).toContain('El dato del pago');

    comp.formaPagoDetalle.set('882301');
    expect(comp.enviarLabel()).not.toContain('El dato del pago');
  });

  it('mientras guarda, lo dice', () => {
    comp.saving.set(true);
    expect(comp.enviarLabel()).toBe('Enviando…');
  });

  /**
   * ⭐ `[GX.31]` **LA PRUEBA QUE FALTABA.** Todas las de arriba comprueban que el botón
   * dice qué falta; NINGUNA comprobaba que, sin faltar nada, el gasto se pueda mandar.
   * Por eso pasó desapercibido que `puedeEnviar()` seguía exigiendo el archivo
   * `solicitud_kepler` después de que GX.18 retirara la única pantalla que lo subía: el
   * botón quedó apagado de por vida **diciendo «Enviar a aprobación»**, porque GX.18
   * también sacó de `enviarTitle()` la rama que lo explicaba. La captura estuvo
   * inutilizable y verde.
   */
  it('con todo puesto, el gasto SE PUEDE ENVIAR', () => {
    comp.gasto.set({
      folio: '0049641', beneficiario: 'PREVENCION', importe: 387.25, sucursal: '01',
      solicitante: 'PREVENCION', fecha: '2026-09-27', concepto: 'BALATAS',
    } as never);
    comp.clasificacion.set('no_comprobable');
    comp.formaPago.set('efectivo');
    // La foto EN VIVO del vale autorizado: es el respaldo desde GX.18. El sello de
    // camara viaja aparte de `names` — `faltan()` los lee a los dos.
    comp.names.set({ comprobante_1: 'vale.jpg' });
    comp.sellos.set({ comprobante_1: { live: true } } as never);

    expect(comp.faltan()).toEqual([]);
    expect(comp.puedeEnviar()).toBe(true);
    expect(comp.enviarLabel()).toBe('Enviar a aprobación');
  });

  /**
   * `[GX.38]` **Que cada botón deje el archivo en SU familia de roles.**
   *
   * No había ninguna prueba del enrutado, y es justo lo que `[GX.36]` cambió: «Subir
   * documento» pasó de `evidencia_*` —un cajón que la compuerta no miraba, así que el
   * archivo entraba y no contaba para nada— a `comprobante_*`. Si alguien lo devuelve,
   * el síntoma es el de entonces: el documento adjunto y el botón diciendo que falta.
   */
  describe('[GX.38] a dónde va cada archivo', () => {
    /** Un `change` como el que dispara el explorador al elegir un archivo. */
    const elegir = (nombre: string, tipo: string) => {
      const input = document.createElement('input');
      input.type = 'file';
      const file = new File([new Uint8Array([1, 2, 3])], nombre, { type: tipo });
      Object.defineProperty(input, 'files', { value: [file] });
      return { target: input } as unknown as Event;
    };

    /**
     * ⚠️ El archivo se lee con `FileReader`, que es ASÍNCRONO: el nombre aparece recién en
     * su `onload`. Comprobarlo en la línea siguiente da vacío y parece un bug del enrutado
     * — la primera versión de estas pruebas se puso roja justo por eso.
     *
     * ⛔ Y esperar «un ratito» tampoco sirve: con dos intentos seguidos el segundo elegía
     * el MISMO hueco, porque `libre()` mira `names()` y todavía no se había llenado. Se
     * espera la CONDICIÓN — cuántos archivos hay — no un tiempo.
     */
    const conArchivos = async (n: number) => {
      for (let i = 0; i < 200 && Object.keys(comp.names()).length < n; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(Object.keys(comp.names()).length).toBe(n);
    };

    it('«Subir vale escaneado» deja el archivo como COMPROBANTE', async () => {
      comp.onFileComprobante(elegir('vale.pdf', 'application/pdf'));
      await conArchivos(1);
      expect(Object.keys(comp.names())).toEqual(['comprobante_1']);
    });

    it('«Subir cotización» deja el archivo como COTIZACIÓN', async () => {
      comp.onFileCotizacion(elegir('cotiza.pdf', 'application/pdf'));
      await conArchivos(1);
      expect(Object.keys(comp.names())).toEqual(['cotizacion']);
    });

    /** ⛔ Un PDF no es una excepción: los dos botones aceptan cualquier tipo desde GX.33. */
    it('los dos aceptan un .docx igual que un PDF', async () => {
      const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      comp.onFileComprobante(elegir('convenio.docx', docx));
      await conArchivos(1);
      comp.onFileCotizacion(elegir('presupuesto.xlsx', 'application/vnd.ms-excel'));
      await conArchivos(2);
      expect(Object.keys(comp.names()).sort()).toEqual(['comprobante_1', 'cotizacion']);
    });

    /** Cada archivo nuevo toma el siguiente hueco libre: no se pisan entre sí. */
    it('varios archivos ocupan huecos distintos', async () => {
      comp.onFileComprobante(elegir('vale-1.pdf', 'application/pdf'));
      await conArchivos(1);
      comp.onFileComprobante(elegir('vale-2.pdf', 'application/pdf'));
      await conArchivos(2);
      expect(Object.keys(comp.names()).sort()).toEqual(['comprobante_1', 'comprobante_2']);
    });

    /** ⚠️ Lleno el cajón, lo DICE — no se traga el archivo en silencio. */
    it('con los huecos llenos avisa, y no pierde el archivo callado', async () => {
      for (let i = 0; i < comp.MAX_COTIZACIONES; i++) { comp.onFileCotizacion(elegir(`c${i}.pdf`, 'application/pdf')); await conArchivos(i + 1); }
      expect(comp.formError()).toBe('');
      comp.onFileCotizacion(elegir('una-mas.pdf', 'application/pdf'));
      expect(comp.formError()).toContain('maximo');
    });
  });

  /**
   * ⭐ `[GX.37]` **El motivo del servidor tiene que llegar a la pantalla.**
   *
   * Medido en local: subir un PDF fallaba y la pantalla decía «No se pudo subir el
   * archivo. Reintenta» — mientras el servidor contestaba «Almacenamiento no configurado
   * (faltan env S3_*)». Reintentar no iba a funcionar nunca, y la persona quedaba dándole
   * al botón. Un mensaje que pide reintentar ante algo que no se arregla reintentando es
   * peor que no decir nada.
   */
  it('cuando el servidor dice POR QUÉ falló la subida, se muestra', () => {
    comp.gasto.set({ folio: '0049650', importe: 1622.5, sucursal: '01' } as never);
    comp.clasificacion.set('no_comprobable');
    comp.formaPago.set('efectivo');
    comp.names.set({ comprobante_1: 'vale.pdf' });
    (comp as unknown as { fileData: Record<string, string> })
      .fileData['comprobante_1'] = 'data:application/pdf;base64,JVBERi0=';

    comp.submit();
    http.expectOne((r) => r.method === 'POST' && r.url.endsWith('/upload'))
      .flush({ message: 'Almacenamiento no configurado (faltan env S3_*).' },
        { status: 400, statusText: 'Bad Request' });

    expect(comp.formError()).toContain('Almacenamiento no configurado');
    // Y NO manda a reintentar algo que no se arregla reintentando.
    expect(comp.formError()).not.toContain('Reintentá');
    // Dice CUÁL archivo, que con varios adjuntos es la mitad del dato.
    expect(comp.formError()).toContain('vale.pdf');
  });

  /** Sin motivo del servidor sí cae al genérico: inventar una causa sería peor. */
  it('sin motivo, cae al mensaje genérico', () => {
    comp.gasto.set({ folio: '0049650', importe: 1622.5, sucursal: '01' } as never);
    comp.clasificacion.set('no_comprobable');
    comp.formaPago.set('efectivo');
    comp.names.set({ comprobante_1: 'vale.pdf' });
    (comp as unknown as { fileData: Record<string, string> })
      .fileData['comprobante_1'] = 'data:application/pdf;base64,JVBERi0=';

    comp.submit();
    http.expectOne((r) => r.url.endsWith('/upload')).flush(null, { status: 500, statusText: 'Server Error' });
    expect(comp.formError()).toContain('Reintentá');
  });

  /** Y sin la foto NO se puede: el respaldo no es opcional, sólo cambió cuál es. */
  it('sin la foto del vale, no se puede enviar', () => {
    comp.gasto.set({ folio: '0049641', importe: 387.25, sucursal: '01' } as never);
    comp.clasificacion.set('no_comprobable');
    comp.formaPago.set('efectivo');
    expect(comp.puedeEnviar()).toBe(false);
    expect(comp.enviarLabel()).toContain('Falta');
  });
});


/**
 * `[GX.41]` — **Llegar a la captura con el folio ya puesto.**
 *
 * Desde «Mis gastos» → «Subir evidencia», el folio y la plaza viajan en la URL. Lo que se
 * prueba no es que el parámetro se lea: es que **se abra el vale correcto, y ninguno más**.
 *
 * ⛔ **373 folios viven en más de una plaza.** Tomar el primer resultado abriría el vale de
 * otra tienda —con el importe y el beneficiario de otra tienda— y la pantalla se vería
 * perfecta. Por eso la sucursal, cuando viene, se exige exacta.
 */
describe('[GX.41] FinanzasCapturarGastoComponent · abrir desde la URL', () => {
  let http: HttpTestingController;

  const montar = (qp: Record<string, string>) => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FinanzasCapturarGastoComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: { get: (k: string) => qp[k] ?? null } } },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    const fix = TestBed.createComponent(FinanzasCapturarGastoComponent);
    return { comp: fix.componentInstance, fix };
  };

  /**
   * Deja pasar las llamadas del arranque y devuelve la del LOOKUP.
   *
   * ⭐ `[GX.49]` Es `/solicitud-exacta`, **no** `/search-solicitudes`. El buscador filtra a
   * las solicitudes de HOY (GX.18) y un vale asignado puede ser de ayer: por el buscador,
   * «Subir evidencia» abria la pantalla VACIA. Medido en runtime: `search-solicitudes` daba
   * 0 filas para un vale de hace tres dias y el lookup exacto daba 1.
   */
  const buscada = (rows: unknown[], ruta = '/solicitud-exacta') => {
    const reqs = http.match((r) => r.url.includes(ruta));
    for (const r of reqs) r.flush(rows);
    http.match(() => true).forEach((r) => { if (!r.cancelled) r.flush([]); });
    return reqs;
  };

  const SOL = (over: Record<string, unknown> = {}) => ({
    folio: '0009946', sucursal: '00', beneficiario: 'TAVISA', importe: 1583.86,
    solicitante: 'DEMO_CAPTURA', fecha: '2026-09-28', concepto: 'COMBUSTIBLE',
    rfc: null, iva: 0, autoriza: null, referencia: null, cuenta_clave: null,
    usuario: null, estado: 'N', ...over,
  });

  it('sin folio en la URL no pide nada', () => {
    montar({});
    expect(http.match((r) => r.url.includes('solicitud')).length).toBe(0);
    http.match(() => true).forEach((r) => { if (!r.cancelled) r.flush([]); });
  });

  /**
   * ⭐ **Con sucursal va por el LOOKUP EXACTO, que no filtra por fecha.** Éste es el arreglo:
   * por el buscador, un vale de ayer no se podia abrir y la pantalla salia vacia — se lee
   * como que los botones no funcionan, que es exactamente como se reporto.
   */
  it('[GX.49] con folio Y sucursal pide el lookup exacto, no el buscador', () => {
    montar({ folio: '0009946', sucursal: '00' });
    const reqs = buscada([SOL()]);
    expect(reqs.length).toBe(1);
    expect(reqs[0].request.urlWithParams).toContain('folio=0009946');
    expect(reqs[0].request.urlWithParams).toContain('sucursal=00');
    expect(reqs[0].request.url).not.toContain('search-solicitudes');
  });

  /**
   * ⚠️ Sin sucursal se cae al buscador a proposito: el lookup exige las dos cosas porque,
   * sin el filtro de fecha, un folio suelto dejaria enumerar 10,082 solicitudes en vez de ~30.
   */
  it('[GX.49] sin sucursal se cae al buscador', () => {
    montar({ folio: '0009946' });
    const reqs = buscada([SOL()], '/search-solicitudes');
    expect(reqs.length).toBe(1);
  });

  it('⭐ abre el vale: el folio queda seleccionado', () => {
    const { comp } = montar({ folio: '0009946', sucursal: '00' });
    buscada([SOL()]);
    expect(comp.gasto()?.folio).toBe('0009946');
    expect(comp.gasto()?.sucursal).toBe('00');
  });

  /** ⛔ El caso que sostiene el bloque: el mismo folio en dos plazas. */
  it('⛔ con la sucursal en la URL, NO abre el de la otra plaza', () => {
    const { comp } = montar({ folio: '0009946', sucursal: '02' });
    buscada([SOL({ sucursal: '00' }), SOL({ sucursal: '02', importe: 999 })]);
    expect(comp.gasto()?.sucursal).toBe('02');
    expect(comp.gasto()?.importe).toBe(999);
  });

  /** ⚠️ Un folio que el feed todavía no trajo NO puede inventar un vale. */
  it('si el folio no aparece, no abre nada', () => {
    const { comp } = montar({ folio: '0009946', sucursal: '00' });
    buscada([]);
    expect(comp.gasto()).toBeNull();
  });

  /** Ni aunque venga otro folio parecido en los resultados. */
  it('no abre un folio distinto al pedido', () => {
    const { comp } = montar({ folio: '0009946' });
    buscada([SOL({ folio: '0009947' })], '/search-solicitudes');
    expect(comp.gasto()).toBeNull();
  });
});
