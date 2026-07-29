export class OutboxProcessingError extends Error {
  constructor(readonly safeMessage: string) {
    super(safeMessage);
  }
}
