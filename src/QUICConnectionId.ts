class QUICConnectionId extends Uint8Array {
  public readonly string: string;

  /**
   * Decodes from hex string.
   */
  public static fromString(idString: string): QUICConnectionId {
    const buf = Buffer.from(idString, 'hex');
    return new this(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /**
   * Decodes as Buffer zero-copy.
   */
  public static fromBuffer(idBuffer: Buffer): QUICConnectionId {
    return new this(idBuffer.buffer, idBuffer.byteOffset, idBuffer.byteLength);
  }

  public constructor();
  public constructor(length: number);
  public constructor(array: ArrayLike<number> | ArrayBufferLike);
  public constructor(
    buffer: ArrayBufferLike,
    byteOffset?: number,
    length?: number,
  );
  public constructor(...args: Array<any>) {
    // @ts-ignore: spreading into Uint8Array constructor
    super(...args);
    this.string = this.toBuffer().toString('hex');
  }

  /**
   * Encodes to hex string.
   */
  public toString(): string {
    return this.string;
  }

  /**
   * Encodes as Buffer zero-copy.
   */
  public toBuffer(): Buffer {
    return Buffer.from(this.buffer, this.byteOffset, this.byteLength);
  }

  public [Symbol.toPrimitive](_hint: 'string' | 'number' | 'default'): string {
    return this.toString();
  }
}

export default QUICConnectionId;
