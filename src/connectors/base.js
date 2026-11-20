// Connector contract — each chat-web platform implements this shape.
// The CLI/core only talks to targets (CDP) + these functions.

export const PLATFORM_HOSTS = {
  chatgpt: ['chatgpt.com'],
  gemini: ['gemini.google.com']
};

export function homeUrl(cfg, platform) {
  const conf = cfg.platforms[platform];
  if (conf?.homeUrl) return conf.homeUrl;
  return 'https://' + (PLATFORM_HOSTS[platform]?.[0] || 'chatgpt.com');
}

export function knownPlatform(platform) {
  return Boolean(PLATFORM_HOSTS[platform]);
}

export function defineConnector(impl) {
  return impl;
}
