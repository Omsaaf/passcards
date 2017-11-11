import react = require('react');
import style = require('ts-style');
import underscore = require('underscore');
import urijs = require('urijs');

import { div, img } from './base/dom_factory';
import err_util = require('../lib/base/err_util');
import event_stream = require('../lib/base/event_stream');
import image = require('../lib/siteinfo/image');
import key_value_store = require('../lib/base/key_value_store');
import site_info = require('../lib/siteinfo/site_info');
import url_util = require('../lib/base/url_util');

var theme = style.create(
    {
        action: {
            cursor: 'pointer',
        },

        container: {
            width: 48,
            height: 48,
            backgroundColor: 'white',
            border: '1px solid #bbb',

            // make icon circular
            borderRadius: '50%',
            overflow: 'hidden',

            focused: {
                boxShadow: '0px 0px 2px 2px rgba(0,0,0,0.2)',
            },

            flexShrink: 0,

            // fix an issue in WebKit / Blink (tested in iOS 8,
            // Chrome 39 on Linux) where the border-radius clipping
            // would not be applied to the child <img> for the icon
            // when a transition was being applied to a nearby element.
            //
            // Forcing the icon container and its descendants into their
            // own compositing layer resolves the issue
            //
            // Possibly related to https://code.google.com/p/chromium/issues/detail?id=430184
            transform: 'translate3d(0,0,0)',
        },

        icon: {
            // horizontally center icon in outline.
            // Limit to max size of 48x48 but prefer
            // intrinsic size
            maxWidth: 48,
            maxHeight: 48,
            marginLeft: 'auto',
            marginRight: 'auto',

            // vertically center icon in outline
            display: 'block',
            position: 'relative',
            top: '50%',
            transform: 'translateY(-50%)',

            // for images that are smaller than the 48px max width,
            // make the image circular, so that the image and the
            // container have the same shape.
            //
            // If the image already fills the container then
            // the container's border-radius will make it circular.
            rounded: {
                borderRadius: '50%',
            },
        },
    },
    __filename
);

/** Fetch state for an icon returned by IconProvider query.
 */
export enum IconFetchState {
    Fetching, ///< Icons associated with the URL are currently being fetched
    NoIcon, ///< The fetch completed but no matching icon was found
    Found, ///< The fetch completed and found an icon
}

export interface Icon {
    iconUrl: string;
    state: IconFetchState;
    width: number;
    height: number;
}

/** Provides icon URLs for websites. IconProvider handles fetching
 * and caching of icons to represent items.
 *
 * Call query(url) to lookup the icon associated with a given URL.
 * If a cached icon is available, it will be returned, otherwise a lookup
 * will be triggered.
 *
 * When the icon associated with a previously looked up URL changes,
 * the updated event stream will emit the normalized URL.
 */
export interface IconProvider {
    /** Stream of icon update events.
     * Emits the normalized URL (using url_util.normalize) of the location
     * when the icon for that location is updated.
     */
    updated: event_stream.EventStream<string>;

    /** Fetch the icon for a given URL. */
    query(url: string): Icon;

    /** Returns true if a given @p updateUrl from IconProvider.updated
     * matches an item with location @p location.
     *
     * The update URL may not match the original item location due to
     * normalization or if a fallback URL has been used to find
     * an icon for the item.
     */
    updateMatches(updateUrl: string, itemUrl: string): boolean;
}

/** Interface for an image loader function
 * which loads data from an image and returns
 * a URL that can later be used with an <img>
 * element to display the image.
 */
export interface ImageLoader {
    (data: Uint8Array): string;
}

// default image loader implementation which uses
// URL.createObjectURL() to load an image's data
function domImageLoader(data: Uint8Array) {
    var iconInfo = image.getInfo(data);
    var mimeType = iconInfo
        ? image.mimeType(iconInfo.type)
        : 'application/octet-stream';
    let blob = new Blob([data], { type: mimeType });
    return URL.createObjectURL(blob);
}

/** An IconProvider implementation which fetches icons
 * from a SiteInfoProvider and caches the results
 * in a local store (eg. an IndexedDB store) for
 * future use.
 */
export class BasicIconProvider implements IconProvider {
    // cache of item URL -> item icon metadata
    private tempCache: Map<string, Icon>;

    // persistent cache of item URL -> item icon
    // image data
    private diskCache: Cache;

    private provider: site_info.SiteInfoProvider;
    private iconSize: number;
    private loadImage: ImageLoader;

    public static LOADING_ICON = 'dist/icons/loading.png';
    private static DEFAULT_ICON = 'dist/icons/default.png';

    updated: event_stream.EventStream<string>;

