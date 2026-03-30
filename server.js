require('dotenv').config();

const express = require('express');
const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Initialize Supabase client (only if credentials are provided)
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
  );
  console.log('✅ Supabase client initialized');
} else {
  console.log('⚠️  Supabase not configured - jobs will not be saved to database');
}

const app = express();
const PORT = 3000;

// Store completed results
const completedJobs = new Map();

// Load cookies if available
let savedCookies = null;
try {
  if (fs.existsSync('cookies.json')) {
    savedCookies = JSON.parse(fs.readFileSync('cookies.json', 'utf8'));
    console.log(`✅ Loaded ${savedCookies.length} cookies from cookies.json`);
  } else {
    console.log('⚠️  No cookies.json found - run node get-cookies.js to login and save cookies');
  }
} catch (error) {
  console.log('⚠️  Error loading cookies:', error.message);
}

// Generate client fingerprint for tracking
function generateClientFingerprint(client) {
  if (!client) return null;
  
  // Combine unique client characteristics
  const fingerprintData = [
    client.location || '',
    client.timezone || '',
    client.memberSince || '',
    client.totalHires || '',
    client.spent || '',
    client.rating || '',
    client.reviews || ''
  ].join('|');
  
  // Create SHA-256 hash
  return crypto.createHash('sha256').update(fingerprintData).digest('hex');
}

