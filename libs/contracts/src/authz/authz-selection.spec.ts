import { AUTHZ_TREE, AuthzApp } from './authz-tree';
import type { Permission } from './permissions';
import {
  alternarGrupo,
  clavesDeModulo,
  cuantasEncendidas,
  overridesContra,
  pantallasAfectadas,
  triEstado,
  ubicacionDeClave,
  valoresDesdeBase,
} from './authz-selection';

/**
 * `[AU.33]` — Candado de la lógica de selección.
 *
 * ⚠️ `globals: true` en `vitest.config.ts` de contracts: estos specs **no importan** `describe`
 * ni `expect` de 'vitest'. Hacerlo rompe la corrida (ya pasó en `scope-areas.spec.ts`).
 *
 * Los bloques marcados ⛔ son las pruebas NEGATIVAS: un gate sin prueba negativa es una intención.
 */

const clv = (...xs: string[]) => xs as unknown as Permission[];

const ARBOL_JUGUETE: readonly AuthzApp[] = [
  {
    id: 'view',
    label: 'Juguete',
    icon: 'pi pi-box',
    kind: 'workspace',
    projects: [
      {
        id: 'p1',
        label: 'Proyecto Uno',
        icon: 'pi pi-box',
        route: '/p1',
        modules: [
          // Claves de juguete: el tipo pide `Permission`, pero la lógica es ciega al enum a
          // propósito — trabaja con strings. El cast declara eso en vez de inventar 3 permisos.
          { id: 'm1', label: 'Módulo Uno', route: '/p1/m1', view: clv('A'), manage: clv('B') },
          { id: 'm2', label: 'Módulo Dos', route: '/p1/m2', view: clv('C'), manage: [] },
          { id: 'm3', label: 'Sin ruta', view: [], manage: [] },
        ],
      },
    ],
  },
];

describe('[AU.33] tri-estado', () => {
  it('reporta all / some / none sobre las claves de un módulo', () => {
    const claves = ['A', 'B'];
    expect(triEstado({ A: true, B: true }, claves)).toBe('all');
    expect(triEstado({ A: true, B: false }, claves)).toBe('some');
    expect(triEstado({ A: false, B: false }, claves)).toBe('none');
    expect(triEstado({}, claves)).toBe('none');
  });

  it('⛔ un grupo VACÍO es `none`, nunca `all`', () => {
    // Con `all` un módulo sin permisos declarados saldría tildado: afirmaría que concede algo que
    // no existe. Es el `cfg ? classify : "ok"` que la Fase VP midió dando verde incondicional.
    expect(triEstado({}, [])).toBe('none');
    expect(triEstado({ A: true }, [])).toBe('none');
  });

  it('cuantasEncendidas cuenta sólo `true` explícito', () => {
    expect(cuantasEncendidas({ A: true, B: false }, ['A', 'B', 'C'])).toBe(1);
  });
});

describe('[AU.33] alternarGrupo', () => {
  it('apaga el grupo entero cuando estaba completo', () => {
    expect(alternarGrupo({ A: true, B: true }, ['A', 'B'])).toEqual({ A: false, B: false });
  });

  it('enciende el grupo entero cuando estaba parcial', () => {
    expect(alternarGrupo({ A: true, B: false }, ['A', 'B'])).toEqual({ A: true, B: true });
  });

  it('al ENCENDER respeta el freno anti-escalada', () => {
    const puede = (k: string) => k === 'A';
    expect(alternarGrupo({}, ['A', 'B'], puede)).toEqual({ A: true });
  });

  it('⛔ al APAGAR NO aplica el freno — y eso es correcto, no un descuido', () => {
    // `setPermissions` sólo valida los `allow`: quitar un permiso que vos no tenés es legítimo.
    // Si acá se frenara, la pantalla prometería un candado que el servidor no aplica.
    const nunca = () => false;
    expect(alternarGrupo({ A: true, B: true }, ['A', 'B'], nunca)).toEqual({ A: false, B: false });
  });

  it('no muta el mapa que recibe', () => {
    const antes = { A: true };
    alternarGrupo(antes, ['A']);
    expect(antes).toEqual({ A: true });
  });
});

