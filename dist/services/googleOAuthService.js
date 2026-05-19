"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.googleOAuthService = void 0;
const googleapis_1 = require("googleapis");
const env_1 = require("../config/env");
const createClient = () => new googleapis_1.google.auth.OAuth2(env_1.env.googleClientId, env_1.env.googleClientSecret, env_1.env.googleCallbackUrl);
exports.googleOAuthService = {
    getAuthUrl() {
        return createClient().generateAuthUrl({
            access_type: 'offline',
            scope: ['profile', 'email'],
            prompt: 'select_account'
        });
    },
    async getUserProfile(code) {
        const client = createClient();
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);
        const oauth2 = googleapis_1.google.oauth2({ version: 'v2', auth: client });
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
