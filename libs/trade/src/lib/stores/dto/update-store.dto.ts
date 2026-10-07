import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateStoreDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  nombre?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  direccion?: string;

  @ApiProperty({
    required: false,
    description: 'Nombre de la zona — se resuelve a zona_id si no se envía zona_id',
  })
  @IsOptional()
  @IsString()
  zona?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  zona_id?: string;

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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}
