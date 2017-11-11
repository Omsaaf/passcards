// item_store contains the core interfaces and types for
// encrypted items and storage of them

import clone = require('clone');
import sprintf = require('sprintf');

import agile_keychain_crypto = require('./agile_keychain_crypto');
import asyncutil = require('./base/asyncutil');
import collectionutil = require('./base/collectionutil');
import dateutil = require('./base/dateutil');
import err_util = require('./base/err_util');
import event_stream = require('./base/event_stream');
import key_agent = require('./key_agent');
import sha1 = require('./crypto/sha1');
import stringutil = require('./base/stringutil');

// typedef for item type codes
export interface ItemType extends String {}

/** Constants for the different types of item
 * that a vault may contain.
 *
 * Item type codes are taken from 1Password v4
 */
export class ItemTypes {
    // The most common type, for logins and other web forms
    static LOGIN = <ItemType>'webforms.WebForm';

    // Other item types
    static CREDIT_CARD = <ItemType>'wallet.financial.CreditCard';
    static ROUTER = <ItemType>'wallet.computer.Router';
    static SECURE_NOTE = <ItemType>'securenotes.SecureNote';
    static PASSWORD = <ItemType>'passwords.Password';
    static EMAIL_ACCOUNT = <ItemType>'wallet.onlineservices.Email.v2';
    static BANK_ACCOUNT = <ItemType>'wallet.financial.BankAccountUS';
    static DATABASE = <ItemType>'wallet.computer.Database';
    static DRIVERS_LICENSE = <ItemType>'wallet.government.DriversLicense';
    static MEMBERSHIP = <ItemType>'wallet.membership.Membership';
    static HUNTING_LICENSE = <ItemType>'wallet.government.HuntingLicense';
    static PASSPORT = <ItemType>'wallet.government.Passport';
    static REWARD_PROGRAM = <ItemType>'wallet.membership.RewardProgram';
    static SERVER = <ItemType>'wallet.computer.UnixServer';
    static SOCIAL_SECURITY = <ItemType>'wallet.government.SsnUS';
    static SOFTWARE_LICENSE = <ItemType>'wallet.computer.License';
    static IDENTITY = <ItemType>'identities.Identity';

    // Non-item types
    static FOLDER = <ItemType>'system.folder.Regular';
    static SAVED_SEARCH = <ItemType>'system.folder.SavedSearch';

    // Marker type used to deleted items. The ID is preserved
    // but the type is set to Tombstone and all other data
    // is removed
    static TOMBSTONE = <ItemType>'system.Tombstone';
}

/** Map of item type codes to human-readable item type names */
export var ITEM_TYPES: ItemTypeMap = {
    'webforms.WebForm': {
        name: 'Login',
        shortAlias: 'login',
    },
    'wallet.financial.CreditCard': {
        name: 'Credit Card',
        shortAlias: 'card',
    },
    'wallet.computer.Router': {
        name: 'Wireless Router',
        shortAlias: 'router',
    },
    'securenotes.SecureNote': {
        name: 'Secure Note',
        shortAlias: 'note',
    },
    'passwords.Password': {
        name: 'Password',
        shortAlias: 'pass',
    },
    'wallet.onlineservices.Email.v2': {
        name: 'Email Account',
        shortAlias: 'email',
    },
    'system.folder.Regular': {
        name: 'Folder',
        shortAlias: 'folder',
    },
    'system.folder.SavedSearch': {
        name: 'Smart Folder',
        shortAlias: 'smart-folder',
    },
    'wallet.financial.BankAccountUS': {
        name: 'Bank Account',
        shortAlias: 'bank',
    },
    'wallet.computer.Database': {
        name: 'Database',
        shortAlias: 'db',
    },
    'wallet.government.DriversLicense': {
        name: "Driver's License",
        shortAlias: 'driver',
    },
    'wallet.membership.Membership': {
        name: 'Membership',
        shortAlias: 'membership',
    },
    'wallet.government.HuntingLicense': {
        name: 'Outdoor License',
        shortAlias: 'outdoor',
    },
    'wallet.government.Passport': {
        name: 'Passport',
        shortAlias: 'passport',
    },
    'wallet.membership.RewardProgram': {
        name: 'Reward Program',
        shortAlias: 'reward',
    },
    'wallet.computer.UnixServer': {
        name: 'Unix Server',
        shortAlias: 'server',
    },
    'wallet.government.SsnUS': {
        name: 'Social Security Number',
        shortAlias: 'social',
    },
    'wallet.computer.License': {
        name: 'Software License',
        shortAlias: 'software',
    },
    'identities.Identity': {
        name: 'Identity',
        shortAlias: 'id',
    },
    // internal entry type created for items
    // that have been removed from the trash
    'system.Tombstone': {
        name: 'Tombstone',
        shortAlias: 'tombstone',
    },
};

