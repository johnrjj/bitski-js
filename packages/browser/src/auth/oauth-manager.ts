import {
  AuthorizationError,
  AuthorizationNotifier,
  AuthorizationRequest,
  AuthorizationRequestHandler,
  AuthorizationResponse,
  AuthorizationServiceConfiguration,
  BaseTokenRequestHandler,
  FetchRequestor,
  GRANT_TYPE_AUTHORIZATION_CODE,
  GRANT_TYPE_REFRESH_TOKEN,
  RedirectRequestHandler,
  TokenRequest,
  TokenRequestHandler,
  TokenResponse,
} from '@openid/appauth';

import { NoHashQueryStringUtils } from '../utils/no-hash-query-string-utils';
import { PopupRequestHandler } from './popup-handler';
import { UserInfoResponse } from './user';

const BITSKI_USER_API_HOST = 'https://www.bitski.com/v1';

const DEFAULT_CONFIGURATION = new AuthorizationServiceConfiguration({
  authorization_endpoint: 'https://account.bitski.com/oauth2/auth',
  revocation_endpoint: '',
  token_endpoint: 'https://account.bitski.com/oauth2/token',
  userinfo_endpoint: 'https://account.bitski.com/userinfo',
});

const DEFAULT_SCOPES = ['openid'];

/**
 * Responsible for submitting requests to our OAuth server.
 */
export class OAuthManager {

  // Represents the oauth endpoints and settings
  public configuration: AuthorizationServiceConfiguration;

  protected clientId: string;
  protected redirectUri: string;
  protected tokenHandler: TokenRequestHandler;
  protected notifier: AuthorizationNotifier;
  protected authHandler?: AuthorizationRequestHandler;
  protected pendingResolver?: { fulfill: (value: AuthorizationResponse) => void, reject: (error: Error) => void };
  protected scopes: string[];

  /**
   * Create a new OAuth Manager
   * @param options Settings object
   * @param options.clientId string: The client id to use for various requests
   * @param options.redirectUri string: The redirect URI to use for responding to auth requests
   * @param options.configuration AuthorizationServiceConfiguration (optional): The configuration for the OAuth server
   * @param options.additionalScopes string[] (optional): Additional scopes to request outside of openid.
   * Default is offline. Pass an empty array to only request openid.
   */
  constructor(options: any) {
    this.clientId = options.clientId;
    this.redirectUri = options.redirectUri;
    this.configuration = options.configuration || DEFAULT_CONFIGURATION;
    const additionalScopes = options.additionalScopes || ['offline'];
    this.scopes = DEFAULT_SCOPES;
    this.scopes.push(additionalScopes);
    this.tokenHandler = new BaseTokenRequestHandler(new FetchRequestor());
    this.notifier = new AuthorizationNotifier();
    this.notifier.setAuthorizationListener(this.didCompleteAuthorizationFlow.bind(this));
  }

  /**
   * Trigger a popup sign in flow (the default)
   */
  public signInPopup(): Promise<TokenResponse> {
    const promise = new Promise<AuthorizationResponse>((fulfill, reject) => {
      this.pendingResolver = { fulfill, reject };
    });
    this.authHandler = new PopupRequestHandler();
    this.authHandler.setAuthorizationNotifier(this.notifier);
    const request = this.createAuthRequest();
    this.authHandler.performAuthorizationRequest(this.configuration, request);
    return promise.then((response) => {
      return this.requestAccessToken(response.code);
    });
  }

  /**
   * Trigger a redirect sign in flow. Promise should never fulfill, as you will be redirected.
   */
  public signInRedirect(): Promise<AuthorizationResponse> {
    const promise = new Promise<AuthorizationResponse>((fulfill, reject) => {
      this.pendingResolver = { fulfill, reject };
    });
    this.authHandler = new RedirectRequestHandler(undefined, new NoHashQueryStringUtils());
    this.authHandler.setAuthorizationNotifier(this.notifier);
    const request = this.createAuthRequest();
    this.authHandler.performAuthorizationRequest(this.configuration, request);
    // Since this method redirects the whole window, the promise will
    // likely never complete unless we encounter an error.
    return promise;
  }

