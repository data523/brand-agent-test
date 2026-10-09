export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseJsonEnv(name, fallback = {}) {
  try { return JSON.parse(process.env[name] || '') || fallback; }
  catch { return fallback; }
}

export function config() {
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseSecretKey) throw new Error('Missing required environment variable: SUPABASE_SECRET_KEY');
  return {
    openaiApiKey: required('OPENAI_API_KEY'),
    openaiBaseUrl: 'https://openrouter.ai/api/v1',
    queryModel: process.env.OPENAI_QUERY_MODEL || 'openai/gpt-5.6-luna',
    answerModel: process.env.OPENAI_ANSWER_MODEL || 'openai/gpt-5.6-terra',
    visionModel: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_ANSWER_MODEL || 'openai/gpt-5.6-terra',
    freeVisionModel: process.env.OPENAI_FREE_VISION_MODEL || 'google/gemini-2.0-flash-exp:free',
    embedModel: process.env.OPENAI_EMBED_MODEL || 'openai/text-embedding-3-small',
    nemotronApiKey: process.env.NVIDIA_API_KEY || '',
    nemotronBaseUrl: process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    nemotronModel: process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b',
    nemotronMode: 'shadow',
    slackBotToken: process.env.SLACK_BOT_TOKEN || '',
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET || '',
    supabaseUrl: required('SUPABASE_URL'),
    supabaseSecretKey,
    adminSecret: required('ADMIN_SECRET'),
    defaultBrandId: process.env.DEFAULT_BRAND_ID || '',
    googleServiceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    googleServiceAccountPrivateKey: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    googleDriveFolderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
    documentParserSecret: process.env.DOCUMENT_PARSER_SECRET || '',
    slackChannelBrandMap: parseJsonEnv('SLACK_CHANNEL_BRAND_MAP', {})
  };
}
