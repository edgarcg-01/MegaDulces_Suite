import { Module } from '@nestjs/common';
import { FinanceExpenseProofsModule } from '../expense-proofs/finance-expense-proofs.module';
import { ExpedienteGastoService } from './expediente-gasto.service';
import { ExpedienteGastoDocumentService } from './expediente-gasto-document.service';
import { ExpedienteGastoController } from './expediente-gasto.controller';

/**
 * `[GX.15]` — El expediente del gasto (los cuatro eslabones + su PDF).
 *
 * Importa `FinanceExpenseProofsModule` **sólo** por `alcanceDelUsuario()`: el recorte por
 * áreas decide quién puede abrir el gasto ajeno, y copiarlo acá crearía dos reglas que se
 * separan. No se importa el módulo de comprobaciones: de ahí sólo se leen filas, y para
 * leer una tabla no hace falta su servicio.
 */
@Module({
  imports: [FinanceExpenseProofsModule],
  controllers: [ExpedienteGastoController],
  providers: [ExpedienteGastoService, ExpedienteGastoDocumentService],
  exports: [ExpedienteGastoService],
})
export class FinanceExpedienteGastoModule {}
