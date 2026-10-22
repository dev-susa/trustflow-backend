export function getCorsOrigin(nodeEnv = process.env.NODE_ENV, configured = process.env.CORS_ORIGIN) {
  const origins = configured
    ?.split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
  if (nodeEnv === 'production' && (!origins?.length || origins.includes('*'))) {
    throw new Error('CORS_ORIGIN must contain an explicit origin in production');
  }
  return origins?.length ? origins : '*';
}
