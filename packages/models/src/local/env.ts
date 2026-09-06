export type EnvScrubResult = {
  removed: Readonly<Record<string, string>>;
};

const NAMED_CREDENTIAL_VARS = new Set([
  "OPENAI_API_KEY",
  "OPENAI_ORG_ID",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GEMINI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "HUGGINGFACE_API_KEY",
  "GITHUB_TOKEN",
  "OPENROUTER_API_KEY",
  "CEREBRAS_API_KEY",
  "NVIDIA_API_KEY",
  "BEDROCK_API_KEY",
]);

const PREFIXES = [
  "OPENAI_",
  "ANTHROPIC_",
  "GOOGLE_",
  "GEMINI_",
  "AZURE_",
  "AWS_SECRET",
  "AWS_ACCESS",
  "AWS_SESSION",
  "BEDROCK_",
  "CLOUDFLARE_",
  "COHERE_",
  "GROQ_",
  "MISTRAL_",
  "TOGETHER_",
  "XAI_",
  "DEEPSEEK_",
  "FIREWORKS_",
  "PERPLEXITY_",
  "VERTEX_",
  "GCP_",
  "OPENROUTER_",
  "CEREBRAS_",
  "HUGGINGFACE_",
  "HF_",
  "GITHUB_",
  "NVIDIA_",
];

const PI_CREDENTIAL_MARKERS = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"];
const PI_SAFE = new Set(["PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "PI_OFFLINE"]);

export function isProviderCredentialEnv(name: string): boolean {
  if (NAMED_CREDENTIAL_VARS.has(name)) {
    return true;
  }
  for (const prefix of PREFIXES) {
    if (name.startsWith(prefix)) {
      return true;
    }
  }
  if (name.startsWith("PI_") && !PI_SAFE.has(name)) {
    const upper = name.toUpperCase();
    return PI_CREDENTIAL_MARKERS.some((marker) => upper.includes(marker));
  }
  return false;
}

export function scrubProviderCredentialEnv(env: NodeJS.ProcessEnv = process.env): EnvScrubResult {
  const removed: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    if (!isProviderCredentialEnv(key)) {
      continue;
    }
    const current = env[key];
    if (current !== undefined) {
      removed[key] = current;
    }
    Reflect.deleteProperty(env, key);
  }
  env.PI_SKIP_VERSION_CHECK = "1";
  env.PI_TELEMETRY = "0";
  return { removed };
}
