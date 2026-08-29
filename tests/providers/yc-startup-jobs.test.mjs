import { pass, fail } from '../helpers.mjs';
import {
  buildYCCompanySearchQueries,
  buildYCSearchQueries,
  enrichYCStartupJob,
  fetchYCStartupJobs,
  isYCContextualEngineeringRole,
  normalizeYCSearchJob,
  parseYCCompanyJobsHtml,
  parseYCCompanySearchConfig,
  parseYCJobDetailHtml,
  ycExplicitlyRejectsSponsorship,
} from '../../seeds/yc-startup-jobs.mjs';

console.log('\nProvider — YC Startup Jobs (workatastartup.com)');

const dataPage = (job) => {
  const json = JSON.stringify({ props: { job } });
  const attr = json
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `<html><body><div data-page="${attr}"></div></body></html>`;
};

const propsPage = (props) => {
  const json = JSON.stringify({ props });
  const attr = json
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `<html><body><div data-page="${attr}"></div></body></html>`;
};

try {
  const queries = buildYCSearchQueries({
    positive: ['word:FDE', 'AI Engineer', 'Agent + Systems Engineer', 'AI Engineer', 'LLM Engineer'],
  });
  if (
    queries.length === 1
    && queries[0] === 'FDE OR AI Engineer OR Agent Systems Engineer OR LLM Engineer'
  ) pass('buildYCSearchQueries cleans operators and deduplicates keywords');
  else fail(`unexpected YC queries: ${JSON.stringify(queries)}`);

  const companyQueries = buildYCCompanySearchQueries({
    positive: ['AI Engineer', 'Agent Platform', 'LLM Engineer', 'Evaluation Engineer'],
  });
  if (
    companyQueries.includes('AI agent')
    && companyQueries.includes('agent platform')
    && companyQueries.includes('LLM')
    && companyQueries.includes('AI evaluation')
  ) pass('buildYCCompanySearchQueries derives company intent from the saved role profile');
  else fail(`unexpected YC company queries: ${JSON.stringify(companyQueries)}`);

  const directoryHtml = '<script>window.AlgoliaOpts = {"app":"ABC123XYZ","key":"publicSearchKey_1234567890"};</script>';
  const companySearchConfig = parseYCCompanySearchConfig(directoryHtml);
  if (companySearchConfig?.app === 'ABC123XYZ' && companySearchConfig.key.startsWith('publicSearchKey')) {
    pass('parseYCCompanySearchConfig reads YC directory search credentials');
  } else fail(`unexpected YC company config: ${JSON.stringify(companySearchConfig)}`);

  const normalized = normalizeYCSearchJob({
    id: 77065,
    title: ' Forward Deployed Engineer ',
    companyName: ' Acme AI ',
    location: ' Remote (EU) ',
    companyOneLiner: 'AI agents for operations',
  });
  if (
    normalized?.url === 'https://www.workatastartup.com/jobs/77065'
    && normalized.company === 'Acme AI'
    && normalized.description === 'AI agents for operations'
  ) pass('normalizeYCSearchJob builds a stable official job URL');
  else fail(`normalizeYCSearchJob returned ${JSON.stringify(normalized)}`);

  if (
    normalizeYCSearchJob({ id: '../admin', title: 'X', companyName: 'Y' }) === null
    && normalizeYCSearchJob({ id: 1, title: '', companyName: 'Y' }) === null
  ) pass('normalizeYCSearchJob rejects unsafe IDs and missing fields');
  else fail('normalizeYCSearchJob accepted an unsafe or incomplete record');

  const detailHtml = dataPage({
    id: 77065,
    title: 'Forward Deployed Engineer',
    location: 'San Francisco, CA, US',
    sponsorsVisa: 'Will sponsor',
    descriptionHtml: '<p>Build &amp; deploy <strong>AI agents</strong>.</p>',
    company: { name: 'Acme AI' },
  });
  const detail = parseYCJobDetailHtml(detailHtml);
  if (
    detail?.sponsorship === 'Will sponsor'
    && detail.description === 'Build & deploy AI agents .'
  ) pass('parseYCJobDetailHtml reads sponsorship and plain-text description');
  else fail(`parseYCJobDetailHtml returned ${JSON.stringify(detail)}`);

  const ycCompanyDetail = propsPage({
    company: { name: 'Lemma' },
    job: {
      id: 104341,
      title: 'Founding Engineer',
      companyName: 'Lemma',
      location: 'San Francisco, CA, US',
      visa: 'Will sponsor',
      description: 'Build production AI agents. We sponsor visas.',
    },
  });
  const ycDetail = parseYCJobDetailHtml(ycCompanyDetail);
  if (ycDetail?.company === 'Lemma' && ycDetail.sponsorship === 'Will sponsor') {
    pass('parseYCJobDetailHtml supports ycombinator.com company job details');
  } else fail(`unexpected YC company detail: ${JSON.stringify(ycDetail)}`);

  const genericOnlyCompanyPage = propsPage({
    company: {
      slug: 'uselemma',
      name: 'Lemma',
      one_liner: 'Production Monitoring for AI agents',
      long_description: 'Find semantic failures in production agent traces.',
      tags: ['Artificial Intelligence', 'Developer Tools'],
    },
    jobPostings: [
      {
        id: 104341,
        title: 'Founding Engineer',
        url: '/companies/uselemma/jobs/founding-engineer',
        location: 'San Francisco, CA, US',
        visa: 'Will sponsor',
      },
      {
        id: 104343,
        title: 'Backend / Infra Engineer',
        url: '/companies/uselemma/jobs/backend-infra-engineer',
        location: 'San Francisco, CA, US',
        visa: 'Will sponsor',
      },
    ],
  });
  const genericOnlyJobs = parseYCCompanyJobsHtml(genericOnlyCompanyPage, {
    expectedSlug: 'uselemma',
    matchedIntent: 'AI agent',
  });
  const contextualConfig = {
    positive: ['AI Engineer', 'Agent Platform'],
    negative: ['Staff Engineer', 'word:Intern'],
  };
  if (
    genericOnlyJobs.length === 2
    && genericOnlyJobs.every(job => isYCContextualEngineeringRole(job, contextualConfig))
  ) pass('company context admits Founding and Backend roles even with no FDE opening');
  else fail(`generic YC company roles were not admitted: ${JSON.stringify(genericOnlyJobs)}`);

  if (!isYCContextualEngineeringRole({
    ...genericOnlyJobs[0],
    title: 'Staff Engineer',
  }, contextualConfig)) pass('contextual YC matching still enforces negative title rules');
  else fail('contextual YC matching re-admitted a negative title');

  if (!isYCContextualEngineeringRole({
    ...genericOnlyJobs[0],
    title: 'Developer Relations',
  }, contextualConfig)) pass('contextual YC matching does not confuse Developer Relations with engineering');
  else fail('contextual YC matching admitted Developer Relations');

  if (
    ycExplicitlyRejectsSponsorship('US citizen/visa only')
    && ycExplicitlyRejectsSponsorship('No visa sponsorship')
    && !ycExplicitlyRejectsSponsorship('Will sponsor')
    && !ycExplicitlyRejectsSponsorship('US citizenship/visa not required')
  ) pass('YC sponsorship classifier separates explicit restrictions from eligible roles');
  else fail('YC sponsorship classifier misclassified a known portal label');

  const calls = [];
  const fetched = await fetchYCStartupJobs({
    titleFilterConfig: { positive: ['AI Engineer', 'Forward Deployed Engineer'] },
    maxJobs: 10,
    ctx: {
      fetchJson: async (url, opts) => {
        calls.push({ url, opts });
        return {
          jobs: [
            { id: 7, title: 'AI Engineer', companyName: 'Acme', location: 'Remote' },
            { id: 7, title: 'AI Engineer', companyName: 'Acme', location: 'Remote' },
          ],
        };
      },
    },
  });
  if (
    fetched.length === 1
    && calls.length === 1
    && calls[0].url.startsWith('https://www.workatastartup.com/jobs/search?q=')
    && calls[0].opts.redirect === 'error'
    && calls[0].opts.headers.accept === 'application/json'
  ) pass('fetchYCStartupJobs uses the official search endpoint and deduplicates results');
  else fail(`fetchYCStartupJobs contract mismatch: ${JSON.stringify({ fetched, calls })}`);

  const discoveryCalls = [];
  const genericDiscovered = await fetchYCStartupJobs({
    titleFilterConfig: contextualConfig,
    maxJobs: 10,
    ctx: {
      fetchText: async (url) => {
        discoveryCalls.push({ type: 'text', url });
        if (url === 'https://www.ycombinator.com/companies') return directoryHtml;
        if (url === 'https://www.ycombinator.com/companies/uselemma/jobs') return genericOnlyCompanyPage;
        throw new Error(`unexpected text URL ${url}`);
      },
      fetchJson: async (url, opts) => {
        discoveryCalls.push({ type: 'json', url, opts });
        if (url.includes('algolia.net/1/indexes/*/queries')) {
          const requestCount = JSON.parse(opts.body).requests.length;
          return {
            results: Array.from({ length: requestCount }, (_, index) => ({
              hits: index === 0 ? [{
                name: 'Lemma',
                slug: 'uselemma',
                one_liner: 'Production Monitoring for AI agents',
                long_description: 'Find semantic failures in production agent traces.',
                tags: ['Artificial Intelligence', 'Developer Tools'],
                industries: ['B2B'],
                isHiring: true,
              }] : [],
            })),
          };
        }
        if (url.startsWith('https://www.workatastartup.com/jobs/search?q=')) return { jobs: [] };
        throw new Error(`unexpected JSON URL ${url}`);
      },
    },
  });
  if (
    genericDiscovered.map(job => job.title).join('|') === 'Founding Engineer|Backend / Infra Engineer'
    && discoveryCalls.some(call => call.url === 'https://www.ycombinator.com/companies/uselemma/jobs')
  ) pass('company-page discovery surfaces generic Lemma roles when ranked job search returns none');
  else fail(`generic-only discovery failed: ${JSON.stringify({ genericDiscovered, discoveryCalls })}`);

  const enriched = await enrichYCStartupJob(normalized, {
    fetchText: async () => detailHtml,
  });
  if (
    enriched.sponsorship === 'Will sponsor'
    && enriched.note === 'YC Startup Jobs · Will sponsor'
    && enriched.description.includes('Will sponsor')
  ) pass('enrichYCStartupJob preserves the portal sponsorship signal for filtering and UI');
  else fail(`enrichYCStartupJob returned ${JSON.stringify(enriched)}`);
} catch (err) {
  fail(`YC Startup Jobs provider tests crashed: ${err.message}`);
}