describe('[AU.33] la diferencia contra el perfil', () => {
  const universo = ['A', 'B', 'C'];

  it('no emite nada cuando lo marcado es exactamente lo que da el perfil', () => {
    const base = new Set(['A', 'B']);
    expect(overridesContra(base, valoresDesdeBase(base), universo)).toEqual([]);
  });

  it('emite allow=false por lo que el perfil da y se destildó', () => {
    const base = new Set(['A', 'B']);
    expect(overridesContra(base, { A: true, B: false }, universo)).toEqual([
      { permission_key: 'B', allow: false },
    ]);
  });

  it('emite allow=true por lo que el perfil NO da y se tildó', () => {
    expect(overridesContra(new Set<string>(), { C: true }, universo)).toEqual([
      { permission_key: 'C', allow: true },
    ]);
  });

  it('⛔ una clave fuera del universo NO se compara, aunque esté en el mapa', () => {
    // El universo es explícito justamente para esto: si se dedujera de `deseado`, una clave que la
    // pantalla no pintó quedaría fuera de la comparación sin que nadie lo note.
    expect(overridesContra(new Set<string>(), { Z: true }, universo)).toEqual([]);
  });
});

describe('[AU.33] de claves a pantallas', () => {
  it('agrupa por módulo y separa quita de concede', () => {
    const r = pantallasAfectadas(
      [
        { permission_key: 'A', allow: false },
        { permission_key: 'B', allow: false },
        { permission_key: 'C', allow: true },
      ],
      ARBOL_JUGUETE,
    );
    expect(r.pantallas).toHaveLength(2);
    expect(r.sinModulo).toEqual([]);
    const m1 = r.pantallas.find((p) => p.moduleId === 'm1');
    expect(m1?.quita.sort()).toEqual(['A', 'B']);
    expect(m1?.tocaGestion).toBe(true);
    const m2 = r.pantallas.find((p) => p.moduleId === 'm2');
    expect(m2?.concede).toEqual(['C']);
    expect(m2?.tocaGestion).toBe(false);
  });

  it('⛔ una clave sin módulo se DECLARA, no desaparece', () => {
    // Hoy esto no puede pasar (las 223 del enum tienen casa), pero una clave nueva sin ubicar
    // entraría por acá — y un hueco mudo se lee como «no afecta a ninguna pantalla».
    const r = pantallasAfectadas([{ permission_key: 'INVENTADA', allow: true }], ARBOL_JUGUETE);
    expect(r.pantallas).toEqual([]);
    expect(r.sinModulo).toEqual(['INVENTADA']);
  });

  it('un módulo sin ruta sale con ruta vacía, no con una inventada', () => {
    const mod = ARBOL_JUGUETE[0].projects[0].modules[2];
    expect(clavesDeModulo(mod)).toEqual([]);
    expect(mod.route ?? '').toBe('');
  });
});

