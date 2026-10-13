// Sin `import ... from 'vitest'`: la config usa `globals: true`.
import { CashLedgerService } from './cash-ledger.service';

/**
 * ⭐⭐ `[CG.124]` — **que el freno esté CABLEADO, no sólo escrito.**
 *
 * El candado del motor (`caja-conciliacion.engine.spec.ts`) prueba la decisión. Medido: con la
 * llamada del servicio apagada a propósito, **esos 9 tests siguen en verde** — o sea que no
 * protegen el cableado. Un motor que nadie llama es una intención.
 *
 * ── Por qué un doble SÍ vale acá, y normalmente no ──────────────────────────────────────────
 *
 * La regla del proyecto es que un doble de Knex no valida SQL, y es cierta. Pero esto **no mide
 * SQL**: mide que el movimiento se rechace **antes de tocar la base**. El `trx` que se pasa
 * EXPLOTA si alguien lo usa, así que la prueba sólo puede pasar si el freno disparó primero.
 *
 * Eso además fija el ORDEN, que es parte del arreglo: validar después de resolver el documento
 * habría hecho una consulta para nada, y —peor— habría dejado el camino abierto a que un cambio
 * futuro guardara la fila antes de mirar.
 */
describe('[CG.124] el freno de conciliación está cableado en create()', () => {
  /** Un `trx` que no se puede tocar: cualquier acceso revienta con un mensaje reconocible. */
  const trxProhibido = new Proxy(function () { /* no-op */ } as never, {
    get: (_t, prop) => { throw new Error(`LA BASE SE TOCÓ: .${String(prop)}`); },
    apply: () => { throw new Error('LA BASE SE TOCÓ: trx(...)'); },
  });

  const montar = () => new CashLedgerService(
    { run: (cb: (trx: unknown) => unknown) => cb(trxProhibido) } as never,
    { requireTenantId: () => '00000000-0000-0000-0000-00000000d01c' } as never,
  );

  const usuario = { id: 'u-1', username: 'carmen_rodriguez' };

  it('⛔ glosa con documento y SIN enlace: rechaza sin consultar la base', async () => {
    // El caso real de `CG-2026-00028`, que se guardó y dejó su documento en la bandeja.
    await expect(montar().create({
      tipo: 'gasto', fecha: '2026-10-13', monto: 10490,
      glosa: 'X-D-26 0023047 · GASTOS GENERALES OFICINAS',
    } as never, usuario)).rejects.toThrow(/X-D-26 0023047/);
  });

  it('⛔ sin documento y sin motivo: rechaza sin consultar la base', async () => {
    await expect(montar().create({
      tipo: 'ingreso', fecha: '2026-10-13', monto: 29340, glosa: 'VENTA 08/10',
    } as never, usuario)).rejects.toThrow(/se concilia contra un documento/);
  });

  /**
   * ⭐ La prueba que impide que este archivo se vuelva un adorno. Si el freno dejara de existir,
   * el flujo seguiría y **tocaría la base** — y acá eso explota con un mensaje distinto. Sin
   * esto, borrar la llamada haría que los dos tests de arriba fallaran por el motivo equivocado
   * y alguien los "arreglaría" aflojando el `toThrow`.
   */
  it('⭐ [negativa] un movimiento BIEN conciliado SÍ llega a la base (y por eso explota acá)', async () => {
    await expect(montar().create({
      tipo: 'gasto', fecha: '2026-10-13', monto: 1250,
      origen_tipo: 'pago_proveedor', origen_ref: '00|X-D-26|0023047|0011',
      glosa: 'X-D-26 0023047 · GASTOS GENERALES OFICINAS',
    } as never, usuario)).rejects.toThrow(/LA BASE SE TOCÓ/);
  });

  it('⭐ [negativa] con motivo declarado también pasa el freno y llega a la base', async () => {
    await expect(montar().create({
      tipo: 'ingreso', fecha: '2026-10-13', monto: 29340, glosa: 'VENTA 08/10',
      sin_documento_motivo: 'Ruta 501 del 08-oct: Kepler no tiene el cobro',
    } as never, usuario)).rejects.toThrow(/LA BASE SE TOCÓ/);
  });

  it('⛔ sin usuario no se guarda nada, ni siquiera bien conciliado', async () => {
    await expect(montar().create({
      tipo: 'gasto', fecha: '2026-10-13', monto: 1250,
      origen_tipo: 'pago_proveedor', origen_ref: '00|X-D-26|0023047|0011',
    } as never, {})).rejects.toThrow(/identificar al usuario/);
  });
});
