# Upwork Scraper Extension — API Queries Reference

All GraphQL requests go to:
```
POST https://www.upwork.com/api/graphql/v1?alias=<ALIAS>
```

REST requests go to `https://www.upwork.com`.

The external webhook for forwarding scraped data goes to the n8n instance configured in `config.js`.

---

## Session Tokens & Header Injection

The extension harvests tokens passively via the Chrome DevTools Protocol (CDP). It cannot access HttpOnly cookies via `document.cookie`, so it intercepts raw request headers using CDP `Network.requestWillBeSent` and `Network.requestWillBeSentExtraInfo` events.

| Token Cookie Name | Usage |
|---|---|
| `UniversalSearchNuxt_vt` | Auth for search-page GQL queries |
| `JobDetailsNuxt_vt` | Auth for job-detail GQL queries |
| `oauth2_global_js_token` | Global fallback bearer token |
| `ag_vs_ui_gql_token` | Auth for agency staff queries |
| `XSRF-TOKEN` | Anti-CSRF token sent as `X-XSRF-TOKEN` header |
| `current_organization_uid` | Tenant ID sent as `X-Upwork-API-TenantId` |

All captured tokens are persisted to `chrome.storage.local` under the key `sessionTokens` and reloaded across service-worker restarts.

### Standard GQL Request Headers

```http
Content-Type: application/json
Accept: application/json
Authorization: Bearer <token>
X-XSRF-TOKEN: <XSRF-TOKEN cookie value>
X-Upwork-Accept-Language: en-US
X-Upwork-API-TenantId: <current_organization_uid>   (only when required — see notes per query)
apollographql-client-name: <captured from original request>
apollographql-client-version: <captured from original request>
```

> **TenantId rule:** `_vt` microapp tokens (e.g. `UniversalSearchNuxt_vt`, `JobDetailsNuxt_vt`, `FxJobPosting_vt`) are scoped to a single microapp and are NOT associated with any tenant/organisation. Sending `X-Upwork-API-TenantId` alongside them causes a **403 "tenant not found in users tenants"** error. Only send the tenant header when using `oauth2_global_js_token` / cookie-based auth.

---

> For a full explanation of how the extension opens tabs, uses CDP, and bypasses HttpOnly cookie / OAuth restrictions, see [TAB_AUTH_MECHANISM.md](TAB_AUTH_MECHANISM.md).

---

## 1. Job Search — `userJobSearch`

**Purpose:** Paginated search for Upwork jobs matching a query string. Used by both "Run Scrape" and the "Search" box in the popup. Returns job IDs (ciphertexts) and basic metadata.

**Trigger:** User clicks **Run Scrape** or types a query and clicks **Search** in the popup.

**Endpoint:** `POST /api/graphql/v1?alias=userJobSearch`

**Auth token:** `UniversalSearchNuxt_vt` (read via CDP `Network.getCookies` from the search tab)

**No `X-Upwork-API-TenantId`** — `_vt` token, tenant header must be omitted.

### Variables

```json
{
  "requestVariables": {
    "userQuery": "n8n",
    "sort": "recency+desc",
    "highlight": false,
    "paging": { "offset": 0, "count": 10 }
  }
}
```

### GraphQL Query

```graphql
query UserJobSearch($requestVariables: UserJobSearchV1Request!) {
  search {
    universalSearchNuxt {
      userJobSearchV1(request: $requestVariables) {
        paging { total }
        results { id }
      }
    }
  }
}
```

### cURL

```bash
curl -X POST "https://www.upwork.com/api/graphql/v1?alias=userJobSearch" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <UniversalSearchNuxt_vt>" \
  -H "X-XSRF-TOKEN: <XSRF-TOKEN>" \
  -H "X-Upwork-Accept-Language: en-US" \
  --data-raw '{
    "query": "query UserJobSearch($requestVariables: UserJobSearchV1Request!) { search { universalSearchNuxt { userJobSearchV1(request: $requestVariables) { paging { total } results { id } } } } }",
    "variables": {
      "requestVariables": {
        "userQuery": "n8n",
        "sort": "recency+desc",
        "highlight": false,
        "paging": { "offset": 0, "count": 10 }
      }
    }
  }'
```

### Response shape

```json
{
  "data": {
    "search": {
      "universalSearchNuxt": {
        "userJobSearchV1": {
          "paging": { "total": 247 },
          "results": [
            {
              "id": "1234567890123456",
              "jobTile": {
                "job": {
                  "id": "1234567890123456",
                  "ciphertext": "~0123456789abcdef",
                  "publishTime": "2026-04-07T10:00:00Z"
                }
              }
            }
          ]
        }
      }
    }
  }
}
```

---

## 2. Public Job Details — `gql-query-get-visitor-job-details`

**Purpose:** Fetches public job details that are visible to any logged-in user before applying. Includes job description, skills, budget, qualifications, buyer stats, and similar jobs.

**Trigger:** Passive page capture or `runFullJobCapture` message handler.

**Endpoint:** `POST /api/graphql/v1?alias=gql-query-get-visitor-job-details`

**Auth token:** `UniversalSearchNuxt_vt`

**No `X-Upwork-API-TenantId`.**

### Variables

