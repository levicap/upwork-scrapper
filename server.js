const express = require('express');
const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// Set Chrome path for production environments
if (process.env.NODE_ENV === 'production' && !process.env.CHROME_PATH) {
  // Try to use Puppeteer's bundled Chrome first
  try {
    const executablePath = puppeteer.executablePath();
    if (fs.existsSync(executablePath)) {
      process.env.CHROME_PATH = executablePath;
      console.log(`✅ Using Puppeteer's Chrome at: ${executablePath}`);
    }
  } catch (e) {
    console.log('⚠️ Puppeteer Chrome not found, trying system Chrome...');
  }
  
  // If Puppeteer's Chrome not found, try common Chrome/Chromium paths on Linux
  if (!process.env.CHROME_PATH) {
    const chromePaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    ];
    
    for (const chromePath of chromePaths) {
      try {
        if (fs.existsSync(chromePath)) {
          process.env.CHROME_PATH = chromePath;
          console.log(`✅ Chrome found at: ${chromePath}`);
          break;
        }
      } catch (e) {}
    }
  }
  
  if (!process.env.CHROME_PATH) {
    console.warn('⚠️ Chrome not found in standard paths');
  }
}

const app = express();
const PORT = 3000;

// Store completed results
const completedJobs = new Map();

async function getFullDescription(page, jobUrl) {
  try {
    await page.goto(jobUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }).catch(() => {});

    await new Promise(r => setTimeout(r, 4000));

    const description = await page.evaluate(() => {
      const selectors = [
        '[data-test="Description"]',
        '.description',
        'section.break-words',
        '[data-test="job-description"]',
        'div[class*="description"]'
      ];
      
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent?.trim().length > 100) {
          return el.textContent.trim();
        }
      }
      
      return '';
    });

    return description;

  } catch (error) {
    return '';
  }
}

