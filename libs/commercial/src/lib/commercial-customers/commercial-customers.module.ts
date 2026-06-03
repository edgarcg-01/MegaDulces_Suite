import { Module } from '@nestjs/common';
import { CommercialCustomersService } from './commercial-customers.service';
import { CommercialCustomersController } from './commercial-customers.controller';

@Module({
  controllers: [CommercialCustomersController],
  providers: [CommercialCustomersService],
  exports: [CommercialCustomersService],
})
export class CommercialCustomersModule {}
