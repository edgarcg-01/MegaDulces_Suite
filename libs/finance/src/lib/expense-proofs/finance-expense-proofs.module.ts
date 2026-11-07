import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CloudinaryModule, AiProductMatcherModule, requireJwtSecret, jwtVerifyOptions } from '@megadulces/platform-core';
import { ExpenseProofsService } from './expense-proofs.service';
import { ExpenseProofsController } from './expense-proofs.controller';
import { ExpenseProofsGateway } from './expense-proofs.gateway';
import { ExpenseCaptureLinksService } from './expense-capture-links.service';
import { ExpenseCaptureLinksController } from './expense-capture-links.controller';
import { ExpenseCapturePublicController } from './expense-capture-public.controller';
import { CierreKeplerService } from './cierre-kepler.service';
import { KeplerAutorizacionGastoAdapter } from './autorizacion-kepler/kepler-autorizacion-gasto.adapter';
import { AutorizacionKeplerLecturaService } from './autorizacion-kepler/autorizacion-kepler-lectura.service';
import { AutorizacionKeplerController } from './autorizacion-kepler/autorizacion-kepler.controller';

/**
 * GX.7 — Comprobación de gasto (captura del comprobante fiscal en plataforma,
 * reemplaza el Google Form). Sube a Cloudinary + guarda en `finance.expense_proofs`.
 */
@Module({
  imports: [
    CloudinaryModule,
    AiProductMatcherModule,
    // JwtModule local para el handshake del gateway (mismo default que las otras gateways de Finanzas).
    JwtModule.register({
      secret: requireJwtSecret(),
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any, algorithm: 'HS256' },
      verifyOptions: jwtVerifyOptions,
    }),
  ],
  // `[PGP.79]` AutorizacionKeplerController: la solicitud de Kepler de los vales que la pantalla ya tiene.
  controllers: [ExpenseProofsController, ExpenseCaptureLinksController, ExpenseCapturePublicController, AutorizacionKeplerController],
  // `[GX.85]` CierreKeplerService: cierra el vale cuando Kepler lo aplica (F).
  // `[PGP.79]` KeplerAutorizacionGastoAdapter: firmar autoriza la solicitud en Kepler (apagado por default).
  providers: [ExpenseProofsService, ExpenseProofsGateway, ExpenseCaptureLinksService, CierreKeplerService, KeplerAutorizacionGastoAdapter, AutorizacionKeplerLecturaService],
  exports: [ExpenseProofsService, ExpenseCaptureLinksService],
})
export class FinanceExpenseProofsModule {}
