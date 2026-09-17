// Entorno de pruebas de Angular sobre Vitest (@analogjs/vitest-angular).
//
// setup-zone carga zone.js y parcha describe/it/beforeEach para que el cuerpo de cada prueba
// corra dentro de una ProxyZone. Eso es lo que hace funcionar fakeAsync y tick -- hoy los usa
// tienda-etiquetas.component.spec.ts.
//
// setupTestBed es lo que antes hacia setupZoneTestEnv() de jest-preset-angular: inicializa el
// TestBed. Sin esta llamada, cualquier spec con TestBed muere en
// "Need to call TestBed.initTestEnvironment() first".
//
// ⚠️ zoneless: false A PROPOSITO, aunque la app corra provideZonelessChangeDetection(): esto
// replica lo que habia (TestBed con zona) y los specs que quieren zoneless ya lo piden ellos
// mismos en sus providers. Ponerlo en true aca se lo impondria tambien a los que NO lo piden, y
// migrar el corredor de pruebas no es el momento de cambiar el modelo de deteccion de cambios.
import '@analogjs/vitest-angular/setup-zone';
import { setupTestBed } from '@analogjs/vitest-angular/setup-testbed';

setupTestBed({ zoneless: false });

/**
 * `[TDA.7]` `IntersectionObserver` para jsdom, que no lo implementa.
 *
 * ── Por qué esto tenía que existir ───────────────────────────────────────────────────────
 * `CountUpDirective` construye un `IntersectionObserver` en `ngOnInit`. Ningún spec de esta app
 * lo proveía, así que **cualquier componente que use la directiva revienta con
 * `ReferenceError` al renderizarse en un test**. No se había notado porque el único consumidor
 * en un componente con spec —el verificador— sólo monta el count-up dentro del bloque de
 * mayoreo, y la fixture de ese spec no traía mayoreo: el camino no se ejecutaba.
 *
 * Eso es lo que hacía que 185 pruebas en verde no dijeran nada sobre esa parte de la pantalla.
 *
 * ── Cómo usarlo ──────────────────────────────────────────────────────────────────────────
 * Por default **NUNCA dispara**, que es el caso realista y el que más importa: un elemento que
 * no llega a estar en viewport (abajo del pliegue en el monitor del mostrador). Un test que
 * quiera el otro camino llama `intersectarTodos()`.
 */
// ⚠️ Sin `implements IntersectionObserver` a propósito: la interfaz del DOM crece entre
// versiones de TS (`scrollMargin`, etc.) y un doble de pruebas no tiene por qué seguirle el
// paso — lo único que importa es que cumpla el contrato que la directiva usa. Además este
// archivo NO debe compilar con la app (`tsconfig.app.json` lo excluye desde TDA.7: cuando dejó
// de ser un `import` suelto, el `include: src/**/*.ts` lo arrastró y `beforeEach` rompió el
// build de producción). Se lo deja type-clean igual, para no depender sólo del exclude.
class IntersectionObserverDePrueba {
  static instancias: IntersectionObserverDePrueba[] = [];

  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: readonly number[] = [];
  /** `true` sólo si un test forzó la intersección: deja AFIRMAR que nadie la vio. */
  disparado = false;
  private observados: Element[] = [];

  constructor(private cb: IntersectionObserverCallback) {
    IntersectionObserverDePrueba.instancias.push(this);
  }

  observe(el: Element): void { this.observados.push(el); }
  unobserve(el: Element): void { this.observados = this.observados.filter((x) => x !== el); }
  disconnect(): void { this.observados = []; }
  takeRecords(): IntersectionObserverEntry[] { return []; }

  /** Simula que el elemento entró en viewport. */
  intersectar(): void {
    this.disparado = true;
    this.cb(
      this.observados.map((target) => ({ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry)),
      this as unknown as IntersectionObserver,
    );
  }
}

(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
  IntersectionObserverDePrueba;

/** Fuerza la intersección en todos los observadores vivos. */
export function intersectarTodos(): void {
  for (const i of IntersectionObserverDePrueba.instancias) i.intersectar();
}

/** `true` si NINGÚN observador fue disparado — o sea, nadie vio el elemento. */
export function nadieIntersecto(): boolean {
  return IntersectionObserverDePrueba.instancias.every((i) => !i.disparado);
}

beforeEach(() => { IntersectionObserverDePrueba.instancias = []; });
