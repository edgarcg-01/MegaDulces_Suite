import { AUTHZ_TREE, type AuthzApp } from './authz-tree';
import { Permission } from './permissions';
import {
  SUITE_SPACES,
  SUITE_UNCLASSIFIED,
  entryPermissions,
  primaryDestinations,
  resolveProjectForUrl,
  resolveSpaceForUrl,
  validateSuiteMap,
  viewProjects,
  visibleSuiteMap,
  type SuiteEntry,
  type SuiteSpace,
} from './suite-map';

/**
 * `[SN.1]` — El mapa de espacios de la landing, contra el árbol REAL.
 *
 * Cada regla del header de `suite-map.ts` tiene acá su aserción, y las que son compuertas
 * tienen además su PRUEBA NEGATIVA: se le pasa a `validateSuiteMap` un mapa roto a propósito y
 * se verifica el rojo. Sin eso, un validador que devuelve `[]` porque no revisa nada se lee
 * igual que uno que revisó y no encontró (ADR-056: un gate sin prueba negativa es una intención).
 */

const ORDEN_5_1 = [
  'Mi trabajo',
  'Dirección General',
  'Comercial',
  'Operación por zonas',
  'Almacenes y Logística',
  'Administración y Finanzas',
  'Auditoría, Prevención y Control',
  'Recursos Humanos',
  'Sistemas, Servicios y Mantenimiento',
  'Configuración de la suite',
];

const ids = (vis: ReturnType<typeof visibleSuiteMap>) =>
  vis.spaces.flatMap((s) => s.entries.map((e) => e.entry.id));
const spaceIds = (vis: ReturnType<typeof visibleSuiteMap>) => vis.spaces.map((s) => s.space.id);
const con = (...perms: Permission[]): Record<string, boolean> =>
  Object.fromEntries(perms.map((p) => [p, true]));

/** Copia mutable del mapa para romperlo en las pruebas negativas. */
const clonar = (): SuiteSpace[] =>
  SUITE_SPACES.map((s) => ({ ...s, entries: s.entries.map((e) => ({ ...e })) }));
const espacio = (mapa: SuiteSpace[], id: string): SuiteSpace => {
  const s = mapa.find((x) => x.id === id);
  if (!s) throw new Error(`no existe el espacio ${id}`);
  return s;
};
const entrada = (mapa: SuiteSpace[], id: string): SuiteEntry => {
  const e = mapa.flatMap((s) => s.entries).find((x) => x.id === id);
  if (!e) throw new Error(`no existe la entrada ${id}`);
  return e;
};