async function getFullJobDetails(page, jobUrl) {
  try {
    console.log(`      Opening: ${jobUrl.substring(0, 60)}...`);
    
    // Navigate to job page
    try {
      await page.goto(jobUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000
      });
    } catch (navError) {
      console.log(`      ⚠️ Navigation timeout, continuing...`);
      await new Promise(r => setTimeout(r, 3000));
    }

    // Wait for content to render
    console.log(`      ⏳ Waiting for page load...`);
    await new Promise(r => setTimeout(r, 8000));

    // STEP 1: Extract embedded Nuxt/Vue data from page source
    const embeddedClientData = await page.evaluate(() => {
      try {
        // Look for __NUXT_DATA__ script tag
        const nuxtScript = document.getElementById('__NUXT_DATA__');
        if (nuxtScript) {
          const nuxtData = JSON.parse(nuxtScript.textContent);
          
          console.log('Found __NUXT_DATA__, array length:', nuxtData.length);
          
          // Parse the reactive array structure
          const resolveRef = (value) => {
            if (typeof value === 'number' && value >= 0 && value < nuxtData.length) {
              const resolved = nuxtData[value];
              if (Array.isArray(resolved) && resolved[0] === "Reactive" && resolved.length > 1) {
                return resolveRef(resolved[1]);
              }
              return resolved;
            }
            return value;
          };

          // Extract organizationUid and companyUid - THE MOST IMPORTANT DATA
          let organizationUid = null;
          let companyUid = null;
          let rid = null;
          let buyer = null;
          let buyerIndex = null;
          
          // Deep search through the ENTIRE nuxtData structure first
          const deepSearch = (obj, depth = 0, path = '') => {
            if (depth > 15) return; // Prevent infinite recursion
            
            if (obj && typeof obj === 'object') {
              // Check if this object has the IDs
              if (obj.organizationUid) {
                organizationUid = typeof obj.organizationUid === 'number' ? resolveRef(obj.organizationUid) : obj.organizationUid;
                console.log(`Found organizationUid at ${path}:`, organizationUid);
              }
              if (obj.companyUid) {
                companyUid = typeof obj.companyUid === 'number' ? resolveRef(obj.companyUid) : obj.companyUid;
                console.log(`Found companyUid at ${path}:`, companyUid);
              }
              if (obj.rid) {
                rid = typeof obj.rid === 'number' ? resolveRef(obj.rid) : obj.rid;
              }
              
              // Recursively search
              if (Array.isArray(obj)) {
                obj.forEach((item, idx) => deepSearch(item, depth + 1, `${path}[${idx}]`));
              } else {
                Object.keys(obj).forEach(key => {
                  deepSearch(obj[key], depth + 1, path ? `${path}.${key}` : key);
                });
              }
            }
          };
          
          // Search the entire nuxtData array
          console.log('Searching entire nuxtData for organizationUid and companyUid...');
          deepSearch(nuxtData);
          
          console.log('organizationUid:', organizationUid);
          console.log('companyUid:', companyUid);
          console.log('rid (legacy ID):', rid);

          // NOW find buyer object for other stats
          for (let i = 0; i < nuxtData.length; i++) {
            const item = nuxtData[i];
            if (item && typeof item === 'object' && item.buyer !== undefined) {
              buyerIndex = item.buyer;
              console.log('Found buyer at index:', i, 'buyer reference:', buyerIndex);
              break;
            }
          }

          if (buyerIndex) {
            buyer = resolveRef(buyerIndex);
            console.log('Buyer object:', JSON.stringify(buyer).substring(0, 200));
            
            const stats = resolveRef(buyer.stats);
            const location = resolveRef(buyer.location);
            const company = resolveRef(buyer.company);
            const companyProfile = company ? resolveRef(company.profile) : null;
            
            console.log('Stats:', JSON.stringify(stats).substring(0, 200));
            console.log('Location:', JSON.stringify(location).substring(0, 200));
            console.log('Company:', JSON.stringify(company).substring(0, 200));

            return {
              organizationUid: organizationUid,
              companyUid: companyUid,
              rid: rid,
              totalHires: stats ? resolveRef(stats.totalJobsWithHires) : null,
              activeHires: stats ? resolveRef(stats.activeAssignmentsCount) : null,
              feedbackCount: stats ? resolveRef(stats.feedbackCount) : null,
              rating: stats ? resolveRef(stats.score) : null,
              totalSpent: stats && stats.totalCharges ? resolveRef(resolveRef(stats.totalCharges).amount) : null,
              country: location ? resolveRef(location.country) : null,
              city: location ? resolveRef(location.city) : null,
              timezone: location ? resolveRef(location.countryTimezone) : null,
              isPaymentVerified: buyer.isPaymentMethodVerified ? resolveRef(buyer.isPaymentMethodVerified) : null,
              companyName: company ? resolveRef(company.name) : null
            };
          } else {
            console.log('No buyer object found in Nuxt data');
          }
        } else {
          console.log('No __NUXT_DATA__ script found');
        }
      } catch (e) {
        console.log('Nuxt data extraction failed:', e.message);
      }
      return null;
    });

    console.log(`      🎯 Embedded client data: ${embeddedClientData ? 'FOUND' : 'Not found'}`);

    // STEP 2: Extract ALL text and then parse it
    const jobDetails = await page.evaluate(() => {
      // Get the entire page text
      const fullPageText = document.body.innerText || document.body.textContent;
      
      // Save first 5000 chars for debugging
      console.log('=== PAGE TEXT PREVIEW ===');
      console.log(fullPageText.substring(0, 5000));
      console.log('=== END PREVIEW ===');
      
      // Helper function to extract by pattern
      const extract = (pattern, flags = 'i') => {
        const match = fullPageText.match(new RegExp(pattern, flags));
        return match ? match[0].trim() : '';
      };
      
      // Helper to extract value after label
      const extractAfterLabel = (label) => {
        const regex = new RegExp(label + '[:\\s]*([^\\n]+)', 'i');
        const match = fullPageText.match(regex);
        return match ? match[1].trim() : '';
      };
      
      // JOB DESCRIPTION - Extract from "Summary" section until price/fixed-price
      let fullDescription = '';
      const summaryMatch = fullPageText.match(/Summary\s*\n([\s\S]+?)(?=\n\$[\d,]+\.|Fixed-price|Hourly|Experience Level|Activity on)/i);
      if (summaryMatch) {
        fullDescription = summaryMatch[1].trim();
      }
      
      // If no summary, try between posted date and price
      if (!fullDescription) {
        const altMatch = fullPageText.match(/Posted.*?ago\s*\n[\s\S]*?\n([\s\S]+?)(?=\n\$[\d,]+|Fixed-price|Hourly)/i);
        if (altMatch) fullDescription = altMatch[1].trim();
      }
      
      // JOB TITLE - Extract after "Sign up" and before "Posted"
      let jobTitle = '';
      const titleMatch = fullPageText.match(/Sign up\s*\n(.+?)\nPosted/s);
      if (titleMatch) jobTitle = titleMatch[1].replace(/\n/g, ' ').trim();
      
      // BUDGET - Look for dollar amount before "Fixed-price" or "Hourly"
      const budgetMatch = fullPageText.match(/\$[\d,]+(?:\.\d{2})?/);
      const budget = budgetMatch ? budgetMatch[0] : '';
      
      // JOB TYPE
      const jobType = fullPageText.includes('Fixed-price') ? 'Fixed-price' : 
                     fullPageText.includes('Hourly') ? 'Hourly' : '';
      
      // EXPERIENCE LEVEL - Look for "Experience Level" section
      const expMatch = fullPageText.match(/Experience Level\s*\n([^\n]+)/i);
      const experienceLevel = expMatch ? expMatch[1].trim() : '';
      
      // SKILLS - Extract from "Skills and Expertise" until "Activity"
      const skills = [];
      const skillsMatch = fullPageText.match(/Skills and Expertise\s*\n([\s\S]+?)(?=\nActivity on|Mandatory skills)/i);
      if (skillsMatch) {
        const skillLines = skillsMatch[1].split('\n');
        skillLines.forEach(line => {
          const trimmed = line.trim();
          if (trimmed && trimmed.length > 2 && trimmed.length < 50 && 
              !trimmed.match(/^(Show|Hide|more|less|\+\s*\d+)$/i)) {
            skills.push(trimmed);
          }
        });
      }
      
      // PROJECT LENGTH/DURATION
      const durationMatch = fullPageText.match(/Project Type\s*\n([^\n]+)/i);
      const duration = durationMatch ? durationMatch[1].trim() : '';
      
      // PROJECT TYPE - Look before "Skills and Expertise"
      const projectTypeMatch = fullPageText.match(/Project Type\s*\n([^\n]+)/i);
      const projectType = projectTypeMatch ? projectTypeMatch[1].trim() : '';
      
      // PROPOSALS - Extract from "Activity on this job" section
      const proposalsMatch = fullPageText.match(/Proposals:\s*\n([^\n]+)/i);
      const proposals = proposalsMatch ? proposalsMatch[1].trim() : '';
      
      // INTERVIEWING
      const interviewingMatch = fullPageText.match(/Interviewing:\s*\n([^\n]+)/i);
      const interviewing = interviewingMatch ? interviewingMatch[1].trim() : '';
      
      // INVITES SENT
      const invitesMatch = fullPageText.match(/Invites sent:\s*\n([^\n]+)/i);
      const invitesSent = invitesMatch ? invitesMatch[1].trim() : '';
      
      // UNANSWERED INVITES
      const unansweredMatch = fullPageText.match(/Unanswered invites:\s*\n([^\n]+)/i);
      const unansweredInvites = unansweredMatch ? unansweredMatch[1].trim() : '';
      
      // POSTED TIME - Extract "Posted X ago"
      const postedMatch = fullPageText.match(/Posted\s+(.+?)\s+ago/i);
      const posted = postedMatch ? `${postedMatch[1]} ago` : '';
      
      // CONNECTS (if shown)
      const connectsMatch = fullPageText.match(/(\d+)\s+Connects?/i);
      const activity = connectsMatch ? connectsMatch[0] : '';
      
      // CATEGORY (not always shown)
      const categoryMatch = fullPageText.match(/Category\s*\n([^\n]+)/i);
      const category = categoryMatch ? categoryMatch[1].trim() : '';
      
      // CLIENT INFORMATION - Look for "About the client" section
      const clientMatch = fullPageText.match(/About the client([\s\S]+?)(?=\nPayment verified|$)/i);
      const clientText = clientMatch ? clientMatch[1] : fullPageText;
      
      // CLIENT NAME - IMPORTANT: Upwork intentionally hides client/company names on job pages
      // Client names are only revealed after a freelancer applies or is invited to the job
      // This is a privacy/security feature to prevent direct outreach bypassing Upwork
      // Result: Client name will always be empty via browser scraping
      // Alternative: Use client fingerprinting (SHA-256 hash) to track clients across jobs
      let clientName = '';
      
      // Note: The patterns below are kept for future use if Upwork changes their policy,
      // but currently they will not find any matches as the name is not in the page HTML
      
      // Pattern 1: Company name might appear right after "About the client"
      const nameMatch1 = fullPageText.match(/About the client\s*\n([A-Z][^\n]{2,50})\n/);
      if (nameMatch1 && !nameMatch1[1].match(/payment|verified|member since|location|rating/i)) {
        clientName = nameMatch1[1].trim();
      }
      
      // Pattern 2: Look for company name before location
      if (!clientName) {
        const nameMatch2 = clientText.match(/\n([A-Z][A-Za-z0-9\s&.,-]{3,50})\n.*(?:United States|United Kingdom|Canada|Australia|India|Germany|France)/);
        if (nameMatch2 && !nameMatch2[1].match(/payment|verified|member since|about|posted|jobs|rating/i)) {
          clientName = nameMatch2[1].trim();
        }
      }
      
      // Pattern 3: Company name in "X at CompanyName" format
      if (!clientName) {
        const nameMatch3 = fullPageText.match(/at\s+([A-Z][A-Za-z0-9\s&.,-]{3,50})(?:\n|,)/);
        if (nameMatch3) {
          clientName = nameMatch3[1].trim();
        }
      }
      
      // CLIENT VERIFICATION BADGES
      const paymentVerified = fullPageText.includes('Payment method verified') || fullPageText.includes('Payment verified') ? 'Yes' : 'No';
      const phoneVerified = fullPageText.includes('Phone number verified') || fullPageText.includes('Phone verified') ? 'Yes' : 'No';
      const identityVerified = fullPageText.includes('Identity Verified') || fullPageText.includes('Identity verified') ? 'Yes' : 'No';
      
      // CLIENT LOCATION - Improved patterns for the actual format
      let clientLocation = '';
      
      // Define list of countries for fallback matching
      const countries = ['France', 'United States', 'United Kingdom', 'Canada', 'Australia', 'India', 'Germany', 'Spain', 'Italy', 'Pakistan', 'Philippines', 'Bangladesh', 'Netherlands', 'Poland', 'Brazil', 'Mexico', 'Argentina', 'Ukraine', 'Romania', 'Egypt', 'South Africa', 'Kenya', 'Nigeria', 'Israel', 'UAE', 'Saudi Arabia', 'Qatar', 'Singapore', 'Malaysia', 'Thailand', 'Vietnam', 'Indonesia', 'Japan', 'China', 'South Korea', 'Russia', 'Turkey', 'Greece', 'Portugal', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Belgium', 'Austria', 'Switzerland'];
      
      // Pattern 1: Look for country + city + time pattern like "France\nMarseille4:51 PM"
      const locationMatch1 = clientText.match(/(France|United States|United Kingdom|Canada|Australia|India|Germany|Spain|Italy|Pakistan|Philippines|Bangladesh|Netherlands|Poland|Brazil|Mexico|Argentina|Ukraine|Romania|Egypt|South Africa|Kenya|Nigeria|Israel|UAE|Saudi Arabia|Qatar|Singapore|Malaysia|Thailand|Vietnam|Indonesia|Japan|China|South Korea|Russia|Turkey|Greece|Portugal|Sweden|Norway|Denmark|Finland|Belgium|Austria|Switzerland)\n([A-Z][a-z]+)\d{1,2}:\d{2}\s*(?:AM|PM)/);
      if (locationMatch1) {
        clientLocation = `${locationMatch1[2]}, ${locationMatch1[1]}`; // City, Country
      }
      
      // Pattern 2: Just country if city not found
      if (!clientLocation) {
        for (const country of countries) {
          if (clientText.includes(country)) {
            clientLocation = country;
            break;
          }
        }
      }
      
      // CLIENT TIMEZONE - Pattern: "Marseille4:51 PM" or "4:51 PM"
      const timezoneMatch = clientText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
      const clientTimezone = timezoneMatch ? timezoneMatch[1] : '';
      
      // HIRE RATE - Pattern: "89% hire rate, 38 open jobs"
      const hireRateMatch = clientText.match(/(\d+)%\s+hire\s+rate/i);
      const clientHireRate = hireRateMatch ? `${hireRateMatch[1]}%` : '';
      
      // OPEN JOBS - Pattern: "89% hire rate, 38 open jobs"
      const openJobsMatch = clientText.match(/(\d+)\s+open\s+jobs?/i);
      const clientOpenJobs = openJobsMatch ? openJobsMatch[1] : '';
      
      // TOTAL SPENT - Pattern: "$13K total spent" or "$13,338 total spent"
      const spentMatch = clientText.match(/\$([\d,]+K?)\s+total\s+spent/i);
      const clientSpent = spentMatch ? `$${spentMatch[1]}` : '';
      
      // MEMBER SINCE - Pattern: "Member since Oct 5, 2024"
      const memberSinceMatch = clientText.match(/Member since\s+([A-Z][a-z]+\s+\d+,\s+\d{4})/i);
      const clientMemberSince = memberSinceMatch ? memberSinceMatch[1] : '';
      
      // CLIENT COMPANY INFO - Industry
      const industryMatch = clientText.match(/(Tech & IT|Marketing|Design|Writing|Sales|Accounting|Engineering|Legal|Admin Support|Customer Service|design|technology|finance|healthcare|education|retail)/i);
      const clientIndustry = industryMatch ? industryMatch[1] : '';
      
      // Company size - multiple patterns
      let clientCompanySize = '';
      const sizeMatch1 = clientText.match(/(Small company|Medium company|Large company|Enterprise|Self employed)\s*(?:\(([^)]+)\))?/i);
      if (sizeMatch1) {
        clientCompanySize = sizeMatch1[2] ? `${sizeMatch1[1]} ${sizeMatch1[2]}` : sizeMatch1[1];
      }
      
      // Alternative pattern: "2-9 people"
      if (!clientCompanySize) {
        const sizeMatch2 = clientText.match(/(\d+-\d+)\s+(?:people|employees|members)/i);
        if (sizeMatch2) {
          clientCompanySize = `${sizeMatch2[1]} people`;
        }
      }
      
      // TOTAL REVIEWS/RATING - Pattern: "4.99 of 184 reviews"
      const reviewRatingMatch = clientText.match(/([\d.]+)\s+of\s+(\d+)\s+reviews?/i);
      const clientReviews = reviewRatingMatch ? reviewRatingMatch[2] : '';
      const clientRating = reviewRatingMatch ? reviewRatingMatch[1] : '';
      
      // HIRES - Pattern: "194 hires, 6 active"
      const hiresMatch = clientText.match(/(\d+)\s+hires?,\s+(\d+)\s+active/i);
      const clientTotalHires = hiresMatch ? hiresMatch[1] : '';
      const clientActiveHires = hiresMatch ? hiresMatch[2] : '';
      
      // JOBS POSTED - Pattern: "214 jobs posted"
      const jobsPostedMatch = clientText.match(/(\d+)\s+jobs?\s+posted/i);
      const clientJobsPosted = jobsPostedMatch ? jobsPostedMatch[1] : '';
      
      // CLIENT RECENT HISTORY - Pattern: "Client's recent history (50)" at end of client section
      let clientRecentHistory = '';
      
      // Pattern 1: Extract count from "Client's recent history (50)"
      const historyMatch1 = clientText.match(/Client'?s?\s+recent\s+history\s*\((\d+)\)/i);
      if (historyMatch1) {
        clientRecentHistory = `${historyMatch1[1]} recent jobs`;
      }
      
      // Pattern 2: Try extracting actual job list if available (less common in search results)
      if (!clientRecentHistory) {
        const historyMatch2 = fullPageText.match(/Client'?s?\s+recent\s+history[:\s]*([\s\S]{0,500})(?=\nFooter|About the client|Apply now|Save job|$)/i);
        if (historyMatch2) {
          const historyText = historyMatch2[1]
            .replace(/\s+/g, ' ')
            .trim();
          if (historyText.length > 20) {
            clientRecentHistory = historyText.substring(0, 200);
          }
        }
      }
      
      // Pattern 3: Fallback - just count if we see job postings mentioned
      if (!clientRecentHistory) {
        const historyMatch3 = clientText.match(/(\d+)\s+(?:past|previous|recent)\s+(?:jobs?|postings?|hires?)/i);
        if (historyMatch3) {
          clientRecentHistory = `${historyMatch3[1]} past jobs`;
        }
      }
      
      // SCREENING QUESTIONS
      const screeningQuestions = [];
      const questionsMatch = fullPageText.match(/(?:Screening questions?|Questions)([\s\S]+?)(?=\nActivity|About the client|Apply now|$)/i);
      if (questionsMatch) {
        const questionText = questionsMatch[1];
        questionText.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (trimmed && trimmed.length > 10 && 
              (trimmed.includes('?') || trimmed.match(/^\d+\./))) {
            screeningQuestions.push(trimmed);
          }
        });
      }
      
      // CLIENT JOB HISTORY & FEEDBACK - "Jobs in progress" section
      // This section contains previous job titles, feedback from freelancers, and ratings
      // Freelancer feedback often mentions client/company names!
      const comments = [];
      const jobHistoryComments = [];
      
      // Extract "Jobs in progress" or "Client's recent history" section
      const jobHistoryMatch = fullPageText.match(/(?:Jobs in progress|Client'?s?\s+recent\s+history)([\s\S]{0,15000})(?=\nView all jobs posted by this client|Footer|About the client|Payment terms)/i);
      
      if (jobHistoryMatch) {
        const historyText = jobHistoryMatch[1];
        
        // Split by job entries - look for rating patterns or job titles
        const jobEntries = historyText.split(/(?=Rating is \d|Good client|Great buyer|No feedback given)/);
        
        jobEntries.forEach(entry => {
          const lines = entry.trim().split('\n').filter(l => l.trim());
          if (lines.length < 2) return;
          
          let jobInfo = {
            title: '',
            rating: '',
            feedback: '',
            freelancer: '',
            period: '',
            amount: ''
          };
          
          // Extract job title (usually first substantial line)
          const titleLine = lines.find(l => l.length > 5 && !l.match(/^(Rating|To freelancer|Good|Great|No feedback|Fixed-price|Hourly|\d+ hrs)/));
          if (titleLine) {
            jobInfo.title = titleLine.trim();
          }
          
          // Extract ratings
          const ratingMatches = entry.match(/Rating is ([\d.]+) out of 5/g);
          if (ratingMatches) {
            jobInfo.rating = ratingMatches.join(' | ');
          }
          
          // Extract freelancer name
          const freelancerMatch = entry.match(/To freelancer:\s*([A-Z][^.\n]{3,30})/);
          if (freelancerMatch) {
            jobInfo.freelancer = freelancerMatch[1].trim();
          }
          
          // Extract feedback comments (these often contain client/company names!)
          const feedbackLines = lines.filter(l => 
            l.length > 30 && 
            !l.match(/^(Rating|To freelancer|Fixed-price|Hourly|\d+ hrs|Billed:|ExportApollo|N8N|Good client|Great buyer|No feedback)/) &&
            l.match(/[a-z]/) // Has lowercase letters (not just titles)
          );
          
          if (feedbackLines.length > 0) {
            jobInfo.feedback = feedbackLines.join(' ').trim();
            // Limit to 500 chars to avoid huge text blocks
            if (jobInfo.feedback.length > 500) {
              jobInfo.feedback = jobInfo.feedback.substring(0, 500) + '...';
            }
          }
          
          // Extract date period
          const periodMatch = entry.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*-\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)?\s*\d{4}/);
          if (periodMatch) {
            jobInfo.period = periodMatch[0];
          }
          
          // Extract amount
          const amountMatch = entry.match(/(?:Fixed-price\s+)?\$[\d,]+\.?\d*|Billed:\s+\$[\d,]+\.?\d*/);
          if (amountMatch) {
            jobInfo.amount = amountMatch[0];
          }
          
          // Only add if we have meaningful data
          if (jobInfo.title || jobInfo.feedback) {
            const commentStr = [
              jobInfo.title ? `Job: ${jobInfo.title}` : '',
              jobInfo.rating ? `Rating: ${jobInfo.rating}` : '',
              jobInfo.freelancer ? `To: ${jobInfo.freelancer}` : '',
              jobInfo.period ? `Period: ${jobInfo.period}` : '',
              jobInfo.amount ? `Amount: ${jobInfo.amount}` : '',
              jobInfo.feedback ? `Feedback: "${jobInfo.feedback}"` : ''
            ].filter(Boolean).join(' | ');
            
            if (commentStr.length > 20) {
              jobHistoryComments.push(commentStr);
            }
          }
        });
      }
      
      // Also check for general comments section
      const commentsMatch = fullPageText.match(/(?:Comments|Discussion)([\s\S]{0,2000})(?=\n\n|Footer)/i);
      if (commentsMatch) {
        const commentText = commentsMatch[1];
        commentText.split('\n\n').forEach(comment => {
          const trimmed = comment.trim();
          if (trimmed && trimmed.length > 20) {
            comments.push(trimmed);
          }
        });
      }
      
      // Combine job history feedback with regular comments
      const allComments = [...jobHistoryComments, ...comments];
      
      // ATTACHMENTS - Look for file attachments mentioned
      const attachments = [];
      const attachmentMatch = fullPageText.match(/Attachments?:([\s\S]{0,500})(?=\n\n)/i);
      if (attachmentMatch) {
        const attText = attachmentMatch[1];
        attText.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (trimmed && (trimmed.match(/\.(pdf|doc|docx|jpg|png|zip)/i) || trimmed.length > 5)) {
            attachments.push(trimmed);
          }
        });
      }
      
      // WORLDWIDE or SPECIFIC LOCATION for job posting
      const jobLocationMatch = fullPageText.match(/Worldwide|(?:Only freelancers located in|Freelancers in)\s+([^\\n]+)/i);
      const jobLocation = jobLocationMatch ? jobLocationMatch[0] : '';
      
      return {
        fullDescription: fullDescription || '',
        jobTitle: jobTitle || '',
        budget: budget || '',
        jobType: jobType || '',
        experienceLevel: experienceLevel || '',
        skills: skills,
        duration: duration || '',
        projectType: projectType || '',
        proposals: proposals || '',
        posted: posted || '',
        activity: `Proposals: ${proposals}, Interviewing: ${interviewing}, Invites: ${invitesSent}`,
        interviewing: interviewing || '',
        invitesSent: invitesSent || '',
        unansweredInvites: unansweredInvites || '',
        category: category || '',
        jobLocation: jobLocation || '',
        screeningQuestions: screeningQuestions,
        comments: allComments,
        attachments: attachments,
        client: {
          name: clientName || '',
          organizationUid: '',
          companyUid: '',
          location: clientLocation || '',
          timezone: clientTimezone || '',
          paymentVerified: paymentVerified || '',
          phoneVerified: phoneVerified || '',
          identityVerified: identityVerified || '',
          spent: clientSpent || '',
          jobsPosted: clientJobsPosted || '',
          hireRate: clientHireRate || '',
          memberSince: clientMemberSince || '',
          rating: clientRating || '',
          reviews: clientReviews || '',
          totalHires: clientTotalHires || '',
          activeHires: clientActiveHires || '',
          openJobs: clientOpenJobs || '',
          industry: clientIndustry || '',
          companySize: clientCompanySize || '',
          recentHistory: clientRecentHistory || ''
        },
        allSectionTexts: [],
        // Debug
        pageTextLength: fullPageText.length,
        foundDescription: fullDescription.length > 0,
        foundSkills: skills.length > 0,
        foundClient: !!(clientLocation || clientSpent || clientMemberSince)
      };
    });

    // STEP 3: Merge embedded data with scraped data (embedded data is more reliable)
    if (embeddedClientData) {
      if (embeddedClientData.organizationUid) jobDetails.client.organizationUid = embeddedClientData.organizationUid.toString();
      if (embeddedClientData.companyUid) jobDetails.client.companyUid = embeddedClientData.companyUid.toString();
      if (embeddedClientData.rid) jobDetails.client.rid = embeddedClientData.rid.toString();
      if (embeddedClientData.totalHires) jobDetails.client.totalHires = embeddedClientData.totalHires.toString();
      if (embeddedClientData.activeHires) jobDetails.client.activeHires = embeddedClientData.activeHires.toString();
      if (embeddedClientData.feedbackCount) jobDetails.client.reviews = embeddedClientData.feedbackCount.toString();
      if (embeddedClientData.rating) jobDetails.client.rating = embeddedClientData.rating.toString();
      if (embeddedClientData.totalSpent) jobDetails.client.spent = `$${embeddedClientData.totalSpent}`;
      if (embeddedClientData.country) jobDetails.client.location = embeddedClientData.country;
      if (embeddedClientData.city) jobDetails.client.location = `${embeddedClientData.city}, ${embeddedClientData.country}`;
      if (embeddedClientData.timezone) jobDetails.client.timezone = embeddedClientData.timezone;
      if (embeddedClientData.isPaymentVerified !== null) jobDetails.client.paymentVerified = embeddedClientData.isPaymentVerified ? 'Yes' : 'No';
      if (embeddedClientData.companyName) jobDetails.client.name = embeddedClientData.companyName;
      
      jobDetails.embeddedDataFound = true;
    }

    const statusSymbol = jobDetails.foundClient || embeddedClientData ? '✓' : '✗';
    console.log(`      ${statusSymbol} Desc: ${jobDetails.foundDescription}, Skills: ${jobDetails.foundSkills}, Client: ${jobDetails.foundClient || embeddedClientData ? 'Yes' : 'No'}`);
    if (embeddedClientData) {
      console.log(`      💎 Embedded: orgUid=${embeddedClientData.organizationUid}, Hires=${embeddedClientData.totalHires}, Spent=$${embeddedClientData.totalSpent}`);
    }
    
    // STEP 4: Try to get client job history and feedback (name clues)
    jobDetails.clientJobHistory = [];
    jobDetails.clientFeedbackComments = [];
    
    if (embeddedClientData && embeddedClientData.organizationUid) {
      const clientUrl = `https://www.upwork.com/o/profiles/users/_~${embeddedClientData.organizationUid}/`;
      const historyData = await getClientJobHistory(page, clientUrl);
      jobDetails.clientJobHistory = historyData.jobs;
      jobDetails.clientFeedbackComments = historyData.feedbackComments;
    }

    return jobDetails;

  } catch (error) {
    console.error(`      ❌ Error getting job details: ${error.message}`);
    console.error(`      Stack: ${error.stack?.substring(0, 200)}`);
    // Return empty structure instead of null so merging works
    return {
      fullDescription: '',
      jobTitle: '',
      clientJobHistory: [],
      clientFeedbackComments: [],
      client: {
        name: '',
        organizationUid: '',
        companyUid: '',
        location: '',
        timezone: '',
        rating: '',
        reviews: '',
        paymentVerified: '',
        phoneVerified: '',
        identityVerified: '',
        spent: '',
        jobsPosted: '',
        hireRate: '',
        openJobs: '',
        totalHires: '',
        activeHires: '',
        memberSince: '',
        industry: '',
        companySize: '',
        recentHistory: ''
      }
    };
  }
}