export interface ItemState {
    uuid: string;
    revision: string;
    deleted: boolean;
}

/** A convenience interface for passing around an item
 * and its contents together.
 */
export interface ItemAndContent {
    item: Item;
    content: ItemContent;
}

export interface ItemTypeInfo {
    name: string;
    shortAlias: string;
}

export interface ItemTypeMap {
    // map of ItemType -> ItemTypeInfo
    [index: string]: ItemTypeInfo;
}

export class UnsavedItemError extends err_util.BaseError {
    constructor() {
        super('Item has not been saved to a store');
    }
}

/** Represents the content of an item, usually stored
 * encrypted in a vault.
 *
 * ItemContent and its dependent fields are plain interfaces
 * to facilitate easy (de-)serialization.
 */
export interface ItemContent {
    sections: ItemSection[];
    urls: ItemUrl[];
    notes: string;
    formFields: WebFormField[];
    htmlMethod: string;
    htmlAction: string;
    htmlId: string;
}

/** Utility functions for creating and extracting
 * data from ItemContent instances.
 */
export let ContentUtil = {
    /** Creates a new ItemContent instance with all
     * fields set to default values.
     */
    empty(): ItemContent {
        return {
            sections: [],
            urls: [],
            notes: '',
            formFields: [],
            htmlMethod: '',
            htmlAction: '',
            htmlId: '',
        };
    },

    /** Returns the account name associated with this item.
     *
     * The field used for the account name depends on the item
     * type. For logins, this is the 'username' field.
     *
     * Returns an empty string if the item has no associated account.
     */
    account(content: ItemContent): string {
        let field = ContentUtil.accountField(content);
        return field ? field.value : '';
    },

    accountField(content: ItemContent): WebFormField {
        let accountFields = content.formFields.filter(
            field => field.designation === 'username'
        );
        return accountFields.length > 0 ? accountFields[0] : null;
    },

    /** Returns the primary password associated with this item.
     *
     * This depends upon the item type. For logins, this is
     * the 'password' field.
     *
     * Returns an empty password if the item has no associated
     * account.
     */
    password(content: ItemContent): string {
        let field = ContentUtil.passwordField(content);
        return field ? field.value : '';
    },

    passwordField(content: ItemContent): WebFormField {
        var passFields = content.formFields.filter(
            field => field.designation === 'password'
        );
        return passFields.length > 0 ? passFields[0] : null;
    },
};

/** Represents a single item in a 1Password vault. */
export class Item {
    // store which this item belongs to, or null
    // if the item has not yet been saved
    private store: Store;

    /** Identifies the version of an item. This is an opaque
     * string which is set when an item is saved to a store.
     * It will change each time an item is saved.
     */
    revision: string;

    /** Identifies the previous version of an item. This is
     * an opaque string which is set to the current revision
     * just prior to a new version being saved to a store
     * which supports item history. It will be updated
     * each time an item is saved.
     */
    parentRevision: string;

    /** Unique ID for this item within the vault */
    uuid: string;

    /** ID of the folder that this item currently belongs to */
    folderUuid: string;
    faveIndex: number;
    trashed: boolean;

    updatedAt: Date;
    createdAt: Date;

    /** Item type code for this item. This is one of the values
     * in the ItemTypes class.
     */
    typeName: ItemType;

    /** Main title for this item. */
    title: string;

    /** Additional metadata (eg. tags)
     * which is stored unencrypted for this item.
     */
    openContents: ItemOpenContents;

    /** List of URLs that this item is associated with. */
    locations: string[];

    /** The account name or number that this item is associated with */
    account: string;

    /** The decrypted content of the item, either set
     * via setContent() or decrypted on-demand by
     * getContent()
     */
    private content: ItemContent;

    /** Create a new item. @p store is the store
     * to associate the new item with. This can
     * be changed later via saveTo().
     *
     * When importing an existing item or loading
     * an existing item from the store, @p uuid may be non-null.
     * Otherwise a random new UUID will be allocated for
     * the item.
     */
    constructor(store?: Store, uuid?: string) {
        this.store = store;

        this.uuid = uuid || agile_keychain_crypto.newUUID();

        this.trashed = false;
        this.typeName = ItemTypes.LOGIN;
        this.folderUuid = '';
        this.locations = [];
        this.title = '';
    }

