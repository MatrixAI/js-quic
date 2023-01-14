import type QUICConnection from "./QUICConnection";
import type { ConnectionId, ConnectionIdString } from "./types";
import * as utils from './utils';

class QUICConnectionMap implements Map<ConnectionId, QUICConnection> {
  public [Symbol.toStringTag]: string = 'QUICConnectionMap';
  protected _serverConnections: Map<ConnectionIdString, QUICConnection> = new Map();
  protected _clientConnections: Map<ConnectionIdString, QUICConnection> = new Map();

  public constructor(
    connections?: Iterable<readonly [ConnectionId, QUICConnection]>
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
  public get serverConnections(): ReadonlyMap<ConnectionIdString, QUICConnection> {
    return this._serverConnections;
  }

  /**
   * Gets the client connections.
   * This uses `ConnectionIdString` because it is too complex to map
   * `ConnectionId` to `ConnectionIdString` and back.
   */
  public get clientConnections(): ReadonlyMap<ConnectionIdString, QUICConnection> {
    return this._clientConnections;
  }

  public has(connectionId: ConnectionId): boolean {
    const connectionIdString = utils.encodeConnectionId(connectionId);
    return this._serverConnections.has(connectionIdString) ||
           this._clientConnections.has(connectionIdString);
  }

  public get(connectionId: ConnectionId): QUICConnection | undefined {
    const connectionIdString = utils.encodeConnectionId(connectionId);
    return this._serverConnections.get(connectionIdString) ??
           this._clientConnections.get(connectionIdString);
  }

  public set(connectionId: ConnectionId, connection: QUICConnection): this {
    const connectionIdString = utils.encodeConnectionId(connectionId);
    if (connection.type === 'server') {
      this._serverConnections.set(connectionIdString, connection);
    } else if (connection.type === 'client') {
      this._clientConnections.set(connectionIdString, connection);
    }
    return this;
  }

  public delete(connectionId: ConnectionId): boolean {
    const connectionIdString = utils.encodeConnectionId(connectionId);
    return this._serverConnections.delete(connectionIdString) ||
           this._clientConnections.delete(connectionIdString);
  }

  public clear(): void {
    this._serverConnections.clear();
    this._clientConnections.clear();
  }

  public forEach(
    callback: (
      value: QUICConnection,
      key: ConnectionId,
      map: Map<ConnectionId, QUICConnection>
    ) => void,
    thisArg?: any
  ): void {
    this._serverConnections.forEach((value, key) => {
      callback.bind(thisArg)(value, utils.decodeConnectionId(key), this);
    });
    this._clientConnections.forEach((value, key) => {
      callback.bind(thisArg)(value, utils.decodeConnectionId(key), this);
    });
  }

  public [Symbol.iterator](): IterableIterator<[ConnectionId, QUICConnection]> {
    const serverIterator = this._serverConnections[Symbol.iterator]();
    const clientIterator = this._clientConnections[Symbol.iterator]();
    const iterator = {
      next: (): IteratorResult<[ConnectionId, QUICConnection], void> => {
        const serverResult = serverIterator.next();
        if (!serverResult.done) {
          const [key, value] = serverResult.value;
          return {
            done: false,
            value: [utils.decodeConnectionId(key), value]
          };
        }
        const clientResult = clientIterator.next();
        if (!clientResult.done) {
          const [key, value] = clientResult.value;
          return {
            done: false,
            value: [utils.decodeConnectionId(key), value]
          };
        }
        return { done: true, value: undefined };
      },
      [Symbol.iterator]: () => iterator
    };
    return iterator;
  }

  public entries(): IterableIterator<[ConnectionId, QUICConnection]> {
    return this[Symbol.iterator]();
  }

  public keys(): IterableIterator<ConnectionId> {
    const iterator = {
      next: (): IteratorResult<ConnectionId, void> => {
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
