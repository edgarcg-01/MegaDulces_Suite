import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { InventoryCountService } from './inventory-count.service';

/**
 * ⛔⛔ `[ICR.M7]` — **El umbral de tolerancia se DECIDE al abrir el folio; no nace en cero.**
 *
 * ## El defecto (F36 / E1 del anexo del trimestral, medido el 2026-11-27)
 *
 * `recount_threshold_pct` es `notNullable().defaultTo(0)` (migración `20260618190000`) y los dos
 * guards que lo leen son `if (umbral > 0)`. Medido en pg-prod, sólo lectura: **los 8 folios de
 * toda la historia del módulo tienen `0.00`** — y el diálogo que los abría manda
 * `formThreshold = signal(0)`, o sea que el cero nunca fue una decisión, fue el default de un
 * formulario. Con cero:
 *
 *   1. no corre el **count-back** (dos conteos coincidentes pero lejísimos del teórico se
 *      auto-resuelven), y
 *   2. no se exige **motivo**: un folio puede cerrarse con una merma enorme **sin que nadie
 *      escriba por qué**.
 *
 * ## Lo que este archivo fija — y lo que NO
 *
 * Fija que **falta decidirlo es un rechazo**, que el rechazo **nombra lo que se apaga**, y que
 * un cero **declarado** sí pasa. ⛔ **No fija ningún número de tolerancia**: ése es del negocio
 * y lo firma Edgar. Que la pantalla pregunte bien es de otro carril (frontend) y acá queda
 * **NO MEDIDO**.
 *
 * ⚠️ Sin `import` de `vitest`: el runner del monorepo inyecta los globales.
 */

/** Marca que sólo aparece si la ejecución LLEGÓ a `tk.run`, o sea si el freno dejó pasar. */
const PASO = Symbol('paso-el-freno');
const WH = '11111111-2222-3333-4444-555555555555';
const SKU = 'aaaaaaaa-0000-0000-0000-000000000001';

function servicio() {
  const corridas: number[] = [];
  const tk = {
    run: async () => {
      corridas.push(1);
      return PASO;
    },
  };
  return { svc: new InventoryCountService(tk as any, {} as any, {} as any), corridas };
}

describe('[ICR.M7] abrir un folio exige decidir el umbral', () => {
  /**
   * CONTROL del arnés: con el umbral puesto, abrir llega hasta la base. Sin esto, un `openCount`
   * que reventara por cualquier otro motivo haría pasar por vacuidad todos los rechazos.
   */
  it('CONTROL — con un umbral explícito el folio se abre (llega a tk.run)', async () => {
    const { svc, corridas } = servicio();
    await expect(
      svc.openCount({ warehouse_id: WH, type: 'full', recount_threshold_pct: 2 }),
    ).resolves.toBe(PASO);
    expect(corridas).toHaveLength(1);
  });

  it('⛔ sin el campo NO se abre folio, y no se toca la base', async () => {
    const { svc, corridas } = servicio();
    await expect(svc.openCount({ warehouse_id: WH, type: 'full' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(corridas, 'el folio se creó igual: un folio abierto ya no se puede re-decidir').toHaveLength(0);
  });

  it('el rechazo NOMBRA las dos protecciones que se apagan, no sólo el campo que falta', async () => {
    const { svc } = servicio();
    const p = svc.openCount({ warehouse_id: WH, type: 'full' });
    await expect(p).rejects.toThrow(/recount_threshold_pct/);
    await expect(p).rejects.toThrow(/revisión/); // el count-back
    await expect(p).rejects.toThrow(/motivo/); // la exigencia de motivo
  });

  it('⛔ el CERO sin declarar se rechaza: es el default del formulario, no una decisión', async () => {
    const { svc, corridas } = servicio();
    await expect(
      svc.openCount({ warehouse_id: WH, type: 'full', recount_threshold_pct: 0 }),
    ).rejects.toThrow(/recount_threshold_ack/);
    expect(corridas).toHaveLength(0);
  });

  /**
   * PRUEBA NEGATIVA: sin esto el freno podría estar rechazando **todo** cero y las pruebas de
   * arriba seguirían verdes — y habría dejado sin salida a quien de verdad quiere contar sin
   * red (y al scheduler del cíclico, que no tiene a quién preguntarle).
   */
  it('PRUEBA NEGATIVA — un cero DECLARADO sí abre folio', async () => {
    const { svc, corridas } = servicio();
    await expect(
      svc.openCount({
        warehouse_id: WH,
        type: 'full',
        recount_threshold_pct: 0,
        recount_threshold_ack: true,
      }),
    ).resolves.toBe(PASO);
    expect(corridas).toHaveLength(1);
  });

  it('un valor que no es número ya no se vuelve 0 en silencio (era `Number(x) || 0`)', async () => {
    const { svc, corridas } = servicio();
    for (const basura of ['dos', NaN, -1, 101]) {
      await expect(
        svc.openCount({ warehouse_id: WH, type: 'full', recount_threshold_pct: basura as any }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(corridas).toHaveLength(0);
  });

  it('el folio cíclico tampoco nace sin red, y el ack viaja hasta openCount', async () => {
    const { svc } = servicio();
    await expect(
      svc.openCycleCount({ warehouse_id: WH, product_ids: [SKU] }),
    ).rejects.toThrow(/recount_threshold_pct/);

    const recibidos: any[] = [];
    const original = svc.openCount.bind(svc);
    svc.openCount = async (dto: any) => {
      recibidos.push(dto);
      return original(dto);
    };
    await expect(
      svc.openCycleCount({
        warehouse_id: WH,
        product_ids: [SKU],
        recount_threshold_pct: 0,
        recount_threshold_ack: true,
      }),
    ).resolves.toBe(PASO);
    expect(recibidos[0].recount_threshold_ack).toBe(true);
  });

  it('lo decidido vuelve en la respuesta: un folio no debería «enterarse después»', () => {
    // Se lee del fuente porque la respuesta sólo existe del otro lado de `tk.run`, que acá es
    // un doble. Es una afirmación más débil y se declara como tal.
    const src = readFileSync(join(__dirname, 'inventory-count.service.ts'), 'utf8');
    expect(src).toContain('recount_threshold_pct: recountThreshold,');
    expect(src).toContain('recount_threshold_off: recountThreshold === 0,');
  });

  it('⭐ el scheduler del cíclico declara su cero en vez de caerse (deuda con nombre)', () => {
    const src = readFileSync(join(__dirname, 'cycle-count-scheduler.service.ts'), 'utf8');
    expect(src).toContain('recount_threshold_pct: 0,');
    expect(src).toContain('recount_threshold_ack: true,');
  });
});
