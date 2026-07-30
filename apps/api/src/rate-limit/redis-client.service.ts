import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

@Injectable()
export class RedisClientService implements OnModuleDestroy {
  private readonly client: RedisClientType;
  private connectPromise: Promise<void> | undefined;

  constructor(configService: ConfigService) {
    const url =
      configService.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    this.client = createClient({ url });
    this.client.on('error', () => undefined);
  }

  async evaluate(script: string, key: string, arguments_: string[]) {
    await this.ensureConnected();

    return this.client.eval(script, {
      keys: [key],
      arguments: arguments_,
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.ensureConnected();
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isReady) {
      return;
    }

    if (!this.connectPromise) {
      this.connectPromise = this.client
        .connect()
        .then(() => undefined)
        .finally(() => {
          this.connectPromise = undefined;
        });
    }

    await this.connectPromise;
  }
}
