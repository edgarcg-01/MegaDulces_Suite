// ⚠️ `import type` a propósito, no un import normal: `authz-tree.ts` re-exporta este archivo, y
// con un import de VALOR eso sería un ciclo en runtime. Los tipos se borran al compilar, así que
// el ciclo no existe. Por lo mismo acá no hay `AUTHZ_TREE` por default: el árbol se pasa.
import type { AuthzApp, AuthzModule, AuthzProject } from './authz-tree';

/**
 * `[AU.14]` — **Seleccionar permisos sobre el árbol: la lógica, una sola vez.**
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * El editor de roles (`admin-roles-permissions`) ya resolvía bien el tri-estado y la cascada,
 * con esta lógica escrita COMO MÉTODOS PRIVADOS de un componente de pantalla. Cuando la ficha de
 * la persona necesitó lo mismo, la salida barata era copiarla — y eso es, literal, el modo de
 * falla que ADR-056 midió ocho veces: un primitivo bien hecho, aplicado a un solo consumidor, que
 * al segundo consumidor se duplica a mano y a partir de ahí diverge en silencio.
 *
 * Así que la lógica baja acá, sin Angular y sin estado, y los DOS la consumen.
 *
 * ── Lo que NO hace ──────────────────────────────────────────────────────────
 * No decide seguridad. `alternarGrupo` recibe `puedeOtorgar` y lo respeta, pero el que manda es
 * el backend: `setPermissions` rechaza otorgar lo que el que edita no tiene. Acá sólo se decide
 * qué se OFRECE, para que la pantalla no proponga algo que el servidor va a negar.
 *
 * No conoce `PERMISSION_META` ni etiquetas: eso es presentación y vive en el cliente.
 */

export type TriEstado = 'all' | 'some' | 'none';

/** El estado deseado, clave por clave. Lo que no esté listado se considera apagado. */
export type MapaDeValores = Readonly<Record<string, boolean>>;

/** Una diferencia contra el perfil base — exactamente la forma que acepta `PUT /users/:id/permissions`. */
export interface OverrideDePermiso {
  permission_key: string;
  allow: boolean;
}

// ── Claves de cada nivel del árbol ──────────────────────────────────────────

export function clavesDeModulo(m: AuthzModule): string[] {
  return [...m.view, ...m.manage];
}

export function clavesDeProyecto(p: AuthzProject): string[] {
  return p.modules.flatMap(clavesDeModulo);
}

export function clavesDeApp(a: AuthzApp): string[] {
  if (a.kind === 'access') return a.accessPermission ? [a.accessPermission] : [];
  return a.projects.flatMap(clavesDeProyecto);
}

// ── Tri-estado ──────────────────────────────────────────────────────────────

export function cuantasEncendidas(valores: MapaDeValores, claves: readonly string[]): number {
  return claves.filter((k) => valores[k] === true).length;
}

/**
 * ⚠️ Un grupo VACÍO devuelve `none`, no `all`. Suena a detalle y no lo es: con `all` un módulo sin
 * permisos declarados saldría tildado, o sea afirmando que concede algo que no existe. Es la misma
 * familia del `cfg ? classify : 'ok'` que la Fase VP midió dando verde incondicional.
 */
export function triEstado(valores: MapaDeValores, claves: readonly string[]): TriEstado {
  if (!claves.length) return 'none';
  const on = cuantasEncendidas(valores, claves);
  return on === 0 ? 'none' : on === claves.length ? 'all' : 'some';
}

/**
 * Enciende o apaga todo un grupo. Si estaba completo, apaga; si no, enciende lo que se pueda.
 *
 * ⚠️ **Apagar nunca se frena y encender sí.** No es una asimetría caprichosa: el backend sólo
 * valida los `allow` (`setPermissions` filtra `pedidos.filter(o => o.allow)`), o sea que quitar un
 * permiso que vos no tenés es una operación legítima. Reflejar eso acá evita que la pantalla
 * prometa un freno que el servidor no aplica — y al revés, que niegue algo que sí se puede.
 */
export function alternarGrupo(
  valores: MapaDeValores,
  claves: readonly string[],
  puedeOtorgar: (clave: string) => boolean = () => true,
): Record<string, boolean> {
  const encender = triEstado(valores, claves) !== 'all';
  const siguiente: Record<string, boolean> = { ...valores };
  for (const k of claves) {
    if (!encender) siguiente[k] = false;
    else if (puedeOtorgar(k)) siguiente[k] = true;
  }
  return siguiente;
}

// ── La diferencia contra el perfil ──────────────────────────────────────────

