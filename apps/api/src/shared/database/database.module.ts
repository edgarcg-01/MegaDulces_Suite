import { Global, Module } from '@nestjs/common';
import knex from 'knex';
import { connectionConfig } from '../../../../../database/knexfile';

export const KNEX_CONNECTION = 'KNEX_CONNECTION';

@Global()
@Module({
  providers: [
    {
      provide: KNEX_CONNECTION,
      useFactory: () => {
        const environment = process.env.NODE_ENV || 'development';
        console.log(`[DatabaseModule] Environment: ${environment}`);
        const config = connectionConfig[environment];
        if (!config) {
          throw new Error(
            `Missing database configuration for environment: ${environment}`,
          );
        }
        console.log(`[DatabaseModule] Database config loaded successfully`);
        return knex(config);
      },
    },
  ],
  exports: [KNEX_CONNECTION],
})
export class DatabaseModule {}
