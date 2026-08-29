// @ts-check

import { decodeEntities } from '../providers/_html-entities.mjs';
import { BROWSER_LIKE_USER_AGENT } from '../providers/_http.mjs';

const SITE_ORIGIN = 'https://www.workatastartup.com';
const SEARCH_URL = `${SITE_ORIGIN}/jobs/search`;
const YC_ORIGIN = 'https://www.ycombinator.com';
const YC_DIRECTORY_URL = `${YC_ORIGIN}/companies`;
const YC_COMPANY_INDEX = 'YCCompany_production';
const MAX_QUERIES = 8;
const MAX_JOBS = 500;
const QUERY_CHUNK_SIZE = 4;
const MAX_COMPANY_QUERIES = 6;
const MAX_COMPANY_PAGES = 120;
const COMPANY_HITS_PER_QUERY = 100;
const COMPANY_PAGE_CONCURRENCY = 6;
const YC_DIRECTORY_TIMEOUT_MS = 20_000;
const YC_COMPANY_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const YC_JOB_SLUG_RE = /^[A-Za-z0-9_-]+$/;
const CONTEXTUAL_ENGINEERING_TITLE_RE = /\b(?:engineer(?:ing)?|developer|architect|member of technical staff|mts)\b/i;
const CONTEXTUAL_TITLE_EXCLUSION_RE = /\b(?:developer relations?|devrel|developer advocate|gtm|go[- ]to[- ]market|sales|quality assurance|qa|test(?:ing)? engineer)\b/i;

function cleanTitleKeyword(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/^word:/i, '')
    .replace(/\s*\+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build bounded YC semantic-search queries from portals.yml title keywords. */
export function buildYCSearchQueries(titleFilterConfig) {
  const positive = Array.isArray(titleFilterConfig?.positive)
    ? titleFilterConfig.positive
    : [];
  const unique = [...new Set(positive.map(cleanTitleKeyword).filter(Boolean))];
  if (unique.length === 0) return ['software engineer'];

  const queries = [];
  for (let i = 0; i < unique.length && queries.length < MAX_QUERIES; i += QUERY_CHUNK_SIZE) {
    queries.push(unique.slice(i, i + QUERY_CHUNK_SIZE).join(' OR '));
  }
  return queries;
}

/**
 * Build a small set of company-domain queries from the saved role profile.
 * These query YC's hiring-company index; job-title matching still happens
 * later, after each relevant company's complete YC jobs page is read.
 */
export function buildYCCompanySearchQueries(titleFilterConfig) {
  const positive = Array.isArray(titleFilterConfig?.positive)
    ? titleFilterConfig.positive
    : [];
  const text = positive.map(cleanTitleKeyword).join(' ').toLowerCase();
  if (!text) return [];

  const has = (pattern) => pattern.test(text);
  const hasAI = has(/\bai\b|artificial intelligence|generative ai/);
  const hasAgent = has(/\bagent(?:ic)?s?\b/);
  const hasPlatform = has(/\bplatform\b|\bsystems?\b|\btooling\b|\bharness\b|developer experience/);
  const queries = [];

  if (hasAI && hasAgent) queries.push('AI agent');
  if (hasAgent && hasPlatform) queries.push('agent platform');
  if (has(/\bllms?\b|large language model/)) queries.push('LLM');
  if (hasAI && hasPlatform) queries.push('AI developer tools');
  if (has(/\bevals?\b|\bevaluation\b/)) queries.push('AI evaluation');
  if (has(/\bsafety\b/)) queries.push('AI safety');
  if (has(/generative ai/)) queries.push('generative AI');

  return [...new Set(queries)].slice(0, MAX_COMPANY_QUERIES);
}

function normalizedIntentText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function intentTokenMatches(text, token) {
  if (token === 'ai') return /\bai\b|\bartificial intelligence\b/.test(text);
  if (token === 'llm') return /\bllms?\b|\blarge language models?\b/.test(text);
  if (token === 'agent') return /\bagents?\b|\bagentic\b/.test(text);
  if (token === 'evaluation') return /\bevaluations?\b|\bevals?\b/.test(text);
  return text.includes(token);
}

function textMatchesIntent(value, query) {
  const text = normalizedIntentText(value);
  const tokens = normalizedIntentText(query).split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every(token => intentTokenMatches(text, token));
}

function titleMatchesKeyword(title, keyword) {
  const raw = typeof keyword === 'string' ? keyword.trim() : '';
  if (!raw) return false;
  const wordOnly = /^word:/i.test(raw);
  const cleaned = cleanTitleKeyword(raw);
  if (!cleaned) return false;
  if (raw.includes('+')) {
    return raw.split('+').map(cleanTitleKeyword).filter(Boolean)
      .every(part => normalizedIntentText(title).includes(normalizedIntentText(part)));
  }
  if (wordOnly) {
    const escaped = cleaned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(title);
  }
  return normalizedIntentText(title).includes(normalizedIntentText(cleaned));
}

function titleCouldBeRelevant(title, titleFilterConfig) {
  const positive = Array.isArray(titleFilterConfig?.positive) ? titleFilterConfig.positive : [];
  if (positive.some(keyword => titleMatchesKeyword(title, keyword))) return true;
  return CONTEXTUAL_ENGINEERING_TITLE_RE.test(title)
    && !CONTEXTUAL_TITLE_EXCLUSION_RE.test(title);
}

/** Parse the public Algolia credentials emitted by YC's company directory. */
export function parseYCCompanySearchConfig(html) {
  if (typeof html !== 'string' || !html) return null;
  const match = html.match(/window\.AlgoliaOpts\s*=\s*(\{[^;\n]+\})/);
  if (!match) return null;
  let raw;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const app = typeof raw?.app === 'string' ? raw.app.trim() : '';
  const key = typeof raw?.key === 'string' ? raw.key.trim() : '';
  if (!/^[A-Za-z0-9]{6,24}$/.test(app) || !/^[A-Za-z0-9_-]{20,}$/.test(key)) return null;
  return { app, key };
}

function parseDataPage(html) {
  if (typeof html !== 'string' || !html) return null;
  const match = html.match(/\bdata-page="([^"]+)"/i);
  if (!match) return null;
  try {
    return JSON.parse(decodeEntities(match[1]));
  } catch {
    return null;
  }
}

