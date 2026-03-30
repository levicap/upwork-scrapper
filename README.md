# Upwork Job Scraper with Complete Details

A comprehensive Node.js API that scrapes **complete** Upwork job listings including full job details, client information, activity, comments, and more. Data can be saved to Supabase for analysis.

## ✨ Features

### Complete Job Details
- Full job description (not truncated)
- Job title, budget, and payment type
- Experience level required
- Project duration and type (one-time vs ongoing)
- All required skills
- Category/industry
- Posted date
- Number of proposals
- Screening questions
- Job activity (invites sent, unanswered invites)
- Comments/questions about the job
- Attachments

### Comprehensive Client Information
- **Client Name** (when available)
- **Location** (country/region)
- **Total amount spent** on Upwork
- **Payment verification status**
- **Client rating**
- **Jobs posted** (total count)
- **Hire rate** (percentage)
- **Open jobs** (current)
- **Total hires** (all time)
- **Active hires** (current)
- **Member since** date

This detailed client information helps you:
- Identify high-quality clients
- Assess client reliability and payment history
- Understand client hiring patterns
- Make informed decisions about bidding

## Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Supabase

1. Create a new project at [supabase.com](https://supabase.com)
### 2. Configure Supabase

1. Create a new project at [supabase.com](https://supabase.com)
2. Go to SQL Editor
3. **If this is a new setup**: Run the `supabase-schema.sql` file to create the table
4. **If you already have the table**: Run the `supabase-migration-add-fields.sql` file to add new fields
5. Get your project URL and anon key from Settings > API

### 3. Environment Variables

Create a `.env` file (or set in Render dashboard):

```env
SUPABASE_URL=your_supabase_project_url
SUPABASE_KEY=your_supabase_anon_key
NODE_ENV=production
```

### 4. Run Locally
```bash
npm start
```

## API Usage

### Scrape Jobs
```
GET /scrape?query=full stack developer&maxJobs=50
```

**Parameters:**
- `query` (required): Search keywords
- `maxJobs` (optional): Number of jobs to scrape (default: 100)

**Data is automatically saved to BOTH:**
1. 📄 **JSON file** in `data/` folder (e.g., `upwork_n8n_1766832649648.json`)
2. 🗄️ **Supabase database** (if configured)

**Example Response:**
```json
{
  "success": true,
  "jobs": [
    {
      "id": "~022004273703687453586",
      "title": "N8N Workflow Automation Expert",
      "url": "https://www.upwork.com/jobs/...",
      "fullDescription": "We are looking for...",
      "budget": "$500-$1000",
      "jobType": "Fixed Price",
      "experienceLevel": "Intermediate",
      "skills": ["n8n", "API Integration", "Automation"],
      "duration": "1 to 3 months",
      "projectType": "One-time project",
      "proposals": "5 to 10",
      "posted": "2 hours ago",
      "activity": "Invites sent: 5",
      "category": "Web Development",
      "screeningQuestions": ["Have you worked with n8n before?"],
      "comments": ["Great opportunity for automation experts"],
      "client": {
        "name": "Tech Startup Inc",
        "location": "United States",
        "rating": "4.9 of 5",
        "paymentVerified": "Payment verified",
        "spent": "$100K+ total spent",
        "jobsPosted": "50+ jobs posted",
        "hireRate": "85% hire rate",
        "openJobs": "3 open jobs",
        "totalHires": "42 hires",
        "activeHires": "2 active",
        "memberSince": "Member since Jun 2020"
      },
      "scrapedAt": "2025-12-27T..."
    }
  ],
  "summary": {
    "totalJobs": 50,
    "searchQuery": "full stack developer",
    "scrapedAt": "2025-12-27T...",
    "avgSkillsPerJob": "8.2",
    "jobsWithBudget": 42,
    "topSkills": [...]
  },
  "savedTo": {
    "jsonFile": "upwork_full_stack_developer_1766832649648.json",
    "jsonPath": "c:\\upwork-scrapper\\data\\upwork_full_stack_developer_1766832649648.json",
    "supabase": true
  }
}
```

### Access Saved Data

**JSON Files:**
- Located in the `data/` folder
- Named with query + timestamp: `upwork_{query}_{timestamp}.json`
- Contains complete job details with all fields
- Easy to share, backup, or analyze offline

**Supabase:**
- Queryable database for advanced filtering
- Real-time updates and collaboration
- SQL queries for complex analysis
- API access for integrations

## Data Fields

### Job Information
- `id` - Unique job identifier
- `title` - Job title
- `url` - Direct link to job
- `fullDescription` - Complete job description
- `shortDescription` - Brief preview from search results
- `budget` - Payment amount/range
- `jobType` - Fixed price or hourly
- `experienceLevel` - Required experience level
- `skills` - Array of required skills
- `duration` - Expected project length
- `projectType` - One-time or ongoing
- `proposals` - Number of proposals received
- `posted` - When the job was posted
- `activity` - Job activity metrics
- `invitesSent` - Number of invites sent
- `unansweredInvites` - Unanswered invite count
- `category` - Job category/industry
- `screeningQuestions` - Array of screening questions
- `comments` - Comments/questions about the job
- `attachments` - File attachments (if any)

### Client Information
- `client.name` - Client/company name
- `client.location` - Country/region
- `client.rating` - Client rating
- `client.paymentVerified` - Payment verification status
- `client.spent` - Total spent on Upwork
- `client.jobsPosted` - Number of jobs posted
- `client.hireRate` - Percentage of jobs that result in hires
- `client.openJobs` - Currently open jobs
- `client.totalHires` - Total hires made
- `client.activeHires` - Currently active hires
- `client.memberSince` - When they joined Upwork

## Deployment on Render

1. Push your code to GitHub
2. Connect your repo to Render
3. Add environment variables in Render dashboard:
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
   - `NODE_ENV=production`

## Database Schema

Jobs are saved to the `upwork_jobs` table with the following fields:

- `job_id` - Unique Upwork job ID
- `title` - Job title
- `url` - Full job URL
- `short_description` - Brief description
- `full_description` - Complete job description
- `posted` - When the job was posted
- `budget` - Job budget
- `job_type` - Fixed/Hourly
- `skills` - Array of required skills
- `experience_level` - Required experience
- `proposals` - Number of proposals
- `client_*` - Client information
- `search_query` - Search term used
- `scraped_at` - When the data was scraped

## Features

- ✅ Scrapes Upwork job listings
- ✅ Extracts full job descriptions
- ✅ Saves to Supabase automatically
- ✅ Prevents duplicates using `job_id`
- ✅ Returns JSON response
- ✅ Full-text search capability via Supabase
