// Entorno de pruebas de Angular sobre Vitest (@analogjs/vitest-angular).
//
// Este archivo NO existia: bajo jest, el config de vendor no declaraba ningun
// setupFilesAfterEnv, asi que el TestBed nunca quedaba inicializado. No se notaba porque el
// unico spec de esta app (core/order/qty-units.spec.ts) es logica pura y no lo usa -- o sea que
// el primer spec de COMPONENTE que alguien escribiera habria muerto en
// "Need to call TestBed.initTestEnvironment() first", sin relacion aparente con su cambio.
//
// ⚠️ zoneless: false para igualar a apps/view. Ver el comentario de apps/view/src/test-setup.ts.
import '@analogjs/vitest-angular/setup-zone';
import { setupTestBed } from '@analogjs/vitest-angular/setup-testbed';

setupTestBed({ zoneless: false });
