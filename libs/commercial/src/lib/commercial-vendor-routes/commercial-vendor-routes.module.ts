import { Module } from '@nestjs/common';
import { CommercialVendorRoutesService } from './commercial-vendor-routes.service';
import { CommercialVendorRoutesController } from './commercial-vendor-routes.controller';

@Module({
  controllers: [CommercialVendorRoutesController],
  providers: [CommercialVendorRoutesService],
  exports: [CommercialVendorRoutesService],
})
export class CommercialVendorRoutesModule {}
