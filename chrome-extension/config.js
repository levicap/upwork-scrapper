// Upwork Scraper Extension — Configuration
// Edit this file to change extension settings. No UI needed.
// This file is loaded by both background.js (importScripts) and popup.html (<script>).

const EXT_CONFIG = {
  // Webhook endpoint to POST job data to
  WEBHOOK_URL: 'https://auto.moezzhioua.com/webhook/test',
  // Upwork search URL to scrape when Run Scrape is clicked
  SEARCH_URL: 'https://www.upwork.com/nx/search/jobs/?nbs=1&q=n8n',
  // Maximum number of jobs to pull per Run Scrape (paginates 10/page)
  MAX_JOBS: 30,
};