```json
{
  "id": "~0123456789abcdef",
  "isLoggedIn": true
}
```

### GraphQL Query

```graphql
query JobPubDetailsQuery($id: ID!, $isLoggedIn: Boolean!) {
  jobPubDetails(id: $id) {
    opening {
      status postedOn publishTime workload contractorTier description
      info {
        ciphertext id type access title hideBudget createdOn
        notSureProjectDuration notSureFreelancersToHire notSureExperienceLevel premium
      }
      segmentationData {
        customValue label name sortOrder type value
        skill { description prettyName skill id }
      }
      sandsData {
        occupation { freeText ontologyId prefLabel id uid: id }
        ontologySkills { groupId id freeText prefLabel groupPrefLabel relevance }
        additionalSkills { groupId id freeText prefLabel relevance }
      }
      category { name urlSlug }
      categoryGroup { name urlSlug }
      budget { amount currencyCode }
      annotations { customFields tags }
      engagementDuration { label weeks }
      extendedBudgetInfo { hourlyBudgetMin hourlyBudgetMax hourlyBudgetType }
      attachments @include(if: $isLoggedIn) { fileName length uri }
      clientActivity {
        lastBuyerActivity totalApplicants totalHired totalInvitedToInterview
        unansweredInvites invitationsSent numberOfPositionsToHire
      }
      deliverables deadline tools { name }
    }
    qualifications {
      countries earnings groupRecno languages localDescription
      localFlexibilityDescription localMarket minJobSuccessScore minOdeskHours
      onSiteType prefEnglishSkill regions risingTalent shouldHavePortfolio
      states tests timezones type locationCheckRequired
      group { groupId groupLogo groupName }
      location { city country countryTimezone offsetFromUtcMillis state worldRegion }
      locations { id type }
    }
    buyer {
      location { offsetFromUtcMillis countryTimezone city country }
      stats {
        totalAssignments activeAssignmentsCount hoursCount feedbackCount score
        totalJobsWithHires totalCharges { amount }
      }
      company {
        name @include(if: $isLoggedIn)
        companyId @include(if: $isLoggedIn)
        isEDCReplicated contractDate profile { industry size }
      }
      jobs {
        openCount
        postedCount @include(if: $isLoggedIn)
        openJobs { id uid: id isPtcPrivate ciphertext title type }
      }
      avgHourlyJobsRate @include(if: $isLoggedIn) { amount }
    }
    similarJobs {
      id ciphertext title description engagement durationLabel contractorTier
      type createdOn hourlyBudgetMin hourlyBudgetMax
      amount { amount }
      ontologySkills { id prefLabel }
    }
    buyerExtra { isPaymentMethodVerified }
  }
}
```

### cURL

```bash
curl -X POST "https://www.upwork.com/api/graphql/v1?alias=gql-query-get-visitor-job-details" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <UniversalSearchNuxt_vt>" \
  -H "X-XSRF-TOKEN: <XSRF-TOKEN>" \
  -H "X-Upwork-Accept-Language: en-US" \
  --data-raw '{
    "query": "...(full query above)...",
    "variables": { "id": "~0123456789abcdef", "isLoggedIn": true }
  }'
```

---

## 3. Authenticated Job Details — `gql-query-get-auth-job-details`

**Purpose:** Full authenticated job details including buyer work history, current user application info, bid stats, and application context. The richest single-query source for job data.

**Trigger:** Every job lookup — passive browse detection (`triggerJobLookup`), manual URL lookup (`lookupJobUrl`), and search scraping (`fetchJobInTab`).

**Endpoint:** `POST /api/graphql/v1?alias=gql-query-get-auth-job-details`

**Auth token:** `JobDetailsNuxt_vt` → fallback `FxJobPosting_vt` → fallback `oauth2_global_js_token`

**No `X-Upwork-API-TenantId`** when using a `_vt` microapp token.

### Variables

```json
{
  "id": "~0123456789abcdef",
  "isFreelancerOrAgency": true,
  "isLoggedIn": true
}
```

### GraphQL Query