/** Parse all current jobs from one official ycombinator.com company page. */
export function parseYCCompanyJobsHtml(html, { expectedSlug = '', matchedIntent = '' } = {}) {
  const page = parseDataPage(html);
  const company = page?.props?.company;
  const postings = page?.props?.jobPostings;
  if (!company || !Array.isArray(postings)) return [];

  const slug = typeof company.slug === 'string' ? company.slug.trim() : '';
  if (!YC_COMPANY_SLUG_RE.test(slug) || (expectedSlug && slug !== expectedSlug)) return [];
  const name = typeof company.name === 'string' ? company.name.trim() : '';
  if (!name) return [];

  const oneLiner = typeof company.one_liner === 'string' ? company.one_liner.trim() : '';
  const longDescription = typeof company.long_description === 'string' ? company.long_description.trim() : '';
  const tags = Array.isArray(company.tags) ? company.tags.filter(tag => typeof tag === 'string').join(' ') : '';
  const companyText = [oneLiner, longDescription, tags].filter(Boolean).join(' ');
  const prefix = `/companies/${slug}/jobs/`;
  const jobs = [];

  for (const raw of postings) {
    if (!raw || typeof raw !== 'object') continue;
    const id = Number(raw.id);
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const path = typeof raw.url === 'string' ? raw.url.trim() : '';
    const jobSlug = path.startsWith(prefix) ? path.slice(prefix.length) : '';
    if (!Number.isSafeInteger(id) || id <= 0 || !title || !YC_JOB_SLUG_RE.test(jobSlug)) continue;
    const location = typeof raw.location === 'string' ? raw.location.trim() : '';
    const sponsorship = typeof raw.visa === 'string' ? raw.visa.trim() : '';
    jobs.push({
      title,
      company: name,
      location,
      url: `${YC_ORIGIN}${path}`,
      ...(companyText ? { description: companyText } : {}),
      sponsorship,
      _ycJobId: id,
      _ycContext: { companyText, matchedIntent, method: 'company-page' },
    });
  }
  return jobs;
}

