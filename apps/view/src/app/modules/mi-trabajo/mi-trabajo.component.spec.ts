import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import type { MeContext, MePendiente, MeWork } from '@megadulces/contracts';
import { MiTrabajoComponent } from './mi-trabajo.component';
import { AuthService, JwtPayload } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { MeContextService } from '../../core/services/me-context.service';
import { DataScopeService, MyScope } from '../../core/services/data-scope.service';
import { Permission } from '../../core/constants/permissions';

/**
 * `[SN.3]` `[SN.8]` `[SN.9]` — Lo que la PANTALLA hace por persona, no lo que el mapa devuelve
 * (eso ya lo prueba `suite-map.spec.ts` en `libs/contracts`). Acá se comprueba lo que se vuelve un
 * rebote, una mentira o un callejón sin salida:
 *
 *  · el almacenista con UNA puerta entra directo (paridad con la landing vieja) — y con `stay`
 *    se queda y ve su tarjeta;
 *  · permisos `sin_cargar` pintan skeleton, no "no tienes nada" (ADR-056: dos `{}` distintos);
 *  · cero puertas con permisos cargados = estado DECLARADO, sin el redirect ciego a captures;
 *  · el error de red del contexto es un error, no "Sin puesto asignado";
 *  · el puesto NULL se declara, no se inventa desde el rol;
 *  · las tarjetas son enlaces reales (`<a href>`): teclado, ctrl+clic, botón medio;
 *  · `[SN.8]` lo que está A TU NOMBRE no se mezcla con una cola compartida, una bandeja en cero
 *    no se pinta, y una bandeja que no se pudo contar se DECLARA en vez de bajar a cero;
 *  · `[SN.9]` el buscador filtra módulos Y pendientes, ignora acentos, acepta tokens en cualquier
 *    orden, encuentra por el nombre de un MÓDULO interior, y Enter abre el primer resultado;
 *  · `[SN.11]` el trabajo tiene columna propia y no desaparece cuando está vacío (su vacío ES el
 *    hecho de que nadie reparte trabajo nominal), la tarjeta dice en qué rama del árbol vive, y la
 *    frescura del conteo sale de `medido_at` del servidor — nunca de restar el reloj del navegador.
 */

const CTX_BASE: MeContext = {
  user_id: 'u1',
  username: 'qa',
  nombre: 'Persona de Prueba',
  role_name: 'almacenista',
  kind: 'interno',
  warehouse_code: '03',
  zona: null,
  department: { code: 'almacen', name: 'Almacén' },
  position: { code: 'almacenista', name: 'Almacenista' },
};

const SCOPE_BASE: MyScope = {
  user_id: 'u1',
  role_name: 'almacenista',
  dimensions: {
    warehouse: { mode: 'own', modeWrite: 'own', source: 'role', options: [{ value: '03', label: '8 ESQUINAS' }] },
    zone: { mode: 'all', modeWrite: 'all', source: 'role', options: [] },
  },
};

const SIN_TRABAJO: MeWork = {
  tareas: [],
  pendientes: [],
  no_medido: [],
  tiene_responsabilidades: false,
  delegacion: { activa: false, claves: [], ocultas: 0 },
  ciclos: [],
  medido_at: '2026-09-11T12:00:00.000Z',
};

/**
 * `[SN.29]` Factoría de bandejas para los fixtures.
 *
 * Nace de un dolor concreto: al agregar `umbral_dias`/`flujo`/`veredicto` se rompieron **6 pruebas
 * de golpe**, todas por lo mismo — cada fixture repetía el objeto entero a mano, así que un campo
 * nuevo obliga a tocar cada literal. Con la factoría, el próximo campo se agrega en un lugar.
 *
 * Los valores por omisión describen una cola SANA (`al_dia`, sale tanto como entra): así, una
 * prueba que quiera verificar un veredicto tiene que PEDIRLO explícitamente, y ninguna se pone
 * verde por accidente sobre un default alarmante.
 */
function bandeja(p: Partial<MePendiente> & Pick<MePendiente, 'id' | 'label'>): MePendiente {
  return {
    detalle: '',
    ruta: '/almacen/cuadre',
    sin_acceso: null,
    icono: 'pi pi-flag',
    total: 1,
    mas_viejo_at: '2026-09-11T00:00:00.000Z',
    umbral_dias: 7,
    flujo: { entradas_7d: 1, entradas_30d: 4, cerradas_30d: 4 },
    veredicto: 'al_dia',
    alcance: 'bandeja',
    ambito: 'red',
    ...p,
  };
}

const TRABAJO_MIXTO: MeWork = {
  medido_at: '2026-09-11T12:00:00.000Z',
  no_medido: [],
  tareas: [],
  tiene_responsabilidades: false,
  delegacion: { activa: false, claves: [], ocultas: 0 },
  ciclos: [],
  pendientes: [
    bandeja({ id: 'caducidades-mias', label: 'Revisiones de caducidad a tu nombre', detalle: 'sin enviar', ruta: '/tienda/caducidades', icono: 'pi pi-clock', mas_viejo_at: '2026-08-01T00:00:00.000Z', total: 2, alcance: 'mio' }),
    bandeja({ id: 'cuadre', label: 'Descuadres por revisar', detalle: 'caja e inventario', mas_viejo_at: '2026-08-01T00:00:00.000Z', total: 1865 }),
  ],
};

/** `[SN.15]` Una tarea REAL asignada, con su vencimiento, y otra que la persona no puede abrir. */
const TRABAJO_ASIGNADO: MeWork = {
  medido_at: '2026-09-11T12:00:00.000Z',
  no_medido: [],
  pendientes: [],
  tiene_responsabilidades: false,
  delegacion: { activa: false, claves: [], ocultas: 0 },
  ciclos: [],
  tareas: [
    {
      fuente: 'finance.recon_tasks', label: 'Conciliaciones a tu nombre', detalle: 'te las repartió Maat',
      ruta: '/finanzas/tareas', sin_acceso: null, icono: 'pi pi-inbox', total: 3,
      mas_viejo_at: '2026-09-01T00:00:00.000Z', vence_at: '2026-09-09T00:00:00.000Z', vencidas: 3,
      no_responde: [],
    },
    {
      fuente: 'commercial.inventory_count_assignments', label: 'Conteos de inventario asignados a ti',
      detalle: 'sesiones en vuelo', ruta: null,
      sin_acceso: 'Te la asignaron, pero tu permiso no abre /almacen/inventory/count. Pídeselo a Sistemas.',
      icono: 'pi pi-list-check', total: 1, mas_viejo_at: '2026-09-05T00:00:00.000Z',
      vence_at: null, vencidas: null, no_responde: ['estado propio: el ciclo de vida esta en commercial.inventory_counts.status'],
    },
  ],
};