```graphql
query JobAuthDetailsQuery($id: ID!, $isFreelancerOrAgency: Boolean!, $isLoggedIn: Boolean!) {
  jobAuthDetails(id: $id) {
    hiredApplicantNames
    opening {
      job {
        status postedOn publishTime workload contractorTier description
        info {
          ciphertext id type access title hideBudget createdOn
          notSureProjectDuration notSureFreelancersToHire notSureExperienceLevel premium
        }
        segmentationData { customValue label name sortOrder type value }
        sandsData {
          occupation { freeText ontologyId prefLabel id uid: id }
          ontologySkills { groupId id freeText prefLabel groupPrefLabel relevance }
          additionalSkills { groupId id freeText prefLabel relevance }
        }
        category { name urlSlug }
        categoryGroup { name urlSlug }
        budget { amount currencyCode }
        annotations { customFields tags }
        engagementDuration { label weeks }
        extendedBudgetInfo { hourlyBudgetMin hourlyBudgetMax hourlyBudgetType }
        attachments @include(if: $isLoggedIn) { fileName length uri }
        clientActivity {
          lastBuyerActivity totalApplicants totalHired totalInvitedToInterview
          unansweredInvites invitationsSent numberOfPositionsToHire
        }
        deliverables deadline tools { name }
      }
      qualifications {
        countries earnings groupRecno languages localDescription
        localFlexibilityDescription localMarket minJobSuccessScore minOdeskHours
        onSiteType prefEnglishSkill regions risingTalent shouldHavePortfolio
        states tests timezones type locationCheckRequired
        group { groupId groupLogo groupName }
        location { city country countryTimezone offsetFromUtcMillis state worldRegion }
        locations { id type }
      }
      questions { question position }
    }
    buyer {
      enterprise isPaymentMethodVerified
      info {
        location { offsetFromUtcMillis countryTimezone city country }
        stats {
          totalAssignments activeAssignmentsCount hoursCount feedbackCount score
          totalJobsWithHires totalCharges { amount }
        }
        company { name companyId isEDCReplicated contractDate profile { industry size } }
        jobs {
          openCount postedCount
          openJobs { id uid: id isPtcPrivate ciphertext title type }
        }
        avgHourlyJobsRate { amount }
      }
      workHistory {
        isPtcJob status isEDCReplicated isPtcPrivate startDate endDate
        totalCharge totalHours
        jobInfo { title id uid: id access type ciphertext }
        contractorInfo { contractorName accessType ciphertext }
        rate { amount }
        feedback { feedbackSuppressed score comment }
        feedbackToClient { feedbackSuppressed score comment }
      }
    }
    currentUserInfo {
      owner
      freelancerInfo {
        profileState applied devProfileCiphertext hired
        application { vjApplicationId }
        pendingInvite { inviteId }
        contract { contractId status }
        hourlyRate { amount }
        qualificationsMatches {
          matches {
            clientPreferred clientPreferredLabel
            freelancerValue freelancerValueLabel qualification qualified
          }
        }
      }
    }
    similarJobs { id uid: id ciphertext title snippet }
    workLocation {
      onSiteCity onSiteCountry onSiteReason onSiteReasonFlexible onSiteState onSiteType
    }
    phoneVerificationStatus { status }
    applicantsBidsStats {
      avgRateBid { amount currencyCode }
      minRateBid { amount currencyCode }
      maxRateBid { amount currencyCode }
    }
    specializedProfileOccupationId @include(if: $isFreelancerOrAgency)
    applicationContext @include(if: $isFreelancerOrAgency) {
      freelancerAllowed clientAllowed
    }
  }
}
```

### cURL

```bash
curl -X POST "https://www.upwork.com/api/graphql/v1?alias=gql-query-get-auth-job-details" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <JobDetailsNuxt_vt>" \
  -H "X-XSRF-TOKEN: <XSRF-TOKEN>" \
  -H "X-Upwork-Accept-Language: en-US" \
  --data-raw '{
    "query": "...(full query above)...",
    "variables": {
      "id": "~0123456789abcdef",
      "isFreelancerOrAgency": true,
      "isLoggedIn": true
    }
  }'
```

---

## 4. Apply-Page Job Context — `gql-query-fetchjobdetailsandcontext`

**Purpose:** Returns the job data as seen from the apply page, including engagement durations, qualifications for matching, opening budget/skills, and context flags (e.g. `enterpriseClient`, `idVerificationRequired`).