/**
 * Allow broad startup titles only for roles found on a company page that
 * itself matched the user's configured AI/agent intent. Negative title rules
 * still win, so this cannot re-admit staff, intern, or other excluded roles.
 */
export function isYCContextualEngineeringRole(job, titleFilterConfig) {
  const context = job?._ycContext;
  if (!context || context.method !== 'company-page') return false;
  if (!CONTEXTUAL_ENGINEERING_TITLE_RE.test(String(job.title || ''))) return false;
  if (CONTEXTUAL_TITLE_EXCLUSION_RE.test(String(job.title || ''))) return false;
  const negative = Array.isArray(titleFilterConfig?.negative) ? titleFilterConfig.negative : [];
  if (negative.some(keyword => titleMatchesKeyword(String(job.title || ''), keyword))) return false;
  return textMatchesIntent(`${context.companyText || ''} ${job.description || ''}`, context.matchedIntent);
}

/** Normalize one /jobs/search result. */
export function normalizeYCSearchJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.id);
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const company = typeof raw.companyName === 'string' ? raw.companyName.trim() : '';
  if (!Number.isSafeInteger(id) || id <= 0 || !title || !company) return null;

  const location = typeof raw.location === 'string' ? raw.location.trim() : '';
  const oneLiner = typeof raw.companyOneLiner === 'string' ? raw.companyOneLiner.trim() : '';
  return {
    title,
    company,
    location,
    url: `${SITE_ORIGIN}/jobs/${id}`,
    _ycJobId: id,
    ...(oneLiner ? { description: oneLiner } : {}),
  };
}

function stripHtml(html) {
  if (typeof html !== 'string' || !html) return '';
  const noMedia = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  return decodeEntities(noMedia.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Parse the Inertia data-page payload from a public YC job detail page. */
export function parseYCJobDetailHtml(html) {
  const page = parseDataPage(html);
  const raw = page?.props?.job;
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.id);
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const company = typeof raw.company?.name === 'string' ? raw.company.name.trim()
    : (typeof raw.companyName === 'string' ? raw.companyName.trim()
      : (typeof page?.props?.company?.name === 'string' ? page.props.company.name.trim() : ''));
  if (!Number.isSafeInteger(id) || id <= 0 || !title) return null;

  const sponsorship = typeof raw.sponsorsVisa === 'string' ? raw.sponsorsVisa.trim()
    : (typeof raw.visa === 'string' ? raw.visa.trim() : '');
  const rawDescription = typeof raw.descriptionHtml === 'string' ? raw.descriptionHtml
    : (typeof raw.description === 'string' ? raw.description : '');
  const description = stripHtml(rawDescription);
  return {
    id,
    title,
    company,
    location: typeof raw.location === 'string' ? raw.location.trim() : '',
    sponsorship,
    description,
  };
}

function normalizeYCCompanyHit(raw, matchedIntent) {
  if (!raw || typeof raw !== 'object' || raw.isHiring !== true) return null;
  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || !YC_COMPANY_SLUG_RE.test(slug)) return null;
  const oneLiner = typeof raw.one_liner === 'string' ? raw.one_liner.trim() : '';
  const longDescription = typeof raw.long_description === 'string' ? raw.long_description.trim() : '';
  const tags = Array.isArray(raw.tags) ? raw.tags.filter(tag => typeof tag === 'string').join(' ') : '';
  const industries = Array.isArray(raw.industries) ? raw.industries.filter(value => typeof value === 'string').join(' ') : '';
  const companyText = [name, oneLiner, longDescription, tags, industries].filter(Boolean).join(' ');
  if (!textMatchesIntent(companyText, matchedIntent)) return null;
  const score = (textMatchesIntent(oneLiner, matchedIntent) ? 30 : 0)
    + (textMatchesIntent(tags, matchedIntent) ? 20 : 0)
    + (textMatchesIntent(longDescription, matchedIntent) ? 10 : 0);
  return { name, slug, matchedIntent, score };
}

