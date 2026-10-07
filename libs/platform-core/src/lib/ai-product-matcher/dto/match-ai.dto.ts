import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class MatchAiDto {
  @ApiProperty({
    description:
      'Texto crudo del colaborador con la lista de productos a identificar. ' +
      'Acepta comas, líneas, abreviaciones, typos. Máx 5000 caracteres.',
    example:
      'carlota fresa, mazapán rosa 12pz / pulparindo y vero mango chamoy',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  rawText!: string;
}