  /**
   * Attempt to finalize auth request from a redirect flow. Called from your redirect url once you've been
   * redirected back.
   */
  public redirectCallback(): Promise<TokenResponse> {
    const promise = new Promise<AuthorizationResponse>((fulfill, reject) => {
      this.pendingResolver = { fulfill, reject };
    });
    this.authHandler = new RedirectRequestHandler(undefined, new NoHashQueryStringUtils());
    this.authHandler.setAuthorizationNotifier(this.notifier);
    this.authHandler.completeAuthorizationRequestIfPossible();
    return promise.then((response) => {
      return this.requestAccessToken(response.code);
    });
  }

  /**
   * Exchange an authorization code for an access token
   * @param code The authorization code to exchange
   */
  public requestAccessToken(code: string): Promise<TokenResponse> {
    const request = this.createTokenRequest(code);
    return this.tokenHandler.performTokenRequest(this.configuration, request);
  }

  /**
   * Request a new access token from a previous refresh token
   * @param refreshToken The refresh token to use for authorization
   */
  public refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const request = this.createRefreshTokenRequest(refreshToken);
    return this.tokenHandler.performTokenRequest(this.configuration, request);
  }

  /**
   * Submit a sign out request on the oauth endpoint
   * @param accessToken The access token to sign out with
   */
  public requestSignOut(accessToken: string): Promise<any> {
    return fetch(`${BITSKI_USER_API_HOST}/logout`, {
        headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        method: 'POST',
    }).then((response) => {
        return this.parseResponse(response);
    });
  }

  /**
   * Request a user's profile from the oauth server
   * @param accessToken The access token for the user
   */
  public requestUserInfo(accessToken: string): Promise<UserInfoResponse> {
    const userInfoEndpoint = this.configuration.userInfoEndpoint;
    if (!userInfoEndpoint) {
      return Promise.reject(new Error('Could not find userinfo endpoint'));
    }
    return fetch(userInfoEndpoint, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    }).then((response) => {
      return this.parseResponse(response);
    }).then((parsed) => {
      return parsed as UserInfoResponse;
    });
  }

  /**
   * Parses a Fetch Response to extract either the result or the error
   * @param response the fetch response to parse
   */
  protected parseResponse(response: Response): Promise<any> {
    return response.json().catch((jsonParseError) => {
      throw new Error('Unknown error. Could not parse error response');
    }).then((json) => {
      if (response.status >= 200 && response.status < 300) {
          return json;
      } else {
        if (json && json.error && json.error.message) {
            throw new Error(json.error.message);
        } else if (json && json.error) {
            throw new Error(json.error);
        } else {
            throw new Error('Unknown error');
        }
      }
    });
  }

  /**
   * Internal callback from our Auth Request handler. Passes the response through to a cached promise if it exists.
   * @param request The original auth request
   * @param response The auth response if it was successful
   * @param errorResponse The error response if it failed
   */
  protected didCompleteAuthorizationFlow(request: AuthorizationRequest, response: AuthorizationResponse | null, errorResponse: AuthorizationError | null) {
    if (this.pendingResolver) {
      if (response) {
        this.pendingResolver.fulfill(response);
        this.pendingResolver = undefined;
      } else if (errorResponse) {
        const error = new Error(errorResponse.error);
        this.pendingResolver.reject(error);
        this.pendingResolver = undefined;
      }
    }
  }

  /**
   * Factory method to create an auth request
   */
  protected createAuthRequest() {
    return new AuthorizationRequest({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: AuthorizationRequest.RESPONSE_TYPE_CODE,
      scope: this.scopes.join(' '),
    }, undefined, false);
  }

  /**
   * Factory method to create a token request with a refresh token
   * @param refreshToken Refresh token to use
   */
  protected createRefreshTokenRequest(refreshToken: string): TokenRequest {
    return new TokenRequest({
      client_id: this.clientId,
      grant_type: GRANT_TYPE_REFRESH_TOKEN,
      redirect_uri: this.redirectUri,
      refresh_token: refreshToken,
    });
  }

  /**
   * Factory method to create a token request with an auth code
   * @param code The auth code to use
   */
  protected createTokenRequest(code: string): TokenRequest {
    return new TokenRequest({
      client_id: this.clientId,
      code,
      grant_type: GRANT_TYPE_AUTHORIZATION_CODE,
      redirect_uri: this.redirectUri,
    });
  }

}