    /** Create an icon provider which uses @p provider to fetch
     * icon data. @p iconSize specifies the size of icon to make from
     * the available icons for a given URL.
     *
     * @param cacheStore A key/value store to use for persisting fetched icons
     * @param provider A provider to query for icons for a given domain
     * @param iconSize The preferred size for icons generated by the provider.
     *                 Depending on the images that can be retrieved for a URL,
     *                 the actual icon image may be larger or smaller than the preferred
     *                 size.
     */
    constructor(
        cacheStore: key_value_store.ObjectStore,
        provider: site_info.SiteInfoProvider,
        iconSize: number,
        imageLoader?: ImageLoader
    ) {
        this.tempCache = new Map<string, Icon>();
        this.diskCache = new Cache(cacheStore);
        this.provider = provider;
        this.iconSize = iconSize;
        this.updated = new event_stream.EventStream<string>();
        this.loadImage = imageLoader;

        if (!this.loadImage) {
            this.loadImage = domImageLoader;
        }

        // increase the number of max listeners since we will have
        // one listener for each visible icon
        this.updated.maxListeners = 100;

        this.provider.updated.listen(url => {
            this.queryProviderForIcon(
                url,
                false /* query only, do not start a lookup */
            );
        });
    }

    updateMatches(updateUrl: string, itemUrl: string) {
        itemUrl = url_util.normalize(itemUrl);
        return (
            updateUrl == itemUrl ||
            updateUrl == this.fallbackUrlForIcon(itemUrl)
        );
    }

    query(url: string): Icon {
        url = url_util.normalize(url);

        if (url.length == 0) {
            return {
                iconUrl: BasicIconProvider.DEFAULT_ICON,
                state: IconFetchState.NoIcon,
                width: 48,
                height: 48,
            };
        }

        if (this.tempCache.get(url)) {
            var cachedIcon = this.tempCache.get(url);
            if (cachedIcon.state == IconFetchState.NoIcon) {
                var fallbackUrl = this.fallbackUrlForIcon(url);
                if (this.tempCache.get(fallbackUrl)) {
                    return this.tempCache.get(fallbackUrl);
                }
            }
            return cachedIcon;
        } else {
            var icon: Icon = {
                iconUrl: BasicIconProvider.LOADING_ICON,
                state: IconFetchState.Fetching,
                width: 48,
                height: 48,
            };
            this.tempCache.set(url, icon);

            this.diskCache
                .query(url)
                .then(entry => {
                    if (entry) {
                        this.updateCacheEntry(url, entry.icons);
                    } else {
                        this.queryProviderForIcon(url);
                    }
                })
                .catch(err => {
                    this.queryProviderForIcon(url);
                });

            return icon;
        }
    }

    // query icon provider for icon data for a URL and
    // update the local caches if a result is available.
    //
    // 'lookup' specifies whether the icon provider should
    // perform a (usually remote) lookup or just return
    // the status of any lookups which have already been
    // triggered
    private queryProviderForIcon(url: string, lookup = true) {
        let lookupResult: site_info.QueryResult;
        if (lookup) {
            lookupResult = this.provider.lookup(url);
        } else {
            lookupResult = this.provider.status(url);
        }

        if (lookupResult.info.icons.length > 0) {
            // cache icons for future use
            this.diskCache
                .insert(url, {
                    icons: lookupResult.info.icons,
                })
                .catch(err => {
                    console.warn(
                        'Caching icons for URL',
                        url,
                        'failed',
                        err.message
                    );
                });
        }

        if (lookupResult.state === site_info.QueryState.Ready) {
            this.updateCacheEntry(url, lookupResult.info.icons);
        }

        // free icon data
        this.provider.forget(url);
    }

    private updateCacheEntry(url: string, icons: site_info.Icon[]) {
        var icon = this.tempCache.get(url);
        var selectedIcon = this.makeIconUrl(icons, this.iconSize);
        icon.iconUrl = selectedIcon.url;
        if (icon.iconUrl != '') {
            icon.state = IconFetchState.Found;
            icon.width = selectedIcon.icon.width;
            icon.height = selectedIcon.icon.height;
        } else {
            icon.state = IconFetchState.NoIcon;
            icon.iconUrl = BasicIconProvider.DEFAULT_ICON;
            icon.width = 48;
            icon.height = 48;
        }
        this.updated.publish(url);

        if (icons.length == 0) {
            // if a query against the actual location returns no suitable icons,
            // try a query against the main domain
            var fallbackUrl = this.fallbackUrlForIcon(url);
            if (fallbackUrl && fallbackUrl != url) {
                this.query(this.fallbackUrlForIcon(url));
            }
        }
    }

    // Take a set of icons for a site, pick the best one for a given target
    // image width of @p minSize and return a blob URL for the image
    // data
    private makeIconUrl(icons: site_info.Icon[], minSize: number) {
        if (icons.length == 0) {
            return { url: '', icon: null };
        }

        var iconsBySize = underscore.sortBy(icons, icon => {
            return icon.width;
        });

        // try to find a square icon of the required-size
        var squareIcon: site_info.Icon;
        var nonSquareIcon: site_info.Icon;

        for (var i = 0; i < iconsBySize.length; i++) {
            var candidate = iconsBySize[i];
            if (candidate.width >= minSize) {
                if (candidate.width == candidate.height) {
                    squareIcon = squareIcon || candidate;
                } else {
                    nonSquareIcon = nonSquareIcon || candidate;
                }
            }
        }

        var icon = squareIcon || nonSquareIcon;
        if (!icon) {
            icon = iconsBySize[iconsBySize.length - 1];
        }

        return { url: this.loadImage(icon.data), icon: icon };
    }

