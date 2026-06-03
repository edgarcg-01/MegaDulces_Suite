import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateCatalogItemDto {
  @ApiProperty({ description: 'Valor/nombre del ítem' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  value!: string;

  @ApiProperty({ required: false, description: 'Orden de visualización' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  orden?: number;

  @ApiProperty({
    required: false,
    description: 'Puntuación (para conceptos/ubicaciones/niveles)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  puntuacion?: number;

  @ApiProperty({ required: false, description: 'Clase de PrimeIcon (ej: pi pi-star)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  icono?: string;

  @ApiProperty({
    required: false,
    description: 'ID del padre (ej: zona padre de una ruta)',
  })
  @IsOptional()
  @IsUUID()
  parent_id?: string;
}
