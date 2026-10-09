import type {
  ApiError,
  ApiKey,
  CreateApiKeyRequest,
  CreatedApiKey,
  TradingHalt,
  Candle,
  Fill,
  Order,
  PlaceOrderRequest,
  Portfolio,
  Instrument,
  Timeframe,
  LoginRequest,
  LoginResponse,
  MfaSetupResponse,
  PublicUser,
  RegisterRequest,
  TokenResponse,
} from '@dta/shared';

const BASE = import.meta.env.VITE_API_URL ?? '';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
  }
}

// The access token lives only in memory; the refresh token is an httpOnly cookie the page cannot read.
let accessToken: string | null = null;
let refreshing: Promise<TokenResponse | null> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const tokenListeners = new Set<(token: string | null) => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

/** Notified whenever the access token changes, e.g. so the market stream can re-authenticate. */
export function onAccessToken(listener: (token: string | null) => void): () => void {
  tokenListeners.add(listener);
  return () => tokenListeners.delete(listener);
}

function setAccessToken(token: string | null, expiresIn?: number): void {
  accessToken = token;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  // Renew a minute before expiry so long-lived streams never see an expired token.
  if (token && expiresIn) refreshTimer = setTimeout(() => void refreshSession(), Math.max(5, expiresIn - 60) * 1000);
  for (const l of tokenListeners) l(token);
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'include' });

  if (res.status === 401 && retry && accessToken && !path.startsWith('/auth/refresh')) {
    if (await refreshSession()) return request<T>(path, init, false);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (body === null) throw new ApiRequestError(res.status, { error: 'bad_response', message: 'Unexpected response from the server' });
  if (!res.ok) throw new ApiRequestError(res.status, body as ApiError);
  return body as T;
}

function store(t: TokenResponse): TokenResponse {
  setAccessToken(t.accessToken, t.expiresIn);
  return t;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/** Exchanges the refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshSession(): Promise<TokenResponse | null> {
  refreshing ??= post<TokenResponse>('/auth/refresh')
    .then(store)
    .catch(() => {
      setAccessToken(null);
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export const api = {
  register: (body: RegisterRequest) => post<TokenResponse>('/auth/register', body).then(store),
  login: async (body: LoginRequest) => {
    const res = await post<LoginResponse>('/auth/login', body);
    if (res.status === 'ok') store(res);
    return res;
  },
  verifyMfa: (mfaToken: string, code: string) =>
    post<TokenResponse>('/auth/mfa/verify', { mfaToken, code }).then(store),
  logout: async () => {
    await post<void>('/auth/logout');
    setAccessToken(null);
  },
  me: () => request<PublicUser>('/auth/me'),
  mfaSetup: () => post<MfaSetupResponse>('/auth/mfa/setup'),
  mfaEnable: (code: string) => post<PublicUser>('/auth/mfa/enable', { code }),
  mfaDisable: (code: string, password: string) => post<PublicUser>('/auth/mfa/disable', { code, password }),
  instruments: () => request<Instrument[]>('/market/instruments'),
  candles: (symbol: string, timeframe: Timeframe, limit = 500) =>
    request<Candle[]>(`/market/candles?${new URLSearchParams({ symbol, timeframe, limit: String(limit) })}`),
  portfolio: () => request<Portfolio>('/portfolio'),
  orders: (status: 'open' | 'closed' | 'all' = 'all') => request<Order[]>(`/orders?status=${status}&limit=100`),
  fills: () => request<Fill[]>('/fills?limit=100'),
  placeOrder: (body: PlaceOrderRequest) => post<Order>('/orders', body),
  cancelOrder: (id: string) => request<Order>(`/orders/${id}`, { method: 'DELETE' }),
  halts: () => request<TradingHalt[]>('/halts'),
  apiKeys: () => request<ApiKey[]>('/api-keys'),
  createApiKey: (body: CreateApiKeyRequest) => post<CreatedApiKey>('/api-keys', body),
  revokeApiKey: (id: string) => request<void>(`/api-keys/${id}`, { method: 'DELETE' }),
};

export function marketSocketUrl(): string {
  const base = new URL(BASE || window.location.origin);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = '/ws/market';
  return base.toString();
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const issues = (err.body.details as { message: string }[] | undefined)?.map((d) => d.message);
    return issues?.length ? issues.join('. ') : err.body.message;
  }
  return 'Could not reach the server';
}
