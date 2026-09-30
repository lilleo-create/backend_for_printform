export type CdekConfig = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  isTest: boolean;
  isConfigured: boolean;
};

export function getCdekConfig(): CdekConfig {
  const isTest = process.env.CDEK_TEST_MODE === 'true';
  const clientId = process.env.CDEK_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.CDEK_CLIENT_SECRET?.trim() ?? '';

  return {
    baseUrl: isTest ? 'https://api.edu.cdek.ru' : 'https://api.cdek.ru',
    clientId,
    clientSecret,
    isTest,
    isConfigured: Boolean(clientId && clientSecret)
  };
}

export const assertCdekConfigured = () => {
  if (!getCdekConfig().isConfigured) throw new Error('CDEK_NOT_CONFIGURED');
};
