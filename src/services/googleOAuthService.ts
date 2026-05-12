import { google } from 'googleapis';
import { env } from '../config/env';

const createClient = () =>
  new google.auth.OAuth2(env.googleClientId, env.googleClientSecret, env.googleCallbackUrl);

export const googleOAuthService = {
  getAuthUrl(): string {
    return createClient().generateAuthUrl({
      access_type: 'offline',
      scope: ['profile', 'email'],
      prompt: 'select_account'
    });
  },

  async getUserProfile(code: string): Promise<{
    googleId: string;
    email: string;
    name: string;
    avatarUrl: string | null;
  }> {
    const client = createClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();

    if (!data.id || !data.email) {
      throw new Error('GOOGLE_PROFILE_INCOMPLETE');
    }

    return {
      googleId: data.id,
      email: data.email,
      name: data.name ?? data.email.split('@')[0],
      avatarUrl: data.picture ?? null
    };
  }
};
