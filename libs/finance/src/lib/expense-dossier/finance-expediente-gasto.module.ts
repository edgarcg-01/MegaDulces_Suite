import { Module } from '@nestjs/common';
import { CloudinaryModule } from '@megadulces/platform-core';
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
 *
 * ── ⛔ `CloudinaryModule` NO es opcional, y su ausencia tiró producción ──────────────────────
 * `ExpedienteGastoService` inyecta `ObjectStorageService` (el PDF del expediente). Ese proveedor
 * lo exporta `CloudinaryModule`, y `FinanceExpenseProofsModule` **lo importa pero no lo
 * reexporta** — o sea que importar al hermano trae `ExpenseProofsService` y nada más. Sin esta
 * línea, Nest aborta el arranque entero:
 *
 *     UnknownDependenciesException: Nest can't resolve dependencies of the ExpedienteGastoService
 *     (TenantKnexService, TenantContextService, ?, ExpenseProofsService).
 *     ObjectStorageService at index [2] is not available in FinanceExpedienteGastoModule
 *
 * ⚠️ **`nx build api` lo compila sin una sola advertencia**: la inyección se resuelve en
 * ARRANQUE, no en compilación, así que el tipo está bien y el grafo no. Por eso pasó el merge y
 * por eso llegó a `main`. Medido el 2026-09-24: el despliegue automático subió `0e1fef3`, el API
 * murió en el boot, y prod estuvo caído dos ventanas de ~1 min hasta que la auto-reversión lo
 * devolvió a `a2052fa1`. Lo único que lo atrapa es **levantar el proceso**, no construirlo.
 */
@Module({
  imports: [CloudinaryModule, FinanceExpenseProofsModule],
  controllers: [ExpedienteGastoController],
  providers: [ExpedienteGastoService, ExpedienteGastoDocumentService],
  exports: [ExpedienteGastoService],
})
export class FinanceExpedienteGastoModule {}
