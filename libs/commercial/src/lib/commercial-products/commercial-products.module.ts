import { Module } from '@nestjs/common';
import { CommercialProductsService } from './commercial-products.service';
import { CommercialProductsController } from './commercial-products.controller';
import { NewProductsService } from './new-products.service';
import { ProductFlowService } from './product-flow.service';
import { FichaSucursalesService } from './ficha-sucursales.service';
import { PreciosCatalogoService } from './precios-catalogo.service';
import { CatalogoFichaService } from './catalogo-ficha.service';
import { CatalogoDetalladoService } from './catalogo-detallado.service';

@Module({
  controllers: [CommercialProductsController],
  providers: [CommercialProductsService, NewProductsService, ProductFlowService, FichaSucursalesService, PreciosCatalogoService, CatalogoFichaService, CatalogoDetalladoService],
  exports: [CommercialProductsService],
})
export class CommercialProductsModule {}
