/**
 * `reflect-metadata` tiene que estar cargado ANTES de que se evalue cualquier clase decorada:
 * los decoradores de NestJS escriben en el registro de metadata al momento de definirse la
 * clase, no al instanciarla. Si se carga despues, las clases quedan sin `design:paramtypes` y
 * la inyeccion falla con un mensaje que culpa al modulo equivocado.
 *
 * En produccion esto lo arrastra `@nestjs/core` desde `main.ts`; en pruebas no hay `main.ts`.
 */
import 'reflect-metadata';
