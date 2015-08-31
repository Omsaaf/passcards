import btoa = require('btoa');
import Q = require('q');
import url = require('url');

import assign = require('../lib/base/assign');
import crypto = require('../lib/base/crypto');

/** Opaque by stringify-able object representing
 * the credentials returned by a login attempt
 */
interface Credentials {
	accessToken: string;
}

/** Interface for handling the auth flow for a
 * cloud service.
 */
interface AuthFlow {
	/** Start the authentication process and return a promise
	 * for a set of credentials which is resolved once the login
	 * completes.
	 */
	authenticate(): Q.Promise<Credentials>;
}

interface AuthMessage {
	type: string; // 'auth-complete'
	credentials: Credentials;
}

/** Window features available for use with window.open() */
export interface WindowSettings {
	width?: number;
	height?: number;
	target?: string;
}

function windowSettingsToString(settings: WindowSettings): string {
	return Object.keys(settings).map(key => `${key}=${settings[key]}`).join(',');
}

interface OAuthFlowOptions {
	/** The OAuth authorization endpoint, which will present
	  * a screen asking for the user's consent to access their data.
	  */
    authServerURL: string;
	/** The URL that the OAuth authorization endpoint will redirect
	  * back to once authentication is complete.
	  */
    authRedirectURL?: string;
	/** Window features passed to window.open() for the
	  * popup window used to present the OAuth authorization dialog.
	  */
	windowSettings?: WindowSettings;
}

// Name of the local storage key which the auth
// window saves access tokens into in order
// to communicate them back to the main window.
const OAUTH_TOKEN_KEY = 'PASSCARDS_OAUTH_TOKEN';

/** Data structure used by auth window to store token data in
  * local storage
  */
interface TokenData {
	accessToken: string;
	state: string;
}

/** Drives the UI for OAuth 2.0 authentication for a cloud service
 * using the implicit grant (aka. 'token') authentication flow.
 *
 * This flow opens a popup window at a specified authorization URL,
 * waits for the user to complete authentication in that popup window
 * and then returns the credentials for use with API calls for that service.
 */
export class OAuthFlow implements AuthFlow {
	private options: OAuthFlowOptions;

	constructor(options: OAuthFlowOptions) {
		this.options = assign<OAuthFlowOptions>({}, {
			windowSettings: {}
		}, options);
	}

	authenticate() {
		let credentials = Q.defer<Credentials>();

		// open a window which displays the auth UI
		let authWindowSettings = windowSettingsToString(this.options.windowSettings);
		let target = '_blank';
		if ('target' in this.options.windowSettings) {
			target = this.options.windowSettings.target;
		}

		let parsedAuthURL = url.parse(this.options.authServerURL, true /* parse query string */);
		let state = crypto.randomBytes(16);
		parsedAuthURL.query.redirect_uri = this.options.authRedirectURL;
		parsedAuthURL.query.state = btoa(state);

		// clear any existing tokens stored in local storage
		// TODO - Encrypt this data with a random key so that it isn't usable
		// if not removed by the call to removeItem() once auth completes
		window.localStorage.removeItem(OAUTH_TOKEN_KEY);

		// clear search property so that query is reconstructed from parsedAuthURL.query
		parsedAuthURL.search = undefined;

		let authURL = url.format(parsedAuthURL);
		let authWindow: Window = window.open(authURL, target, authWindowSettings);

		// poll, waiting for auth to complete.
		// auth_receiver.ts stores the access token in local storage once
		// the auth flow completes
		let pollTimeout = setInterval(() => {
			let tokenDataStr = window.localStorage.getItem(OAUTH_TOKEN_KEY);
			if (tokenDataStr) {
				try {
					window.localStorage.removeItem(OAUTH_TOKEN_KEY);
					let tokenData = <TokenData>JSON.parse(tokenDataStr);

					let requiredFields = ['state', 'accessToken'];
					for (let field of requiredFields) {
						if (!tokenData[field]) {
							throw new Error(`Missing field "${field}" in token data`);
						}
					}

					let decodedState = atob(tokenData.state);
					if (decodedState === state) {
						credentials.resolve({
							accessToken: tokenData.accessToken
						});
					} else {
						credentials.reject(new Error('State mismatch'));
					}
				} catch (ex) {
					credentials.reject(`Failed to parse OAuth token data: ${ex.toString() }`);
				}
			}
		}, 200);

		authWindow.addEventListener('close', (e: CloseEvent) => {
			credentials.reject(new Error('Window closed before auth completed'));
		});

		credentials.promise.finally(() => {
			authWindow.close();
			clearTimeout(pollTimeout);
		});

		return credentials.promise;
	}
}
