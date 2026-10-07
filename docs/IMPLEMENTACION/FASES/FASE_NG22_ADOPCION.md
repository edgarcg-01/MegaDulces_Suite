# FASE NG22 — Adopción de features Angular 22 + PrimeNG 22

> **Contexto:** el upgrade de versiones (Angular 18→22, PrimeNG 18→22, Nx 20→23, NgRx→22, TS 6) ya está **hecho y compilando verde** en el branch `worktree-upgrade-ng22-primeng22`. Los schematics de migración corrieron y se **verificaron por grep** (no por fe): OnPush→Eager en 26 componentes, HTTP `withXhr()`, sin APIs removidas en uso.
>
> Esta fase NO es el upgrade. Es **qué features nuevas de la versión conviene adoptar ahora**, priorizadas por ROI real medido contra el código actual.
>
> **Regla de oro:** nada de esto es urgente. El upgrade ya te dejó en la última versión. Esto es mejora incremental — adoptar en lo próximo que se toque, **no reescribir lo que funciona**.

---

## Estado del upgrade base (prerequisito de todo lo demás)

| Item | Estado |
|---|---|
| Angular 22.0.8 / Nx 23.1.0 / PrimeNG 22.0.0 / @primeuix/themes 3 / NgRx 22.0.0-beta.0 / TS 6.0.3 | ✅ build verde 3 apps |
| Schematics v22 (OnPush→Eager, HTTP withXhr, strictTemplates) | ✅ verificados |
| QA visual light + **dark** en browser | ⬜ **TU tarea** (dev servers son tuyos) |
| Merge a `main` | ⬜ tras QA + OK explícito |

**Caveats abiertos:** NgRx en `22.0.0-beta.0` (única dep no-estable) · PrimeNG 22 trae `@primeui/license-manager` (solo aplica si usás componentes premium).

---

## Superficie de adopción medida (worktree, apps/view)

| Métrica | Valor | Feature que la ataca |
|---|---|---|
| `.subscribe(` (fetch manual + signal) | **701** en 147 archivos | Resource API |
| Servicios `@Injectable` | **74** | `injectAsync` + `@Service` (solo pesados) |
| Archivos con Reactive Forms | **15** (30 usos) | Signal Forms (diferido) |
| Uso actual de Resource API | **0** | greenfield |
| Componentes CD | 146 OnPush + 26 Eager | migración a OnPush+signals |

---

## Sprints

### NG22.0 — Cierre del upgrade ⬜ (bloquea todo)
- QA visual (light + dark) de las pantallas calientes: botones `<p-button>` convertidos (61), autocomplete sin `styleClass`, theming `@primeuix/themes@3`.
- `run-all-tests.js` con el API arriba.
- Merge del branch a `main`.
- **Gate:** sin esto, todo lo demás vive en un branch sin mergear.

### NG22.1 — Router params explícito ⬜ (safety, chico)
- v22 cambió `paramsInheritanceStrategy` default `emptyOnly`→`always` (rutas hijas heredan params del padre).
- **Acción:** setear explícito en `provideRouter(routes, withRouterConfig({ paramsInheritanceStrategy: 'emptyOnly' }))` para preservar el comportamiento de 18, O auditar que ninguna ruta hija lea un `paramMap` que ahora reciba un valor heredado inesperado.
- **Esfuerzo:** 1 línea + revisión. **Prioridad: alta** (es correctness, no feature).

