import type {
  ApiError,
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

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'include' });

  if (res.status === 401 && retry && accessToken && !path.startsWith('/auth/refresh')) {
    if (await refreshSession()) return request<T>(path, init, false);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({ error: 'bad_response', message: res.statusText }));
  if (!res.ok) throw new ApiRequestError(res.status, body as ApiError);
  return body as T;
}

function store(t: TokenResponse): TokenResponse {
  accessToken = t.accessToken;
  return t;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

/** Exchanges the refresh cookie for a new access token. Concurrent callers share one request. */
export function refreshSession(): Promise<TokenResponse | null> {
  refreshing ??= post<TokenResponse>('/auth/refresh')
    .then(store)
    .catch(() => {
      accessToken = null;
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
    accessToken = null;
  },
  me: () => request<PublicUser>('/auth/me'),
  mfaSetup: () => post<MfaSetupResponse>('/auth/mfa/setup'),
  mfaEnable: (code: string) => post<PublicUser>('/auth/mfa/enable', { code }),
  mfaDisable: (code: string, password: string) => post<PublicUser>('/auth/mfa/disable', { code, password }),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const issues = (err.body.details as { message: string }[] | undefined)?.map((d) => d.message);
    return issues?.length ? issues.join('. ') : err.body.message;
  }
  return 'Could not reach the server';
}
