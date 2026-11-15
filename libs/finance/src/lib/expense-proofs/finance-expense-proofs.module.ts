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
import { KeplerSolicitudGastoSinkAdapter } from './solicitud-kepler/kepler-solicitud-gasto-sink.adapter';
import { SolicitudGastoService } from './solicitud-kepler/solicitud-gasto.service';
import { SolicitudGastoController } from './solicitud-kepler/solicitud-gasto.controller';

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
  // `[PGP.122]` SolicitudGastoController: la solicitud de gasto nace en la Suite (ruta propia).
  controllers: [ExpenseProofsController, ExpenseCaptureLinksController, ExpenseCapturePublicController, AutorizacionKeplerController, SolicitudGastoController],
  // `[GX.85]` CierreKeplerService: cierra el vale cuando Kepler lo aplica (F).
  // `[PGP.79]` KeplerAutorizacionGastoAdapter: firmar autoriza la solicitud en Kepler (apagado por default).
  // `[PGP.122]` KeplerSolicitudGastoSinkAdapter + SolicitudGastoService: firmar ESCRIBE en Kepler la solicitud
  // nacida en la Suite (apagado por default: bandera, plantilla por servidor, interruptor y GRANT).
  providers: [ExpenseProofsService, ExpenseProofsGateway, ExpenseCaptureLinksService, CierreKeplerService, KeplerAutorizacionGastoAdapter, AutorizacionKeplerLecturaService,
    KeplerSolicitudGastoSinkAdapter, SolicitudGastoService],
  exports: [ExpenseProofsService, ExpenseCaptureLinksService],
})
export class FinanceExpenseProofsModule {}
