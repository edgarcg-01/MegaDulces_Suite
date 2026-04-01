import { NestFactory } from '@nestjs/core';
import { AppModule } from '../apps/api/src/app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as fs from 'fs';
import * as path from 'path';

async function generate() {
  const app = await NestFactory.create(AppModule);
  const config = new DocumentBuilder()
    .setTitle('Trade Marketing API')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  const outputPath = path.resolve(process.cwd(), 'swagger.json');
  fs.writeFileSync(outputPath, JSON.stringify(document, null, 2));
  console.log(`✅ Swagger JSON generated at ${outputPath}`);
  await app.close();
  process.exit(0);
}

generate();