async function scrapeUpwork(searchQuery, maxJobs = 100) {
  let browser, page;
  
  try {
    const connectOptions = {
      headless: 'auto',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ],
      turnstile: true
    };

    // Add Chrome path for production (Render)
    if (process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH) {
      connectOptions.executablePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const connection = await connect(connectOptions);
    
    browser = connection.browser;
    page = connection.page;

    const allJobs = [];
    let currentPage = 1;
    
    console.log(`🔍 Collecting job listings for: ${searchQuery}`);
    
    while (allJobs.length < maxJobs && currentPage <= 15) {
      try {
        const offset = (currentPage - 1) * 10;
        const searchUrl = `https://www.upwork.com/nx/search/jobs/?q=${encodeURIComponent(searchQuery)}&sort=recency&page=${offset}`;
        
        console.log(`📄 Page ${currentPage}`);
        
        await page.goto(searchUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45000
        }).catch(() => {});

        await new Promise(r => setTimeout(r, 8000));

        const jobs = await page.evaluate(() => {
          const articles = document.querySelectorAll('article[data-ev-job-uid]');
          
          return Array.from(articles).map(article => {
            const titleEl = article.querySelector('h2.job-tile-title a, h2 a, h3 a');
            const title = titleEl?.textContent?.trim() || '';
            const href = titleEl?.getAttribute('href') || '';
            const url = href.startsWith('http') ? href : `https://www.upwork.com${href}`;
            
            const descEl = article.querySelector('[data-test="job-description-text"], .air3-line-clamp');
            const shortDescription = descEl?.textContent?.trim() || '';
            
            const postedEl = article.querySelector('[data-test="job-pubilshed-date"] span:last-child, small span:last-child');
            const posted = postedEl?.textContent?.trim() || '';
            
            const budgetEl = article.querySelector('[data-test="budget"], [data-test="is-fixed-price"]');
            const budget = budgetEl?.textContent?.trim() || '';
            
            const jobTypeEl = article.querySelector('[data-test="job-type-label"]');
            const jobType = jobTypeEl?.textContent?.trim() || '';
            
            const skillEls = article.querySelectorAll('[data-test="token"] span, .air3-token span');
            const skills = Array.from(skillEls).map(s => s.textContent?.trim()).filter(Boolean);
            
            const expEl = article.querySelector('[data-test="experience-level"]');
            const experienceLevel = expEl?.textContent?.trim() || '';
            
            const proposalsEl = article.querySelector('[data-test="proposals"]');
            const proposals = proposalsEl?.textContent?.trim() || '';
            
            const clientSpentEl = article.querySelector('[data-test="client-spendings"]');
            const clientSpent = clientSpentEl?.textContent?.trim() || '';
            
            const clientLocationEl = article.querySelector('[data-test="client-location"]');
            const clientLocation = clientLocationEl?.textContent?.trim() || '';
            
            const clientRatingEl = article.querySelector('[data-test="client-rating"]');
            const clientRating = clientRatingEl?.textContent?.trim() || '';
            
            const paymentVerifiedEl = article.querySelector('[data-test="payment-verification-status"]');
            const paymentVerified = paymentVerifiedEl?.textContent?.trim() || '';

            return {
              id: article.getAttribute('data-ev-job-uid') || '',
              title,
              url,
              shortDescription,
              posted,
              budget,
              jobType,
              skills,
              experienceLevel,
              proposals,
              client: {
                spent: clientSpent,
                location: clientLocation,
                rating: clientRating,
                paymentVerified
              }
            };
          }).filter(j => j.title && j.url.includes('/jobs/'));
        });

        if (jobs.length === 0) break;
        
        allJobs.push(...jobs);
        console.log(`  Collected ${allJobs.length}/${maxJobs} jobs`);
        
        if (allJobs.length >= maxJobs) break;
        
        currentPage++;
        await new Promise(r => setTimeout(r, 5000));
        
      } catch (pageError) {
        console.error(`Error on page ${currentPage}:`, pageError.message);
        break;
      }
    }

    const jobsToEnrich = allJobs.slice(0, maxJobs);
    
    if (jobsToEnrich.length === 0) {
      return { jobs: [], summary: { totalJobs: 0 } };
    }

    console.log(`🔍 Getting full descriptions for ${jobsToEnrich.length} jobs...`);
    
    const enrichedJobs = [];
    
    for (let i = 0; i < jobsToEnrich.length; i++) {
      const job = jobsToEnrich[i];
      
      console.log(`  [${i + 1}/${jobsToEnrich.length}] ${job.title.substring(0, 60)}...`);
      
      const fullDescription = await getFullDescription(page, job.url);
      
      enrichedJobs.push({
        ...job,
        fullDescription,
        scrapedAt: new Date().toISOString()
      });

      await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
    }

    const summary = {
      totalJobs: enrichedJobs.length,
      searchQuery,
      scrapedAt: new Date().toISOString(),
      avgSkillsPerJob: enrichedJobs.length > 0 
        ? (enrichedJobs.reduce((sum, j) => sum + j.skills.length, 0) / enrichedJobs.length).toFixed(1)
        : 0,
      jobsWithBudget: enrichedJobs.filter(j => j.budget).length,
      topSkills: getTopSkills(enrichedJobs)
    };
    
    console.log(`✅ Scraped ${enrichedJobs.length} jobs successfully!`);
    
    return {
      success: true,
      jobs: enrichedJobs,
      summary
    };

  } catch (error) {
    console.error('Scraping error:', error);
    throw error;
  } finally {
    if (browser) {
      try {
        browser.process()?.kill('SIGKILL');
      } catch (e) {
        console.log('Browser cleanup skipped');
      }
    }
  }
}

function getTopSkills(jobs) {
  const skillCount = {};
  
  jobs.forEach(job => {
    job.skills.forEach(skill => {
      skillCount[skill] = (skillCount[skill] || 0) + 1;
    });
  });
  
  return Object.entries(skillCount)
    .map(([skill, count]) => ({ skill, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

// Main endpoint - returns JSON directly
app.get('/scrape', async (req, res) => {
  const { query, maxJobs = 100 } = req.query;
  
  if (!query) {
    return res.status(400).json({
      error: 'Missing required parameter: query',
      example: '/scrape?query=full stack developer&maxJobs=50'
    });
  }
  
  try {
    console.log(`\n🚀 Starting scrape for: ${query} (max: ${maxJobs})`);
    
    const result = await scrapeUpwork(query, parseInt(maxJobs));
    
    res.json(result);
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    service: 'Upwork Scraper API',
    status: 'running',
    endpoint: 'GET /scrape?query=YOUR_SEARCH&maxJobs=NUMBER',
    examples: [
      '/scrape?query=full stack developer&maxJobs=50',
      '/scrape?query=automation n8n&maxJobs=100',
      '/scrape?query=react typescript&maxJobs=25'
    ],
    note: 'Results are returned directly in JSON format'
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Upwork Scraper API running on http://localhost:${PORT}`);
  console.log(`\n📖 Usage:`);
  console.log(`   http://localhost:${PORT}/scrape?query=full stack developer&maxJobs=50\n`);
});