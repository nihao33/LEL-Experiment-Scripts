import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsWarning,
  extractDomainsFromText,
  hasHttpClickableLink,
  hasTargetDomainHit,
  normalizeDomain,
  normalizeBareTextDomain,
} from '../src/domain.js';

test('normalizeDomain removes protocol, path, and leading www only', () => {
  assert.equal(normalizeDomain('https://www.docs.example.com/path'), 'docs.example.com');
  assert.equal(normalizeDomain('http://www.example.co.uk/products'), 'example.co.uk');
});

test('normalizeDomain rejects prose artifacts that are not real public or private suffix domains', () => {
  assert.equal(normalizeDomain('1-4-6.bobby'), '');
  assert.equal(normalizeDomain('3-4.march'), '');
  assert.equal(normalizeDomain('4-6.statusdefunct'), '');
  assert.equal(normalizeDomain('example.com'), 'example.com');
  assert.equal(normalizeDomain('example.co.uk'), 'example.co.uk');
});

test('normalizeBareTextDomain rejects numbered prose artifacts even when the suffix exists', () => {
  assert.equal(normalizeBareTextDomain('1-4.fox'), '');
  assert.equal(normalizeBareTextDomain('do-2-6.here'), '');
  assert.equal(normalizeBareTextDomain('ltd-1-3-4.studio'), '');
  assert.equal(normalizeBareTextDomain('8.purpose'), '');
  assert.equal(normalizeBareTextDomain('news.example.com'), 'news.example.com');
  assert.equal(normalizeBareTextDomain('archive.example.org'), 'archive.example.org');
  assert.equal(normalizeBareTextDomain('example.co.uk'), 'example.co.uk');
});

test('extractDomainsFromText combines text domains and hrefs', () => {
  const domains = extractDomainsFromText(
    'Use http://www.example.com/ and ignore artifacts such as 1-4-6.bobby.',
    ['https://sub.example.org/path'],
  );

  assert.deepEqual(domains, ['example.com', 'sub.example.org']);
});

test('hasTargetDomainHit matches target host or its subdomain', () => {
  const sample = {
    registered_domain: 'example.com',
    target_url: 'https://example.com',
  };

  assert.equal(hasTargetDomainHit(sample, ['example.com']), true);
  assert.equal(hasTargetDomainHit(sample, ['docs.example.com']), true);
  assert.equal(hasTargetDomainHit(sample, ['otherexample.com']), false);
});

test('link and warning detection work for common cases', () => {
  assert.equal(hasHttpClickableLink(['mailto:test@example.com', 'https://example.com']), true);
  assert.equal(containsWarning('The archived page may be outdated or no longer available.'), true);
  assert.equal(containsWarning('这是官方主页。'), false);
});
