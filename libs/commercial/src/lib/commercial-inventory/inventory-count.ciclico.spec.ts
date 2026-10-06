import { BadRequestException } from '@nestjs/common';
import { InventoryCountService } from './inventory-count.service';

/**
 * `[IC.13]` — **Un folio "cíclico" sin subconjunto es un folio TOTAL con otra etiqueta.**
 *
 * Nace de lo medido el 2026-10-06 leyendo `/almacen/inventory/sessions`: el diálogo ofrecía
 * «Cíclico (parcial)» y mandaba `POST /open` con `type:'cycle'` y sin `product_ids`. El
 * snapshot de `openCount` **no se ramifica por `type`** — sin subconjunto siembra el almacén
 * entero —, así que la palabra "parcial" no acotaba nada; y como el toggle «Congelar
 * movimientos» viene en `true`, ese supuesto conteo parcial **congelaba la sucursal**, que es
 * justo lo que `openCycleCount` evita a propósito (su default de freeze es `false`).
 *
 * El freno vive en el servicio y no en la pantalla porque la pantalla es un cliente entre
 * varios: así ningún otro puede volver a pedir lo imposible.
 *
 * ⚠️ **Qué NO afirma este archivo.** El `tk` es un doble: acá no se ejecuta una sola línea de
 * SQL, así que esto **no** prueba que el snapshot siembre bien, ni que el folio quede
 * consistente, ni nada que toque Postgres (ADR-044: eso se prueba por HTTP). Lo único que se
 * fija es **dónde decide el freno y qué decide**, que es exactamente donde estaba el defecto.
 */

/** Marca que sólo puede aparecer si la ejecución LLEGÓ a `tk.run`, o sea si el freno dejó pasar. */
const PASO_EL_FRENO = Symbol('paso-el-freno');

const WH = '11111111-2222-3333-4444-555555555555';
const SKU_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const SKU_B = 'aaaaaaaa-0000-0000-0000-000000000002';

function servicio() {
  const llamadasATkRun: number[] = [];
  const tk = {
    run: async () => {
      llamadasATkRun.push(Date.now());
      return PASO_EL_FRENO;
    },
  };
  const svc = new InventoryCountService(tk as any, {} as any, {} as any);
  return { svc, llamadasATkRun };
}

describe('conteo cíclico · el subconjunto no es opcional', () => {
  /**
   * Candado del propio arnés. Sin esto, un `openCount` que reventara por cualquier otro
   * motivo haría pasar por vacuidad todas las pruebas de "no frenó" de más abajo.
   */
  it('el doble se ejerce de verdad: un folio TOTAL llega hasta tk.run', async () => {
    const { svc, llamadasATkRun } = servicio();
    await expect(svc.openCount({ warehouse_id: WH, type: 'full' })).resolves.toBe(PASO_EL_FRENO);
    expect(llamadasATkRun).toHaveLength(1);
  });

  // ── El defecto, tal como llegaba desde la pantalla ─────────────────────────────────────
  it('cíclico SIN product_ids se rechaza ANTES de tocar la base', async () => {
    const { svc, llamadasATkRun } = servicio();
    await expect(svc.openCount({ warehouse_id: WH, type: 'cycle' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Lo importante no es sólo que falle: es que falle sin abrir folio ni sembrar nada.
    expect(llamadasATkRun).toHaveLength(0);
  });

  it('el mensaje nombra la salida, no sólo el error', async () => {
    const { svc } = servicio();
    await expect(svc.openCount({ warehouse_id: WH, type: 'cycle' })).rejects.toThrow(/open-cycle/);
    await expect(svc.openCount({ warehouse_id: WH, type: 'cycle' })).rejects.toThrow(/TOTAL/);
  });

  it('un array vacío es lo mismo que no mandar nada', async () => {
    const { svc, llamadasATkRun } = servicio();
    await expect(
      svc.openCount({ warehouse_id: WH, type: 'cycle', product_ids: [] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(llamadasATkRun).toHaveLength(0);
  });

  // ── PRUEBA NEGATIVA: el freno tiene que DEJAR PASAR lo legítimo ────────────────────────
  /**
   * Sin esta, el freno podría estar rechazando *todo* cíclico y las pruebas de arriba
   * seguirían verdes — y habría roto el camino que el scheduler nocturno usa todas las noches.
   */
  it('cíclico CON product_ids pasa: es el camino de openCycleCount y del scheduler', async () => {
    const { svc, llamadasATkRun } = servicio();
    await expect(
      svc.openCount({ warehouse_id: WH, type: 'cycle', product_ids: [SKU_A, SKU_B] }),
    ).resolves.toBe(PASO_EL_FRENO);
    expect(llamadasATkRun).toHaveLength(1);
  });

  it('openCycleCount con lista explícita sigue atravesando el freno', async () => {
    const { svc, llamadasATkRun } = servicio();
    await expect(
      svc.openCycleCount({ warehouse_id: WH, product_ids: [SKU_A] }),
    ).resolves.toBe(PASO_EL_FRENO);
    expect(llamadasATkRun).toHaveLength(1);
  });

  it('un folio TOTAL no necesita subconjunto (el freno es sólo para cycle)', async () => {
    const { svc } = servicio();
    await expect(svc.openCount({ warehouse_id: WH })).resolves.toBe(PASO_EL_FRENO);
    await expect(svc.openCount({ warehouse_id: WH, type: 'full' })).resolves.toBe(PASO_EL_FRENO);
  });

  it('el warehouse_id inválido sigue decidiéndose primero', async () => {
    const { svc, llamadasATkRun } = servicio();
    await expect(svc.openCount({ warehouse_id: 'no-soy-uuid', type: 'cycle' })).rejects.toThrow(
      /warehouse_id/,
    );
    expect(llamadasATkRun).toHaveLength(0);
  });
});

describe('conteo cíclico · el default de congelar', () => {
  /**
   * El cíclico existe para contar **sin parar la operación**. Si alguna vez su default de
   * freeze se volviera `true` «por simetría con el total», el conteo parcial volvería a
   * congelar la sucursal — el mismo daño del defecto de arriba, por otra puerta.
   */
  it('openCycleCount NO congela el almacén salvo que se lo pidan', async () => {
    const recibidos: any[] = [];
    const svc = new InventoryCountService({ run: async () => PASO_EL_FRENO } as any, {} as any, {} as any);
    const original = svc.openCount.bind(svc);
    svc.openCount = async (dto: any) => { recibidos.push(dto); return original(dto); };

    await svc.openCycleCount({ warehouse_id: WH, product_ids: [SKU_A] });
    expect(recibidos[0].freeze_movements).toBe(false);

    await svc.openCycleCount({ warehouse_id: WH, product_ids: [SKU_A], freeze_movements: true });
    expect(recibidos[1].freeze_movements).toBe(true);
  });

  it('y el tipo que manda a openCount es cycle, no full', async () => {
    const recibidos: any[] = [];
    const svc = new InventoryCountService({ run: async () => PASO_EL_FRENO } as any, {} as any, {} as any);
    const original = svc.openCount.bind(svc);
    svc.openCount = async (dto: any) => { recibidos.push(dto); return original(dto); };

    await svc.openCycleCount({ warehouse_id: WH, product_ids: [SKU_A] });
    expect(recibidos[0].type).toBe('cycle');
    expect(recibidos[0].product_ids).toEqual([SKU_A]);
  });
});