interface Montaje {
  perms?: Permission[];
  role?: string;
  cargado?: boolean;
  ctx$?: Observable<MeContext>;
  scope$?: Observable<MyScope | null>;
  work$?: Observable<MeWork>;
  stay?: boolean;
}

const con = (...p: Permission[]): Record<string, boolean> => Object.fromEntries(p.map((k) => [k, true]));

describe('MiTrabajoComponent · lo que ve cada persona', () => {
  let fix: ComponentFixture<MiTrabajoComponent>;
  let navigate: jest.SpyInstance;
  const html = () => (fix.nativeElement as HTMLElement).textContent ?? '';
  const q = <T extends Element>(sel: string) => (fix.nativeElement as HTMLElement).querySelectorAll<T>(sel);
  /** `[SN.25]` La tarjeta apaisada pasó a ser la celda de la grilla rígida. */
  const tarjetas = () => q<HTMLAnchorElement>('a.mt-cell');
  /** `[SN.11]` La píldora pasó a fila: dos columnas, el trabajo con su propio espacio. */
  const pendientes = () => q<HTMLAnchorElement>('a.mt-task');

  /**
   * `[SN.26]` La hoja de estilos del componente, leída del ARCHIVO y sin comentarios.
   *
   * ⚠️ No sirve `document.styleSheets`: en jsdom los estilos del componente no llegan al DOM, y la
   * primera versión de estas pruebas encontraba **cero reglas** y se ponía verde sin medir nada
   * (ADR-056: cero coincidencias no es cero infracciones). Los comentarios se quitan porque
   * **citan** las reglas retiradas — sin eso la prueba juzgaría la explicación, no el código.
   */
  function cssDelComponente(): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    return fs
      .readFileSync(path.join(__dirname, 'mi-trabajo.component.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
  }

  /** Escribe en el buscador y refresca la vista. */
  function buscar(texto: string) {
    const input = (fix.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input.mt-search-input')!;
    input.value = texto;
    input.dispatchEvent(new Event('input'));
    fix.detectChanges();
  }

  async function montar(m: Montaje = {}) {
    const permisos = con(...(m.perms ?? []));
    const role = m.role ?? 'almacenista';
    const user = signal<JwtPayload | null>({ sub: 'u1', username: 'qa', role_name: role, permissions: permisos, exp: 0, iat: 0 });
    const perms = new PermissionsService();
    if (m.cargado !== false) perms.load(permisos, role, 'jwt');

    if (m.stay) window.history.replaceState({ stay: true }, '', '/projects');
    else window.history.replaceState(null, '', '/projects');

    await TestBed.configureTestingModule({
      imports: [MiTrabajoComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { user, logout: jest.fn() } },
        { provide: PermissionsService, useValue: perms },
        {
          provide: MeContextService,
          useValue: {
            mine: () => m.ctx$ ?? of(CTX_BASE),
            work: () => m.work$ ?? of(SIN_TRABAJO),
            reset: jest.fn(),
          },
        },
        { provide: DataScopeService, useValue: { mine: () => m.scope$ ?? of(SCOPE_BASE) } },
      ],
    }).compileComponents();

    const router = TestBed.inject(Router);
    navigate = jest.spyOn(router, 'navigate').mockResolvedValue(true);
    fix = TestBed.createComponent(MiTrabajoComponent);
    fix.detectChanges();
    await fix.whenStable();
    fix.detectChanges();
  }

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  // ── Puertas ───────────────────────────────────────────────────────────────

  it('el almacenista (RECIBIR + SUPERVISAR) tiene UNA puerta → entra directo a /almacen', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR, Permission.COMMERCIAL_INVENTORY_SUPERVISAR] });
    expect(navigate).toHaveBeenCalledWith(['/almacen']);
  });

  it('…pero si pidió QUEDARSE (state.stay) no navega, y ve su tarjeta con los módulos que sí abre', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR, Permission.COMMERCIAL_INVENTORY_SUPERVISAR], stay: true });
    expect(navigate).not.toHaveBeenCalled();
    const cards = tarjetas();
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('Almacén');
    /*
     * `[SN.25]` La celda ya no nombra tres submódulos: dice CUÁNTOS abre esta persona. Y el número
     * sigue siendo el de ella, no el del módulo — Almacén tiene 12 y con RECIBIR + SUPERVISAR se
     * abren 2. Eso es lo que la prueba original protegía, y se protege mejor: antes se verificaba
     * un nombre, ahora el recuento completo.
     */
    expect(cards[0].textContent).toContain('2 submódulos');
    // Es un enlace de verdad: href puesto por routerLink.
    expect(cards[0].getAttribute('href')).toBe('/almacen');
    // Y no ofrece lo que no puede abrir.
    expect(html()).not.toContain('Compras');
  });

  it('permisos sin_cargar → skeleton, NO "no tienes nada", y no navega', async () => {
    await montar({ perms: [], cargado: false });
    expect(q('.ls-sk').length).toBeGreaterThan(0);
    expect(html()).not.toContain('Tu cuenta no tiene ningún espacio');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('cero puertas con permisos cargados → estado DECLARADO con salida, sin redirect a captures', async () => {
    await montar({ perms: [], role: 'piso_tienda' });
    expect(navigate).not.toHaveBeenCalled();
    expect(html()).toContain('Tu cuenta no tiene ningún espacio asignado');
    expect(html()).toContain('qa (piso_tienda)');
    expect(html()).toContain('Cerrar sesión');
  });

  it('la cuenta de kiosco (HR_ATTENDANCE_CHECAR, sin pantalla) cae al estado declarado', async () => {
    await montar({ perms: [Permission.HR_ATTENDANCE_CHECAR], role: 'checador_kiosco' });
    expect(navigate).not.toHaveBeenCalled();
    expect(html()).toContain('Tu cuenta no tiene ningún espacio asignado');
    expect(tarjetas().length).toBe(0);
  });

  it('el admin de plataforma ve los 6 espacios (4 activos + 2 propuestos con su P-xx) y los planned sólo declarados', async () => {
    await montar({ perms: [], role: 'superadmin' });
    expect(navigate).not.toHaveBeenCalled();
    expect(q('section.mt-space').length).toBe(6);
    expect(html()).toContain('P-03');
    expect(html()).toContain('P-06');
    expect(html()).toContain('Configuración de la suite');
    // Los planned no son sección: son una línea al pie.
    expect(q('#espacio-recursos-humanos').length).toBe(0);
    expect(html()).toContain('Espacios sin funciones todavía');
    expect(html()).toContain('Operación por zonas');
    expect(html()).toContain('Recursos Humanos');
  });

  it('el vendedor no ve el back-office de Ventas aunque tenga la clave', async () => {
    await montar({ perms: [Permission.COMMERCIAL_ORDERS_VER, Permission.COMMERCIAL_EXPIRY_VER], role: 'vendedor', stay: true });
    const hrefs = Array.from(tarjetas()).map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('/comercial');
    // …pero sí lo que sí es suyo (caducidades abre Punto de Venta y Almacén).
    expect(hrefs).toEqual(expect.arrayContaining(['/tienda', '/almacen']));
    expect(html()).toContain('Punto de Venta');
  });

  /*
   * `[SN.25]` Esta prueba exigía «tres módulos y un +N», que es exactamente lo que se retiró: el
   * corte era POR POSICIÓN y el «+N» escondía 71 de 101 submódulos sin poder tocarse. Ahora exige
   * lo contrario — que la línea diga el recuento de ESA persona y que el «+N» no vuelva.
   */
  it('la línea de contenido dice cuántos submódulos abre ESA persona, y ya no hay «+N»', async () => {
    await montar({ perms: [], role: 'superadmin' });
    const finanzas = Array.from(tarjetas()).find((a) => a.getAttribute('href') === '/finanzas');
    expect(finanzas).toBeTruthy();
    expect(finanzas!.textContent).toMatch(/\d+ submódulos/);
    expect(finanzas!.textContent).not.toMatch(/· \+\d+/);
  });

  // ── Mi contexto ───────────────────────────────────────────────────────────

  it('Mi contexto: nombre en la cabecera, puesto, área, alcance (de me/scope) y periodo', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true });
    expect(html()).toContain('Persona de Prueba');
    expect(html()).toContain('Almacenista');
    expect(html()).toContain('8 ESQUINAS');
    expect(html()).toContain('todas las zonas');
    expect(html()).toMatch(/Periodo/);
  });

  it('puesto NULL → "Sin puesto asignado" (declarado, nunca derivado del rol)', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, ctx$: of({ ...CTX_BASE, position: null, department: null }) });
    expect(html()).toContain('Sin puesto asignado');
    expect(html()).not.toContain('Almacenista');
  });

  it('alcance no resoluble se declara como "sin determinar", no como "sin alcance"', async () => {
    await montar({
      perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true,
      scope$: of({ ...SCOPE_BASE, dimensions: { warehouse: { mode: 'own', modeWrite: 'own', source: 'role', options: [], resolvable: false } } }),
    });
    expect(html()).toContain('sin determinar (ficha incompleta)');
    expect(html()).not.toContain('sin alcance');
  });

  it('error de red en el contexto → se dice el error, NUNCA "Sin puesto asignado"', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, ctx$: throwError(() => ({ status: 0 })) });
    expect(html()).toContain('Sin conexión con el servidor');
    expect(html()).toContain('Reintentar');
    expect(html()).not.toContain('Sin puesto asignado');
    // Y la operación sigue disponible: el contexto caído no esconde las puertas.
    expect(tarjetas().length).toBe(1);
  });

  it('la cabecera de Dirección NO se estrena: lo pendiente se declara con sus P-xx', async () => {
    await montar({ perms: [], role: 'superadmin' });
    expect(html()).not.toContain('Esto ve Dirección General');
    expect(html()).toContain('pendientes de definición');
    expect(html()).toContain('P-01');
    expect(html()).toContain('P-11');
    /*
     * `[SN.15]` P-06 ya NO es incondicional. Era «reparto nominal: pendiente de definición», y el
     * reparto EXISTE (151 tareas vivas en prod). Lo que sigue pendiente es de qué responde cada
     * puesto — `identity.position_responsibilities` vacía— y es lo único que P-06 puede reclamar.
     */
    expect(html()).toContain('P-06');
    expect(html()).toContain('De qué responde cada puesto');
  });

  it('si el puesto YA tiene responsabilidades, la pantalla deja de reclamar P-06', async () => {
    await montar({
      perms: [], role: 'superadmin',
      work$: of({ ...SIN_TRABAJO, tiene_responsabilidades: true }),
    });
    // Ojo: `P-06` a secas sigue apareciendo como insignia del espacio "Dirección General", que es
    // otra cosa. Lo que tiene que desaparecer es el reclamo del PIE del trabajo.
    expect(html()).not.toContain('De qué responde cada puesto');
    expect(html()).toContain('A tu nombre es lo que alguien te asignó');
  });

  // ── [SN.8] Mi trabajo: pendientes ─────────────────────────────────────────

  it('lo que está A TU NOMBRE no se mezcla con la cola compartida', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(TRABAJO_MIXTO) });
    expect(html()).toContain('A tu nombre');
    expect(html()).toContain('En tus bandejas');
    const ps = pendientes();
    expect(ps.length).toBe(2);
    // El "a tu nombre" va primero y se marca distinto.
    expect(ps[0].classList).toContain('is-mine');
    expect(ps[0].getAttribute('href')).toBe('/tienda/caducidades');
    expect(ps[1].classList).not.toContain('is-mine');
    expect(ps[1].textContent).toContain('1,865');
    // La cola compartida se declara como tal: nadie la tiene asignada.
    const tag = Array.from(q<HTMLElement>('.mt-grupo-tag')).find((t) => t.textContent?.includes('bandejas'));
    expect(tag?.getAttribute('title')).toContain('nadie las tiene asignadas');
  });

  it('sin pendientes → se dice, no se pintan cajas en cero', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true });
    expect(pendientes().length).toBe(0);
    expect(html()).toContain('Sin pendientes en tus bandejas');
    // `[SN.11]` El bloque "A tu nombre" no desaparece: esconderlo haría creer que sí hay reparto.
    expect(html()).toContain('No tienes trabajo a tu nombre');
  });

  // ── [SN.15] Tareas asignadas: la tercera pregunta ─────────────────────────

  /*
   * Hasta SN.14 la pantalla afirmaba «Nadie te asignó trabajo hoy» SIEMPRE, apoyada en una
   * medición del 10-sep que decía que las tablas de asignación estaban en cero. Medido de nuevo
   * el 11-sep contra prod: 151 tareas vivas sobre 38 de 118 personas. Estos casos son el candado
   * de que la frase no vuelva a ser un literal.
   */
  it('una tarea ASIGNADA se muestra a tu nombre, y ya no se dice que nadie te asignó nada', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(TRABAJO_ASIGNADO) });
    expect(html()).toContain('Conciliaciones a tu nombre');
    expect(html()).not.toContain('No tienes trabajo a tu nombre');
    // El vencimiento vencido se dice y se marca; no se disfraza de antigüedad.
    expect(html()).toContain('venció hace');
    expect(q<HTMLElement>('.mt-task-vence.is-vencido').length).toBe(1);
  });

  it('tarea asignada SIN el permiso de su ruta: se muestra, pero NO como enlace', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(TRABAJO_ASIGNADO) });
    const bloqueada = q<HTMLElement>('.mt-task.is-bloqueada');
    expect(bloqueada.length).toBe(1);
    // Es la clave del caso: aparece (no se esconde) y no invita a un 403 (no es <a href>).
    expect(bloqueada[0].tagName).toBe('P');
    expect(bloqueada[0].textContent).toContain('tu permiso no abre');
  });

  // ── [SN.16] Trabajo cíclico: la tira de meses ─────────────────────────────

  /** Los tres estados que importan + el mes sin datos, con las cifras reales de prod. */
  const CON_CICLO: MeWork = {
    ...SIN_TRABAJO,
    ciclos: [
      {
        id: 'conciliacion-egresos',
        label: 'Conciliación de egresos',
        detalle: 'los retiros del mes, contra las pólizas del 102 de Kepler',
        icono: 'pi pi-arrow-up-right',
        pendientes: 3,
        es_mio: false,
        periodos: [
          { periodo: '2026-01', estado: 'en_proceso', faltan: 2386, motivo: '1111 casados, 2386 sin casar contra Kepler.', ruta: '/finanzas/bancos', queryParams: { view: 'cuadre', period: '2026-01' } },
          { periodo: '2026-02', estado: 'sin_empezar', faltan: 2864, motivo: '2864 egresos y la conciliación no se ha corrido.', ruta: '/finanzas/bancos', queryParams: { view: 'cuadre', period: '2026-02' } },
          { periodo: '2026-06', estado: 'sin_datos', faltan: null, motivo: 'No hay estado de cuenta cargado de este mes.', ruta: null, queryParams: null },
          { periodo: '2026-07', estado: 'al_dia', faltan: 0, motivo: 'Los 800 egresos casaron contra Kepler.', ruta: '/finanzas/bancos', queryParams: { view: 'cuadre', period: '2026-07' } },
        ],
      },
    ],
  };

  it('la tira lleva a la pantalla CON el mes ya puesto', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(CON_CICLO) });
    expect(html()).toContain('Conciliación de egresos');
    const celdas = q<HTMLAnchorElement>('a.ps-mes');
    // 3 de los 4 periodos navegan; el de `sin_datos` no es enlace (ver caso siguiente).
    expect(celdas.length).toBe(3);
    expect(celdas[0].getAttribute('href')).toBe('/finanzas/bancos?view=cuadre&period=2026-01');
  });

  /*
   * La prueba negativa que da sentido a toda la fase: medido en prod, junio y julio NO tienen
   * estado de cuenta cargado. Si se pintaran como "sin conciliar" le estaríamos inventando
   * trabajo a alguien que no tiene con qué hacerlo, y el enlace lo mandaría a una pantalla que no
   * le puede contestar nada.
   */
  it('un mes SIN DATOS no es enlace, no cuenta como pendiente, y dice por qué', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(CON_CICLO) });
    const vacio = q<HTMLElement>('.ps-mes.is-vacio');
    expect(vacio.length).toBe(1);
    expect(vacio[0].tagName).toBe('SPAN');
    expect(vacio[0].getAttribute('title')).toContain('No hay estado de cuenta');
    // Y el resumen lo nombra aparte: 1 sin empezar · 1 a medias · 1 al día · 1 sin datos.
    expect(html()).toContain('sin datos');
    expect(html()).not.toContain('4 sin empezar');
  });

  it('los tres estados con trabajo se distinguen por su punto, no por el fondo', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(CON_CICLO) });
    expect(q<HTMLElement>('.ps-mes.e-en_proceso').length).toBe(1);
    expect(q<HTMLElement>('.ps-mes.e-sin_empezar').length).toBe(1);
    expect(q<HTMLElement>('.ps-mes.e-al_dia').length).toBe(1);
  });

  it('el ciclo que NO es tuyo se rotula como cola compartida', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(CON_CICLO) });
    const tag = Array.from(q<HTMLElement>('.mt-grupo-tag')).find((t) => t.textContent?.includes('Por periodo'));
    expect(tag?.getAttribute('title')).toContain('no respondes tú de él');
    // Y no se cuela al bloque de lo propio.
    expect(html()).toContain('No tienes trabajo a tu nombre');
    expect(q<HTMLElement>('.ps.is-mine').length).toBe(0);
  });

  /*
   * `[SN.20]` A quien se le delegó el trabajo ve el SUYO y nada más. Ivonne es sólo ingresos y
   * Mayra sólo egresos, las dos con el mismo puesto. «Mi trabajo» no es un menú de permisos: es la
   * lista de lo que te delegaron, y el módulo sigue abierto para las dos.
   */
  it('a quien se le delegó, la pantalla muestra sólo lo suyo', async () => {
    const soloIngresos: MeWork = {
      ...SIN_TRABAJO,
      ciclos: [
        { ...CON_CICLO.ciclos[0], id: 'conciliacion-bancos-ingresos', label: 'Conciliación de bancos · ingresos', es_mio: true },
        { ...CON_CICLO.ciclos[0], id: 'conciliacion-caja-ingresos', label: 'Conciliación de caja · ingresos', es_mio: true },
      ],
    };
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(soloIngresos) });
    // Sus dos tiras, las dos marcadas, arriba en «A tu nombre».
    expect(q<HTMLElement>('.ps.is-mine').length).toBe(2);
    expect(html()).not.toContain('No tienes trabajo a tu nombre');
    /*
     * Y NADA del otro lado. ⚠️ Se asierta sobre el TÍTULO del ciclo, no sobre la palabra suelta:
     * "egresos" también aparece dentro de los motivos de cada mes ("2,864 egresos y la conciliación
     * no se ha corrido"), así que un `not.toContain('egresos')` fallaba sin que hubiera ningún
     * ciclo ajeno en pantalla.
     */
    const titulos = Array.from(q<HTMLElement>('.ps-l')).map((e) => e.textContent ?? '');
    expect(titulos.every((t) => t.includes('ingresos'))).toBe(true);
    expect(titulos.some((t) => t.includes('egresos'))).toBe(false);
    expect(Array.from(q<HTMLElement>('.mt-grupo-tag')).some((t) => t.textContent?.includes('Por periodo'))).toBe(false);
  });

  it('a quien NO se le delegó nada, se le siguen mostrando todos los ciclos', async () => {
    const sinReparto: MeWork = {
      ...SIN_TRABAJO,
      ciclos: [
        { ...CON_CICLO.ciclos[0], id: 'conciliacion-bancos-ingresos', label: 'Conciliación de bancos · ingresos', es_mio: false },
        { ...CON_CICLO.ciclos[0], id: 'conciliacion-bancos-egresos', label: 'Conciliación de bancos · egresos', es_mio: false },
      ],
    };
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(sinReparto) });
    // Sin reparto no se esconde nada: quedarse con la pantalla vacía sería peor que verlo de más.
    expect(q<HTMLElement>('app-periodo-strip').length).toBe(2);
    expect(q<HTMLElement>('.ps.is-mine').length).toBe(0);
    expect(html()).toContain('No tienes trabajo a tu nombre');
  });

  /*
   * `[SN.21]` — Lo que el reparto le hizo a la lista se DICE. Una lista recortada en silencio se
   * lee igual que una completa, y entonces «ya no hay nada» y «lo demás no es tuyo» se confunden.
   */
  it('una lista acotada por el reparto lo declara, y dice cuánto quedó fuera', async () => {
    await montar({
      perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true,
      work$: of({
        ...SIN_TRABAJO,
        ciclos: [{ ...CON_CICLO.ciclos[0], id: 'conciliacion-caja-ingresos', es_mio: true }],
        delegacion: { activa: true, claves: ['finanzas.conciliacion_ingresos'], ocultas: 3 },
      } as MeWork),
    });
    expect(html()).toContain('acotada a lo que responde tu reparto');
    expect(html()).toContain('3 colas más');
    // Y se aclara que nadie perdió acceso: la responsabilidad ordena, no cierra puertas.
    expect(html()).toContain('las sigues abriendo desde su pantalla');
  });

  it('sin recorte no se dice nada: no se habla de un filtro que no se aplicó', async () => {
    await montar({
      perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true,
      work$: of({ ...SIN_TRABAJO, delegacion: { activa: true, claves: ['almacen.cuadre'], ocultas: 0 } } as MeWork),
    });
    expect(html()).not.toContain('acotada a lo que responde tu reparto');
  });

  /*
   * `[SN.21]` — La auto-entrada deja de pasar por encima del trabajo propio.
   *
   * Con UN solo destino la landing navegaba sola, así que Ivonne y Mayra nunca veían la pantalla
   * que se hizo para ellas. Medido: 18 personas tienen exactamente 1 destino y sólo 3 tienen algo
   * propio, así que el atajo se conserva para las otras 15 — eso es lo que prueba el primer caso
   * de este archivo, que sigue verde.
   */
  it('con UNA puerta pero trabajo a tu nombre, la app NO te saca de la pantalla', async () => {
    await montar({
      perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR, Permission.COMMERCIAL_INVENTORY_SUPERVISAR],
      work$: of({ ...SIN_TRABAJO, ciclos: [{ ...CON_CICLO.ciclos[0], es_mio: true }] } as MeWork),
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(q<HTMLElement>('.ps.is-mine').length).toBe(1);
  });

  it('con UNA puerta y el trabajo SIN MEDIR, tampoco se auto-entra: no se sabe si hay algo tuyo', async () => {
    await montar({
      perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR, Permission.COMMERCIAL_INVENTORY_SUPERVISAR],
      work$: throwError(() => ({ status: 500 })),
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(html()).toContain('No se pudo consultar tu trabajo pendiente');
  });

  it('un conteo acotado dice a qué universo pertenece; uno sin ficha lo DECLARA', async () => {
    const conAmbito: MeWork = {
      ...SIN_TRABAJO,
      pendientes: [
        bandeja({ id: 'compras-hallazgos', label: 'Hallazgos de reabastecimiento', detalle: 'del barrido nocturno', ruta: '/compras/hallazgos', mas_viejo_at: '2026-08-01T00:00:00.000Z', total: 21940, ambito: 'red_sin_ficha' }),
      ],
    };
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(conAmbito) });
    // Se cuenta toda la red porque la ficha no tiene sucursal, y se dice. Acotar a [] daría 0.
    expect(html()).toContain('toda la red');
    expect(html()).not.toContain('tu sucursal');
  });

  it('una bandeja que no se pudo contar se DECLARA, no baja a cero', async () => {
    await montar({
      perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true,
      work$: of({
        medido_at: '2026-09-11T12:00:00.000Z',
        pendientes: [],
        no_medido: [{ id: 'cuadre', label: 'Descuadres por revisar', motivo: 'relation does not exist' }],
      } satisfies MeWork),
    });
    expect(html()).toContain('Sin medir');
    expect(html()).toContain('Descuadres por revisar');
    expect(html()).toContain('no se muestra en cero');
  });

  it('error al consultar el trabajo → error, no "sin pendientes"', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: throwError(() => ({ status: 500 })) });
    expect(html()).toContain('No se pudo consultar tu trabajo pendiente');
    expect(html()).not.toContain('Sin pendientes');
  });

  // ── [SN.9] Buscador ───────────────────────────────────────────────────────

  it('filtra los módulos y esconde los espacios que se quedan sin nada', async () => {
    await montar({ perms: [], role: 'superadmin' });
    const total = tarjetas().length;
    expect(total).toBeGreaterThan(10);
    buscar('compras');
    expect(tarjetas().length).toBeLessThan(total);
    expect(Array.from(tarjetas()).every((a) => (a.textContent ?? '').length > 0)).toBe(true);
    // Espacios sin coincidencias no se pintan.
    expect(q('section.mt-space').length).toBeLessThan(6);
  });

  it('ignora acentos y acepta los tokens en cualquier orden', async () => {
    await montar({ perms: [], role: 'superadmin' });
    buscar('auditoria');
    const conAcento = tarjetas().length;
    expect(conAcento).toBeGreaterThan(0);
    buscar('ruta auditoria');
    expect(tarjetas().length).toBeGreaterThan(0);
    expect(html()).toContain('Auditoría en Ruta');
  });

  it('encuentra un proyecto por el nombre de un MÓDULO de adentro', async () => {
    await montar({ perms: [], role: 'superadmin' });
    buscar('bancos');
    const hrefs = Array.from(tarjetas()).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/finanzas');
  });

  it('Enter abre el primer resultado', async () => {
    await montar({ perms: [], role: 'superadmin' });
    buscar('contabilidad');
    const primera = tarjetas()[0].getAttribute('href');
    const input = (fix.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input.mt-search-input')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fix.detectChanges();
    expect(navigate).toHaveBeenCalledWith([primera]);
  });

  it('el buscador también filtra los pendientes', async () => {
    await montar({ perms: [], role: 'superadmin', work$: of(TRABAJO_MIXTO) });
    expect(pendientes().length).toBe(2);
    buscar('descuadres');
    expect(pendientes().length).toBe(1);
    expect(pendientes()[0].textContent).toContain('1,865');
  });

  it('una búsqueda sin coincidencias se dice, no deja la pantalla en blanco', async () => {
    await montar({ perms: [], role: 'superadmin' });
    buscar('zzzz');
    expect(tarjetas().length).toBe(0);
    expect(html()).toContain('Nada coincide con');
    expect(html()).toContain('Limpiar búsqueda');
  });

  // ── [SN.10] Lo que la captura del 2026-09-11 destapó ──────────────────────

  it('ninguna tarjeta usa la jerga de relleno «Atajo · vive en su espacio»', async () => {
    await montar({ perms: [], role: 'superadmin' });
    // Salía 12 veces, truncada, con el mismo peso visual que la información real.
    expect(html()).not.toContain('vive en su espacio');
    expect(html()).not.toContain('Atajo');
  });

  it('dos módulos homónimos en el mismo espacio se distinguen por su proyecto de origen', async () => {
    await montar({ perms: [], role: 'superadmin' });
    const hallazgos = Array.from(tarjetas()).filter((a) => (a.textContent ?? '').includes('Hallazgos'));
    expect(hallazgos.length).toBeGreaterThanOrEqual(2);
    const textos = hallazgos.map((a) => a.textContent ?? '');
    // Cada uno dice de dónde sale, y no hay dos idénticos.
    expect(textos.some((t) => t.includes('de Finanzas'))).toBe(true);
    expect(textos.some((t) => t.includes('Compras'))).toBe(true);
    expect(new Set(textos).size).toBe(textos.length);
  });

  it('la segunda línea no repite el título', async () => {
    await montar({ perms: [], role: 'superadmin' });
    for (const a of Array.from(tarjetas())) {
      const titulo = a.querySelector('.mt-cell-nm')?.textContent?.trim() ?? '';
      const cuerpo = a.querySelector('.mt-cell-sb')?.textContent?.trim() ?? '';
      if (cuerpo) expect(cuerpo.toLowerCase()).not.toBe(titulo.toLowerCase());
    }
  });

  it('los módulos enlazados no comparten todos el icono de su proyecto', async () => {
    await montar({ perms: [], role: 'superadmin' });
    const iconos = Array.from(tarjetas())
      .map((a) => a.querySelector('.mt-cell-ico')?.className ?? '')
      .filter(Boolean);
    // Antes `entryIcon` devolvía SIEMPRE el del proyecto: cinco módulos de `trade` salían iguales.
    expect(new Set(iconos).size).toBeGreaterThan(iconos.length / 2);
  });

  // ── [SN.25] Cómo se presentan los módulos ─────────────────────────────────

  /*
   * El hallazgo que dio forma a este rediseño: 10 de las 22 tarjetas NO son módulos, son un
   * submódulo de otro módulo sacado a la portada — y llevaban el mismo cuerpo, tamaño y peso que
   * un módulo de 21 submódulos. Por eso había dos «Hallazgos» idénticos uno al lado del otro.
   */
  it('un acceso directo se distingue de un módulo, y dice de dónde sale', async () => {
    await montar({ perms: [], role: 'superadmin' });
    const alias = q<HTMLElement>('a.mt-cell.is-alias');
    expect(alias.length).toBeGreaterThan(5);
    // Cada uno declara su origen; ninguno finge tener submódulos propios.
    for (const a of Array.from(alias)) {
      const sb = a.querySelector('.mt-cell-sb')?.textContent?.trim() ?? '';
      expect(sb.startsWith('de ') || sb === 'acceso directo').toBe(true);
      expect(sb).not.toMatch(/submódulos?$/);
    }
  });

  it('un módulo dice cuántos submódulos abre, en vez de nombrar tres y esconder el resto', async () => {
    await montar({ perms: [], role: 'superadmin' });
    const propios = Array.from(tarjetas()).filter((a) => !a.classList.contains('is-alias'));
    const conCuenta = propios
      .map((a) => a.querySelector('.mt-cell-sb')?.textContent?.trim() ?? '')
      .filter((t) => /submódulos?$/.test(t));
    expect(conCuenta.length).toBeGreaterThan(5);
    // Y ya no queda ningún «+N»: era el residuo que escondía el 70% del catálogo.
    expect(html()).not.toMatch(/·\s*\+\d+/);
  });

  /*
   * ⛔ La prueba que sostiene la honestidad de «Tus accesos»: arranca VACÍA. No se puede pintar
   * «lo más usado» porque el registro de uso todavía no se lee (cero endpoints, días de vida), así
   * que lo que hay es «lo último que abriste» — y si no abriste nada, no se dibuja una caja
   * prometiendo accesos que no existen.
   */
  it('«Tus accesos» no se dibuja mientras no hayas abierto nada', async () => {
    localStorage.removeItem('mt.accesos.v1');
    await montar({ perms: [], role: 'superadmin' });
    expect(q('.mt-freq').length).toBe(0);
    expect(html()).not.toContain('Tus accesos');
  });

  it('…y aparece con lo que abriste, sin repetir y con lo más reciente primero', async () => {
    localStorage.setItem('mt.accesos.v1', JSON.stringify(['finanzas', 'compras', 'finanzas']));
    await montar({ perms: [], role: 'superadmin' });
    const chips = q<HTMLAnchorElement>('a.mt-chip');
    expect(chips.length).toBe(2);
    expect(chips[0].textContent).toContain('Finanzas');
    localStorage.removeItem('mt.accesos.v1');
  });

  /*
   * `[SN.26]` El atajo **no puede costar más alto que las puertas a las que atajo**. Medido a
   * 1440×874 (la laptop con la que Edgar lo revisó): la columna derecha pedía 836 px sobre 732
   * disponibles, y los mosaicos 4:3 se llevaban 146 de esos 732 para repetir tarjetas que ya
   * estaban en pantalla. Esta prueba fija el contrato de forma —línea, no retícula— para que nadie
   * los devuelva a un bloque alto sin volver a medir el presupuesto.
   */
  it('los accesos van en una línea de chips, no en una retícula de mosaicos', async () => {
    localStorage.setItem('mt.accesos.v1', JSON.stringify(['finanzas', 'compras']));
    await montar({ perms: [], role: 'superadmin' });
    expect(q('.mt-chips').length).toBe(1);
    // La retícula de 4:3 no vuelve por la puerta de atrás.
    expect(q('.mt-tiles').length).toBe(0);
    expect(q('a.mt-tile').length).toBe(0);
    localStorage.removeItem('mt.accesos.v1');
  });

  /*
   * `[SN.26]` El acceso directo **tiene que verse**. Se hundía con `--layout-bg`, que arriba de
   * 100rem es EXACTAMENTE el fondo de la isla del grupo: 11 de 22 tarjetas sin contraste de relleno
   * contra su propio contenedor. La distinción vive en tipo y contraste (DESIGN.md Q.5), no en un
   * relleno que lo desaparece — así que la clase ya no puede traer `background` propio.
   */
  /*
   * `[SN.27]` **El hueco no estaba en la celda, estaba en el GRUPO.** Cada espacio ocupaba una
   * franja de ancho completo, así que uno de 2 tarjetas dejaba 3 huecos a su derecha: 52% de
   * ocupación a 1920, 63% a 1440. Con los espacios en columnas los grupos chicos comparten fila y
   * sube a 88%. Esta prueba fija las dos mitades del contrato —el contenedor existe y declara
   * columnas— porque jsdom no calcula multicolumna y sin las dos la regresión pasa muda.
   */
  it('los espacios fluyen en columnas, no en franjas de ancho completo', async () => {
    await montar({ perms: [], role: 'superadmin' });
    const cont = q<HTMLElement>('.mt-espacios');
    expect(cont.length).toBe(1);
    expect(cont[0].querySelectorAll('section.mt-space').length).toBeGreaterThan(3);
    expect(cssDelComponente()).toMatch(/\.mt-espacios\s*\{[^}]*columns\s*:/);
  });

  it('un acceso directo se distingue por tipo, no por un relleno que lo borra', () => {
    const reglas = cssDelComponente().match(/\.is-alias\b[^{}]*\{[^}]*\}/g) ?? [];
    // ⛔ Sin esto la prueba pasa EN VACÍO: cero coincidencias se lee igual que cero infracciones.
    expect(reglas.length).toBeGreaterThan(0);
    for (const r of reglas) expect(r).not.toMatch(/background/);
  });

  it('el buscador encuentra SUBMÓDULOS y lleva directo, no sólo al módulo que los contiene', async () => {
    await montar({ perms: [], role: 'superadmin' });
    buscar('clientes 360');
    const subs = q<HTMLAnchorElement>('a.mt-cell.is-sub');
    expect(subs.length).toBeGreaterThan(0);
    // Lleva al submódulo, no a la puerta del módulo.
    expect(subs[0].getAttribute('href')).not.toBe('/comercial');
    expect(subs[0].textContent).toContain('de Ventas');
  });

  it('cada grupo de pendientes lleva su propia etiqueta dentro', async () => {
    await montar({ perms: [], role: 'superadmin', work$: of(TRABAJO_MIXTO) });
    const grupos = q<HTMLElement>('.mt-grupo');
    expect(grupos.length).toBe(2);
    // La etiqueta vive DENTRO del grupo: al envolver no se queda en la fila de arriba.
    for (const g of Array.from(grupos)) {
      expect(g.querySelector('.mt-grupo-tag')).toBeTruthy();
      expect(g.querySelector('a.mt-task')).toBeTruthy();
    }
  });

  // ── [SN.11] Dos columnas: el trabajo deja de ser una tira ─────────────────

  it('la columna de trabajo existe y se distingue de la de espacios, aunque no haya pendientes', async () => {
    await montar({ perms: [], role: 'superadmin' });
    expect(q('section.mt-work').length).toBe(1);
    expect(q('section.mt-spaces').length).toBe(1);
    // Cada columna encabeza lo suyo; el trabajo no cuelga de la rejilla de puertas.
    expect(html()).toContain('Tu trabajo');
    expect(html()).toContain('Tus espacios');
    // Y las puertas siguen siendo enlaces reales dentro de su propia zona de scroll.
    expect(q('.mt-scroll a.mt-cell').length).toBe(tarjetas().length);
  });

  /*
   * `[SN.25]` La migaja del árbol ya no se pinta arriba del nombre: en una celda de 52 px no caben
   * las dos, y por ir primero se leía antes que el título. No se perdió — vive en el `title`, que es
   * lo que esta prueba ahora protege. Si alguien la quita de ahí también, se pone roja.
   */
  it('la rama del árbol no compite con el nombre, pero sigue disponible al señalar', async () => {
    await montar({ perms: [], role: 'superadmin' });
    const celda = (href: string) => Array.from(tarjetas()).find((a) => a.getAttribute('href') === href);
    expect(celda('/dashboard')?.getAttribute('title')).toContain('Ventas › Rutas de detalle');
    // El grupo completo de Telemarketing tiene un tercer nivel que repite el nombre de la entrada.
    expect(celda('/telemarketing')?.getAttribute('title')).toContain('Atención telefónica');
    // Y ya no se pinta como renglón propio: era lo que competía con el título.
    expect(q('.mt-card-group').length).toBe(0);
  });

  it('las cifras llevan separador de miles', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(TRABAJO_MIXTO) });
    const n = Array.from(q<HTMLElement>('.mt-task-n')).map((e) => e.textContent?.trim());
    expect(n).toContain('1,865');
    expect(n).not.toContain('1865');
  });

  it('la hora del conteo sale del servidor (medido_at); si no vino, se declara', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(TRABAJO_MIXTO) });
    expect(html()).toContain('contado a las');
    // Se muestra una HORA, no un "hace N minutos" restando el reloj del navegador (ADR-056).
    expect(html()).not.toMatch(/hace \d+ min/);
    const meta = (fix.nativeElement as HTMLElement).querySelector('.mt-col-meta span[title]');
    expect(meta?.getAttribute('title')).toContain('2026-09-11T12:00:00.000Z');
  });

  it('sin medido_at usable, la frescura se DECLARA en vez de inventarse', async () => {
    await montar({
      perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true,
      work$: of({ ...SIN_TRABAJO, medido_at: '' }),
    });
    expect(html()).toContain('hora de conteo no declarada');
    expect(html()).not.toContain('contado a las');
  });

  it('la bandeja que no se pudo contar lleva su motivo, no sólo su nombre', async () => {
    await montar({
      perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true,
      work$: of({
        medido_at: '2026-09-11T12:00:00.000Z',
        pendientes: [],
        no_medido: [{ id: 'cuadre', label: 'Descuadres por revisar', motivo: 'relation does not exist' }],
      } satisfies MeWork),
    });
    const declarado = (fix.nativeElement as HTMLElement).querySelector('.mt-declarado');
    expect(declarado?.textContent).toContain('Descuadres por revisar');
    expect(declarado?.querySelector('span[title]')?.getAttribute('title')).toBe('relation does not exist');
  });

  it('el contexto no repite puesto y área cuando son lo mismo', async () => {
    await montar({
      perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true,
      ctx$: of({ ...CTX_BASE, position: { code: 'sis', name: 'Sistemas' }, department: { code: 'sis', name: 'Sistemas' } }),
    });
    const tira = (fix.nativeElement as HTMLElement).querySelector('.mt-ctx')?.textContent ?? '';
    expect(tira).toContain('Sistemas');
    expect(tira.match(/Sistemas/g)?.length).toBe(1);
  });

  /*
   * `[SN.29]` ── El veredicto en pantalla ────────────────────────────────────────────────────────
   *
   * La lógica del veredicto se prueba en `libs/contracts/src/http/veredicto.spec.ts`. Acá se prueba
   * lo OTRO: que la pantalla no vuelva a dejar todas las filas iguales, y que no convierta un
   * «no se pudo medir» en un «cero».
   */
  const TRABAJO_CON_VEREDICTOS: MeWork = {
    ...SIN_TRABAJO,
    pendientes: [
      bandeja({
        id: 'cuadre', label: 'Descuadres por revisar', detalle: 'caja e inventario',
        total: 2409, mas_viejo_at: '2026-07-08T00:00:00.000Z', umbral_dias: 7,
        flujo: { entradas_7d: 209, entradas_30d: 648, cerradas_30d: 0 }, veredicto: 'congelada',
      }),
      bandeja({
        id: 'flota-alertas', label: 'Alertas de flota abiertas', detalle: 'sin señal',
        ruta: '/logistica/rastreo', total: 9, umbral_dias: 1,
        flujo: { entradas_7d: 9, entradas_30d: 7205, cerradas_30d: null }, veredicto: 'al_dia',
      }),
    ],
  };

  it('la cola congelada lleva su insignia y la sana NO lleva ninguna', async () => {
    // Si las dos la llevaran, volverían a verse iguales — que es el defecto de origen: la pantalla
    // le daba el mismo tratamiento a 2,409 sin resolver jamás y a 9 abiertas de hoy.
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(TRABAJO_CON_VEREDICTOS) });
    const insignias = Array.from(q<HTMLElement>('.mt-veredicto')).map((e) => e.textContent?.trim());
    expect(insignias).toEqual(['congelada']);
    expect(q('a.mt-task.is-v-congelada')).toHaveLength(1);
    expect(q('a.mt-task.is-v-al_dia')).toHaveLength(1);
  });

  it('⛔ `cerradas_30d: null` se declara «sin medir», NUNCA se pinta como «0 resueltas»', async () => {
    // Es la confusión que ADR-056 prohíbe: «la fuente no lo puede contestar» y «nadie cerró
    // ninguna» son afirmaciones opuestas. `logistics.fleet_alerts` no tiene `updated_at`.
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(TRABAJO_CON_VEREDICTOS) });
    const flujos = Array.from(q<HTMLElement>('.mt-task-flujo')).map((e) => e.textContent?.trim() ?? '');
    expect(flujos.some((f) => f.includes('salidas sin medir'))).toBe(true);
    expect(flujos.some((f) => f.includes('0 resueltas'))).toBe(true); // la congelada SÍ midió su 0
    // Y la que no pudo medir no dice un número de resueltas.
    const flota = flujos.find((f) => f.includes('salidas sin medir')) ?? '';
    expect(flota).not.toMatch(/\d+ resueltas/);
  });

  it('las colas congeladas se declaran al pie con lo que les falta: un dueño', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(TRABAJO_CON_VEREDICTOS) });
    const pie = (fix.nativeElement as HTMLElement).querySelector('.mt-congeladas')?.textContent ?? '';
    expect(pie).toContain('congelada');
    expect(pie).toContain('dueño');
  });

  it('⛔ el número de 40 px es LO TUYO, no la suma de las colas compartidas', async () => {
    /*
     * El defecto que disparó `[SN.29]`: `totalPendientes()` sumaba `deBandeja()`, o sea por
     * construcción lo único de la pantalla que no es de nadie. En la captura real, 1 era tuyo y
     * 2,082 no — y el 89.6% de ese 2,082 era una sola cola que jamás resolvió una fila.
     */
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(TRABAJO_MIXTO) });
    const titular = (fix.nativeElement as HTMLElement).querySelector('.mt-titular-n')?.textContent?.trim();
    // TRABAJO_MIXTO: 2 propias (caducidades) + 1,865 compartidas (cuadre).
    expect(titular).toBe('2');
    expect(titular).not.toBe('1,865');
    const sub = (fix.nativeElement as HTMLElement).querySelector('.mt-titular-txt')?.textContent ?? '';
    expect(sub).toContain('a tu nombre');
    // Lo compartido no desaparece: baja al subtítulo, con su unidad dicha.
    expect(sub).toContain('1,865');
    expect(sub).toContain('cola compartida');
  });

  it('un 0 propio se pinta y se atenúa: la ausencia de reparto es el hecho medido', async () => {
    await montar({ perms: [Permission.COMMERCIAL_INVENTORY_RECIBIR], stay: true, work$: of(TRABAJO_CON_VEREDICTOS) });
    const n = (fix.nativeElement as HTMLElement).querySelector('.mt-titular-n');
    expect(n?.textContent?.trim()).toBe('0');
    expect(n?.classList.contains('is-cero')).toBe(true);
  });
});