async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) break;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchYCCompanyPageJobs({ ctx, titleFilterConfig, maxJobs, onWarning }) {
  if (!ctx?.fetchText || !ctx?.fetchJson) return [];
  const queries = buildYCCompanySearchQueries(titleFilterConfig);
  if (queries.length === 0) return [];

  const directoryHtml = await ctx.fetchText(YC_DIRECTORY_URL, {
    timeoutMs: YC_DIRECTORY_TIMEOUT_MS,
    redirect: 'error',
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': BROWSER_LIKE_USER_AGENT,
    },
  });
  const searchConfig = parseYCCompanySearchConfig(directoryHtml);
  if (!searchConfig) throw new Error('YC company directory has no readable public search config');

  const searchUrl = `https://${searchConfig.app.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries`;
  const requests = queries.map(query => ({
    indexName: YC_COMPANY_INDEX,
    params: new URLSearchParams({
      query,
      hitsPerPage: String(COMPANY_HITS_PER_QUERY),
      filters: 'isHiring:true',
      attributesToRetrieve: 'name,slug,one_liner,long_description,tags,industries,isHiring',
      analytics: 'false',
    }).toString(),
  }));
  const payload = await ctx.fetchJson(searchUrl, {
    timeoutMs: YC_DIRECTORY_TIMEOUT_MS,
    method: 'POST',
    body: JSON.stringify({ requests }),
    redirect: 'error',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-algolia-application-id': searchConfig.app,
      'x-algolia-api-key': searchConfig.key,
      'user-agent': BROWSER_LIKE_USER_AGENT,
    },
  });
  if (!payload || !Array.isArray(payload.results)) {
    throw new Error('YC company search returned an unexpected response shape');
  }

  const companies = new Map();
  for (let i = 0; i < payload.results.length && i < queries.length; i++) {
    const hits = Array.isArray(payload.results[i]?.hits) ? payload.results[i].hits : [];
    for (const raw of hits) {
      const company = normalizeYCCompanyHit(raw, queries[i]);
      if (!company) continue;
      const previous = companies.get(company.slug);
      if (!previous || company.score > previous.score) companies.set(company.slug, company);
    }
  }

  const companyLimit = Math.min(
    MAX_COMPANY_PAGES,
    Math.max(40, Math.ceil(Math.min(maxJobs, MAX_JOBS) * 0.75)),
  );
  const selected = [...companies.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, companyLimit);
  const pages = await mapConcurrent(selected, COMPANY_PAGE_CONCURRENCY, async (company) => {
    try {
      const html = await ctx.fetchText(`${YC_ORIGIN}/companies/${company.slug}/jobs`, {
        timeoutMs: YC_DIRECTORY_TIMEOUT_MS,
        redirect: 'error',
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': BROWSER_LIKE_USER_AGENT,
        },
      });
      return parseYCCompanyJobsHtml(html, {
        expectedSlug: company.slug,
        matchedIntent: company.matchedIntent,
      }).filter(job => titleCouldBeRelevant(job.title, titleFilterConfig));
    } catch (err) {
      onWarning?.(`${company.name} company jobs page failed: ${err.message}`);
      return [];
    }
  });
  return pages.flat().slice(0, maxJobs);
}