    /** Retrieves and decrypts the content of a 1Password item.
     *
     * In the Agile Keychain format, items are stored in two parts.
     * The overview data is stored in both contents.js and replicated
     * in the <UUID>.1password file for the item and is unencrypted.
     *
     * The item content is stored in the <UUID>.1password file and
     * is encrypted using the store's master key.
     *
     * The item's store must be unlocked using Store.unlock() before
     * item content can be retrieved.
     */
    getContent(): Promise<ItemContent> {
        if (this.content) {
            return Promise.resolve(this.content);
        } else if (!this.store) {
            this.content = ContentUtil.empty();
            return Promise.resolve(this.content);
        }

        return this.store.getContent(this);
    }

    setContent(content: ItemContent) {
        this.content = content;
    }

    /** Return the raw decrypted JSON data for an item.
     * This is only available for saved items.
     */
    getRawDecryptedData(): Promise<string> {
        if (!this.store) {
            return Promise.reject<string>(new UnsavedItemError());
        }
        return this.store.getRawDecryptedData(this);
    }

    /** Save this item to its associated store */
    save(): Promise<void> {
        if (!this.store) {
            return Promise.reject<void>(new UnsavedItemError());
        }
        return this.saveTo(this.store);
    }

    /** Save this item to the specified store */
    saveTo(store: Store): Promise<void> {
        if (!this.content && !this.isSaved()) {
            return Promise.reject<void>(
                new Error('Unable to save new item, no content set')
            );
        }
        this.store = store;
        return this.store.saveItem(this);
    }

    /** Remove the item from the store.
     * This erases all of the item's data and leaves behind a 'tombstone'
     * entry for syncing purposes.
     */
    remove(): Promise<void> {
        if (!this.store) {
            return Promise.reject<void>(new UnsavedItemError());
        }
        this.typeName = ItemTypes.TOMBSTONE;
        this.title = 'Unnamed';
        this.trashed = true;
        this.setContent(ContentUtil.empty());
        this.folderUuid = '';
        this.locations = [];
        this.faveIndex = null;
        this.openContents = null;

        return this.store.saveItem(this);
    }

    /** Returns true if this is a 'tombstone' entry remaining from
     * a deleted item. When an item is deleted, all of the properties except
     * the UUID are erased and the item's type is changed to 'system.Tombstone'.
     *
     * These 'tombstone' markers are preserved so that deletions are synced between
     * different 1Password clients.
     */
    isTombstone(): boolean {
        return this.typeName == ItemTypes.TOMBSTONE;
    }

    /** Returns true if this is a regular item - ie. not a folder,
     * tombstone or saved search.
     */
    isRegularItem(): boolean {
        return !stringutil.startsWith(<string>this.typeName, 'system.');
    }

    /** Returns a shortened version of the item's UUID, suitable for disambiguation
     * between different items with the same type and title.
     */
    shortID(): string {
        return this.uuid.slice(0, 4);
    }

    /** Returns the human-readable type name for this item's type. */
    typeDescription(): string {
        if (ITEM_TYPES[<string>this.typeName]) {
            return ITEM_TYPES[<string>this.typeName].name;
        } else {
            return <string>this.typeName;
        }
    }

    /** Returns true if this item has been saved to a store. */
    isSaved(): boolean {
        return this.store && this.updatedAt != null;
    }

    /** Set the last-modified time for the item to the current time.
     * If the created time for the item has not been initialized, it
     * is also set to the current time.
     */
    updateTimestamps() {
        if (!this.createdAt) {
            this.createdAt = new Date();
        }

        // update last-modified time
        var prevDate = this.updatedAt;
        this.updatedAt = new Date();

        // ensure that last-modified time always advances by at least one
        // second from the previous time on save.
        //
        // This is required to ensure the 'updatedAt' time saved in contents.js
        // changes since it only stores second-level resolution
        if (prevDate && this.updatedAt.getTime() - prevDate.getTime() < 1000) {
            this.updatedAt = new Date(prevDate.getTime() + 1000);
        }
    }

    /** Returns the main URL associated with this item or an empty
     * string if there are no associated URLs.
     */
    primaryLocation(): string {
        if (this.locations.length > 0) {
            return this.locations[0];
        } else {
            return '';
        }
    }

    /** Update item overview metadata to match the complete
     * content of an item.
     *
     * This updates the URL list for an item.
     */
    updateOverviewFromContent(content: ItemContent) {
        this.locations = [];
        content.urls.forEach(url => {
            this.locations.push(url.url);
        });

        this.account = ContentUtil.account(content);
    }
}

/** Content of an item which is usually stored unencrypted
 * as part of the overview data.
 */
