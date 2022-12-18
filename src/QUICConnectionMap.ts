import type QUICConnection from "./QUICConnection";
import QUICConnectionId from './QUICConnectionId';

class QUICConnectionMap implements Map<QUICConnectionId, QUICConnection> {
  public [Symbol.toStringTag]: string = 'QUICConnectionMap';
  protected _serverConnections: Map<string, QUICConnection> = new Map();
  protected _clientConnections: Map<string, QUICConnection> = new Map();

  public constructor(
    connections?: Iterable<readonly [QUICConnectionId, QUICConnection]>
  ) {
    if (connections != null) {
      for (const [connectionId, connection] of connections) {
        this.set(connectionId, connection);
      }
    }
  }

  public get size(): number {
    return this._serverConnections.size + this._clientConnections.size;
  }

  /**
   * Gets the server connections.
   * This uses `ConnectionIdString` because it is too complex to map
   * `ConnectionId` to `ConnectionIdString` and back.
   */
  public get serverConnections(): ReadonlyMap<string, QUICConnection> {
    return this._serverConnections;
  }

  /**
   * Gets the client connections.
   * This uses `ConnectionIdString` because it is too complex to map
   * `ConnectionId` to `ConnectionIdString` and back.
   */
  public get clientConnections(): ReadonlyMap<string, QUICConnection> {
    return this._clientConnections;
  }

  public has(connectionId: QUICConnectionId): boolean {
    return this._serverConnections.has(connectionId.toString()) ||
           this._clientConnections.has(connectionId.toString());
  }

  public get(connectionId: QUICConnectionId): QUICConnection | undefined {
    return this._serverConnections.get(connectionId.toString()) ??
           this._clientConnections.get(connectionId.toString());
  }

  public set(connectionId: QUICConnectionId, connection: QUICConnection): this {
    if (connection.type === 'server') {
      this._serverConnections.set(connectionId.toString(), connection);
    } else if (connection.type === 'client') {
      this._clientConnections.set(connectionId.toString(), connection);
    }
    return this;
  }

  public delete(connectionId: QUICConnectionId): boolean {
    return this._serverConnections.delete(connectionId.toString()) ||
           this._clientConnections.delete(connectionId.toString());
  }

  public clear(): void {
    this._serverConnections.clear();
    this._clientConnections.clear();
  }

  public forEach(
    callback: (
      value: QUICConnection,
      key: QUICConnectionId,
      map: Map<QUICConnectionId, QUICConnection>
    ) => void,
    thisArg?: any
  ): void {
    this._serverConnections.forEach((value, key) => {
      callback.bind(thisArg)(value, QUICConnectionId.fromString(key), this);
    });
    this._clientConnections.forEach((value, key) => {
      callback.bind(thisArg)(value, QUICConnectionId.fromString(key), this);
    });
  }

  public [Symbol.iterator](): IterableIterator<[QUICConnectionId, QUICConnection]> {
    const serverIterator = this._serverConnections[Symbol.iterator]();
    const clientIterator = this._clientConnections[Symbol.iterator]();
    const iterator = {
      next: (): IteratorResult<[QUICConnectionId, QUICConnection], void> => {
        const serverResult = serverIterator.next();
        if (!serverResult.done) {
          const [key, value] = serverResult.value;
          return {
            done: false,
            value: [QUICConnectionId.fromString(key), value]
          };
        }
        const clientResult = clientIterator.next();
        if (!clientResult.done) {
          const [key, value] = clientResult.value;
          return {
            done: false,
            value: [QUICConnectionId.fromString(key), value]
          };
        }
        return { done: true, value: undefined };
      },
      [Symbol.iterator]: () => iterator
    };
    return iterator;
  }

  public entries(): IterableIterator<[QUICConnectionId, QUICConnection]> {
    return this[Symbol.iterator]();
  }

  public keys(): IterableIterator<QUICConnectionId> {
    const iterator = {
      next: (): IteratorResult<QUICConnectionId, void> => {
        const result = this[Symbol.iterator]().next();
        if (!result.done) {
          return {
            done: false,
            value: result.value[0]
          };
        }
        return { done: true, value: undefined };
      },
      [Symbol.iterator]: () => iterator
    };
    return iterator;
  }

  public values(): IterableIterator<QUICConnection> {
    const iterator = {
      next: (): IteratorResult<QUICConnection, void> => {
        const result = this[Symbol.iterator]().next();
        if (!result.done) {
          return {
            done: false,
            value: result.value[1]
          };
        }
        return { done: true, value: undefined };
      },
      [Symbol.iterator]: () => iterator
    };
    return iterator;
  }
}

export default QUICConnectionMap;