describe('SUITE_SPACES · el mapa contra el árbol', () => {
  it('es válido (cero errores) — y si falla, dice cuáles', () => {
    expect(validateSuiteMap()).toEqual([]);
  });

  it('son los 10 espacios de §5.1, en su orden', () => {
    const ordenados = [...SUITE_SPACES].sort((a, b) => a.order - b.order);
    expect(ordenados.map((s) => s.label)).toEqual(ORDEN_5_1);
    expect(ordenados.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('los tres espacios sin módulo son planned y no llevan entradas', () => {
    const planned = SUITE_SPACES.filter((s) => s.status === 'planned').map((s) => s.id).sort();
    expect(planned).toEqual(['operacion-por-zonas', 'recursos-humanos', 'sistemas-servicios-mantenimiento']);
    for (const s of SUITE_SPACES.filter((x) => x.status === 'planned')) expect(s.entries).toEqual([]);
  });

  it('cada proyecto de la app view tiene exactamente una casa primaria (espacio o sin clasificar)', () => {
    const primarias = [...SUITE_SPACES.flatMap((s) => s.entries), ...SUITE_UNCLASSIFIED]
      .filter((e) => e.kind === 'project' && !e.crossLink)
      .map((e) => e.project)
      .sort();
    expect(primarias).toEqual(viewProjects().map((p) => p.id).sort());
  });

  it('un módulo sin ruta no aporta permisos: el kiosco de asistencia no abre Punto de Venta', () => {
    const pdv = entrada(clonar(), 'pisos-de-venta');
    expect(entryPermissions(pdv)).not.toContain(Permission.HR_ATTENDANCE_CHECAR);
    // …y sí aporta lo que tiene pantalla.
    expect(entryPermissions(pdv)).toEqual(expect.arrayContaining([Permission.STORE_LIVE_VER, Permission.STORE_PRICE_CHECK_VER]));
  });

  it('Finanzas se describe por sus módulos reales, no por la tarjeta vieja ("egresos desde pólizas")', () => {
    const fin = entryPermissions(entrada(clonar(), 'finanzas'));
    expect(fin).toEqual(
      expect.arrayContaining([
        Permission.FINANCE_BANK_VER,
        Permission.FINANCE_COLLECTIONS_VER,
        Permission.FINANCE_RECEIVABLES_VER,
        Permission.FINANCE_PAYMENTS_VER,
        Permission.FINANCE_EXPENSES_VER,
        Permission.FINANCE_AI_CHAT,
      ]),
    );
  });
});

describe('validateSuiteMap · pruebas NEGATIVAS (el validador tiene que ponerse rojo)', () => {
  it('proyecto inexistente en el árbol', () => {
    const mapa = clonar();
    (entrada(mapa, 'compras') as { project: string }).project = 'no-existe';
    expect(validateSuiteMap(mapa).join('\n')).toMatch(/proyecto inexistente.*no-existe/);
  });

  it('módulo inexistente', () => {
    const mapa = clonar();
    (entrada(mapa, 'mkt-promociones') as { module: string }).module = 'fantasma';
    expect(validateSuiteMap(mapa).join('\n')).toMatch(/módulo inexistente: comercial\/fantasma/);
  });

  it('un proyecto con dos casas primarias', () => {
    const mapa = clonar();
    const fin = espacio(mapa, 'administracion-y-finanzas');
    (fin as { entries: SuiteEntry[] }).entries = [
      ...fin.entries,
      { id: 'compras-otra-vez', kind: 'project', project: 'compras', source: { status: 'propuesta', cite: 'x' } },
    ];
    expect(validateSuiteMap(mapa).join('\n')).toMatch(/proyecto compras: 2 entradas primarias/);
  });

  it('un proyecto sin casa (se le quita la primaria)', () => {
    const mapa = clonar();
    const com = espacio(mapa, 'comercial');
    (com as { entries: SuiteEntry[] }).entries = com.entries.filter((e) => e.id !== 'compras');
    expect(validateSuiteMap(mapa).join('\n')).toMatch(/proyecto compras: 0 entradas primarias/);
  });

  it('un espacio planned con entradas, y uno activo vacío', () => {
    const mapa = clonar();
    const rh = espacio(mapa, 'recursos-humanos');
    (rh as { entries: SuiteEntry[] }).entries = [
      { id: 'rh-x', kind: 'module', project: 'trade', module: 'catalogs', crossLink: true, source: { status: 'propuesta', cite: 'x' } },
    ];
    const fin = espacio(mapa, 'administracion-y-finanzas');
    (fin as { entries: SuiteEntry[] }).entries = [];
    const errores = validateSuiteMap(mapa).join('\n');
    expect(errores).toMatch(/recursos-humanos: planned con entradas/);
    expect(errores).toMatch(/administracion-y-finanzas: active sin entradas/);
    // …y los proyectos que perdieron casa también se acusan.
    expect(errores).toMatch(/proyecto finanzas: 0 entradas primarias/);
  });

  it('gate sin motivo, y gate con una clave que no existe en el árbol ni en LEGACY', () => {
    const mapa = clonar();
    (entrada(mapa, 'entregas-reparto') as { gate: unknown }).gate = { anyOf: [Permission.REPARTO_DESPACHAR], reason: '   ' };
    (entrada(mapa, 'configuracion-suite') as { gate: unknown }).gate = {
      anyOf: ['NO_EXISTE' as unknown as Permission],
      reason: 'para probar',
    };
    const errores = validateSuiteMap(mapa).join('\n');
    expect(errores).toMatch(/entregas-reparto: gate sin reason/);
    expect(errores).toMatch(/configuracion-suite: gate con clave fuera del árbol y de LEGACY: NO_EXISTE/);
  });

  it('orden no contiguo', () => {
    const mapa = clonar();
    (espacio(mapa, 'comercial') as { order: number }).order = 30;
    expect(validateSuiteMap(mapa).join('\n')).toMatch(/orden no contiguo/);
  });

  it('con un árbol sin el proyecto whatsapp, la entrada sin clasificar se acusa', () => {
    const arbol: AuthzApp[] = AUTHZ_TREE.map((a) =>
      a.id === 'view' ? { ...a, projects: a.projects.filter((p) => p.id !== 'whatsapp') } : a,
    );
    expect(validateSuiteMap(SUITE_SPACES, SUITE_UNCLASSIFIED, arbol).join('\n')).toMatch(/proyecto inexistente en el árbol: whatsapp/);
  });
});

describe('resolveProjectForUrl / resolveSpaceForUrl · por segmento, nunca por prefijo de texto', () => {
  it('casa el primer segmento y sólo ése', () => {
    expect(resolveProjectForUrl('/admin/users')?.id).toBe('admin');
    expect(resolveProjectForUrl('/dashboard/captures?x=1')?.id).toBe('trade');
    expect(resolveProjectForUrl('/telemarketing/queue#a')?.id).toBe('televenta');
    expect(resolveProjectForUrl('/tienda/verificador')?.id).toBe('pdv');
  });

  it('no inventa: /administracion no es /admin, y la raíz no es nada', () => {
    expect(resolveProjectForUrl('/administracion')).toBeNull();
    expect(resolveProjectForUrl('/x')).toBeNull();
    expect(resolveProjectForUrl('/')).toBeNull();
    expect(resolveProjectForUrl('')).toBeNull();
    expect(resolveProjectForUrl('/sin-acceso?from=/admin')).toBeNull();
  });

  it('WhatsApp (route vacía) jamás se lleva una URL', () => {
    for (const url of ['/', '/x', '/login', '/projects']) {
      expect(resolveProjectForUrl(url)?.id).not.toBe('whatsapp');
    }
  });

  it('el espacio es el de la casa PRIMARIA, aunque haya cross-links al mismo módulo', () => {
    expect(resolveSpaceForUrl('/admin/roles')?.space.id).toBe('configuracion-de-la-suite');
    // /comercial/promotions aparece en Mercadotecnia como cross-link; la casa es Ventas.
    const com = resolveSpaceForUrl('/comercial/promotions');
    expect(com?.space.id).toBe('comercial');
    expect(com?.entry.id).toBe('ventas-backoffice');
    // /almacen/prevencion está enlazado desde Auditoría; su casa es Almacenes y Logística.
    expect(resolveSpaceForUrl('/almacen/prevencion')?.space.id).toBe('almacenes-y-logistica');
    expect(resolveSpaceForUrl('/nada')).toBeNull();
  });
});

describe('visibleSuiteMap · lo que ve cada persona', () => {
  it('sin permisos: ningún espacio, y los planned igual se DECLARAN', () => {
    const vis = visibleSuiteMap({}, false, null);
    expect(vis.spaces).toEqual([]);
    expect(vis.declared.map((s) => s.id)).toEqual(['operacion-por-zonas', 'recursos-humanos', 'sistemas-servicios-mantenimiento']);
  });

  it('permisos en null (todavía no cargaron) se tratan como vacío, no como error', () => {
    expect(visibleSuiteMap(null, false, null).spaces).toEqual([]);
  });

  it('la cuenta de kiosco (HR_ATTENDANCE_CHECAR) no ve nada: su permiso no tiene pantalla', () => {
    expect(ids(visibleSuiteMap(con(Permission.HR_ATTENDANCE_CHECAR), false, 'checador_kiosco'))).toEqual([]);
  });

  it('el almacenista (RECIBIR + SUPERVISAR) ve sólo Almacenes, con sus módulos y nada más', () => {
    const vis = visibleSuiteMap(con(Permission.COMMERCIAL_INVENTORY_RECIBIR, Permission.COMMERCIAL_INVENTORY_SUPERVISAR), false, 'almacenista');
    expect(spaceIds(vis)).toEqual(['almacenes-y-logistica']);
    expect(ids(vis)).toEqual(['almacenes']);
    const mods = vis.spaces[0].entries[0].modules.map((m) => m.id).sort();
    expect(mods).toEqual(['physical-inventory', 'receiving-auditor']);
    expect(primaryDestinations(vis)).toEqual(['/almacen']);
  });

  it('el admin de plataforma ve todos los espacios activos y propuestos, nunca los planned ni la landing', () => {
    const vis = visibleSuiteMap({}, true, 'superadmin');
    expect(spaceIds(vis)).toEqual([
      'direccion-general',
      'comercial',
      'almacenes-y-logistica',
      'administracion-y-finanzas',
      'auditoria-prevencion-control',
      'configuracion-de-la-suite',
    ]);
    // Once puertas primarias: los 12 proyectos menos WhatsApp, que no tiene ruta.
    expect(primaryDestinations(vis)).toHaveLength(11);
    expect(ids(vis)).not.toContain('whatsapp-bot');
  });

  it('el vendedor no ve el back-office de Ventas aunque tenga la clave — ni siendo admin', () => {
    expect(ids(visibleSuiteMap(con(Permission.COMMERCIAL_ORDERS_VER), false, 'vendedor'))).not.toContain('ventas-backoffice');
    expect(ids(visibleSuiteMap({}, true, 'vendedor'))).not.toContain('ventas-backoffice');
    // Otro rol con la misma clave sí lo ve.
    expect(ids(visibleSuiteMap(con(Permission.COMMERCIAL_ORDERS_VER), false, 'supervisor_ventas'))).toContain('ventas-backoffice');
  });

  it('gate de Reparto: ENTREGAR solo no abre (el guard pide DESPACHAR); DESPACHAR sí', () => {
    expect(ids(visibleSuiteMap(con(Permission.REPARTO_ENTREGAR), false, 'repartidor'))).not.toContain('entregas-reparto');
    expect(ids(visibleSuiteMap(con(Permission.REPARTO_DESPACHAR), false, 'encargada'))).toContain('entregas-reparto');
  });

  it('gate de Configuración: ROLES_VER solo abre (la ruta /admin/roles lo acepta); USUARIOS_VER solo no abre nada', () => {
    expect(ids(visibleSuiteMap(con(Permission.ROLES_VER), false, 'auditor'))).toContain('configuracion-suite');
    expect(ids(visibleSuiteMap(con(Permission.USUARIOS_VER), false, 'auditor'))).not.toContain('configuracion-suite');
  });

  it('gate de Trade: paridad con la tarjeta vieja — RUTAS_VER solo NO abre (colaboradorGuard rebota), PLANOGRAMAS_GESTIONAR solo sí', () => {
    expect(ids(visibleSuiteMap(con(Permission.RUTAS_VER), false, 'x'))).not.toContain('rutas-auditoria');
    const solo = visibleSuiteMap(con(Permission.PLANOGRAMAS_GESTIONAR), false, 'x');
    expect(ids(solo)).toContain('rutas-auditoria');
    // …pero el enlace DIRECTO al planograma desde Mercadotecnia exige lo que el shell exige.
    expect(ids(solo)).not.toContain('mkt-planograma');
    const conReportes = visibleSuiteMap(con(Permission.PLANOGRAMAS_GESTIONAR, Permission.REPORTES_VER_EQUIPO), false, 'x');
    expect(ids(conReportes)).toContain('mkt-planograma');
  });

  it('un cross-link no cuenta como destino primario: quien sólo tiene analítica entra directo a /comercial', () => {
    const vis = visibleSuiteMap(con(Permission.COMMERCIAL_ANALYTICS_VER), false, 'direccion');
    expect(ids(vis)).toEqual(expect.arrayContaining(['dg-centro-de-control', 'ventas-backoffice']));
    expect(primaryDestinations(vis)).toEqual(['/comercial']);
  });

  it('la línea secundaria lista sólo los módulos abribles por ESA persona', () => {
    const vis = visibleSuiteMap(con(Permission.FINANCE_BANK_VER, Permission.FINANCE_AI_CHAT), false, 'finanzas');
    const fin = vis.spaces.find((s) => s.space.id === 'administracion-y-finanzas')?.entries.find((e) => e.entry.id === 'finanzas');
    expect(fin?.modules.map((m) => m.id).sort()).toEqual(['bancos', 'hallazgos', 'maat', 'tareas']);
  });

  it('las etiquetas y el grupo salen del mapa o del árbol, y los espacios propuestos traen su P-xx', () => {
    const vis = visibleSuiteMap({}, true, 'superadmin');
    const com = vis.spaces.find((s) => s.space.id === 'comercial')!;
    const tele = com.entries.find((e) => e.entry.id === 'mayoreo-telemarketing')!;
    expect(tele.label).toBe('Telemarketing');
    expect(tele.groupLabel).toBe('Ventas › Mayoreo › Atención telefónica / Telemarketing');
    expect(tele.route).toBe('/telemarketing');
    const apc = vis.spaces.find((s) => s.space.id === 'auditoria-prevencion-control')!;
    expect(apc.space.status).toBe('proposed');
    expect(apc.space.proposal).toBe('P-03');
    expect(apc.entries.every((e) => e.entry.crossLink)).toBe(true);
  });
});
