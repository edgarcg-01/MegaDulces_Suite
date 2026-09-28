import { readFileSync } from 'fs';
import { join } from 'path';
import { InventoryCountService } from './inventory-count.service';

/**
 * `[WMS-REC.16]` — **Cancelar un folio no es aplicarlo, y la diferencia se cuida acá.**
 *
 * Nace de un incidente medido en producción (2026-09-28): `INV-2026-00009` llevaba 100 días
 * congelando Padre Hidalgo con 3 artículos contados de 2,094, y 10 capturas de caducidad se
 * guardaron y se revirtieron contra ese almacén. Nadie lo destrabó porque abandonar el conteo
 * exigía la misma llave que aplicarlo.
 *
 * Dos cosas se fijan acá, y las dos tienen que poder romperse:
 *  1. la **puerta** — `cancel` acepta las dos llaves, `reconcile` sigue exigiendo una sola;
 *  2. la **regla** que vuelve segura la llave acotada — sólo se abandona lo que nadie toca.
 */
const FUENTE_CONTROLLER = readFileSync(join(__dirname, 'inventory-count.controller.ts'), 'utf8');

/**
 * El bloque de UNA ruta: desde su decorador de método hasta el de la siguiente.
 *
 * Se corta en el próximo decorador de ruta y NO por una longitud fija: un corte por
 * caracteres se come el decorador del vecino y pone el candado en rojo con el código
 * intacto (ya pasó en `bin-location.permisos.spec.ts`). Un candado que falla por su
 * propia ventana enseña a ignorarlo.
 */
function gateDe(metodo: string, ruta: string): string {
  const i = FUENTE_CONTROLLER.indexOf(`@${metodo}('${ruta}')`);
  if (i < 0) throw new Error(`No existe la ruta @${metodo}('${ruta}')`);
  const resto = FUENTE_CONTROLLER.slice(i + 1);
  const siguiente = resto.search(/@(Get|Post|Delete|Put|Patch)\(/);
  return siguiente < 0 ? FUENTE_CONTROLLER.slice(i) : FUENTE_CONTROLLER.slice(i, i + 1 + siguiente);
}

describe('conteo · abandonar no es aplicar', () => {
  // Candado del propio extractor: si devolviera vacío, TODOS los `toContain` de abajo
  // pasarían por vacuidad y este archivo se pondría verde sin mirar nada.
  it('el extractor devuelve el bloque de la ruta, no una cadena vacía', () => {
    const g = gateDe('Post', ':id/cancel');
    expect(g.length).toBeGreaterThan(40);
    expect(g).toContain('cancel');
  });

  it('cancelar acepta la llave acotada Y la de reconciliar (nadie pierde lo que tenía)', () => {
    const g = gateDe('Post', ':id/cancel');
    expect(g).toContain('RequireAnyPermission');
    expect(g).toContain('COMMERCIAL_INVENTORY_RECONCILIAR');
    expect(g).toContain('COMMERCIAL_INVENTORY_CANCELAR_CONTEO');
  });

  /**
   * El lado peligroso. Reconciliar ajusta el saldo al físico contado: con el folio del
   * incidente (3 de 2,094) habría puesto la sucursal casi en cero. Separar las llaves
   * pierde todo el sentido si esta puerta se abre "por simetría".
   */
  it('reconciliar NO se abre: sigue exigiendo RECONCILIAR a secas', () => {
    const g = gateDe('Post', ':id/reconcile');
    expect(g).toContain('RequirePermissions');
    expect(g).not.toContain('RequireAnyPermission');
    expect(g).not.toContain('COMMERCIAL_INVENTORY_CANCELAR_CONTEO');
  });

  it('la restricción se decide por el permiso de quien llama, no por el cuerpo del request', () => {
    const g = gateDe('Post', ':id/cancel');
    expect(g).toContain('soloSiEstaAbandonado');
    expect(g).toContain('COMMERCIAL_INVENTORY_RECONCILIAR');
    // El god-mode no puede quedar acotado por no tener la clave en su JSONB.
    expect(g).toContain('isPlatformAdminRole');
  });
});

describe('conteo · qué cuenta como abandonado', () => {
  const DIA = 86400000;
  const ahora = Date.parse('2026-09-28T12:00:00Z');

  it('el folio del incidente (67 días sin escaneos) está abandonado', () => {
    expect(InventoryCountService.estaAbandonado('2026-07-22T22:40:25.558Z', ahora)).toBe(true);
  });

  it('un conteo que se tocó ayer NO se puede abandonar', () => {
    expect(InventoryCountService.estaAbandonado(new Date(ahora - 1 * DIA), ahora)).toBe(false);
  });

  it('justo en el umbral cuenta como abandonado, un minuto antes no', () => {
    const umbral = InventoryCountService.DIAS_ABANDONADO * DIA;
    expect(InventoryCountService.estaAbandonado(new Date(ahora - umbral), ahora)).toBe(true);
    expect(InventoryCountService.estaAbandonado(new Date(ahora - umbral + 60000), ahora)).toBe(false);
  });

  /**
   * Ante la duda NO se deja cancelar. Es el lado seguro: quien reconcilia siempre puede,
   * así que una fecha ausente sólo cuesta pedirle a otro — nunca tirar un conteo vivo.
   */
  it('sin fecha o con fecha ilegible responde que NO está abandonado', () => {
    expect(InventoryCountService.estaAbandonado(null, ahora)).toBe(false);
    expect(InventoryCountService.estaAbandonado(undefined, ahora)).toBe(false);
    expect(InventoryCountService.estaAbandonado('no soy una fecha', ahora)).toBe(false);
  });

  it('el umbral es de días, no de horas: un conteo de esta mañana no se toca', () => {
    expect(InventoryCountService.estaAbandonado(new Date(ahora - 3 * 3600000), ahora)).toBe(false);
  });
});
