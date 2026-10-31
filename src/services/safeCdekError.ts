type ProviderError = { code?: unknown; additional_code?: unknown; message?: unknown };

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const safeText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, 300);
  if (/authorization|bearer|client_secret|access_token|password/i.test(text)) return '[REDACTED]';
  return text || null;
};

export const safeCdekError = (error: unknown, operation?: string) => {
  const source = record(error);
  const response = record(source.response);
  const data = record(response.data);
  const requests = Array.isArray(data.requests) ? data.requests : [];
  const providerErrors = requests.flatMap((request) => {
    const errors = record(request).errors;
    return Array.isArray(errors) ? errors : [];
  }).slice(0, 5).map((entry) => {
    const item = record(entry) as ProviderError;
    return {
      code: safeText(item.code),
      additionalCode: safeText(item.additional_code),
      message: safeText(item.message)
    };
  });
  const status = Number(response.status ?? source.status);
  return {
    operation: safeText(operation),
    message: safeText(source.message) ?? 'CDEK_REQUEST_FAILED',
    code: safeText(source.code),
    httpStatus: Number.isInteger(status) && status > 0 ? status : null,
    providerErrors
  };
};