describe('[AU.33] contra el árbol REAL', () => {
  /**
   * El caso medido en prod el 2026-10-03: a `ernesto_zarate` le quitaron estas 27 claves de a una,
   * cada una su propia fila. Son **dos proyectos enteros**. Este bloque es el candado de que la
   * traducción clave → pantalla sigue dando lo mismo si alguien reacomoda el árbol.
   */
  const LAS_27 = [
    'FINANCE_AI_CHAT', 'FINANCE_BANK_GESTIONAR', 'FINANCE_BANK_VER',
    'FINANCE_COLLECTIONS_GESTIONAR', 'FINANCE_COLLECTIONS_VER', 'FINANCE_EXPENSES_VER',
    'FINANCE_FINDINGS_GESTIONAR', 'FINANCE_PAYMENTS_GESTIONAR', 'FINANCE_PAYMENTS_VER',
    'FINANCE_RECEIVABLES_VER', 'FINANCE_RECON_ASIGNAR',
    'FISCAL_CFDI_VER', 'FISCAL_CONCILIACION_VER', 'FISCAL_CONTAB_GESTIONAR', 'FISCAL_CONTAB_VER',
    'FISCAL_CREDENCIALES_GESTIONAR', 'FISCAL_DESCARGA_GESTIONAR', 'FISCAL_DESCARGA_VER',
    'FISCAL_DIOT_VER', 'FISCAL_FACTURAR_GESTIONAR', 'FISCAL_FACTURAR_VER', 'FISCAL_IMPUESTOS_VER',
    'FISCAL_LISTAS_GESTIONAR', 'FISCAL_LISTAS_VER', 'FISCAL_MATERIALIDAD_GESTIONAR',
    'FISCAL_MATERIALIDAD_VER', 'FISCAL_PURCHASE_BOOK_VER',
  ];

  /**
   * ⛔ **Acá decía 19, derivado a mano, y el árbol real dice 18.** El error de método vale más que
   * el número: la lista se había armado leyendo los módulos de Finanzas y Contabilidad y
   * repartiendo las claves «por donde suenan», y tres cayeron mal —`FINANCE_PAYMENTS_*` vive en
   * **Calendario de pagos** y no en Pagos a proveedor, `FINANCE_EXPENSES_VER` en **Gastos** y no
   * en Egresos contables, y `FINANCE_FINDINGS_GESTIONAR` no tiene módulo «Hallazgos» propio—.
   * Comprobar una derivación contra sí misma la pasa en verde; sólo el árbol la refuta.
   *
   * ⛔ **Enmienda `[CPA.10]`:** las tres «caídas mal» eran, en realidad, el índice uno-a-uno
   * acreditando una clave compartida a una sola pantalla. `FINANCE_FINDINGS_GESTIONAR` **sí**
   * tiene «Hallazgos» propio, y `FINANCE_PAYMENTS_*` abre Calendario de pagos **y** Pagos a
   * proveedor. Las tres aparecen hoy en `LAS_25_PANTALLAS`. La lección de método se sostiene;
   * lo que falló fue el instrumento con que se comprobó.
   */
  /*
   * ⭐ Pasó de 18 a 19 con `[CPA.0]` y **de 19 a 25 con `[CPA.10]`**, y la lista crece
   * ENUMERANDO las pantallas, no subiendo un contador.
   *
   * ⛔⛔ De las 6 que entraron, **sólo una es nueva** (`contabilidad/mi-cierre`). Las otras cinco
   * —`finanzas/egresos`, `finanzas/estado-cuenta-acreedores`, `finanzas/hallazgos`,
   * `finanzas/pagos-comprobantes`, `finanzas/pronto-pago`— **ya existían y el candado no las
   * veía**: el índice era uno-a-uno (`ix.set`) y una clave compartida quedaba atribuida al
   * último módulo del árbol. O sea que esta lista no creció porque se construyó algo: creció
   * porque se dejó de sub-reportar.
   *
   * ⚠️ Y eso **refuta un comentario de este mismo archivo**: decía que
   * «`FINANCE_FINDINGS_GESTIONAR` no tiene módulo "Hallazgos" propio». Sí lo tiene
   * (`finanzas/hallazgos`); lo que pasaba es que el índice se lo acreditaba a otra pantalla.
   *
   * El semáforo (`contabilidad/cierre-contable`), la bandeja (`contabilidad/mi-cierre`) y
   * «Contabilidad electrónica» comparten `FISCAL_CONTAB_VER` a propósito, para no estrenar un
   * permiso que alguien tendría que repartir en prod (`[LC.6.2]`). El efecto correcto de esa
   * decisión es justo éste: quitarle esa clave a alguien cierra **tres** pantallas, y la UI de
   * roles ahora lo dice en vez de nombrar una sola.
   */
  const LAS_25_PANTALLAS = [
    'contabilidad/cfdi', 'contabilidad/cierre-contable', 'contabilidad/conciliacion',
    'contabilidad/contabilidad', 'contabilidad/credenciales', 'contabilidad/descarga',
    'contabilidad/diot', 'contabilidad/facturar', 'contabilidad/impuestos',
    'contabilidad/libro-compras', 'contabilidad/listas-sat', 'contabilidad/materialidad',
    'contabilidad/mi-cierre',
    'finanzas/bancos', 'finanzas/calendario-pagos', 'finanzas/cartera', 'finanzas/cobranza',
    'finanzas/egresos', 'finanzas/estado-cuenta-acreedores', 'finanzas/gastos',
    'finanzas/hallazgos', 'finanzas/maat', 'finanzas/pagos-comprobantes',
    'finanzas/pronto-pago', 'finanzas/tareas',
  ];

  it('las 27 claves del caso real caen en 25 pantallas de 2 proyectos', () => {
    const r = pantallasAfectadas(
      LAS_27.map((k) => ({ permission_key: k, allow: false })),
      AUTHZ_TREE,
    );
    expect(r.sinModulo).toEqual([]);
    expect(r.pantallas.map((p) => `${p.projectId}/${p.moduleId}`).sort()).toEqual(LAS_25_PANTALLAS);
    expect(new Set(r.pantallas.map((p) => p.projectId))).toEqual(new Set(['finanzas', 'contabilidad']));
    /*
     * ⛔ `[CPA.10]` Acá se exigía que la suma diera 27 («ninguna clave se contó dos veces»), y
     * esa invariante SÓLO se sostenía porque el índice guardaba una pantalla por clave. Con el
     * índice uno-a-muchos una clave compartida aparece en varias pantallas a propósito, y la
     * suma da 39. Lo que de verdad hay que proteger es que no se PIERDA ni se INVENTE ninguna:
     * el conjunto de claves distintas repartidas sigue siendo exactamente LAS_27.
     */
    const repartidas = new Set(r.pantallas.flatMap((p) => [...p.quita, ...p.concede]));
    expect([...repartidas].sort()).toEqual([...LAS_27].sort());
  });

  it('cada una de las 27 tiene casa en el árbol', () => {
    const huerfanas = LAS_27.filter((k) => !ubicacionDeClave(k, AUTHZ_TREE));
    expect(huerfanas).toEqual([]);
  });

  it('las de gestión se distinguen de las que sólo leen, en TODAS sus pantallas', () => {
    const r = pantallasAfectadas(
      LAS_27.map((k) => ({ permission_key: k, allow: false })),
      AUTHZ_TREE,
    );

    /*
     * ⛔ `[CPA.10]` Esta derivación usaba `ubicacionDeClave`, que devuelve UNA pantalla. Mientras
     * el índice era uno-a-uno las dos caras coincidían por construcción — o sea que el candado
     * comparaba el sub-reporte contra sí mismo y pasaba en verde. Ahora se barre el árbol
     * ENTERO: la marca de gestión tiene que aparecer en cada pantalla que declare la clave en su
     * `manage`, no sólo en la última que el índice conservaba.
     */
    const modulosConGestion = new Set<string>();
    for (const app of AUTHZ_TREE) {
      if (app.kind !== 'workspace') continue;
      for (const project of app.projects) {
        for (const module of project.modules) {
          if (LAS_27.some((k) => (module.manage as readonly string[]).includes(k))) {
            modulosConGestion.add(module.id);
          }
        }
      }
    }
    expect(new Set(r.pantallas.filter((p) => p.tocaGestion).map((p) => p.moduleId))).toEqual(
      modulosConGestion,
    );
    // Y que la marca no sea vacua: hay pantallas de sólo lectura entre las afectadas.
    expect(r.pantallas.some((p) => !p.tocaGestion)).toBe(true);
  });
});