    // Returns a fallback URL to try if querying an item's URL does
    // not return an icon.
    //
    // (eg. 'https://sub.domain.com/foo/bar' => 'https://www.domain.com')
    //
    // We use HTTPS here although there are many sites which do have secure
    // login pages but whoose main site is not reachable over HTTPS
    // due to an invalid certificate or simply lack of SSL support.
    //
    // We could try an HTTP-only variant of the lookup but this is open
    // to MITM spoofing if run from the user's system.
    //
    private fallbackUrlForIcon(url: string) {
        url = url_util.normalize(url);
        var parsedUrl = urijs(url);
        return 'https://www.' + parsedUrl.domain();
    }
}

interface CacheEntry {
    icons: site_info.Icon[];
}

class Cache {
    constructor(private store: key_value_store.ObjectStore) {}

    /** Look up the icons for @p url in the cache.
     * Resolves with the cache entry if found or undefined
     * if no such entry exists.
     */
    query(url: string): Promise<CacheEntry> {
        return this.withKey(url, key => {
            return this.store.get<CacheEntry>(key);
        });
    }

    insert(url: string, icons: CacheEntry): Promise<void> {
        return this.withKey(url, key => {
            return this.store.set(key, icons);
        });
    }

    clear(url: string): Promise<void> {
        return this.withKey(url, key => {
            return this.store.remove(key);
        });
    }

    private withKey<T>(
        url: string,
        f: (key: string) => Promise<T>
    ): Promise<T> {
        var key = urijs(url_util.normalize(url)).hostname();
        if (!key) {
            return Promise.reject<T>(new err_util.BaseError('Invalid URL'));
        }
        return f(key);
    }
}

export interface IconControlProps extends react.Props<void> {
    location: string;
    iconProvider: IconProvider;
    isFocused: boolean;
    onClick?: () => void;
    title?: string;
}

export class IconControl extends react.Component<IconControlProps, {}> {
    private iconUpdateListener: (url: string) => void;

    private setupIconUpdateListener(iconProvider: IconProvider) {
        if (!this.iconUpdateListener) {
            this.iconUpdateListener = url => {
                if (
                    this.props.location &&
                    this.props.iconProvider.updateMatches(
                        url,
                        this.props.location
                    )
                ) {
                    this.forceUpdate();
                }
            };
        }
        if (this.props.iconProvider) {
            this.props.iconProvider.updated.ignore(this.iconUpdateListener);
        }
        iconProvider.updated.listen(this.iconUpdateListener);
    }

    componentDidMount() {
        if (!this.iconUpdateListener) {
            this.setupIconUpdateListener(this.props.iconProvider);
        }
    }

    componentWillUnmount() {
        if (this.iconUpdateListener && this.props.iconProvider) {
            this.props.iconProvider.updated.ignore(this.iconUpdateListener);
        }
        this.iconUpdateListener = null;
    }

    componentWillReceiveProps(nextProps: IconControlProps) {
        this.setupIconUpdateListener(nextProps.iconProvider);
    }

    render() {
        var icon = this.props.iconProvider.query(this.props.location);
        var imgStyles: any[] = [theme.icon];
        if (icon.width < 48) {
            // make image rounded if it doesn't fill the container.
            // For images that do fill the container, we get smoother
            // anti-aliased rounding for the icon if we only
            // apply border-radius to the container and not to both
            // the container and the icon
            imgStyles.push(theme.icon.rounded);
        }

        var containerStyles: any[] = [theme.container];
        if (this.props.isFocused) {
            containerStyles.push(theme.container.focused);
        }
        if (this.props.onClick) {
            containerStyles.push(theme.action);
        }

        return div(
            style.mixin(containerStyles, {
                onClick: this.props.onClick,
                title: this.props.title,
            }),
            img(style.mixin(imgStyles, { ref: 'img', src: icon.iconUrl }))
        );
    }
}

type URLString = string;

export class FakeIconProvider implements IconProvider {
    private icons: Map<URLString, Icon>;

    updated: event_stream.EventStream<string>;

    constructor() {
        this.updated = new event_stream.EventStream<string>();
        this.icons = new Map<URLString, Icon>();
    }

    query(url: URLString): Icon {
        var icon = this.icons.get(url);
        if (icon) {
            return icon;
        } else {
            return {
                iconUrl: '',
                state: IconFetchState.NoIcon,
                width: 48,
                height: 48,
            };
        }
    }

    addIcon(url: URLString, icon: Icon) {
        this.icons.set(url, icon);
        this.updated.publish(url);
    }

    updateMatches(updateUrl: string, itemUrl: string) {
        return updateUrl == itemUrl;
    }
}

export var IconControlF = react.createFactory(IconControl);
