import { env } from '../config/env';

const AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
const TOKEN_URL = 'https://oauth.yandex.ru/token';
const PROFILE_URL = 'https://login.yandex.ru/info?format=json';
const REQUEST_TIMEOUT_MS = 10_000;

const requireYandexConfig = () => {
  if (!env.yandexClientId || !env.yandexClientSecret || !env.yandexCallbackUrl) {
    throw new Error('OAUTH_NOT_CONFIGURED');
  }
};

const fetchJson = async (url: string, init: RequestInit): Promise<Record<string, unknown>> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload: unknown;

    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('YANDEX_MALFORMED_RESPONSE');
    }

    if (!response.ok || !payload || typeof payload !== 'object') {
      throw new Error('YANDEX_HTTP_ERROR');
    }

    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('YANDEX_REQUEST_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

export const yandexOAuthService = {
  getAuthUrl(state: string): string {
    requireYandexConfig();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.yandexClientId,
      redirect_uri: env.yandexCallbackUrl,
      state
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  },

  async getUserProfile(code: string): Promise<{
    yandexId: string;
    email: string;
    name: string;
    avatarUrl: string | null;
  }> {
    requireYandexConfig();

    const token = await fetchJson(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: env.yandexClientId,
        client_secret: env.yandexClientSecret,
        redirect_uri: env.yandexCallbackUrl
      }).toString()
    });

    const accessToken = typeof token.access_token === 'string' ? token.access_token : '';
    if (!accessToken) throw new Error('YANDEX_TOKEN_EXCHANGE_FAILED');

    const profile = await fetchJson(PROFILE_URL, {
      headers: { Authorization: `OAuth ${accessToken}` }
    });

    const yandexId = typeof profile.id === 'string' ? profile.id.trim() : '';
    const email = typeof profile.default_email === 'string' ? profile.default_email.trim() : '';
    if (!yandexId || !email) throw new Error('YANDEX_PROFILE_INCOMPLETE');

    const login = typeof profile.login === 'string' ? profile.login.trim() : '';
    const realName = typeof profile.real_name === 'string' ? profile.real_name.trim() : '';
    const avatarId = typeof profile.default_avatar_id === 'string' ? profile.default_avatar_id.trim() : '';

    return {
      yandexId,
      email,
      name: realName || login || email.split('@')[0],
      avatarUrl: avatarId ? `https://avatars.yandex.net/get-yapic/${avatarId}/islands-200` : null
    };
  }
};
