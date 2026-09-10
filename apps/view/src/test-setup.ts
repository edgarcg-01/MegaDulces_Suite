// jest-preset-angular 17: el entrypoint es `setup-env/zone` (el viejo
// `setup-jest` se retiró). Zone-based porque la app todavía usa Zone.js.
//
// ⚠️ El módulo EXPORTA `setupZoneTestEnv`, no lo ejecuta al importarse: con el
// `import 'jest-preset-angular/setup-env/zone'` a secas el entorno nunca se
// inicializaba y cualquier spec con TestBed moría en "Need to call
// TestBed.initTestEnvironment() first". Nadie lo vio porque hasta ahora ningún
// spec de esta app usaba TestBed (el único con esa forma son 3 `it.todo`).
import { setupZoneTestEnv } from 'jest-preset-angular/setup-env/zone';

setupZoneTestEnv();

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
class IntersectionObserverDePrueba implements IntersectionObserver {
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
      this,
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