async function scrapeUpwork(searchQuery, maxJobs = 100) {
  let browser, page;
  
  try {
    const connectOptions = {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ],
      turnstile: true
    };

    const connection = await connect(connectOptions);
    
    browser = connection.browser;
    page = connection.page;

    // ========== API INTERCEPTION SETUP ==========
    console.log('\n🎯 Setting up API call interception...\n');
    
    const apiCalls = [];
    
    // Enable request interception
    await page.setRequestInterception(true);
    
    // Intercept all requests
    page.on('request', (request) => {
      const url = request.url();
      
      // Log Upwork API calls
      if (url.includes('upwork.com/api') || url.includes('upwork.com/ab/') || url.includes('upwork.com/graphql')) {
        console.log(`📡 API REQUEST: ${request.method()} ${url.substring(0, 150)}`);
      }
      
      request.continue();
    });
    
    // Intercept all responses
    page.on('response', async (response) => {
      const url = response.url();
      const status = response.status();
      
      // Capture Upwork API responses
      if (url.includes('upwork.com/api') || url.includes('upwork.com/ab/') || url.includes('upwork.com/graphql')) {
        try {
          const contentType = response.headers()['content-type'] || '';
          
          // Capture both JSON and Thrift+JSON responses
          if (contentType.includes('application/json') || contentType.includes('thrift+json')) {
            const data = await response.json();
            
            console.log(`✅ API RESPONSE: ${status} ${url.substring(0, 100)}`);
            console.log(`   Content-Type: ${contentType}`);
            console.log(`   Data keys: ${Object.keys(data).join(', ')}`);
            
            // Store API call details
            apiCalls.push({
              url: url,
              method: response.request().method(),
              status: status,
              timestamp: new Date().toISOString(),
              dataKeys: Object.keys(data),
              dataPreview: JSON.stringify(data).substring(0, 500)
            });
            
            // Save full response for important endpoints (search, jobs, profiles, savedJobs, feedbacks)
            if (url.includes('/profiles/') || url.includes('/jobs/') || url.includes('search') || 
                url.includes('savedjobs') || url.includes('jobsFeedbacks') || url.includes('graphql')) {
              const urlPart = url.split('?')[0].split('/').pop().substring(0, 50);
              const filename = `api_response_${Date.now()}_${urlPart}.json`;
              const filepath = path.join(__dirname, 'data', 'api_logs', filename);
              
              // Create directory if it doesn't exist
              const dir = path.dirname(filepath);
              if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
              }
              
              fs.writeFileSync(filepath, JSON.stringify({
                url: url,
                method: response.request().method(),
                status: status,
                timestamp: new Date().toISOString(),
                headers: response.headers(),
                data: data
              }, null, 2));
              
              console.log(`   💾 Saved to: ${filename}`);
            }
            
          } else {
            console.log(`📄 Non-JSON Response: ${status} ${url.substring(0, 100)} (${contentType})`);
          }
        } catch (error) {
          console.log(`⚠️  Could not parse response from ${url.substring(0, 100)}: ${error.message}`);
        }
      }
    });
    
    console.log('✅ API interception enabled\n');

    const allJobs = [];
    let currentPage = 1;
    
    console.log(`🔍 Collecting job listings for: ${searchQuery}`);
    
    // Inject cookies before first navigation
    if (savedCookies && savedCookies.length > 0) {
      try {
        await page.setCookie(...savedCookies);
        console.log(`✅ Injected ${savedCookies.length} cookies for authenticated session`);
      } catch (err) {
        console.log(`⚠️  Cookie injection failed:`, err.message);
      }
    }
    
    while (allJobs.length < maxJobs && currentPage <= 15) {
      try {
        const offset = (currentPage - 1) * 10;
        const searchUrl = `https://www.upwork.com/nx/search/jobs/?q=${encodeURIComponent(searchQuery)}&sort=recency&page=${offset}`;
        
        console.log(`📄 Page ${currentPage}`);
        
        console.log(`   Navigating to: ${searchUrl.substring(0, 80)}...`);
        
        try {
          await page.goto(searchUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 45000
          });
        } catch (navError) {
          console.log(`   ⚠️ Navigation error: ${navError.message}`);
          // Check if we hit Cloudflare challenge
          const pageContent = await page.content();
          if (pageContent.includes('Checking your browser') || pageContent.includes('challenge')) {
            console.log(`   ❌ Cloudflare challenge detected - cookies may be expired`);
            console.log(`   💡 Run: node get-cookies.js to get fresh cookies`);
            break;
          }
        }

        console.log(`   Waiting for content to load...`);
        await new Promise(r => setTimeout(r, 12000));

        console.log(`   Extracting jobs...`);
        const jobs = await page.evaluate(() => {
          // Try multiple selectors for job cards
          let articles = document.querySelectorAll('article[data-ev-job-uid]');
          
          if (articles.length === 0) {
            articles = document.querySelectorAll('article');
          }
          
          if (articles.length === 0) {
            articles = document.querySelectorAll('[data-test="job-tile"], .job-tile, section[class*="job"]');
          }
          
          console.log(`Found ${articles.length} job elements`);
          console.log('Page title:', document.title);
          
          // Check if we're on a challenge page
          if (document.title.includes('Just a moment') || document.body.innerText.includes('Cloudflare')) {
            console.log('⚠️ Cloudflare challenge detected');
            return [];
          }
          
          const extracted = Array.from(articles).map(article => {
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
              href,  // Add for debugging
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
          });
          
          console.log(`Extracted ${extracted.length} jobs before filter`);
          if (extracted.length > 0) {
            console.log('First job sample:', {
              title: extracted[0].title,
              href: extracted[0].href,
              url: extracted[0].url,
              hasTitle: !!extracted[0].title,
              urlIncludesJobs: extracted[0].url.includes('/jobs/')
            });
          }
          
          return extracted.filter(j => j.title && j.url.includes('/jobs/'));
        });

        console.log(`   Found ${jobs.length} valid jobs on this page`);

        if (jobs.length === 0) {
          console.log(`   No jobs found, stopping...`);
          break;
        }
        
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
      console.log('⚠️ No jobs found');
      return { 
        success: false,
        jobs: [], 
        summary: { 
          totalJobs: 0,
          searchQuery,
          scrapedAt: new Date().toISOString()
        },
        savedTo: {
          jsonFile: null,
          supabase: false
        }
      };
    }

    console.log(`🔍 Getting full job details for ${jobsToEnrich.length} jobs...`);
    
    const enrichedJobs = [];
    
    for (let i = 0; i < jobsToEnrich.length; i++) {
      const job = jobsToEnrich[i];
      
      console.log(`  [${i + 1}/${jobsToEnrich.length}] ${job.title.substring(0, 60)}...`);
      
      const fullJobDetails = await getFullJobDetails(page, job.url);
      
      // Merge the search results data with detailed page data
      enrichedJobs.push({
        ...job,
        // Override with more detailed information if available
        fullDescription: fullJobDetails?.fullDescription || job.shortDescription,
        jobTitle: fullJobDetails?.jobTitle || job.title,
        budget: fullJobDetails?.budget || job.budget,
        jobType: fullJobDetails?.jobType || job.jobType,
        experienceLevel: fullJobDetails?.experienceLevel || job.experienceLevel,
        skills: fullJobDetails?.skills?.length > 0 ? fullJobDetails.skills : job.skills,
        proposals: fullJobDetails?.proposals || job.proposals,
        posted: fullJobDetails?.posted || job.posted,
        // New detailed fields
        duration: fullJobDetails?.duration || '',
        projectType: fullJobDetails?.projectType || '',
        activity: fullJobDetails?.activity || '',
        invitesSent: fullJobDetails?.invitesSent || '',
        unansweredInvites: fullJobDetails?.unansweredInvites || '',
        interviewing: fullJobDetails?.interviewing || '',
        category: fullJobDetails?.category || '',
        jobLocation: fullJobDetails?.jobLocation || '',
        screeningQuestions: fullJobDetails?.screeningQuestions || [],
        comments: fullJobDetails?.comments || [],
        attachments: fullJobDetails?.attachments || [],
        allSectionTexts: fullJobDetails?.allSectionTexts || [],
        // Enhanced client information - prioritize detail page data
        client: {
          name: '',
          organizationUid: fullJobDetails?.client?.organizationUid || '',
          companyUid: fullJobDetails?.client?.companyUid || '',
          location: fullJobDetails?.client?.location || job.client.location,
          timezone: fullJobDetails?.client?.timezone || '',
          rating: fullJobDetails?.client?.rating || job.client.rating,
          reviews: fullJobDetails?.client?.reviews || '',
          paymentVerified: fullJobDetails?.client?.paymentVerified || job.client.paymentVerified,
          phoneVerified: fullJobDetails?.client?.phoneVerified || '',
          identityVerified: fullJobDetails?.client?.identityVerified || '',
          spent: fullJobDetails?.client?.spent || job.client.spent,
          jobsPosted: fullJobDetails?.client?.jobsPosted || '',
          hireRate: fullJobDetails?.client?.hireRate || '',
          openJobs: fullJobDetails?.client?.openJobs || '',
          totalHires: fullJobDetails?.client?.totalHires || '',
          activeHires: fullJobDetails?.client?.activeHires || '',
          memberSince: fullJobDetails?.client?.memberSince || '',
          industry: fullJobDetails?.client?.industry || '',
          companySize: fullJobDetails?.client?.companySize || '',
          recentHistory: fullJobDetails?.client?.recentHistory || ''
        },
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
    
    // Save to JSON file
    const timestamp = Date.now();
    const safeQuery = searchQuery.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const jsonFileName = `upwork_${safeQuery}_${timestamp}.json`;
    const jsonFilePath = path.join(__dirname, 'data', jsonFileName);
    
    try {
      // Ensure data directory exists
      if (!fs.existsSync(path.join(__dirname, 'data'))) {
        fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
      }
      
      // Prepare complete data object
      const dataToSave = {
        success: true,
        metadata: {
          searchQuery,
          totalJobs: enrichedJobs.length,
          scrapedAt: new Date().toISOString(),
          fileName: jsonFileName
        },
        summary,
        jobs: enrichedJobs
      };
      
      // Save to JSON file
      fs.writeFileSync(jsonFilePath, JSON.stringify(dataToSave, null, 2));
      console.log(`💾 Saved to JSON: ${jsonFileName}`);
      
    } catch (fileError) {
      console.error('⚠️  Failed to save JSON file:', fileError.message);
    }
    
    // Save to Supabase
    if (supabase) {
      try {
        console.log('💾 Saving to Supabase...');
        
        const jobsToInsert = enrichedJobs.map(job => {
          const clientFingerprint = generateClientFingerprint(job.client);
          
          return {
          job_id: job.id,
          title: job.title,
          url: job.url,
          short_description: job.shortDescription,
          full_description: job.fullDescription,
          posted: job.posted,
          budget: job.budget,
          job_type: job.jobType,
          skills: job.skills,
          experience_level: job.experienceLevel,
          proposals: job.proposals,
          duration: job.duration,
          project_type: job.projectType,
          activity: job.activity,
          invites_sent: job.invitesSent,
          unanswered_invites: job.unansweredInvites,
          interviewing: job.interviewing,
          category: job.category,
          job_location: job.jobLocation,
          screening_questions: job.screeningQuestions,
          comments: job.comments,
          attachments: job.attachments,
          all_section_texts: job.allSectionTexts,
          client_fingerprint: clientFingerprint,
          client_job_history: job.clientJobHistory || [],
          client_feedback_comments: job.clientFeedbackComments || [],
          client_name: job.client.name,
          client_organization_uid: job.client.organizationUid || null,
          client_company_uid: job.client.companyUid || null,
          client_spent: job.client.spent,
          client_location: job.client.location,
          client_timezone: job.client.timezone,
          client_rating: job.client.rating,
          client_reviews: job.client.reviews,
          payment_verified: job.client.paymentVerified,
          client_phone_verified: job.client.phoneVerified,
          client_identity_verified: job.client.identityVerified,
          client_jobs_posted: job.client.jobsPosted,
          client_hire_rate: job.client.hireRate,
          client_open_jobs: job.client.openJobs,
          client_total_hires: job.client.totalHires,
          client_active_hires: job.client.activeHires,
          client_member_since: job.client.memberSince,
          client_industry: job.client.industry,
          client_company_size: job.client.companySize,
          client_recent_history: job.client.recentHistory,
          search_query: searchQuery,
          scraped_at: job.scrapedAt
        }});
        
        const { data, error } = await supabase
          .from('upwork_fulljobs')
          .upsert(jobsToInsert, { onConflict: 'job_id' });
        
        if (error) {
          console.error('Supabase error:', error.message);
        } else {
          console.log(`✅ Saved ${jobsToInsert.length} jobs to Supabase (with client fingerprints)`);
        }
      } catch (dbError) {
        console.error('Database save error:', dbError.message);
      }
    }
    
    // ========== API CALLS SUMMARY ==========
    console.log('\n📊 API CALLS SUMMARY:');
    console.log(`   Total API calls intercepted: ${apiCalls.length}`);
    
    // Group by endpoint
    const endpointGroups = {};
    apiCalls.forEach(call => {
      const endpoint = call.url.split('?')[0].split('/').slice(-3).join('/');
      if (!endpointGroups[endpoint]) {
        endpointGroups[endpoint] = [];
      }
      endpointGroups[endpoint].push(call);
    });
    
    console.log('\n   API Endpoints discovered:');
    Object.keys(endpointGroups).forEach(endpoint => {
      console.log(`   - ${endpoint} (${endpointGroups[endpoint].length} calls)`);
      const firstCall = endpointGroups[endpoint][0];
      console.log(`     Keys: ${firstCall.dataKeys.join(', ')}`);
    });
    
    // Save API summary
    const apiLogsDir = path.join(__dirname, 'data', 'api_logs');
    if (!fs.existsSync(apiLogsDir)) {
      fs.mkdirSync(apiLogsDir, { recursive: true });
    }
    
    const apiSummaryPath = path.join(apiLogsDir, `api_summary_${timestamp}.json`);
    fs.writeFileSync(apiSummaryPath, JSON.stringify({
      totalCalls: apiCalls.length,
      endpoints: endpointGroups,
      calls: apiCalls
    }, null, 2));
    console.log(`\n   💾 API summary saved to: api_summary_${timestamp}.json\n`);

    return {
      success: true,
      jobs: enrichedJobs,
      summary,
      apiCallsSummary: {
        totalCalls: apiCalls.length,
        endpoints: Object.keys(endpointGroups),
        summaryFile: `api_summary_${timestamp}.json`
      },
      savedTo: {
        jsonFile: jsonFileName,
        jsonPath: jsonFilePath,
        supabase: supabase ? true : false
      }
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
    
    console.log(`\n✅ Results ready!`);
    if (result.savedTo) {
      console.log(`   📄 JSON file: ${result.savedTo.jsonFile || 'N/A'}`);
      console.log(`   🗄️  Supabase: ${result.savedTo.supabase ? 'Saved' : 'Not configured'}`);
    }
    console.log(`   📊 Total jobs: ${result.jobs ? result.jobs.length : 0}\n`);
    
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