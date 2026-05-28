import { Module } from '@nestjs/common';
import { TenantsAdminService } from './tenants-admin.service';
import { TenantsAdminController } from './tenants-admin.controller';

@Module({
  controllers: [TenantsAdminController],
  providers: [TenantsAdminService],
  exports: [TenantsAdminService],
})
export class TenantsAdminModule {}
