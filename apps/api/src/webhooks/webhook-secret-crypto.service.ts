import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export type EncryptedWebhookSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
};

@Injectable()
export class WebhookSecretCryptoService {
  private readonly key: Buffer;
  private readonly keyVersion: string;
  constructor(config: ConfigService) {
    const encoded = config.get<string>('WEBHOOK_SECRET_ENCRYPTION_KEY');
    this.keyVersion =
      config.get<string>('WEBHOOK_SECRET_ENCRYPTION_KEY_VERSION') ?? 'v1';
    if (!encoded) {
      throw new InternalServerErrorException(
        'Webhook secret encryption is not configured.',
      );
    }

    try {
      this.key = this.decodeBase64(encoded, 32);
    } catch {
      throw new InternalServerErrorException(
        'Webhook secret encryption is not configured.',
      );
    }
  }
  encrypt(plaintextSecret: string): EncryptedWebhookSecret {
    if (!plaintextSecret.trim())
      throw new BadRequestException('Webhook signing secret is required.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintextSecret, 'utf8'),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: this.keyVersion,
    };
  }
  decrypt(envelope: EncryptedWebhookSecret): string {
    try {
      const iv = this.decodeBase64(envelope.iv, 12);
      const tag = this.decodeBase64(envelope.authTag, 16);
      const ciphertext = this.decodeBase64(envelope.ciphertext);
      if (!ciphertext.length) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new BadRequestException('Webhook secret envelope is invalid.');
    }
  }

  private decodeBase64(value: string, expectedLength?: number): Buffer {
    if (
      !value ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      )
    ) {
      throw new Error('Invalid base64.');
    }

    const decoded = Buffer.from(value, 'base64');
    if (
      (expectedLength !== undefined && decoded.length !== expectedLength) ||
      decoded.toString('base64') !== value
    ) {
      throw new Error('Invalid base64.');
    }

    return decoded;
  }
}
