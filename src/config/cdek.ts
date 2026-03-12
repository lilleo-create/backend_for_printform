export function getCdekConfig() {
  const isTest = process.env.CDEK_TEST_MODE !== 'false';

  return {
    baseUrl: isTest
      ? 'https://api.edu.cdek.ru'
      : 'https://api.cdek.ru',
    clientId: isTest
      ? 'wqGwiQx0gg8mLtiEKsUinjVSICCjtTEP'
      : (process.env.CDEK_CLIENT_ID ?? ''),
    clientSecret: isTest
      ? 'RmAmgvSgSl1yirlz9QupbzOJVqhCxcP5'
      : (process.env.CDEK_CLIENT_SECRET ?? ''),
    isTest
  };
}