/**
 * `[AU.14]` Las excepciones que hay que guardar = **la diferencia** entre lo que el perfil base da
 * y lo que la pantalla dejó marcado.
 *
 * Es el corazón del cambio de forma: hasta ahora quien administraba escribía las EXCEPCIONES a
 * mano, de a una. Ahora marca el estado FINAL que quiere y la diferencia se deriva. Medido en
 * prod el 2026-10-03: `ernesto_zarate` tiene 28 excepciones, 27 de ellas «quita», y las 27 son
 * dos proyectos enteros — 27 decisiones escritas a mano para expresar dos.
 *
 * `universo` es explícito a propósito: sin él habría que recorrer `deseado`, y una clave que la
 * pantalla no pintó quedaría fuera de la comparación sin que nadie lo note.
 */
export function overridesContra(
  base: ReadonlySet<string>,
  deseado: MapaDeValores,
  universo: readonly string[],
): OverrideDePermiso[] {
  const fuera: OverrideDePermiso[] = [];
  for (const k of universo) {
    const loDaElPerfil = base.has(k);
    const loQuiero = deseado[k] === true;
    if (loQuiero !== loDaElPerfil) fuera.push({ permission_key: k, allow: loQuiero });
  }
  return fuera;
}

/** El estado inicial del árbol para una persona: lo que su perfil le da, tildado. */
export function valoresDesdeBase(base: Iterable<string>): Record<string, boolean> {
  const v: Record<string, boolean> = {};
  for (const k of base) v[k] = true;
  return v;
}

// ── De claves a PANTALLAS ───────────────────────────────────────────────────

export interface CambioDePantalla {
  projectId: string;
  projectLabel: string;
  moduleId: string;
  /** Etiqueta del módulo = el nombre de la pantalla, que es como lo nombra quien administra. */
  label: string;
  /** Vacía cuando el módulo no es navegable (kiosco, bot). Se DECLARA, no se inventa una ruta. */
  route: string;
  /** Claves que se quitan / que se conceden, ya separadas. */
  quita: string[];
  concede: string[];
  /** Alguna de las claves tocadas es de gestión (escribe), no sólo de lectura. */
  tocaGestion: boolean;
}

export interface PantallasAfectadas {
  pantallas: CambioDePantalla[];
  /**
   * Claves que no viven en ningún módulo del árbol. Hoy son **cero** (medido: las 223 del enum
   * tienen casa, 2 marcadas LEGACY), pero una clave nueva sin ubicar entraría por acá — y un
   * hueco mudo se lee como «no afecta a ninguna pantalla», que es justo lo contrario.
   */
  sinModulo: string[];
}

interface Ubicacion {
  project: AuthzProject;
  module: AuthzModule;
}

/** Índice inverso clave → dónde vive. Se arma una vez por árbol. */
function indiceDeClaves(tree: readonly AuthzApp[]): Map<string, Ubicacion> {
  const ix = new Map<string, Ubicacion>();
  for (const app of tree) {
    if (app.kind !== 'workspace') continue;
    for (const project of app.projects) {
      for (const module of project.modules) {
        for (const k of clavesDeModulo(module)) ix.set(k, { project, module });
      }
    }
  }
  return ix;
}

/**
 * `[AU.14]` Traduce un lote de excepciones a **las pantallas que cambian**.
 *
 * Es lo que vuelve revisable un cambio en bloque: «27 claves» no se puede leer, «19 pantallas, y
 * éstas son» sí. El nombre y la ruta salen del árbol, que ya los tiene — 128 de 131 módulos
 * declaran su ruta, y los 3 que no son kioscos y bots, no pantallas de la SPA.
 */
export function pantallasAfectadas(
  overrides: readonly OverrideDePermiso[],
  tree: readonly AuthzApp[],
): PantallasAfectadas {
  const ix = indiceDeClaves(tree);
  const porModulo = new Map<string, CambioDePantalla>();
  const sinModulo: string[] = [];

  for (const o of overrides) {
    const u = ix.get(o.permission_key);
    if (!u) {
      sinModulo.push(o.permission_key);
      continue;
    }
    const id = `${u.project.id}/${u.module.id}`;
    let fila = porModulo.get(id);
    if (!fila) {
      fila = {
        projectId: u.project.id,
        projectLabel: u.project.label,
        moduleId: u.module.id,
        label: u.module.label,
        route: u.module.route ?? '',
        quita: [],
        concede: [],
        tocaGestion: false,
      };
      porModulo.set(id, fila);
    }
    if (o.allow) fila.concede.push(o.permission_key);
    else fila.quita.push(o.permission_key);
    if ((u.module.manage as readonly string[]).includes(o.permission_key)) fila.tocaGestion = true;
  }

  return { pantallas: [...porModulo.values()], sinModulo };
}

/** Dónde vive una clave. `null` = no está en el árbol (ver `sinModulo`). */
export function ubicacionDeClave(
  clave: string,
  tree: readonly AuthzApp[],
): { project: AuthzProject; module: AuthzModule } | null {
  return indiceDeClaves(tree).get(clave) ?? null;
}