export interface ItemOpenContents {
    tags: string[];

    /** Indicates where this item will be displayed.
     * Known values are 'Always' (show everywhere)
     * and 'Never' (never shown in browser)
     */
    scope: string;
}

/** A group of fields in an item. */
export interface ItemSection {
    /** Internal name of the section. */
    name: string;

    /** User-visible title for the section. */
    title: string;
    fields: ItemField[];
}

/** A specific property/attribute of an item.
 *
 * Each field has a data type, an internal name/ID for the field,
 * a user-visible title and a current value.
 */
export interface ItemField {
    kind: FieldType;
    name: string;
    title: string;
    value: any;
}

export function fieldValueString(field: ItemField) {
    switch (field.kind) {
        case FieldType.Date:
            return dateutil.dateFromUnixTimestamp(field.value).toString();
        case FieldType.MonthYear:
            var month = field.value % 100;
            var year = (field.value / 100) % 100;
            return sprintf('%02d/%d', month, year);
        default:
            return field.value;
    }
}

/** Type of input field in a web form. */
export enum FormFieldType {
    Text,
    Password,
    Email,
    Checkbox,
    Input,
}

/** Saved value of an input field in a web form. */
export interface WebFormField {
    value: string;

    /** 'id' attribute of the <input> element */
    id: string;

    /** Name of the field. For web forms this is the 'name'
     * attribute of the <input> element.
     */
    name: string;

    /** Type of input element used for this form field */
    type: FormFieldType;

    /** Purpose of the field. Known values are 'username', 'password' */
    designation: string;
}

/** Entry in an item's 'Websites' list. */
export interface ItemUrl {
    label: string;
    url: string;
}

/** Type of data stored in a field.
 * The set of types comes originally from those used
 * in the 1Password Agile Keychain format.
 */
export enum FieldType {
    Text,
    Password,
    Address,
    Date,
    MonthYear,
    URL,
    CreditCardType,
    PhoneNumber,
    Gender,
    Email,
    Menu,
}

export interface ListItemsOptions {
    /** Include 'tombstone' items which are left in the store
     * when an item is removed.
     */
    includeTombstones?: boolean;
}

/** Specifies where an update came from when saving an item.
 */
export enum ChangeSource {
    /** Indicates a change resulting from a sync with another store. */
    Sync,
    /** Indicates a local change. */
    Local,
}

/** Interface for a store of encrypted items.
 *
 * A Store consists of a set of Item(s), identified by unique ID,
 * plus a set of encryption keys used to encrypt the contents of
 * those items.
 *
 * Items are versioned with an implementation-specific revision.
 * Stores may keep only the last revision of an item or they
 * may keep previous revisions as well.
 */
export interface Store {
    /** Emits events when items are updated in the store. */
    onItemUpdated: event_stream.EventStream<Item>;

    /** Emits events when keys are updated in the store. */
    onKeysUpdated?: event_stream.EventStream<key_agent.Key[]>;

    /** Unlock the vault */
    unlock(password: string): Promise<void>;

    /** List the states (ID, last update time and whether deleted)
     * of all items in the store.
     */
    listItemStates(): Promise<ItemState[]>;

    /** List all of the items in the store */
    listItems(opts?: ListItemsOptions): Promise<Item[]>;

    /** Load the item with a specific ID.
     *
     * If a revision is specified, load a specific version of an item,
     * otherwise load the current version of the item.
     *
     * loadItem() should report an error if the item has been deleted.
     * Deleted items are only available as tombstone entries in the
     * list returned by listItemStates().
     */
    loadItem(uuid: string, revision?: string): Promise<ItemAndContent>;

    /** Save changes to the overview data and item content
     * back to the store. The @p source specifies whether
     * this update is a result of syncing changes
     * with another store or a local modification.
     *
     * Saving an item assigns a new revision to it.
     */
    saveItem(item: Item, source?: ChangeSource): Promise<void>;

    /** Fetch and decrypt the item's secure contents. */
    getContent(item: Item): Promise<ItemContent>;

    /** Fetch and decrypt item's secure contents and return
     * as a raw string - ie. without parsing the data and converting
     * to an ItemContent instance.
     */
    getRawDecryptedData(item: Item): Promise<string>;

    /** Retrieve the master encryption keys for this store. */
    listKeys(): Promise<key_agent.Key[]>;

    /** Update the encryption keys in this store. */
    saveKeys(keys: key_agent.Key[], hint: string): Promise<void>;

    /** Permanently delete all data from the store.
     */
    clear(): Promise<void>;

    /** Return the user-provided password hint. */
    passwordHint(): Promise<string>;
}

