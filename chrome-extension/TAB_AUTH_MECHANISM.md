# Tab-Based Request Execution & OAuth Bypass

All active GQL requests are executed **inside a real Upwork browser tab** rather than directly from the extension service worker. This is the core mechanism that bypasses OAuth / cookie authentication problems that would otherwise block direct fetch calls.

---

## Why direct fetch from a service worker fails

A Chrome extension service worker runs in an isolated context with no access to the user's Upwork session:

- **HttpOnly cookies are invisible** — `document.cookie` and `fetch` requests from the service worker do not carry `_vt` microapp tokens, `XSRF-TOKEN`, or `oauth2_global_js_token` because they are all `HttpOnly` and `SameSite=Strict`.
- **CORS blocks cross-origin requests** — `fetch('https://www.upwork.com/api/graphql/v1', ...)` from the extension origin is not an Upwork page origin, so `credentials: 'include'` has no session cookies to include and Upwork's CORS policy rejects the call.
- **`_vt` microapp tokens expire and are scoped** — each Upwork frontend micro-app (search, job detail, apply) issues its own short-lived `_vt` token stored as an HttpOnly cookie. These cannot be read or replicated statically; they must be consumed from the live browser session.

---

## How CDP + tab injection solves this

The extension uses the **Chrome DevTools Protocol (CDP)** to attach a debugger session to every Upwork tab (`chrome.debugger.attach`). This gives it privileged access to three capabilities that together solve all the above problems:

| CDP Command | Purpose |
|---|---|
| `Network.enable` | Starts intercepting all network events for the tab |
| `Network.getCookies` | Reads **all** cookies for `upwork.com` including HttpOnly ones — this is how `_vt` tokens are obtained |
| `Network.requestWillBeSentExtraInfo` | Captures the full `Cookie` and `Authorization` headers Chrome adds to each outgoing request — used to harvest tokens passively without navigating |
| `Runtime.evaluate` | Executes arbitrary JavaScript **inside the tab's page context** — used to run `fetch()` with `credentials: 'include'` so the browser attaches all session cookies automatically |

---

## The `tabFetch` pattern

Instead of calling `fetch()` from the service worker, every active GQL query is injected into a real Upwork tab as a string expression via `Runtime.evaluate`:

```js
// Executed inside an Upwork tab via CDP Runtime.evaluate
(async () => {
  const r = await fetch('https://www.upwork.com/api/graphql/v1?alias=...', {
    method: 'POST',
    credentials: 'include',   // ← attaches all session cookies automatically
    headers: { 'Authorization': '<_vt token from getCookies>', 'X-XSRF-TOKEN': '...' },
    body: JSON.stringify({ query: '...', variables: { ... } })
  });
  return r.text();
})()
```

Because the code runs **in the Upwork page's origin**, `credentials: 'include'` causes the browser to attach every session cookie — including the HttpOnly ones the service worker cannot see. The result string is returned back to the service worker via the `returnByValue: true` option.

---

## Token selection per request

Before injecting the `fetch()`, the extension calls `Network.getCookies` to read the current cookies for `https://www.upwork.com` and picks the right token for the query being made:

```
Search queries  →  UniversalSearchNuxt_vt     (from getCookies)
Job detail      →  FxJobPosting_vt / JobDetailsNuxt_vt  (from getCookies, in priority order)
Agency staffs   →  ag_vs_ui_gql_token + X-Upwork-API-TenantId  (captured live from page request)
Freelancer      →  captured live from navigating to a real freelancer page (see below)
Global fallback →  oauth2_global_js_token  (from getCookies or stored sessionTokens)
```

The `XSRF-TOKEN` cookie is also read via `getCookies` and forwarded as the `X-XSRF-TOKEN` header on every request.

---

## Which tab is used for each operation

| Operation | Tab used | How obtained |
|---|---|---|
| **Search scraping** (`runSearchLookup`) | A new tab navigated to the Upwork search URL | Created with `chrome.tabs.create`, waited for `status: 'complete'`, CDP attached |
| **Job detail lookup** (per cipher) | The same search tab, reused after scanning | Already on `www.upwork.com`, CDP already attached, cookies already in place |
| **Passive browse capture** (`triggerJobLookup`) | The tab the user already has open on the job page | CDP was attached on `tabs.onUpdated`; GQL responses are harvested from the tab's natural page load |
| **Agency staff list** (Phase 1) | A new blank tab navigated to the agency page | `chrome.tabs.create({ url: 'about:blank' })` → CDP attach → `Page.navigate` to agency URL; this ensures CDP is active before the first request fires |
| **Freelancer profiles** (Phase 2) | A second new blank tab navigated to `https://www.upwork.com/freelancers/moezz` | Same blank-then-navigate pattern; the page's real `getDetails` request headers are captured live, then replayed for every staff member ciphertext |

---

## Agency lookup: the two-phase blank-tab trick

The `runAgencyLookupInNewTab` function uses a specific pattern to guarantee headers are captured even before the first network request fires.

**Phase 1 — agency page:**
1. `chrome.tabs.create({ url: 'about:blank', active: false })` — creates a blank tab so no network requests fire yet.
2. `chrome.debugger.attach` is called immediately — CDP is now active before navigation.
3. `Network.enable` is called to start capturing.
4. `Page.navigate` navigates to the agency URL. Because CDP was attached first, every request — including the very first `agencystaffsauth` GQL call — is intercepted.
5. `Network.requestWillBeSentExtraInfo` captures the full headers (including `Authorization` with `ag_vs_ui_gql_token` and `X-Upwork-API-TenantId`) from that request.
6. Those captured headers are used to replay `getAgencyStaffsAuth` for all staff pages.

**Phase 2 — freelancer profile headers:**
1. A second blank tab is created and CDP is attached before navigation.
2. The tab is navigated to `https://www.upwork.com/freelancers/moezz` (a known public freelancer profile). This forces the browser to generate a real `getDetails` GQL request with a valid `Authorization` header for the freelancer-profile microapp.
3. The `Network.requestWillBeSentExtraInfo` event captures those headers.
4. The captured headers are injected into a batched `fetch()` loop (via `Runtime.evaluate` in the same tab) that calls `getDetails` once per freelancer staff ciphertext.
5. Both tabs are detached and closed after completion.

This pattern avoids the need to know the correct microapp token in advance — the browser generates it naturally when loading the real page, and CDP intercepts it before any request can escape.

---

## Request template caching

Every successful GQL request whose body contains an explicit `query` string is stored in `chrome.storage.local` under `requestTemplates[alias]`. Stored templates include the full headers from `Network.requestWillBeSentExtraInfo`. On subsequent runs the extension can replay a template (with swapped `variables`) directly from the search tab via `tabFetch`, avoiding a full page navigation if the tokens are still valid.
