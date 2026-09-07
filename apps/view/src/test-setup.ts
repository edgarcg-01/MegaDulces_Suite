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
