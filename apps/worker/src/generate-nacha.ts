import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NachaFileGeneratorService } from './ach/nacha-file-generator.service';

async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    const generator = app.get(NachaFileGeneratorService);
    const results = await generator.generateAll(new Date());

    if (!results.length) {
      console.log('No eligible VALIDATED payments found.');
      return;
    }

    for (const result of results) {
      console.log('--- NACHA METADATA ---');
      console.log({
        ...result.metadata,
        debitTotalCents: result.metadata.debitTotalCents.toString(),
        creditTotalCents: result.metadata.creditTotalCents.toString(),
      });
      console.log('--- NACHA FILE ---');
      console.log(result.file);
    }
  } finally {
    await app.close();
  }
}

void run();
