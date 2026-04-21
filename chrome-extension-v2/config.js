// Upwork Scraper v2 — Configuration
// Loaded by both background.js (importScripts) and popup.html (<script>).

const EXT_CONFIG_V2 = {
  // n8n webhook endpoint
  WEBHOOK_URL: 'https://n8n-production-3b5ff.up.railway.app/webhook/upwork-leads',

  // Default search URL (used when auto-scrape fires without an explicit query)
  SEARCH_URL: 'https://www.upwork.com/nx/search/jobs/?nbs=1&q=n8n',

  // Default search query term (parsed from SEARCH_URL if changed)
  SEARCH_QUERY: 'n8n',

  // Max jobs to collect per scrape run
  MAX_JOBS: 100,

  // Parallel jobs processed simultaneously (keep 3–5 to avoid rate-limits)
  QUEUE_CONCURRENCY: 3,

  // How long (ms) before stored tokens are considered stale → triggers re-read
  TOKEN_REFRESH_INTERVAL_MS: 8 * 60 * 1000,

  // Base delay (ms) between sequential API calls inside one job's processing
  API_DELAY_MS: 500,

  // Cooldown (ms) between auto-scrape runs for the same search URL
  AUTO_SCRAPE_COOLDOWN_MS: 5 * 60 * 1000,

  // How long (ms) a captured messages/rooms live token stays valid
  MSG_TOKEN_TTL_MS: 12 * 60 * 1000,

  // How long (ms) a captured getDetails live token stays valid
  DETAILS_TOKEN_TTL_MS: 10 * 60 * 1000,
};
