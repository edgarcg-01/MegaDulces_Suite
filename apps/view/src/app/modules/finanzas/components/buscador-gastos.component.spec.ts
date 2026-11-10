import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LOCALE_ID } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
import { BuscadorGastosComponent } from './buscador-gastos.component';
import { BuscadorGastosEstado, valeDelFolio } from './buscador-gastos.estado';
import { PermissionsService } from '../../../core/services/permissions.service';
import type { ExpedienteDelDia, ResultadoBusquedaGastos } from '../comprobaciones.service';

/**
 * `[GX.88]` **El buscador de gastos**, compartido por Aprobación, Historial y Expediente.
 * Pedido del usuario (2026-10-30): folios, nombre, quién lo levantó, quién lo aprobó, y las
 * solicitudes de Kepler que nunca se subieron. Sólo para quien tiene permiso de aprobar.
 *
 * `[GX.103]` (2026-11-09) A la par de Kepler: los últimos sin escribir, folio + Enter abre, tabla
 * densa, F9 y `/` para llegar, flechas para moverse.
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
  recientes: false,
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
  const caja = () => fix.nativeElement.querySelector('input.bg-in') as HTMLInputElement;
  const renglones = () => Array.from(fix.nativeElement.querySelectorAll('tr.bg-vale')) as HTMLElement[];
  const tecla = (el: EventTarget, key: string) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  };

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

  it('⛔ sin permiso, ni F9 ni «Últimos» consultan nada', () => {
    montar({ FINANCE_EXPENSES_VER: true });
    tecla(document, 'F9');
    estado().verRecientes();
    expect(c.buscando()).toBe(false);
    http.expectNone((r) => r.url.includes('/buscar'));
  });

  it('con permiso de aprobar aparece', () => {
    montar();
    expect(fix.nativeElement.querySelector('input[type=search]')).not.toBeNull();
  });

  it('busca en el servidor y pinta vales y solicitudes sin vale por separado, en tablas', () => {
    montar();
    buscar('papeleria');
    const req = pedido();
    expect(req.request.params.get('q')).toBe('papeleria');
    req.flush(RES());
    fix.detectChanges();
    expect(txt()).toContain('0010287');
    expect(txt()).toContain('cerró DEMO APROBADOR');
    expect(txt()).toContain('pidió SOLICITANTE DEMO');
    expect(txt()).toContain('Solicitudes de Kepler sin vale');
    expect(txt()).toContain('0010570');
    // La columna se llama «En Kepler»: el renglón ya no lo repite.
    expect(txt()).toContain('En Kepler');
    expect(txt()).toContain('Aplicada · salió el dinero');
    expect(txt()).not.toContain('aplicada en Kepler');
    // Dice desde cuándo busca en Kepler: antes de la Suite, «sin vale» no es pendiente.
    expect(txt()).toContain('21/08/26');
    // `[GX.103]` Una tabla densa, no tarjetas: dos tablas, una por lista.
    expect(fix.nativeElement.querySelectorAll('p-table').length).toBe(2);
    expect(renglones().length).toBe(2);
  });

  it('al elegir un vale lo pasa al estado: qué se hace con él lo decide la pantalla de la pestaña', () => {
    montar();
    const elegidos: ExpedienteDelDia[] = [];
    estado().aperturas$.subscribe((v) => elegidos.push(v));
    buscar('papeleria');
    pedido().flush(RES());
    fix.detectChanges();
    renglones()[0].click();
    expect(elegidos.map((v) => v.id)).toEqual(['v1']);
    // La solicitud sin vale no se abre: no hay expediente que mirar. Ni clic ni foco.
    const sinVale = fix.nativeElement.querySelector('tr.bg-sinvale') as HTMLElement;
    expect(sinVale).not.toBeNull();
    expect(sinVale.getAttribute('tabindex')).toBeNull();
    expect(sinVale.getAttribute('role')).toBeNull();
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

  describe('[GX.103] los últimos sin escribir (F9 en Kepler)', () => {
    it('Enter con la caja vacía trae los últimos', () => {
      montar();
      c.buscarYa();
      const req = pedido();
      expect(req.request.params.get('q')).toBe('');
      req.flush(RES({ q: '', recientes: true, vales_truncado: true }));
      fix.detectChanges();
      expect(c.buscando()).toBe(true);
      expect(txt()).toContain('Los últimos vales');
      // ⛔ Cortada, lo dice: son los últimos, no todos.
      expect(txt()).toContain('Son los últimos 2');
      expect(txt()).not.toContain('Escribe al menos');
    });

    it('«Últimos» hace lo mismo con un clic (en el celular no hay F9)', () => {
      montar();
      (fix.nativeElement.querySelector('button.bg-ultimos') as HTMLButtonElement).click();
      expect(pedido().request.params.get('q')).toBe('');
    });

    it('con texto, «Últimos» se cambia por la tachita de limpiar', () => {
      montar();
      c.escribir('pa');
      fix.detectChanges();
      expect(fix.nativeElement.querySelector('button.bg-ultimos')).toBeNull();
      expect(fix.nativeElement.querySelector('button.bg-x')).not.toBeNull();
      c.limpiar(); // cancela la espera de la búsqueda: no queda una consulta suelta
    });

    it('escribir deja los recientes y busca lo escrito', () => {
      montar();
      estado().verRecientes();
      pedido().flush(RES({ q: '', recientes: true }));
      c.escribir('pap');
      expect(estado().recientes()).toBe(false);
      c.buscarYa();
      expect(pedido().request.params.get('q')).toBe('pap');
    });

    it('rebuscar con los recientes vuelve a pedir los recientes', () => {
      montar();
      estado().verRecientes();
      pedido().flush(RES({ q: '', recientes: true }));
      estado().rebuscar();
      expect(pedido().request.params.get('q')).toBe('');
    });

    it('limpiar sale de los recientes', () => {
      montar();
      estado().verRecientes();
      pedido().flush(RES({ q: '', recientes: true }));
      c.limpiar();
      expect(estado().recientes()).toBe(false);
      expect(c.buscando()).toBe(false);
    });
  });

  describe('[GX.103] folio + Enter abre el vale (como en Kepler)', () => {
    it('si el folio es de UN solo vale, se abre al llegar', () => {
      montar();
      const elegidos: ExpedienteDelDia[] = [];
      estado().aperturas$.subscribe((v) => elegidos.push(v));
      buscar('10287');
      pedido().flush(RES({ q: '10287', vales: [V()] }));
      expect(elegidos.map((v) => v.id)).toEqual(['v1']);
    });

    it('⛔ con el mismo folio en dos sucursales no adivina: se elige de la lista', () => {
      montar();
      const elegidos: ExpedienteDelDia[] = [];
      estado().aperturas$.subscribe((v) => elegidos.push(v));
      buscar('10287');
      pedido().flush(RES({ q: '10287', vales: [V(), V({ id: 'v9', sucursal: '03' })] }));
      expect(elegidos).toEqual([]);
    });

    it('⛔ un texto que no es folio no abre nada aunque haya un solo vale', () => {
      montar();
      const elegidos: ExpedienteDelDia[] = [];
      estado().aperturas$.subscribe((v) => elegidos.push(v));
      buscar('mantenimiento');
      pedido().flush(RES({ q: 'mantenimiento', vales: [V()] }));
      expect(elegidos).toEqual([]);
    });

    it('Enter sobre la búsqueda que ya está en pantalla abre sin volver a preguntar', () => {
      montar();
      const elegidos: ExpedienteDelDia[] = [];
      estado().aperturas$.subscribe((v) => elegidos.push(v));
      c.escribir('10287');
      estado().ejecutar(); // lo que hace la espera al dejar de escribir
      pedido().flush(RES({ q: '10287', vales: [V()] }));
      expect(elegidos).toEqual([]); // buscar solo no abre: abrir es del Enter
      c.buscarYa();
      http.expectNone((r) => r.url.includes('/buscar'));
      expect(elegidos.map((v) => v.id)).toEqual(['v1']);
    });

    it('⛔ rebuscar (después de decidir sobre un vale) nunca lo vuelve a abrir', () => {
      montar();
      const elegidos: ExpedienteDelDia[] = [];
      estado().aperturas$.subscribe((v) => elegidos.push(v));
      buscar('10287');
      pedido().flush(RES({ q: '10287', vales: [V()] }));
      estado().rebuscar();
      pedido().flush(RES({ q: '10287', vales: [V()] }));
      expect(elegidos.map((v) => v.id)).toEqual(['v1']); // una vez, la del Enter
    });

    it('valeDelFolio compara el número del folio, sin los ceros', () => {
      expect(valeDelFolio('10287', [V()])?.id).toBe('v1');
      expect(valeDelFolio('0010287', [V()])?.id).toBe('v1');
      expect(valeDelFolio('287', [V()])).toBeNull(); // contenerlo no es serlo
      expect(valeDelFolio('papeleria', [V()])).toBeNull();
      expect(valeDelFolio('10287', [])).toBeNull();
    });
  });

  describe('[GX.103] teclado', () => {
    it('F9 lleva a la caja y, vacía, trae los últimos', () => {
      montar();
      const ev = tecla(document, 'F9');
      expect(ev.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(caja());
      expect(pedido().request.params.get('q')).toBe('');
    });

    it('F9 con texto sólo lleva a la caja: no borra lo escrito', () => {
      montar();
      c.escribir('pap');
      tecla(document, 'F9');
      expect(document.activeElement).toBe(caja());
      expect(c.busqueda()).toBe('pap');
      http.expectNone((r) => r.url.includes('/buscar')); // F9 con texto no pide los recientes
      c.limpiar();
    });

    it('«/» lleva a la caja desde cualquier parte', () => {
      montar();
      const ev = tecla(document.body, '/');
      expect(ev.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(caja());
    });

    it('⛔ «/» mientras se escribe en otro campo es una diagonal, no un atajo', () => {
      montar();
      const otro = document.createElement('input');
      document.body.appendChild(otro);
      try {
        otro.focus();
        const ev = tecla(otro, '/');
        expect(ev.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(otro);
      } finally { otro.remove(); }
    });

    it('⛔ dentro de un diálogo (el visor del vale) los atajos no hacen nada', () => {
      montar();
      const dialogo = document.createElement('div');
      dialogo.className = 'p-dialog';
      const boton = document.createElement('button');
      dialogo.appendChild(boton);
      document.body.appendChild(dialogo);
      try {
        const ev = tecla(boton, 'F9');
        expect(ev.defaultPrevented).toBe(false);
        http.expectNone((r) => r.url.includes('/buscar'));
      } finally { dialogo.remove(); }
    });

    it('↓ en la caja baja al primer renglón; ↓↑ se mueve; ↑ en el primero regresa a la caja', () => {
      montar();
      buscar('papeleria');
      pedido().flush(RES());
      fix.detectChanges();
      const [r1, r2] = renglones();
      caja().focus();
      tecla(caja(), 'ArrowDown');
      expect(document.activeElement).toBe(r1);
      tecla(r1, 'ArrowDown');
      expect(document.activeElement).toBe(r2);
      tecla(r2, 'ArrowUp');
      expect(document.activeElement).toBe(r1);
      tecla(r1, 'ArrowUp');
      expect(document.activeElement).toBe(caja());
    });

    it('Enter en un renglón lo abre; Esc regresa a la caja sin borrar lo buscado', () => {
      montar();
      const elegidos: ExpedienteDelDia[] = [];
      estado().aperturas$.subscribe((v) => elegidos.push(v));
      buscar('papeleria');
      pedido().flush(RES());
      fix.detectChanges();
      const [, r2] = renglones();
      tecla(r2, 'Enter');
      expect(elegidos.map((v) => v.id)).toEqual(['v2']);
      tecla(r2, 'Escape');
      expect(document.activeElement).toBe(caja());
      expect(c.busqueda()).toBe('papeleria');
    });

    it('la tabla trae el importe como número (si llega como texto, ordenaría «9000» después de «72899»)', () => {
      montar();
      buscar('papeleria');
      pedido().flush(RES({ vales: [V(), V({ id: 'v3', importe: '9000.00' as unknown as number })] }));
      expect(c.filasVales().map((f) => f.importe)).toEqual([72899.91, 9000]);
    });
  });

  /** `[GX.103]` Cómo se ven los resultados (2026-11-09): tarjetas, columnas parejas, lo buscado resaltado. */
  describe('[GX.103] cómo se ven los resultados', () => {
    const marcas = () => Array.from(fix.nativeElement.querySelectorAll('mark.bg-hit')).map((m) => (m as HTMLElement).textContent);

    it('resalta dónde coincide lo buscado: el número adentro del folio', () => {
      montar();
      buscar('102');
      pedido().flush(RES({ q: '102', vales: [V()], sin_vale: [] }));
      fix.detectChanges();
      expect(marcas()).toEqual(['102']);
      // El folio se sigue leyendo entero: resaltar no le quita ni le pone nada.
      expect((fix.nativeElement.querySelector('tr.bg-vale .bg-folio') as HTMLElement).textContent).toBe('0010287');
    });

    it('resalta sin acentos ni mayúsculas, en el concepto y en la persona', () => {
      montar();
      buscar('medico demo');
      pedido().flush(RES({ q: 'medico demo', vales: [V({ concepto: 'SERVICIO MÉDICO' })], sin_vale: [] }));
      fix.detectChanges();
      expect(marcas()).toContain('MÉDICO');
      expect(marcas()).toContain('DEMO');
    });

    it('⛔ con los últimos no se buscó nada: no se resalta nada', () => {
      montar();
      estado().verRecientes();
      pedido().flush(RES({ q: '', recientes: true }));
      fix.detectChanges();
      expect(marcas()).toEqual([]);
    });

    it('⛔ resalta la búsqueda que produjo los resultados, no lo que se está escribiendo encima', () => {
      montar();
      buscar('102');
      pedido().flush(RES({ q: '102', vales: [V()], sin_vale: [] }));
      c.escribir('mantenimiento'); // todavía no llega la respuesta nueva
      fix.detectChanges();
      expect(marcas()).toEqual(['102']);
      c.limpiar();
    });

    it('mientras llega la búsqueda nueva, lo de antes se atenúa y se declara ocupado', () => {
      montar();
      buscar('papeleria');
      pedido().flush(RES());
      estado().rebuscar();
      fix.detectChanges();
      const res = fix.nativeElement.querySelector('.bg-resultados') as HTMLElement;
      expect(res.classList).toContain('bg-viejo');
      expect(res.getAttribute('aria-busy')).toBe('true');
      pedido().flush(RES());
      fix.detectChanges();
      expect(res.classList).not.toContain('bg-viejo');
    });

    it('cada lista va en su tarjeta, y las dos tablas tienen las mismas columnas', () => {
      montar();
      buscar('papeleria');
      pedido().flush(RES());
      fix.detectChanges();
      expect(fix.nativeElement.querySelectorAll('section.surf-panel').length).toBe(2);
      const columnas = (i: number) => Array.from(fix.nativeElement.querySelectorAll('p-table')[i].querySelectorAll('th'))
        .map((th) => (th as HTMLElement).className.match(/bg-c-\w+/)?.[0]);
      expect(columnas(0)).toEqual(['bg-c-folio', 'bg-c-fecha', 'bg-c-con', 'bg-c-imp', 'bg-c-estado', 'bg-c-quien']);
      expect(columnas(1)).toEqual(columnas(0));
    });

    it('el folio lleva su sucursal y el concepto a su proveedor, en la segunda línea', () => {
      montar();
      buscar('papeleria');
      pedido().flush(RES({ vales: [V()], sin_vale: [] }));
      fix.detectChanges();
      const fila = fix.nativeElement.querySelector('tr.bg-vale') as HTMLElement;
      const subs = Array.from(fila.querySelectorAll('.bg-sub')).map((e) => (e as HTMLElement).textContent?.trim());
      expect(subs[0]).toContain('00');
      expect(subs).toContain('PROVEEDOR DEMO');
      expect(subs).toContain('levantó demo.capturista · cerró DEMO APROBADOR');
    });

    it('sólo el vale lleva la flecha de «se abre»; la solicitud sin vale no', () => {
      montar();
      buscar('papeleria');
      pedido().flush(RES());
      fix.detectChanges();
      expect(fix.nativeElement.querySelectorAll('tr.bg-vale .bg-ir').length).toBe(2);
      expect(fix.nativeElement.querySelectorAll('tr.bg-sinvale .bg-ir').length).toBe(0);
    });

    it('sin solicitante en Kepler lo dice, no deja la celda en blanco', () => {
      montar();
      buscar('papeleria');
      pedido().flush(RES({ sin_vale: [{ ...RES().sin_vale[0], solicitante: null }] }));
      fix.detectChanges();
      expect(txt()).toContain('Kepler no dice quién');
    });

    it('el color de la pastilla dice algo: cerrado verde, rechazado rojo, a revisar ámbar; el trámite normal, neutro', () => {
      montar();
      expect(c.tonoEstado('validada')).toBe('success');
      expect(c.tonoEstado('rechazada')).toBe('danger');
      expect(c.tonoEstado('revision')).toBe('warn');
      expect(c.tonoEstado('recibida')).toBe('secondary');
      expect(c.tonoEstado('aprobada')).toBe('secondary');
    });

    it('en Kepler, ámbar sólo cuando el dinero ya salió y no hay vale', () => {
      montar();
      expect(c.tonoKepler('F')).toBe('warn');
      expect(c.tonoKepler('A')).toBe('secondary');
      expect(c.tonoKepler(null)).toBe('secondary');
      expect(c.estadoKepler('A')).toBe('Autorizada');
      expect(c.estadoKepler('x')).toBe('Estado X');
      expect(c.estadoKepler(null)).toBe('Sin estado');
    });
  });
});
