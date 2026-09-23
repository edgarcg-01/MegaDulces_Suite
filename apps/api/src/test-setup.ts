/**
 * `reflect-metadata` tiene que estar cargado ANTES de que se evalue cualquier clase decorada:
 * los decoradores de NestJS escriben en el registro de metadata al momento de definirse la
 * clase, no al instanciarla. Si se carga despues, las clases quedan sin `design:paramtypes` y
 * la inyeccion falla con un mensaje que culpa al modulo equivocado.
 *
 * En produccion esto lo arrastra `@nestjs/core` desde `main.ts`; en pruebas no hay `main.ts`.
 */
import 'reflect-metadata';

/**
 * `[AUTHZ-HARD.0]` Secreto de firma para las pruebas.
 *
 * ── Por qué acá y no en el YAML del CI ────────────────────────────────────────────────────
 * `libs/platform-core` resuelve el secreto **al evaluarse el módulo**, no al instanciar nada
 * (`tenant.module.ts` llama a `requireJwtSecret()` en el cuerpo del archivo, y el barril
 * `index.ts` lo arrastra). O sea que cualquier spec que importe `@megadulces/platform-core`
 * —directo o de rebote— explota al IMPORTAR, antes de correr una sola aserción: 4 suites de
 * `api` caían con "Failed Suites 4 · no tests", un mensaje que parece de configuración de
 * Nest y es de entorno.
 *
 * Ponerlo en el `env:` del step de CI también lo arreglaría **allá**, y dejaría el rojo intacto
 * en la máquina de cada quien — que es donde hoy vive la compuerta. Un test que sólo pasa en un
 * entorno no prueba el código, prueba el entorno. Acá es hermético: mismo resultado en las dos.
 *
 * ⚠️ NO es el default público del repo a propósito (`super_secret_dev_key_change_in_prod`): ése
 * sigue siendo el agujero que `requireJwtSecret` existe para cerrar, y tolerarlo acá lo
 * normaliza. Éste no firma nada que salga del proceso de pruebas.
 *
 * Sólo se pone si NO venía definido: un dev con su secreto real en el entorno lo conserva.
 */
process.env['JWT_SECRET'] ||= 'test-only-jwt-secret-no-vale-fuera-de-vitest-32b+';
