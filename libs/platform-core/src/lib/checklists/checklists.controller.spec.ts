import 'reflect-metadata';
import { Permission } from '../constants/permissions';
import { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { ChecklistsController } from './checklists.controller';

/**
 * `[MDT.2.5]` Quién entra a cada endpoint de tareas por puesto.
 *
 * ⚠️ Se prueba la metadata que lee `RolesGuard` (`@RequirePermissions` = todas, `@RequireAnyPermission`
 * = basta una), recorriendo TODOS los métodos: un endpoint nuevo sin llave, o con la de equipo donde
 * debería ir la de entregar, rompe esta prueba en vez de quedar abierto.
 */
type Metodo = keyof ChecklistsController;
const proto = ChecklistsController.prototype as unknown as Record<string, object>;
const metodos = Object.getOwnPropertyNames(ChecklistsController.prototype)
  .filter((m) => m !== 'constructor' && m !== 'puedeVerEquipo' && typeof proto[m] === 'function') as Metodo[];
const todas = (m: Metodo): string[] | undefined => Reflect.getMetadata(PERMISSIONS_KEY, proto[m]);
const alguna = (m: Metodo): string[] | undefined => Reflect.getMetadata(ANY_PERMISSIONS_KEY, proto[m]);

function entra(m: Metodo, llaves: Permission[]): boolean {
  const and = todas(m) ?? [];
  const any = alguna(m) ?? [];
  return and.every((k) => llaves.includes(k as Permission)) && (!any.length || any.some((k) => llaves.includes(k as Permission)));
}
const alcanza = (llaves: Permission[]) => metodos.filter((m) => entra(m, llaves)).sort();

describe('[MDT.2.5] ChecklistsController — llaves por endpoint', () => {
  it('ningún endpoint queda sin llave', () => {
    const sinLlave = metodos.filter((m) => !(todas(m)?.length) && !(alguna(m)?.length));
    expect(sinLlave).toEqual([]);
  });

  it('ENTREGAR abre mis tareas y escribir en MI entrega; no el equipo ni la norma', () => {
    expect(alcanza([Permission.TAREAS_PUESTO_ENTREGAR])).toEqual(
      ['abrir', 'detalle', 'entregar', 'guardarPunto', 'mias', 'retirar', 'subir'].sort());
  });

  it('EQUIPO_VER sólo lee: el equipo, una entrega y el manual — ninguna escritura', () => {
    expect(alcanza([Permission.TAREAS_PUESTO_EQUIPO_VER])).toEqual(['detalle', 'equipo', 'normas'].sort());
  });

  it('NORMA_GESTIONAR lee el manual y agrega versiones; no entrega por nadie', () => {
    expect(alcanza([Permission.TAREAS_PUESTO_NORMA_GESTIONAR])).toEqual(['normas', 'nuevaVersion'].sort());
  });

  it('prueba negativa: sin llaves de tareas no entra a nada', () => {
    expect(alcanza([Permission.DEFINICIONES_VER])).toEqual([]);
  });
});