**Trigger:** `runFullJobCapture` message handler (Step 3, query #3).

**Endpoint:** `POST /api/graphql/v1?alias=gql-query-fetchjobdetailsandcontext`

**Auth token:** `oauth2_global_js_token`

**Requires `X-Upwork-API-TenantId`** — uses global token, tenant pairing is valid.

### Variables

```json
{
  "ciphertext": "~0123456789abcdef"
}
```

> Note: variable name is `ciphertext` (String!), **not** `id` (ID!).

### GraphQL Query

```graphql
query fetchJobDetailsAndContext($ciphertext: String!) {
  fetchJobDetailsAndContext(ciphertext: $ciphertext) {
    affiliateContractorInCurrentOrg canViewAgencyContractorsInSomeOrg
    companyId eacInSomeOrg enterpriseClient
    idVerificationRequired phoneVerificationRequired
    engagementDurations { id label type weeks }
    qualifications {
      locationCheckRequired localMarket minHoursWeek minJobSuccessScore
      minOdeskHours prefEnglishSkill risingTalent shouldHavePortfolio type countries
    }
    opening {
      description duration durationLabel durationId startDate postedOn publishTime
      sourcingTime status visibility workload companyRecno contractorTier openingId
      budget { amount currencyCode }
      extendedBudgetInfo { hourlyBudgetMin hourlyBudgetMax hourlyBudgetType }
      deliveryDate
      category { name urlSlug }
      categoryGroup { name urlSlug }
      clientActivity { numberOfPositionsToHire totalApplicants }
      info {
        access ciphertext createdOn hideBudget notSureExperienceLevel
        notSureFreelancersToHire notSureLocationPreference notSureProjectDuration
        premium title type id
      }
      engagementDuration { id label type weeks }
      annotations { customFields tags }
      segmentationData { customValue label name sortOrder type value }
      sandsData {
        occupation { id freeText ontologyId prefLabel }
        ontologySkills { attributeGroupId attributeId freeText ontologyId prefLabel }
        occupations { id freeText ontologyId prefLabel }
      }
    }
  }
}
```

### cURL

```bash
curl -X POST "https://www.upwork.com/api/graphql/v1?alias=gql-query-fetchjobdetailsandcontext" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <oauth2_global_js_token>" \
  -H "X-XSRF-TOKEN: <XSRF-TOKEN>" \
  -H "X-Upwork-Accept-Language: en-US" \
  -H "X-Upwork-API-TenantId: <current_organization_uid>" \
  --data-raw '{
    "query": "...(full query above)...",
    "variables": { "ciphertext": "~0123456789abcdef" }
  }'
```

---

## 5. Client Info by Opening — `companyBuyer`

**Purpose:** Returns client/company information for a specific job opening — company profile, hiring stats, location, and payment verification. Used alongside `jobAuthDetails` to enrich the buyer section.

**Trigger:** `buildJobEntry()` (passive browse path, alias `companyBuyer`).

**Endpoint:** `POST /api/graphql/v1?alias=companyBuyer`

**Auth token:** Captured live from the first GQL request fired by `https://www.upwork.com/ab/messages/rooms/` via CDP `Network.requestWillBeSent`. Same interception pattern as `clientCompanyMetadata`.

**No `X-Upwork-API-TenantId`** — the intercepted messages/rooms token does NOT require the tenant header for this query (sending it causes a 403).

> **Restricted fields:** `logo`, `avgHourlyJobsRate`, `cssTier`, `profile.visible`, `profile.l3Occupations` are **not accessible** with the messages/rooms token — including them causes `ExecutionAborted`. They have been removed from the query.

### Opening ID derivation

```
openingId = cipher.replace(/^~02/, '')
// Example: "~021234567890123456" → "1234567890123456"
```

### Variables

```json
{
  "openingId": "1234567890123456"
}
```

### GraphQL Query

```graphql
query clientInfoByOpening($openingId: ID!) {
  clientInfoByOpening(openingId: $openingId) {
    buyer {
      info {
        company {
          contractDate
          name
          profile { industry size }
          id: companyId
        }
        location {
          country city state countryTimezone worldRegion offsetFromUtcMillis
        }
        jobs { postedCount filledCount openCount }
        stats {
          feedbackCount hoursCount
          totalCharges { amount currencyCode }
          totalAssignments activeAssignmentsCount score totalJobsWithHires
        }
      }
      isPaymentMethodVerified
      isEnterprise: enterprise
    }
    activity {
      lastBuyerActivity numberOfPositionsToHire totalApplicants
      totalInvitedToInterview totalHired unansweredInvites invitationsSent
    }
    jobInfo { status }
  }
}
```

### cURL

```bash
curl -X POST "https://www.upwork.com/api/graphql/v1?alias=companyBuyer" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: bearer <captured_from_messages_rooms_page>" \
  -H "X-XSRF-TOKEN: <XSRF-TOKEN>" \
  -H "Accept-Language: en-US,en;q=0.9" \
  -H "Origin: https://www.upwork.com" \
  -H "Referer: https://www.upwork.com/ab/messages/rooms/" \
  --data-raw '{
    "query": "...(full query above)...",
    "variables": { "openingId": "1234567890123456" }
  }'
```

---

## 6. Search Job Card — `searchJobCard`

**Purpose:** Lightweight job card data for displaying a job in search results. Includes title, description, budget, skills, and client stats. Faster than the full auth query.

**Trigger:** `runFullJobCapture` message handler (Step 3, query #4).

**Endpoint:** `POST /api/graphql/v1?alias=searchJobCard`

**Auth token:** `UniversalSearchNuxt_vt`

**No `X-Upwork-API-TenantId`.**

### Variables

```json
{
  "id": "~0123456789abcdef"
}
```

### GraphQL Query

```graphql
query SearchJobCard($id: ID!) {
  marketplaceJobPosting(id: $id) {
    jobTs openingUid
    job {
      ciphertext
      info {
        title description
        category { uid name }
        subCategory { uid name }
        contractorTier engagement
        durationV3 { weeks label }
        hourlyBudgetMin hourlyBudgetMax
        amount { amount currencyCode }
        skills { uid prettyName }
      }
      opening {
        connectedRecruiters { totalCount }
        applicantsCount invitedToInterviewCount
        totalApplicantsBidsAmount connectsRequired
      }
      client {
        totalPostedJobs totalJobsWithHires totalFeedback feedbackScore
        paymentVerificationStatus
        location { country }
        totalSpent { amount currencyCode }
      }
    }
  }
}
```

### cURL

```bash
curl -X POST "https://www.upwork.com/api/graphql/v1?alias=searchJobCard" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <UniversalSearchNuxt_vt>" \
  -H "X-XSRF-TOKEN: <XSRF-TOKEN>" \
  -H "X-Upwork-Accept-Language: en-US" \
  --data-raw '{
    "query": "...(full query above)...",
    "variables": { "id": "~0123456789abcdef" }
  }'
```

---

## 7. Agency Staff List — `gql-query-agencystaffsauth`

**Purpose:** Returns all staff members (freelancers and clients) associated with an agency/company. Used to enumerate freelancers for profile enrichment in agency lookup.

**Trigger:** `runAgencyLookupInTab`, `runAgencyLookupInNewTab` (Phase 1), and `runFullJobCapture` (query #8).

**Endpoint:** `POST /api/graphql/v1?alias=gql-query-agencystaffsauth`

**Auth token:** `ag_vs_ui_gql_token` → fallback `oauth2_global_js_token`

**Requires `X-Upwork-API-TenantId`.**

### Variables

```json
{
  "agencyId": "2012207015295215238",
  "agencyTeamId": "2012207015295215238",
  "limit": 50,
  "offset": ""
}
```

### GraphQL Query

```graphql
query getAgencyStaffsAuth(
  $agencyId: ID!,
  $agencyTeamId: ID!,
  $limit: Int,
  $offset: String
) {
  agencyStaffsAuth(
    agencyId: $agencyId
    agencyTeamId: $agencyTeamId
    limit: $limit
    offset: $offset
  ) {
    totalCount
    staffs {
      id
      memberType
      canBeViewed
      personalData {
        id name portrait ciphertext
      }
    }
  }
}
```

### cURL

```bash
curl -X POST "https://www.upwork.com/api/graphql/v1?alias=gql-query-agencystaffsauth" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ag_vs_ui_gql_token>" \
  -H "X-XSRF-TOKEN: <XSRF-TOKEN>" \
  -H "X-Upwork-Accept-Language: en-US" \
  -H "X-Upwork-API-TenantId: <current_organization_uid>" \
  --data-raw '{
    "query": "...(full query above)...",
    "variables": {
      "agencyId": "2012207015295215238",
      "agencyTeamId": "2012207015295215238",
      "limit": 50,
      "offset": ""
    }
  }'
```

---

## 8. Freelancer Profile — `getDetails`

**Purpose:** Fetches a freelancer's full profile including identity, stats, skills, agencies, and languages. Called for each freelancer staff member found in Phase 1 of agency lookup.

**Trigger:** `runAgencyLookupInNewTab` Phase 2. The extension navigates to `https://www.upwork.com/freelancers/moezz` via CDP to capture real auth headers for this microapp, then replays those exact headers for each staff ciphertext.

**Endpoint:** `POST /api/graphql/v1?alias=getDetails`

**Auth token:** Captured live from the freelancer page's own `getDetails` request via CDP.

### Variables

```json
{
  "personId": null,
  "profileUrl": "~0abc123freelancer",
  "viewerMode": false
}
```

### GraphQL Query

```graphql
query GetTalentProfile(
  $profileUrl: String,
  $jobProposalId: ID,
  $openingId: ID,
  $viewerMode: Boolean,
  $freeText: String,
  $skillIds: [ID!],
  $occupationIds: [ID!]
) {
  talentVPDAuthProfile(filter: {
    profileUrl: $profileUrl,
    jobProposalId: $jobProposalId,
    openingId: $openingId,
    viewerMode: $viewerMode,
    freeText: $freeText,
    skillIds: $skillIds,
    occupationIds: $occupationIds,
    excludePortfolio: true,
    excludeAgencies: false
  }) {
    ...AuthProfileResponseFragment
  }
}

fragment BaseProfileResponseFragment on TalentVPDProfileResponse {
  identity { uid: id id userId ciphertext recno }
  profile {
    name title description
    location { country city state }
    portrait { portrait }
    skills { node { id name prettyName } }
  }
  stats {
    totalHours totalFeedback rating
    hourlyRate { node { currencyCode amount } }
    memberSince totalEarnings topRatedStatus topRatedPlusStatus
  }
  agencies {
    name logo recentHours score recno scoreRecent totalFeedback totalHours
    agencyRate { node { currencyCode amount } }
    nSS100BwScore topRatedStatus topRatedPlusStatus hideEacEarnings
    ciphertext uid: id id defaultAgency
  }
  languages {
    language { englishName }
    proficiencyLevel { proficiencyTitle }
  }
}

fragment AuthProfileResponseFragment on TalentVPDProfileResponse {
  ...BaseProfileResponseFragment
  vettedBadge { vetted }
}
```

### cURL

```bash
curl -X POST "https://www.upwork.com/api/graphql/v1?alias=getDetails" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <captured_from_freelancer_page>" \
  -H "X-XSRF-TOKEN: <XSRF-TOKEN>" \
  -H "X-Upwork-Accept-Language: en-US" \
  --data-raw '{
    "query": "...(full query above)...",
    "variables": {
      "personId": null,
      "profileUrl": "~0abc123freelancer",
      "viewerMode": false
    }
  }'
```

---

## 9. Job Details by UID — `jobPostingByUid` (no alias)

**Purpose:** Alternative job detail query keyed by numeric UID instead of ciphertext. Returns buyer info, payment verification and current user qualification matches.

**Trigger:** `runJobDetailsQuery` message (sent from popup when needed).

**Endpoint:** `POST /api/graphql/v1` (no alias parameter)

**Auth token:** `oauth2_global_js_token` → fallback `UniversalSearchNuxt_vt` → fallback `JobDetailsNuxt_vt`

### Variables

```json
{
  "jobId": "1234567890123456"
}
```

### GraphQL Query

```graphql
query GetJobDetails($jobId: String!) {
  jobPostingByUid(uid: $jobId) {
    buyer {
      info {
        company {
          name id companyUid contractDate isEDCReplicated
          profile { size industry visible }
        }
        location { country city state countryTimezone offsetFromUtcMillis }
        jobs { postedCount filledCount openCount }
        stats {
          feedbackCount hoursCount totalAssignments score totalJobsWithHires
        }
      }
      isPaymentMethodVerified
      isEnterprise
      cssTier
    }
    currentUserInfo {
      owner
      freelancerInfo {
        qualificationsMatches {
          totalQualifications totalMatches
          matches {
            qualification qualified clientPreferred freelancerValue
            freelancerValueLabel clientPreferredLabel
          }
        }
      }
    }
    similarJobs { uid title }
  }
}
```

### cURL

```bash
curl -X POST "https://www.upwork.com/api/graphql/v1" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer <oauth2_global_js_token>" \
  -H "x-xsrf-token: <XSRF-TOKEN>" \
  -H "x-upwork-accept-language: en-US" \
  --data-raw '{
    "query": "...(full query above)...",
    "variables": { "jobId": "1234567890123456" }
  }'
```

---

## 10. Application Readiness — REST

**Purpose:** Checks whether a proposal can be submitted for a given job (connects required, test stats, etc.).

**Trigger:** `runFullJobCapture` message handler (Step 3, query #5).

**Endpoint:** `GET /api/v3/proposals/jobs/{cipher}/ready_to_submit?include_test_stats=true`

**Auth token:** `oauth2_global_js_token`

### cURL

```bash
curl -X GET "https://www.upwork.com/api/v3/proposals/jobs/~0123456789abcdef/ready_to_submit?include_test_stats=true" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer <oauth2_global_js_token>" \
  -H "x-upwork-accept-language: en-US"
```

---

## 11. Company / Org Profile — REST

**Purpose:** Fetches the company's public profile from the org API.

**Trigger:** `runFullJobCapture` (Step 3, query #6) when a `companyId` or `orgUid` is available.

**Endpoint:** `GET /api/v2/org/companies/{orgId}/`

**Auth token:** `oauth2_global_js_token`

### cURL

```bash
curl -X GET "https://www.upwork.com/api/v2/org/companies/2012207015295215238/" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer <oauth2_global_js_token>" \
  -H "x-upwork-accept-language: en-US"
```

---

## 12. Job v2 REST

**Purpose:** Fetches job metadata from the legacy v2 REST API.

**Trigger:** `runFullJobCapture` (Step 3, query #7).

**Endpoint:** `GET /api/v2/jobs/{cipher}/`

**Auth token:** `oauth2_global_js_token`

### cURL

```bash
curl -X GET "https://www.upwork.com/api/v2/jobs/~0123456789abcdef/" \
  -H "Accept: application/json" \
  -H "Authorization: Bearer <oauth2_global_js_token>" \
  -H "x-upwork-accept-language: en-US"
```

---

## 13. n8n Webhook (Outbound)

**Purpose:** Forwards all scraped & enriched job data to an external n8n automation workflow for downstream processing (CRM, notifications, etc.).

**Trigger:** After every successful job lookup or search result.

**Endpoint:** `POST https://n8n-production-3b5ff.up.railway.app/webhook/upwork-leads`
(Configurable in `config.js` under `EXT_CONFIG.WEBHOOK_URL`)

### Headers

```http
Content-Type: application/json
```

### Body shape (search scraping)

```json
{
  "source": "search",
  "query": "n8n",
  "jobCiphertext": "~0123456789abcdef",
  "jobTitle": "n8n Automation Developer",
  "jobType": "HOURLY",
  "jobCategory": "Software Development",
  "description": "...",
  "budget": { "amount": null, "currencyCode": "USD" },
  "hourlyBudget": { "hourlyBudgetMin": 30, "hourlyBudgetMax": 60, "hourlyBudgetType": "RANGE" },
  "postedOn": "2026-04-07T10:00:00Z",
  "skills": ["n8n", "Node.js", "API Integration"],
  "companyId": "2012207015295215238",
  "companyName": "Acme Corp",
  "industry": "Technology",
  "companySize": "10",
  "clientCountry": "United States",
  "clientCity": "New York",
  "clientScore": 4.9,
  "totalJobsPosted": 42,
  "totalHired": 38,
  "totalSpent": 125000.00,
  "feedbackCount": 35,
  "paymentVerified": true,
  "enterprise": false,
  "totalApplicants": 14,
  "lastBuyerActivity": "2026-04-07T09:00:00Z",
  "runAt": "2026-04-07T11:00:00Z"
}
```

### cURL

```bash
curl -X POST "https://n8n-production-3b5ff.up.railway.app/webhook/upwork-leads" \
  -H "Content-Type: application/json" \
  --data-raw '{
    "source": "search",
    "jobCiphertext": "~0123456789abcdef",
    "jobTitle": "n8n Automation Developer",
    ...
  }'
```

---

## 14. Client Company Metadata — `clientCompanyMetadata`

**Purpose:** Returns the company name and identifiers for a given company UID. Provides the `name` field that is missing from `jobAuthDetails` (`buyer.info.company.name` is often `null`). Used to backfill the company name in the webhook payload under `clientCompanyMetadata`.

**Trigger:** `buildJobEntry()` and the older `runQueriesInTab()` path — called after `companyBuyer` resolves, when a `companyId` is available.

**Endpoint:** `POST /api/graphql/v1`

**Auth token:** Captured live from the first GQL request fired by `https://www.upwork.com/ab/messages/rooms/` via CDP `Network.requestWillBeSent`. The token is a session-scoped microapp token (e.g. `oauth2v2_int_...`), NOT `ag_vs_ui_gql_token`.

**Requires `X-Upwork-API-TenantId`** — the messages/rooms page sends this header alongside the live token.

> **Implementation note:** The extension opens a hidden `about:blank` tab, attaches a CDP debugger, enables `Network`, navigates to `messages/rooms/`, and listens for the first `Network.requestWillBeSent` event with a URL containing `api/graphql/v1`. It merges headers from `Network.requestWillBeSentExtraInfo` (browser-added), then immediately fires a `Runtime.evaluate` with the captured `Authorization` and `X-Upwork-API-TenantId` values substituted into the clientCompanyMetadata fetch.

### Variables

```json
{
  "uid": "1925253415047326392"
}
```

> `uid` = `jobAuthDetails.buyer.info.company.companyId`

### GraphQL Query

```graphql
query($uid: ID!) {
  clientCompanyMetadata(id: $uid) {
    rid
    uid
    name
  }
}
```

### cURL

```bash
curl -X POST "https://www.upwork.com/api/graphql/v1" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -H "Authorization: bearer <captured_from_messages_rooms_page>" \
  -H "X-XSRF-TOKEN: <XSRF-TOKEN>" \
  -H "X-Upwork-API-TenantId: <current_organization_uid>" \
  -H "Accept-Language: en-US,en;q=0.9" \
  -H "Origin: https://www.upwork.com" \
  -H "Referer: https://www.upwork.com/ab/messages/rooms/" \
  --data-raw '{
    "query": "query($uid: ID!) { clientCompanyMetadata(id: $uid) { rid uid name } }",
    "variables": { "uid": "1925253415047326392" }
  }'
```

### Response shape

```json
{
  "data": {
    "clientCompanyMetadata": {
      "rid": "123456",
      "uid": "1925253415047326392",
      "name": "Acme Golf Tours"
    }
  }
}
```

---

## Query Execution Flow

```
User clicks Run Scrape / Search
        │
        ▼
[1] UserJobSearch  ──── paginate ───► collect ciphertexts
        │
        ▼ (for each cipher)
[3] JobAuthDetailsQuery  ──┐
[5] clientInfoByOpening  ──┤ (parallel, inside CDP-attached tab)
        │                  │
        │  if companyId ───┘
        ▼
[7] getAgencyStaffsAuth  ──► Phase 1: get staff list
        │
        ▼ (for each freelancer staff)
[8] GetTalentProfile (getDetails)  ──► Phase 2: per-freelancer profile
        │
        ▼
[14] clientCompanyMetadata  ──► backfill company name (messages/rooms tab)
        │
        ▼
[13] POST webhook ──► n8n

─────────────────────────────────────────────────────────
Passive browse (user opens a job page):
        │
        ▼
CDP captures Network traffic ──► [3] JobAuthDetailsQuery response found
        │
        ▼
buildJobEntry() ──► [5] companyBuyer (messages/rooms tab)
                ──► [14] clientCompanyMetadata (messages/rooms tab)
                ──► [7/8] runAgencyLookupInNewTab
                ──► saveJobEntry() ──► companyLookups storage
```

---

## Token Priority Matrix

| Query | Primary Token | Fallback | TenantId? |
|---|---|---|---|
| UserJobSearch | `UniversalSearchNuxt_vt` | — | No |
| JobPubDetailsQuery | `UniversalSearchNuxt_vt` | — | No |
| JobAuthDetailsQuery | `JobDetailsNuxt_vt` | `FxJobPosting_vt` → `oauth2_global_js_token` | No |
| fetchJobDetailsAndContext | `oauth2_global_js_token` | — | **Yes** |
| clientInfoByOpening (companyBuyer) | Captured live from messages/rooms page | — | No |
| SearchJobCard | `UniversalSearchNuxt_vt` | — | No |
| getAgencyStaffsAuth | `ag_vs_ui_gql_token` | `oauth2_global_js_token` | **Yes** |
| GetTalentProfile (getDetails) | Captured live from freelancer page | — | No |
| jobPostingByUid | `oauth2_global_js_token` | `UniversalSearchNuxt_vt` | No |
| clientCompanyMetadata | Captured live from messages/rooms page | — | **Yes** |
| REST endpoints | `oauth2_global_js_token` | — | No |

---

## Known Issues & Debugging Notes

### 1. `ag_vs_ui_gql_token` cookie ≠ actual Authorization header

**Problem:** `chrome.cookies.getAll()` returns the `ag_vs_ui_gql_token` cookie value, but the actual `Authorization: bearer ...` header the browser sends for most GQL requests is a **different, runtime-generated token** (`oauth2v2_int_...` scoped per microapp). Injecting `ag_vs_ui_gql_token` directly into a `fetch()` call results in a **403 "provided tenant id could not be found in users tenants"** error.

**Root cause:** Upwork microapp pages (`messages/rooms`, job details, etc.) each generate their own short-lived `oauth2v2_int_*` session token at page load. This token is different from the cookie value visible via `chrome.cookies`. `document.cookie` in page context also cannot read it because it is **HttpOnly**.

**Fix:** Never inject cookie values as bearer tokens. Instead, open the target page via CDP, enable `Network` domain, and capture the real `Authorization` header from the first `Network.requestWillBeSent` event that hits `api/graphql/v1`. Then replay that exact header.

---

### 2. `companyBuyer` / `clientCompanyMetadata` timing out (status: 0)

**Problem:** Both queries open a `messages/rooms/` tab and wait for `Page.loadEventFired` before firing the GQL fetch. This causes a 25–30 s timeout when:
- The page redirects multiple times before settling (each redirect fires a new navigation)
- The service worker is restarted mid-flight and the CDP debugger listener is garbage-collected
- The tab gets blocked by Cloudflare or login redirects before `loadEventFired`

**Fix (current):** Switch from waiting for `Page.loadEventFired` to waiting for `Network.requestWillBeSent` with `url.includes('api/graphql/v1')`. The page fires a GQL request very early in its load cycle — well before the full `loadEventFired`. This is now the mechanism used by both functions.

**Debug steps if status is still 0:**
1. Open Chrome extension background service worker console (`chrome://extensions` → Service Worker)
2. Look for: `[upwork-ext] companyBuyer: captured GQL headers — auth: true tenant: true`
3. If `auth: false` → the page isn't firing GQL before the 30 s timeout; check if Upwork is logged in
4. If `auth: true` but `status: 0` → the `Runtime.evaluate` call itself timed out; increase `awaitPromise` timeout

---

### 3. `clientInfoByOpening` — ExecutionAborted (fields not permitted)

**Problem:** Certain fields in the `clientInfoByOpening` query are **not accessible** with the `messages/rooms/` microapp token. Requesting them causes the entire response to be aborted with:
```json
{
  "errors": [{
    "message": "Requested oAuth2 client does not have permission to see some of the requested fields.",
    "extensions": { "classification": "ExecutionAborted" }
  }]
}
```

**Restricted fields (must be omitted):**
| Field | Path |
|---|---|
| `logo` | `clientInfoByOpening.buyer.info.logo` |
| `avgHourlyJobsRate` | `clientInfoByOpening.buyer.info.avgHourlyJobsRate` |
| `cssTier` | `clientInfoByOpening.buyer.cssTier` |
| `visible` | `clientInfoByOpening.buyer.info.company.profile.visible` |
| `l3Occupations` | `clientInfoByOpening.buyer.info.company.profile.l3Occupations` |

**Fix:** Remove all restricted fields from the query. The current query in `background.js` already has them stripped.

---

### 4. `clientCompanyMetadata` always null in webhook payload

**Problem:** `clientCompanyMetadata` was populated in the `runQueriesInTab()` path but **never called inside `buildJobEntry()`** (the passive browse path). The field was always `null` in the webhook body because `buildJobEntry` completed and sent the webhook before the metadata resolved.

**Fix:** Added an explicit `await runClientCompanyMetadataInNewTab(agencyCId)` call inside `buildJobEntry()` after `companyBuyer` and before the agency lookup.

---

### 5. TenantId rule — 403 when sent with `_vt` tokens

**Problem:** Sending `X-Upwork-API-TenantId` alongside a `_vt` microapp token (e.g. `JobDetailsNuxt_vt`, `UniversalSearchNuxt_vt`) causes a hard **403** from Upwork's API:
```
Authorization failed: provided tenant (organization) id could not be found in users tenants
```

**Root cause:** `_vt` tokens are scoped to a single microapp and have no tenant association. The API rejects any tenant header paired with them.

**Rule:** Only send `X-Upwork-API-TenantId` when using `oauth2_global_js_token` or a live-captured `oauth2v2_int_*` token from a page that itself sends the tenant header (e.g. `messages/rooms`, `fetchJobDetailsAndContext`).

---

### 6. CDP debugger attach race condition

**Problem:** If `chrome.debugger.onEvent.addListener()` is called before `Page.enable` or `Network.enable` completes, early CDP events can be missed. Specifically, if `Page.navigate` fires and the page loads before the listener is registered, `Page.loadEventFired` or the first `Network.requestWillBeSent` will never be seen.

**Fix (current):** Add the event listener **before** calling `chrome.debugger.attach()`, so no events are missed during the async attach callback. The `_pTab` guard (`if (!_pTab || src.tabId !== _pTab.id) return`) prevents spurious triggers from other tabs.

---

### 7. Multiple `messages/rooms/` tabs open simultaneously

**Problem:** `companyBuyer` and `clientCompanyMetadata` each open a separate `messages/rooms/` tab. If jobs are processed rapidly, several hidden tabs accumulate. Each tab is cleaned up via `chrome.tabs.remove()` in the `done()` callback, but if the service worker is killed mid-flight, orphan tabs may remain.

**Mitigation:** Both functions use `attachedTabs` set to track open tabs. On service worker restart, any tab IDs in `attachedTabs` that no longer exist are silently ignored. Tabs are always removed inside the `done()` cleanup path regardless of success or timeout.

