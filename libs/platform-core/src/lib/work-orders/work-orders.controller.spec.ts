import 'reflect-metadata';
import { Permission } from '../constants/permissions';
import { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';
import { WorkOrdersModule } from './work-orders.module';
import { ObjectStorageService } from '../storage/object-storage.service';

/**
 * `[MDT.2.3]` Quién entra a cada endpoint del vale de servicio. Se recorre TODO método: uno nuevo sin
 * llave, o con «levantar» donde va «coordinar», rompe esta prueba en vez de quedar abierto. Lo que cada
 * quien puede hacer sobre UN vale lo decide además el servicio con la fila (`motivoNoPuede`).
 */
type Metodo = keyof WorkOrdersController;
const proto = WorkOrdersController.prototype as unknown as Record<string, object>;
const metodos = Object.getOwnPropertyNames(WorkOrdersController.prototype)
  .filter((m) => m !== 'constructor' && m !== 'llaves' && typeof proto[m] === 'function') as Metodo[];
const todas = (m: Metodo): string[] | undefined => Reflect.getMetadata(PERMISSIONS_KEY, proto[m]);
const alguna = (m: Metodo): string[] | undefined => Reflect.getMetadata(ANY_PERMISSIONS_KEY, proto[m]);

function entra(m: Metodo, llaves: Permission[]): boolean {
  const and = todas(m) ?? [];
  const any = alguna(m) ?? [];
  return and.every((k) => llaves.includes(k as Permission)) && (!any.length || any.some((k) => llaves.includes(k as Permission)));
}
const alcanza = (llaves: Permission[]) => metodos.filter((m) => entra(m, llaves)).sort();

describe('[MDT.2.3] WorkOrdersController — llaves por endpoint', () => {
  it('ningún endpoint queda sin llave', () => {
    const sinLlave = metodos.filter((m) => !(todas(m)?.length) && !(alguna(m)?.length));
    expect(sinLlave).toEqual([]);
  });

  it('LEVANTAR: levantar, ver, capturar y cerrar lo suyo, firmar y cancelar (el servicio decide sobre la fila); no tomar, asignar ni reabrir', () => {
    expect(alcanza([Permission.VALE_SERVICIO_LEVANTAR])).toEqual(
      ['cancelar', 'completar', 'crear', 'detalle', 'firmar', 'guardar', 'lista', 'quitarFirma'].sort());
  });

  it('ATENDER suma tomar; no asignar ni reabrir', () => {
    const a = alcanza([Permission.VALE_SERVICIO_ATENDER]);
    expect(a).toContain('tomar');
    expect(a).not.toContain('asignar');
    expect(a).not.toContain('reabrir');
    expect(a).not.toContain('responsables');
  });

  it('GESTIONAR alcanza todo', () => {
    expect(alcanza([Permission.VALE_SERVICIO_GESTIONAR])).toEqual([...metodos].sort());
  });

  it('prueba negativa: sin llaves de vales no entra a nada', () => {
    expect(alcanza([Permission.TAREAS_PUESTO_ENTREGAR, Permission.SERVICIO_REPORTAR])).toEqual([]);
  });

  // Vitest no emite design:paramtypes: el grafo se lee de los decoradores del módulo (patrón de los *.arranque.spec).
  const meta = <T>(clave: string, objetivo: unknown): T[] => (Reflect.getMetadata(clave, objetivo as object) as T[] | undefined) ?? [];
  const alcanceDe = (modulo: unknown): unknown[] => {
    const out = [...meta<unknown>('providers', modulo)];
    for (const imp of meta<unknown>('imports', modulo)) for (const exp of meta<unknown>('exports', imp)) out.push(exp);
    return out;
  };

  it('arranque: el servicio toma tres dependencias y el bucket le llega por CloudinaryModule (las otras dos son globales)', () => {
    expect(WorkOrdersService.length).toBe(3);
    expect(WorkOrdersController.length).toBe(1);
    const alcance = alcanceDe(WorkOrdersModule);
    expect(alcance).toContain(WorkOrdersService);
    expect(alcance).toContain(ObjectStorageService);
  });

  it('PRUEBA NEGATIVA: sin el import de CloudinaryModule, el bucket queda fuera de alcance', () => {
    class SinBucket {}
    Reflect.defineMetadata('providers', [WorkOrdersService], SinBucket);
    Reflect.defineMetadata('imports', [], SinBucket);
    expect(alcanceDe(SinBucket)).not.toContain(ObjectStorageService);
  });
});