async function fetchYCSearchJobs({ ctx, titleFilterConfig, maxJobs }) {
  const queries = buildYCSearchQueries(titleFilterConfig);
  const jobs = [];
  const seen = new Set();

  for (let i = 0; i < queries.length && jobs.length < maxJobs; i++) {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(queries[i])}`;
    const payload = await ctx.fetchJson(url, {
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'user-agent': BROWSER_LIKE_USER_AGENT,
      },
    });
    if (!payload || !Array.isArray(payload.jobs)) {
      throw new Error('unexpected search response shape');
    }
    for (const raw of payload.jobs) {
      const job = normalizeYCSearchJob(raw);
      if (job && !seen.has(job.url)) {
        seen.add(job.url);
        jobs.push(job);
        if (jobs.length >= maxJobs) break;
      }
    }
    if (i < queries.length - 1 && typeof ctx.sleep === 'function') await ctx.sleep(150);
  }
  return jobs;
}

/** YC's explicit existing-work-authorisation category is not sponsorship. */
export function ycExplicitlyRejectsSponsorship(value) {
  if (typeof value !== 'string') return false;
  return /\bus citizen\s*\/\s*visa only\b/i.test(value)
    || /\b(?:no|without)\s+(?:visa\s+)?sponsorship\b/i.test(value)
    || /\b(?:cannot|unable to|do not|does not)\s+sponsor\b/i.test(value);
}

/** Search YC's own live jobs portal. The endpoint returns current public jobs. */
export async function fetchYCStartupJobs({ ctx, titleFilterConfig, maxJobs = MAX_JOBS, onWarning = () => {} }) {
  if (!ctx?.fetchJson) throw new Error('yc-startup-jobs: fetchJson transport is required');
  const limit = Math.max(1, Math.min(Number(maxJobs) || MAX_JOBS, MAX_JOBS));
  const failures = [];
  let companyJobs = [];
  let searchJobs = [];

  if (ctx.fetchText) {
    try {
      companyJobs = await fetchYCCompanyPageJobs({ ctx, titleFilterConfig, maxJobs: limit, onWarning });
    } catch (err) {
      failures.push(`company-page discovery failed: ${err.message}`);
    }
  }
  try {
    searchJobs = await fetchYCSearchJobs({ ctx, titleFilterConfig, maxJobs: limit });
  } catch (err) {
    failures.push(`job search failed: ${err.message}`);
  }

  if (companyJobs.length === 0 && searchJobs.length === 0 && failures.length > 0) {
    throw new Error(`yc-startup-jobs: ${failures.join('; ')}`);
  }
  failures.forEach(onWarning);

  const jobs = [];
  const seen = new Set();
  const sourceLength = Math.max(companyJobs.length, searchJobs.length);
  for (let i = 0; i < sourceLength && jobs.length < limit; i++) {
    for (const job of [companyJobs[i], searchJobs[i]]) {
      if (!job) continue;
      const key = job._ycJobId ? `id:${job._ycJobId}` : job.url;
      if (!seen.has(key)) {
        seen.add(key);
        jobs.push(job);
        if (jobs.length >= limit) break;
      }
    }
  }
  return jobs;
}

/** Enrich a YC search result with the authoritative detail page. */
export async function enrichYCStartupJob(job, ctx) {
  if (!ctx?.fetchText) throw new Error('yc-startup-jobs: fetchText transport is required');
  const html = await ctx.fetchText(job.url, {
    redirect: 'error',
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': BROWSER_LIKE_USER_AGENT,
    },
  });
  const detail = parseYCJobDetailHtml(html);
  if (!detail) throw new Error('yc-startup-jobs: detail page has no readable job payload');

  const companyContext = job?._ycContext?.companyText || '';
  const description = [companyContext, detail.description, detail.sponsorship].filter(Boolean).join(' ');
  const sourceLabel = job?._ycContext?.method === 'company-page'
    ? 'YC company page'
    : 'YC Startup Jobs';
  return {
    ...job,
    title: detail.title || job.title,
    company: detail.company || job.company,
    location: detail.location || job.location,
    ...(description ? { description } : {}),
    sponsorship: detail.sponsorship,
    note: detail.sponsorship
      ? `${sourceLabel} · ${detail.sponsorship}`
      : `${sourceLabel} · sponsorship not stated`,
  };
}
