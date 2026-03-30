require('dotenv').config();
const { connect } = require('puppeteer-real-browser');
const fs = require('fs');

/**
 * This script opens Upwork in a browser and lets you manually login.
 * After you login, press ENTER in the terminal and it will save your cookies to cookies.json
 */

async function getCookies() {
  console.log('\n🔐 Cookie Extraction Tool\n');
  console.log('Instructions:');
  console.log('1. A browser will open at Upwork homepage');
  console.log('2. Manually login to your Upwork account');
  console.log('3. Navigate to any job search page');
  console.log('4. Click on a job to see full details');
  console.log('5. Once you can see complete job info, come back here');
  console.log('6. Press ENTER in this terminal to save your cookies\n');

  const { browser, page } = await connect({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    turnstile: true,
    customConfig: {},
    connectOption: {},
    disableXvfb: false,
    ignoreAllFlags: false
  });

  try {
    console.log('🌐 Opening Upwork...\n');
    
    // Just go to homepage - let user navigate themselves
    await page.goto('https://www.upwork.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }).catch(() => {
      console.log('⚠️  Initial page load slow, but browser is open - continue manually');
    });

    console.log('✅ Browser opened - please login now...');
    console.log('   Navigate to: https://www.upwork.com/ab/account-security/login');
    console.log('   Or click "Log In" button in the browser\n');

    // Wait for user to press ENTER
    await new Promise(resolve => {
      process.stdin.once('data', () => resolve());
    });

    console.log('\n📥 Extracting cookies...');

    // Get all cookies
    const cookies = await page.cookies();
    
    // Save cookies to file
    fs.writeFileSync(
      'cookies.json',
      JSON.stringify(cookies, null, 2)
    );

    console.log(`✅ Saved ${cookies.length} cookies to cookies.json`);
    console.log('\nCookie names:');
    cookies.forEach(cookie => {
      console.log(`  - ${cookie.name}`);
    });

    console.log('\n✅ Done! You can now use these cookies in your scraper.');
    console.log('The scraper will automatically load cookies.json if it exists.\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
  }
}

getCookies();