### NG22.2 — Resource API en pantallas nuevas 🟢 (mayor ROI)
- `httpResource` / `rxResource` reemplazan el patrón `svc.get().subscribe()` + `signal.set()` + manejo manual de loading/error (el patrón dominante hoy — ej. `product-search.component.ts:68-77`, y 700 más).
- Ventaja real: `isLoading`/error/**cancelación de race conditions** automática (mata el switchMap manual).
- **Regla:** NO migrar los 701 de golpe. Adoptar en:
  1. Toda pantalla **nueva** desde ya (default del equipo).
  2. Pantallas que se toquen por otro motivo (oportunista).
  3. Piloto: migrar 1 pantalla read-heavy existente (candidata: `comercial-products` o `compras-existencia-critica`) como referencia/patrón documentado.
- **Esfuerzo:** por pantalla. **No es un big-bang.**

### NG22.3 — `injectAsync` + `@Service()` para servicios pesados ⬜
- Lazy-load de servicios que arrastran bundle grande y no se usan al inicio. Candidatos reales:
  - Servicios de IA: `maat.service`, `supervisor-ai.service`, `commercial-intelligence.service`, `ai-product-matcher.service`, `thot-*`.
  - `commercial-map.service` / `map-live-layer.service` (Mapbox/Leaflet).
- Patrón: `someSvc = injectAsync(() => import('./heavy.service').then(m => m.HeavySvc))` + el servicio con `@Service()` o `providedIn:'root'`.
- **Cuidado:** medir bundle antes/después; no aplicar a servicios chicos (overhead sin ganancia).
- **Esfuerzo:** medio, por servicio. **Prioridad: media** (ganancia = tiempo de carga inicial).

### NG22.4 — WebMCP spike (agentes IA) ⬜
- `provideExperimentalWebMcpTools` expone "tools" del frontend a un agente IA en el browser (name/description/inputSchema/execute).
- Encaje natural con Maat/Thot/Horus: el usuario le pide al chat "muéstrame los hallazgos críticos de este mes" y el agente **navega/filtra tu UI** vía tool.
- **Spike, NO producción:** API experimental, cambia incluso fuera de majors. Objetivo = 1 prueba de concepto (ej. una tool `abrir_hallazgo(id)` en `/finanzas/hallazgos`) para evaluar madurez.
- **Esfuerzo:** spike acotado (1-2 días). **Prioridad: baja/exploratoria.**

### NG22.5 — OnPush everywhere ⬜
- Los 26 componentes en `Eager` (que el schematic marcó para preservar comportamiento) son los viejos/dashboard sin disciplina de signals.
- Migrarlos a `OnPush` + estado en signals → menos ciclos de CD.
- **Cuidado:** requiere QA por componente (los pusieron en Eager justamente porque mutan estado sin trigger). No es mecánico.
- **Esfuerzo:** alto (26 componentes con QA). **Prioridad: baja** (perf marginal; hacerlo oportunista al tocar cada uno).

### NG22.6 — Signal Forms ⬜ DIFERIDO
- Graduó a API pública en v22 pero **sigue madurando**; el texto que decía "production-ready" exageró.
- Superficie chica: solo 15 archivos con Reactive Forms.
- **Gate:** esperar 1-2 minors a que estabilice. Cuando se adopte, `provideExperimentalWebMcpForms` genera tools WebMCP gratis desde los form models (sinergia con NG22.4).

### NG22.7 — Zoneless ⬜ DIFERIDO
- Seguís con `zone.js` 0.16.2. Zoneless es opt-in y exige auditar que ninguna lib dependa de Zone.
- **Gate:** verificar primero que PrimeNG 22 y Chart.js funcionen zoneless. Proyecto aparte, alto riesgo, ganancia real pero no ahora.

### NG22.8 — NgRx a estable ⬜
- Hoy en `22.0.0-beta.0` (forzado para llegar a latest). Cuando salga `22.x` estable → bump directo.
- **Esfuerzo:** trivial (bump de versión + build). **Prioridad: hacer cuando exista el estable.**

### NG22.9 — Limpieza post-upgrade ⬜
- Quitar los `SharedModule` de 'primeng/api' agregados en 7 archivos durante el debug de NG3004 (fueron misdiagnosis, hoy inertes).
- Resolver los 5 warnings NG8113 (imports Spartan `hlm*` sin usar en captures + `MetricStrip` en bancos).
- **Esfuerzo:** chico. **Prioridad: baja** (cosmético, no rompe).

---

## Orden recomendado

```
NG22.0 (merge)  ──►  NG22.1 (router, safety)  ──►  NG22.2 (Resource API, default nuevo)
                                                         │
                                    ┌────────────────────┼────────────────────┐
                                 NG22.3 (injectAsync)  NG22.9 (cleanup)   NG22.4 (WebMCP spike)
                                                         │
                                              [diferidos con gate]
                                        NG22.5 · NG22.6 · NG22.7 · NG22.8
```

**Lo único con prioridad real inmediata:** NG22.0 (merge tras QA) + NG22.1 (router, es correctness). El resto es adopción incremental sin fecha.

---

## Decisiones abiertas
1. **NG22.1:** ¿preservamos `emptyOnly` (comportamiento 18) o adoptamos el nuevo `always`? (recomiendo preservar hasta auditar).
2. **NG22.2:** ¿arrancamos el piloto de Resource API o solo lo hacemos default para pantallas nuevas?
3. **NgRx beta:** ¿te quedás en `22.0.0-beta.0` o preferís bajar a Angular 21 / NgRx 21 estable hasta que NgRx 22 sea estable? (el upgrade soporta ambos).

---

_Fuentes: [RFC OnPush #66779](https://github.com/angular/angular/discussions/66779) · [Angular v22.0.0](https://github.com/angular/angular/releases/tag/v22.0.0) · [injectAsync](https://angular.dev/api/core/injectAsync) · [WebMCP](https://angular.dev/ai/webmcp)_