/** Represents a pair of revision strings for
 * the same revision of an item in the local and cloud
 * stores.
 *
 * Item revision formats are specific to the store
 * implementation, so the same revision of an item
 * that is synced between two stores (eg. a local
 * store in IndexedDB in the browser and a cloud store
 * in Dropbox) will have different revision strings.
 */
export interface RevisionPair {
    /** The revision of the item in the local store. */
    local: string;
    /** The corresponding revision of the item in the
     * external store.
     */
    external: string;
}

/** SyncableStore provides methods for storing metadata
 * to enable syncing this store with other stores.
 */
export interface SyncableStore extends Store {
    /** Stores which revision of an item in a store (identified by @p storeID) was
     * last synced with this store.
     */
    setLastSyncedRevision(
        item: Item,
        storeID: string,
        revision?: RevisionPair
    ): Promise<void>;

    /** Retrieves the revision of an item in a store (identified by @p storeID)
     * which was last synced with this store.
     */
    getLastSyncedRevision(uuid: string, storeID: string): Promise<RevisionPair>;

    /** Retrieve a map of (item ID -> last-synced revision) for
     * all items in the store which have previously been synced with
     * @p storeID.
     */
    lastSyncRevisions(storeID: string): Promise<Map<string, RevisionPair>>;
}

/** Copy an item and its contents, using @p uuid as the ID for
 * the new item. If new item is associated with @p store.
 *
 * The returned item will have {itemAndContent.item.revision} as
 * its parentRevision and a null revision property.
 */
export function cloneItem(
    itemAndContent: ItemAndContent,
    uuid: string,
    store?: Store
) {
    let item = itemAndContent.item;

    // item ID and sync data
    let clonedItem = new Item(store, uuid);
    clonedItem.parentRevision = item.revision;

    // core metadata
    clonedItem.folderUuid = item.uuid;
    clonedItem.faveIndex = item.faveIndex;
    clonedItem.trashed = item.trashed;
    clonedItem.updatedAt = item.updatedAt;
    clonedItem.createdAt = item.createdAt;
    clonedItem.typeName = item.typeName;
    clonedItem.title = item.title;
    clonedItem.openContents = item.openContents;
    clonedItem.locations = <string[]>clone(item.locations);
    clonedItem.account = item.account;

    // item content
    let clonedContent = <ItemContent>clone(itemAndContent.content);
    clonedItem.setContent(clonedContent);

    return { item: clonedItem, content: clonedContent };
}

/** Generate a content-based revision ID for an item.
 * Revision IDs are a hash of the item's parent revision,
 * plus all of its current content.
 */
export function generateRevisionId(item: ItemAndContent) {
    var contentMetadata = {
        uuid: item.item.uuid,
        parentRevision: item.item.parentRevision,

        title: item.item.title,
        updatedAt: item.item.updatedAt,
        createdAt: item.item.createdAt,
        typeName: item.item.typeName,
        openContents: item.item.openContents,
        folderUuid: item.item.folderUuid,
        faveIndex: item.item.faveIndex,
        trashed: item.item.trashed,

        content: item.content,
    };
    var contentString = JSON.stringify(contentMetadata);
    var hasher = new sha1.SHA1();
    var srcBuf = collectionutil.bufferFromString(contentString);
    var digest = new Int32Array(5);
    hasher.hash(srcBuf, digest);
    return collectionutil.hexlify(digest);
}

/** Provides a default implementation of ItemStore.listItemStates() using
 * ItemStore.listItems(). Since listItemStates() returns a subset of
 * the information returned by listItems(), stores may be able to
 * provide more efficient implementations.
 */
export function itemStates(store: Store): Promise<ItemState[]> {
    return store.listItems({ includeTombstones: true }).then(items =>
        items.map(item => ({
            uuid: item.uuid,
            revision: item.revision,
            deleted: item.isTombstone(),
        }))
    );
}

/** Decrypt the encryption keys for @p store and add
 * the keys to @p agent.
 */
export function unlockStore(
    store: Store,
    agent: key_agent.KeyAgent,
    password: string
): Promise<void> {
    return store
        .listKeys()
        .then(keys => {
            if (keys.length == 0) {
                throw new Error(
                    'Unable to unlock store: No encryption keys have been saved'
                );
            }
            return key_agent.decryptKeys(keys, password);
        })
        .then(keys => {
            let savedKeys: Promise<void>[] = [];
            keys.forEach(key => {
                savedKeys.push(agent.addKey(key.id, key.key));
            });
            return asyncutil.eraseResult(Promise.all(savedKeys));
        });
}
