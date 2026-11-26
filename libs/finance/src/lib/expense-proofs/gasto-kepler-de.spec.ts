import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ExpenseProofsService } from './expense-proofs.service';

/**
 * `[PGP.123]` G-AUD.16 (2026-11-23) — `GET proofs/:id/gasto-kepler`: el gasto (X-A-10) de UN vale, para su panel desde
 * cualquier pantalla. Antes sólo lo traía la cola «Esperan a Kepler» y el vale comprobado, abierto desde el buscador, no
 * decía su folio ni su póliza. Sólo lee: se prueba que valida el id, que sólo pide la cola para un vale validado y que
 * devuelve lo que la cola calcula para ESE vale.
 */
describe('[PGP.123] G-AUD.16 gastoKeplerDe', () => {
  const ID = '8122d544-213f-4cf6-aa70-35a20c179707';
  const ESCRITO = { comprobacion: { listo: true, fecha: '2026-11-23' }, escritura: { abierta: true, motivo: null, detalle: null },
    gasto: { id: ID, status: 'written', folio: '0000095', poliza: 'kdc22611/D/406', fecha: '2026-11-23', nota: null, intentos: 1, siguiente: null } };

  const armar = (status: string | null) => {
    const pedidos: string[][] = [];
    const svc = Object.create(ExpenseProofsService.prototype) as ExpenseProofsService;
    const trx = () => ({ where: () => ({ first: async () => (status ? { status } : undefined) }) });
    Object.assign(svc, {
      tk: { run: async <T>(fn: (t: unknown) => Promise<T>) => fn(trx) },
      comprobacionGasto: { enLaCola: async (ids: string[]) => { pedidos.push(ids); return new Map([[ID, ESCRITO]]); } },
    });
    return { svc, pedidos };
  };

  it('validado: devuelve el gasto que la cola calcula para ESE vale', async () => {
    const { svc, pedidos } = armar('validada');
    await expect(svc.gastoKeplerDe(ID.toUpperCase())).resolves.toEqual(ESCRITO);
    expect(pedidos).toEqual([[ID]]);
  });

  it('⛔ NEGATIVA: un vale no validado no pide la cola (null), uno que no existe es 404, un id raro es 400', async () => {
    const r = armar('recibida');
    await expect(r.svc.gastoKeplerDe(ID)).resolves.toBeNull();
    expect(r.pedidos).toEqual([]);
    await expect(armar(null).svc.gastoKeplerDe(ID)).rejects.toBeInstanceOf(NotFoundException);
    await expect(armar('validada').svc.gastoKeplerDe("1' OR '1'='1")).rejects.toBeInstanceOf(BadRequestException);
  });
});
