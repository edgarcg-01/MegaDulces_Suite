import { Global, Module } from '@nestjs/common';
import knex from 'knex';
import knexConfig from '../../../../../database/knexfile';

export const KNEX_CONNECTION = 'KNEX_CONNECTION';

@Global()
@Module({
  providers: [
    {
      provide: KNEX_CONNECTION,
      useFactory: () => {
        const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';
        return knex(knexConfig[environment]);
      },
    },
  ],
  exports: [KNEX_CONNECTION],
})
export class DatabaseModule {}
