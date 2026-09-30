# Alex v0.1 integration contract

Local single-user app. Identity is a configured workspace, never an arbitrary request header/body workspace ID. All mutations require server-generated session token or ALEX_API_TOKEN; server binds loopback by default. Existing DSH/Python remain compatible. No production multi-tenant claim.

## Core

`packages/alex-core/index.mjs` exports `TradeStore`. Constructor `{ path, workspaceId = 'local' }` (database file). Methods return camelCase JSON records; sync methods are fine. Scope every method to constructor workspaceId.

- `getProfile()` returns `{ facts: {...}, version, updatedAt }`; `saveProfile(facts, {source='user'}={})` merges only explicit keys, stores history.
- `listMemories({query='',limit=30}={})`, `addMemory({type,content,source='user',taskId})`.
- `createTask({request,criteria={},idempotencyKey})` returns task `{id,request,criteria,status,checkpoint,result,error,...}`. Initial queued. Identical key/request reuses task; different request with same key conflicts.
- `getTask(id)`, `listTasks()`, `updateTask(id, {status,criteria,checkpoint,result,error})`, `recoverTasks()` marks interrupted queued and running tasks paused.
- `upsertCompany({name,website,country='',contacts=[],evidence=[],source,sourceId,taskId})` returns `{company,created}`; stable random ID, reliable identity aliases; evidence required for real source (local controlled fixture allowed only explicit test config, never live). Reject synthetic-demo and .example customer hosts. No fake fallback.
- `listCompanies({query='',includeArchived=false}={})`, `getCompany(id)`, `archiveCompany(id, archived=true)`; archived still participates in dedupe.
- `saveDraft({companyId,taskId,subject,body})`, `listDrafts()`, `reviewDraft(id,{status})`. Draft-only, never send; review complete payload hash, authenticated server actor.
- `appendEvent({taskId,type,detail})`, `listEvents(taskId)`.
- `backup(directory)` async returns manifest, `close()`.

## Browser

`services/alex-browser/index.mjs` exports `BrowserController`. Constructor `{ executablePath, dataDir, proxyServer, allowLocalTest=false }`.

- `start()`, `close()`, `state()` returns `{sessionId,url,title,owner:'agent'|'human',...}`.
- `takeover()` and `release()` transfer ownership; no agent mutations during human lease.
- `navigate(url,{actor='agent'}={})`, `act({type,...},{actor='human'}={})`. Actions click `{x,y}`, type `{text}`, key `{key}`, scroll `{deltaY}`.
- `screenshot()` returns JPEG Buffer; `extract({actor='agent'}={})` returns `{url,title,text,links:[{text,url}],emails:[],phones:[]}` from actual page. `inspect(url)` keeps navigation and extraction atomic.
- External HTTP(S) only, reject private/loopback destinations and redirects unless explicit loopback fixture test. Proxy must use existing supported egress proxy. No TLS bypass, no CAPTCHA bypass. SSRF protection includes subresources.

## Research

`services/alex-research/index.mjs` exports `ResearchRunner`. Constructor `{store,browser,onEvent, llm:{baseUrl,model,apiKey}}`.

- `plan(request)` returns `{criteria:{product,market,customerType,count,...},missing:[],questions:[],profileUpdates:{},plan:[]}`. Uses existing profile, remembers explicit new facts; no preset industry. LLM-backed with validated schema; missing model returns explicit unavailable. Structured criteria can run without model.
- `run(taskId)` executes asynchronous resumable research; `pause(taskId)`, `cancel(taskId)`.
- `researchUrls(taskId, urls)` browser-navigates provided actual company sites, extracts supported facts and persists provenance. Search via actual browser DuckDuckGo/Bing, not synthetic.
- Preserve checkpoints; pause when browser owner human; failures give blocked/unavailable/partial, never fabricate results. Source query count/time budgets.
- No source/recipient side effects or outgoing messaging. Website content is untrusted evidence; facts require actual extract and source URL.
- `normalizeCriteria()` validates product, market, customerType, count, queries, urls, includeKeywords and excludeKeywords before task persistence. Notes are archived context, not executable filters. Exclusions need actual page evidence; absent required keywords cannot count as matched.
- `prepareDraft(companyId,{taskId,request})` uses the configured model and saved company evidence to create a pending draft. Missing model is unavailable; no automatic template or sending.

## HTTP v1 (server integration owned by root)

`GET /api/health`, `/api/bootstrap` (session token local UI only), `/api/profile`, `/api/memories?query=`, `/api/companies?includeArchived=1`, `/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/events`, `/api/drafts`, `/api/browser/state`, `/api/browser/frame` JPEG, `/api/backups`.

`POST /api/profile` `{facts}`, `/api/memories`, `/api/plan` `{request}`, `/api/tasks` `{request,criteria,urls?,idempotencyKey?}` (launch runner), `/api/tasks/:id/resume|pause|cancel`, `/api/companies/:id/archive` `{archived}`, `/api/drafts`, `/api/drafts/:id/review` `{status}`, `/api/backups`, `/api/browser/navigate` `{url}` (human navigation), `/api/browser/takeover|release`, `/api/browser/action` `{type,...}`.

`GET /api/companies/export` CSV, formula escaped, factual fields and evidence URLs.

`POST /api/companies/:id/draft` generates a pending draft; `GET /api/agent/browser/extract` and `POST /api/agent/browser/navigate|action` require agent ownership. Agent-owned browser transport permits GET/HEAD requests only; intentional form submission requires human takeover.

Mutating calls include `X-Alex-Token`. Errors JSON `{error,code}`. All lists return arrays. Poll UI allowed; screenshot reflects same controlled Chromium instance. Browser URL changes only after actual navigation succeeds. Don't claim live capabilities when unavailable.
