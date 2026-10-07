import { ApiProperty } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateStoreDto {
  @ApiProperty({ description: 'Nombre del PDV' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  nombre!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  direccion?: string;

  @ApiProperty({
    required: false,
    description: 'Nombre de la zona — se resuelve a zona_id en el backend',
  })
  @IsOptional()
  @IsString()
  zona?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  ruta_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitud?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitud?: number;
}
