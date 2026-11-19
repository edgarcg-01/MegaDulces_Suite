import { BadRequestException } from '@nestjs/common';
import { FinanceBankController } from './finance-bank.controller';
import { LIBRO_RETIRADO } from './libro-retirado';

/** `[BFU.5.1]` El libro CUENTAS ya no entra por pantalla ni por Sheets: el servidor lo niega y dice adónde ir. */
describe('[BFU.5.1] el libro CUENTAS ya no se carga', () => {
  // Un controlador sin dependencias: si llegara a tocar el servicio o el job, la prueba revienta distinto.
  const ctl = Object.create(FinanceBankController.prototype) as FinanceBankController;
  const res = {} as never, req = {} as never;

  it('subir el libro se niega con el mensaje que manda a Estados de cuenta', () => {
    expect(() => ctl.import({ file_base64: 'AAAA', period: '2026-11' }, 'true', req, res)).toThrow(BadRequestException);
    expect(() => ctl.import({ file_base64: 'AAAA', period: '2026-11' }, 'true', req, res)).toThrow(LIBRO_RETIRADO);
  });

  it('sincronizar desde Google Sheets también', () => {
    expect(() => ctl.sheetSyncRun({ sync: true }, 'true', req, res)).toThrow(LIBRO_RETIRADO);
  });

  it('el mensaje dice adónde ir', () => {
    expect(LIBRO_RETIRADO).toContain('Estados de cuenta');
  });
});
