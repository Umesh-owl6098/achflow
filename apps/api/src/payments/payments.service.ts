import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePaymentDto } from './dto/create-payment.dto';

@Injectable()
export class PaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePaymentDto) {
    const existingPayment = await this.prisma.payment.findUnique({
      where: {
        idempotencyKey: dto.idempotencyKey,
      },
    });

    if (existingPayment) {
      return this.serialize(existingPayment);
    }

    try {
      const payment = await this.prisma.payment.create({
        data: {
          idempotencyKey: dto.idempotencyKey,
          externalReference: dto.externalReference,
          direction: dto.direction,
          amountCents: BigInt(dto.amountCents),
          currency: dto.currency?.toUpperCase() ?? 'USD',
          originatorName: dto.originatorName,
          receiverName: dto.receiverName,
          receiverAccountRef: dto.receiverAccountRef,
          routingNumber: dto.routingNumber,
          description: dto.description,
        },
      });

      return this.serialize(payment);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A payment already exists for this idempotency key.',
        );
      }

      throw error;
    }
  }

  async findOne(id: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
    });

    if (!payment) {
      throw new NotFoundException(`Payment ${id} was not found.`);
    }

    return this.serialize(payment);
  }

  private serialize<T extends { amountCents: bigint }>(payment: T) {
    return {
      ...payment,
      amountCents: payment.amountCents.toString(),
    };
  }
}
