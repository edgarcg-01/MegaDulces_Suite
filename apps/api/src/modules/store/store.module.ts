import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import knex, { Knex } from 'knex';
import { StoreGateway } from './store.gateway';
import { StoreService } from './store.service';
import { StoreController } from './store.controller';
import { StoreIngestGuard } from './store-ingest.guard';

/**
 * Proyecto Tienda (TDA) — monitor de tickets de venta en vivo.
 * Gateway WS (namespace /store) + servicio de ingesta/snapshot. JwtModule local
 * para validar el token del handshake (mismo default que AlertsGateway).
 * Pool propio (max 3) contra la DB nueva — analytics.* no tiene RLS.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'super_secret_dev_key_change_in_prod',
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any },
    }),
  ],
  controllers: [StoreController],
  providers: [
    StoreGateway,
    StoreService,
    StoreIngestGuard,
    {
      provide: 'STORE_KNEX',
      useFactory: (): Knex => {
        const conn = process.env.KNEX_CONNECTION || process.env.DATABASE_URL_NEW || process.env.DATABASE_URL || '';
        return knex({
          client: 'pg',
          connection: /rlwy|railway|proxy/i.test(conn) ? { connectionString: conn, ssl: { rejectUnauthorized: false } } : conn,
          pool: { min: 0, max: 3 },
        });
      },
    },
  ],
})
export class StoreModule {}
