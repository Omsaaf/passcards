// key_value_store.Database is an interface for IndexedDB-style databases.
// In the browser it is implemented with IndexedDB.

import assert = require('assert');

import asyncutil = require('./asyncutil');
import err_util = require('./err_util');
import stringutil = require('./stringutil');
import { defer } from './promise_util';

function promisify<T>(req: IDBRequest): Promise<T> {
    var result = defer<T>();
    req.onsuccess = () => {
        result.resolve(req.result);
    };
    req.onerror = () => {
        result.reject(req.error);
    };
    return result.promise;
}

export interface DatabaseSchemaModifier {
    createStore(name: string): void;
    deleteStore(name: string): void;
    storeNames(): string[];
    currentVersion(): number;
}

export interface Database {
    /** Open a database with a given name and version number. */
    open(
        name: string,
        version: number,
        schemaUpdateCallback: (schemaUpdater: DatabaseSchemaModifier) => void
    ): Promise<void>;

    /** Return an object store within the current database. */
    store(name: string): ObjectStore;

    /** Close and remove the open database. */
    delete(): Promise<void>;
}

export interface ObjectStore {
    set<T>(key: string, value: T): Promise<void>;
    get<T>(key: string): Promise<T>;
    remove(key: string): Promise<void>;

    /** Iterate over keys in an object store beginning with @p prefix,
     * invoking callback() for each match.
     */
    iterate<T>(
        prefix: string,
        callback: (key: string, value?: T) => void
    ): Promise<void>;
}

export function listKeys(store: ObjectStore, prefix = ''): Promise<string[]> {
    let keys: string[] = [];
    return store
        .iterate<void>(prefix, key => {
            keys.push(key);
        })
        .then(() => {
            keys.sort();
            return keys;
        });
}

export function setItems<V>(store: ObjectStore, items: [string, V][]) {
    let saved: Promise<void>[] = [];
    for (let item of items) {
        saved.push(store.set(item[0], item[1]));
    }
    return Promise.all(saved);
}

export class IndexedDBDatabase implements Database {
    private database: Promise<IDBDatabase>;
    private stores: Map<string, IndexedDBStore>;

    constructor() {
        this.reset();
    }

    private reset() {
        this.database = null;
        this.stores = new Map<string, IndexedDBStore>();
    }

    open(
        name: string,
        version: number,
        schemaUpdateCallback: (schemaModifier: DatabaseSchemaModifier) => void
    ) {
        // FIXME [Firefox] - When a DB is opened with a new Fx release,
        // then later we try to open the same DB with an older Fx release
        // which uses an earlier schema version for IDB databases the open
        // request may fail.
        //
        // In this case Firefox 31 prints a useful error message to the
        // Browser Console but does not return a useful error to the
        // onerror() handler below.

        var _db = defer<IDBDatabase>();
        var req = indexedDB.open(name, version);
        req.onupgradeneeded = e => {
            var db = <IDBDatabase>req.result;
            schemaUpdateCallback({
                createStore: (name: string) => {
                    db.createObjectStore(name);
                },
                deleteStore: (name: string) => {
                    db.deleteObjectStore(name);
                },
                storeNames: () => {
                    var names: string[] = [];
                    for (var i = 0; i < db.objectStoreNames.length; i++) {
                        names.push(db.objectStoreNames[i]);
                    }
                    return names;
                },
                currentVersion: () => {
                    // [WORKAROUND / iOS 8.0 / Bug #136888] - the initial current
                    // version reported for a new DB is a large positive value
                    // (specifically, the result of Math.pow(2,63)) instead of 0 or undefined.
                    //
                    // Set old version to 0 if it appears to be invalid so that
                    // correct schema upgrade steps are run.
                    var MAX_SCHEMA_VERSION = Math.pow(2, 50);
                    var oldVersion = e.oldVersion || 0;
                    if (oldVersion > MAX_SCHEMA_VERSION) {
                        oldVersion = 0;
                    }
                    return oldVersion;
                },
            });
        };
        req.onsuccess = () => {
            var db = <IDBDatabase>req.result;
            _db.resolve(db);
        };
        req.onerror = e => {
            var err = new err_util.BaseError(
                'Failed to open IndexedDB database'
            );
            err.sourceErr = (<ErrorEvent>e).error;
            _db.reject(err);
        };
        this.database = _db.promise;

        return asyncutil.eraseResult(this.database);
    }

    store(name: string): ObjectStore {
        if (!this.stores.has(name)) {
            this.stores.set(name, new IndexedDBStore(this.database, name));
        }
        var store = this.stores.get(name);
        assert(store);
        return store;
    }

    close() {
        return this.database.then(db => {
            db.close();
        });
    }

    delete() {
        if (!this.database) {
            return Promise.reject<void>(new Error('Database is not open'));
        }

        return this.database.then(db => {
            var deleteRequest = indexedDB.deleteDatabase(db.name);

            // IndexedDB keeps the database around until the last open
            // connection has been closed. Each connection is in turn
            // kept around until a) closed via close() and b)
            // any open transactions on it have finished
            db.close();
            this.reset();

            return promisify<void>(deleteRequest);
        });
    }
}

class IndexedDBStore implements ObjectStore {
    private db: Promise<IDBDatabase>;

    constructor(database: Promise<IDBDatabase>, public storeName: string) {
        this.db = database;
    }

    private getStore(db: IDBDatabase) {
        const tx = db.transaction(this.storeName, 'readwrite');
        return tx.objectStore(this.storeName);
    }

    set<T>(key: string, value: T): Promise<void> {
        return this.db.then(db => {
            return promisify<void>(this.getStore(db).put(value, key));
        });
    }

    get<T>(key: string): Promise<T> {
        return this.db.then(db => {
            return promisify<T>(this.getStore(db).get(key));
        });
    }

    remove(key: string): Promise<void> {
        return this.db.then(db => {
            return promisify<void>(this.getStore(db).delete(key));
        });
    }

    iterate<T>(
        prefix: string,
        callback: (key: string, value?: T) => void
    ): Promise<void> {
        return this.db.then(db => {
            var store = this.getStore(db);
            var req = store.openCursor(IDBKeyRange.lowerBound(prefix));
            var result = defer<void>();

            req.onsuccess = () => {
                var cursor = <IDBCursorWithValue>req.result;
                var key: string;
                if (cursor) {
                    key = cursor.key as string;
                }
                if (!cursor || !stringutil.startsWith(key, prefix)) {
                    result.resolve(null);
                    return;
                }
                if (callback.length < 2) {
                    callback(key);
                } else {
                    callback(key, cursor.value);
                }
                cursor.continue();
            };
            req.onerror = () => {
                result.reject(req.error);
            };

            return result.promise;
        });
    }
}
