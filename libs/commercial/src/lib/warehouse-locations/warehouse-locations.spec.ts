import { readFileSync } from 'fs';
import { join } from 'path';
import type { WarehouseLocationRow } from '@megadulces/contracts';
import { resumir } from './warehouse-locations.service';

/**
 * `[UB.1]` Candados del catálogo de ubicaciones.
 *
 * 1. **Gates**: leer = `ALMACEN_UBICACIONES_VER`; dar de alta = `_GESTIONAR`. Prueba negativa: el
 *    alta NO puede quedar abierta a VER ni a ACOMODAR (acomodar es piso, no catálogo), y ninguna
 *    ruta puede volver a colgarse de `COMMERCIAL_INVENTORY_ASIGNAR`, que es la clave que arma los
 *    equipos de conteo (FASE_UB §4.1).
 * 2. **Resumen**: cuenta lo que hay, sin inventar — una bloqueada no es activa ni baja.
 */
const FUENTE = readFileSync(join(__dirname, 'warehouse-locations.controller.ts'), 'utf8');

function gateDe(metodo: 'Get' | 'Post', ruta = ''): string {
  const marca = ruta ? `@${metodo}('${ruta}')` : `@${metodo}()`;
  const i = FUENTE.indexOf(marca);
  if (i < 0) throw new Error(`No existe la ruta ${marca}`);
  const resto = FUENTE.slice(i + 1);
  const siguiente = resto.search(/@(Get|Post|Delete|Put|Patch)\(/);
  return siguiente < 0 ? FUENTE.slice(i) : FUENTE.slice(i, i + 1 + siguiente);
}

describe('[UB.1] ubicaciones · permisos', () => {
  it('leer el catálogo lo puede quien tenga cualquiera de las tres (gestionar o acomodar incluye ver)', () => {
    const g = gateDe('Get');
    for (const k of ['VER', 'ACOMODAR', 'GESTIONAR']) expect(g).toContain(`Permission.ALMACEN_UBICACIONES_${k}`);
  });

  it('dar de alta pide GESTIONAR, y sólo GESTIONAR', () => {
    const g = gateDe('Post');
    expect(g).toContain('@RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)');
    expect(g).not.toContain('RequireAnyPermission');
    expect(g).not.toContain('ALMACEN_UBICACIONES_VER');
    expect(g).not.toContain('ALMACEN_UBICACIONES_ACOMODAR');
  });

  it.each([
    ['Post', 'bulk/preview'],
    ['Post', 'bulk'],
    ['Get', 'batches'],
    ['Post', 'batches/:id/undo'],
  ] as const)('[UB.2] %s %s pide GESTIONAR, y sólo GESTIONAR', (m, ruta) => {
    const g = gateDe(m, ruta);
    expect(g).toContain('@RequirePermissions(Permission.ALMACEN_UBICACIONES_GESTIONAR)');
    expect(g).not.toContain('RequireAnyPermission');
  });

  it('ninguna ruta se cuelga de la clave de equipos de conteo', () => {
    expect(FUENTE).not.toContain('COMMERCIAL_INVENTORY_ASIGNAR');
  });
});

const fila = (p: Partial<WarehouseLocationRow>): WarehouseLocationRow => ({
  id: 'x', warehouse_id: 'w', warehouse_code: '01', code: 'BA053', label: null, familia: 'ubicacion',
  zona: 'B', pasillo: 'A', rack: 5, nivel: 3, tipo: null, estado: 'activa', motivo_estado: null,
  pick_sequence: 1, renglones_con_cantidad: 0, updated_at: '2026-10-08T00:00:00.000Z', ...p,
});

describe('[UB.1] ubicaciones · resumen', () => {
  it('cuenta estados, familias y contenido por separado', () => {
    const s = resumir([
      fila({}),
      fila({ estado: 'bloqueada', motivo_estado: 'rack dañado', renglones_con_cantidad: 2 }),
      fila({ estado: 'baja', motivo_estado: 'retirado' }),
      fila({ familia: 'legado', code: '40174', zona: null, pasillo: null, rack: null, nivel: null, renglones_con_cantidad: 1 }),
    ]);
    expect(s).toEqual({ total: 4, activas: 2, bloqueadas: 1, bajas: 1, con_formato: 3, legado: 1, con_contenido: 2 });
  });

  it('vacío es cero, no undefined', () => {
    expect(resumir([])).toEqual({ total: 0, activas: 0, bloqueadas: 0, bajas: 0, con_formato: 0, legado: 0, con_contenido: 0 });
  });
});
