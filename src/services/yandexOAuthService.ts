import { env } from '../config/env';

const YANDEX_AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
const YANDEX_TOKEN_URL = 'https://oauth.yandex.ru/token';
const YANDEX_USER_INFO_URL = 'https://login.yandex.ru/info?format=json';
const YANDEX_AVATAR_BASE = 'https://avatars.yandex.net/get-yapic';

interface YandexTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

interface YandexUserInfo {
  id: string;
  login: string;
  real_name?: string;
  default_email?: string;
  default_avatar_id?: string;
  default_phone?: { id: number; number: string } | null;
}

export const yandexOAuthService = {
  getAuthUrl(): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.yandexClientId,
      redirect_uri: env.yandexCallbackUrl,
      scope: 'login:info login:email'
    });
    return `${YANDEX_AUTHORIZE_URL}?${params.toString()}`;
  },

  async getUserProfile(code: string): Promise<{
    yandexId: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    phone: string | null;
  }> {
    const tokenRes = await fetch(YANDEX_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: env.yandexClientId,
        client_secret: env.yandexClientSecret,
        redirect_uri: env.yandexCallbackUrl
      }).toString()
    });

    const tokenData = (await tokenRes.json()) as YandexTokenResponse;

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[Yandex OAuth] Token exchange failed', {
        status: tokenRes.status,
        error: tokenData.error,
        error_description: tokenData.error_description
      });
      throw new Error('YANDEX_TOKEN_EXCHANGE_FAILED');
    }

    const infoRes = await fetch(YANDEX_USER_INFO_URL, {
      headers: { 'Authorization': `OAuth ${tokenData.access_token}` }
    });

    if (!infoRes.ok) {
      console.error('[Yandex OAuth] Profile fetch failed', { status: infoRes.status });
      throw new Error('YANDEX_PROFILE_FETCH_FAILED');
    }

    const info = (await infoRes.json()) as YandexUserInfo;

    if (!info.id || !info.default_email) {
      console.error('[Yandex OAuth] Profile incomplete', { id: info.id, hasEmail: !!info.default_email });
      throw new Error('YANDEX_PROFILE_INCOMPLETE');
    }

    const avatarUrl = info.default_avatar_id
      ? `${YANDEX_AVATAR_BASE}/${info.default_avatar_id}/islands-200`
      : null;

    const phone = info.default_phone?.number ?? null;

    return {
      yandexId: info.id,
      email: info.default_email,
      name: info.real_name ?? info.login,
      avatarUrl,
      phone
    };
  }
};
