import { env } from '../config/env';

const YANDEX_AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
const YANDEX_TOKEN_URL = 'https://oauth.yandex.ru/token';
const YANDEX_USER_INFO_URL = 'https://login.yandex.ru/info?format=json';
const YANDEX_AVATAR_BASE = 'https://avatars.yandex.net/get-yapic';

interface YandexTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface YandexUserInfo {
  id: string;
  login: string;
  real_name?: string;
  default_email?: string;
  default_avatar_id?: string;
}

export const yandexOAuthService = {
  getAuthUrl(): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.yandexClientId,
      redirect_uri: env.yandexCallbackUrl
    });
    return `${YANDEX_AUTHORIZE_URL}?${params.toString()}`;
  },

  async getUserProfile(code: string): Promise<{
    yandexId: string;
    email: string;
    name: string;
    avatarUrl: string | null;
  }> {
    const credentials = Buffer.from(`${env.yandexClientId}:${env.yandexClientSecret}`).toString('base64');

    const tokenRes = await fetch(YANDEX_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: env.yandexClientId,
        client_secret: env.yandexClientSecret,
        redirect_uri: env.yandexCallbackUrl
      }).toString()
    });

    if (!tokenRes.ok) {
      throw new Error('YANDEX_TOKEN_EXCHANGE_FAILED');
    }

    const { access_token } = (await tokenRes.json()) as YandexTokenResponse;

    const infoRes = await fetch(YANDEX_USER_INFO_URL, {
      headers: { 'Authorization': `OAuth ${access_token}` }
    });

    if (!infoRes.ok) {
      throw new Error('YANDEX_PROFILE_FETCH_FAILED');
    }

    const info = (await infoRes.json()) as YandexUserInfo;

    if (!info.id || !info.default_email) {
      throw new Error('YANDEX_PROFILE_INCOMPLETE');
    }

    const avatarUrl = info.default_avatar_id
      ? `${YANDEX_AVATAR_BASE}/${info.default_avatar_id}/islands-200`
      : null;

    return {
      yandexId: info.id,
      email: info.default_email,
      name: info.real_name ?? info.login,
      avatarUrl
    };
  }
};
