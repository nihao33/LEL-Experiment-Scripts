import { domainToASCII } from 'node:url';
import { parse as parseTld } from 'tldts';

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}，。；、]+/giu;
const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,63}\b/giu;

const WARNING_PATTERNS = [
  /过期|失效|不可访问|无法访问|打不开|无法打开|链接可能变化|链接已变化|页面不存在|页面已删除|页面已迁移|死链|风险/iu,
  /\b(?:404|not found|expired|deprecated|unavailable|inaccessible|dead link|link rot|no longer available|may be outdated|moved|redirected|changed|broken link)\b/iu,
];

function stripWrapperPunctuation(value) {
  return String(value)
    .trim()
    .replace(/^[("'“”‘’<\[]+/u, '')
    .replace(/[)"'“”‘’>\].,，。:：;；!?！？]+$/u, '');
}

function hostFromValue(value) {
  const raw = stripWrapperPunctuation(value);
  if (!raw || /^\d+$/u.test(raw)) {
    return '';
  }

  try {
    const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`;
    return new URL(withProtocol).hostname;
  } catch {
    return raw.split(/[/?#]/u)[0];
  }
}

function isAcceptedParsedDomain(parsed) {
  if (!parsed.domain || !parsed.publicSuffix) {
    return false;
  }

  // This rejects prose artifacts such as "1-4-6.bobby" and "3-4.march".
  // Private suffixes are kept because the benchmark includes domains such as uk.com.
  return parsed.isIcann || parsed.isPrivate;
}

function isLikelyBareTextArtifact(parsed) {
  const name = parsed.domainWithoutSuffix ?? '';
  if (!parsed.isPrivate && /^\d+$/u.test(name)) {
    return true;
  }

  if (/^\d+(?:-\d+)+$/u.test(name)) {
    return true;
  }

  if (/[a-z]+(?:-\d+){1,}$/iu.test(name)) {
    return true;
  }

  return false;
}

export function normalizeDomain(value) {
  const host = hostFromValue(value);
  if (!host || !host.includes('.')) {
    return '';
  }

  const asciiHost = domainToASCII(host)
    .toLowerCase()
    .replace(/\.$/u, '')
    .replace(/^www\./u, '')
    .replace(/:\d+$/u, '');

  if (!asciiHost || !asciiHost.includes('.')) {
    return '';
  }

  const parsed = parseTld(asciiHost, { allowPrivateDomains: true });
  if (!isAcceptedParsedDomain(parsed)) {
    return '';
  }

  return asciiHost;
}

export function normalizeBareTextDomain(value) {
  const normalized = normalizeDomain(value);
  if (!normalized) {
    return '';
  }

  const parsed = parseTld(normalized, { allowPrivateDomains: true });
  if (isLikelyBareTextArtifact(parsed)) {
    return '';
  }

  return normalized;
}

export function extractDomainsFromText(text = '', hrefs = []) {
  const recovered = new Set();

  for (const href of hrefs) {
    const normalized = normalizeDomain(href);
    if (normalized) {
      recovered.add(normalized);
    }
  }

  for (const match of String(text).matchAll(URL_RE)) {
    const normalized = normalizeDomain(match[0]);
    if (normalized) {
      recovered.add(normalized);
    }
  }

  for (const match of String(text).matchAll(DOMAIN_RE)) {
    const normalized = normalizeBareTextDomain(match[0]);
    if (normalized) {
      recovered.add(normalized);
    }
  }

  return [...recovered].sort();
}

export function hasTargetDomainHit(sample, recoveredDomains) {
  const target = normalizeDomain(sample.registered_domain) || normalizeDomain(sample.target_url);
  if (!target) {
    return false;
  }

  return recoveredDomains.some((domain) => domain === target || domain.endsWith(`.${target}`));
}

export function hasHttpClickableLink(hrefs = []) {
  return hrefs.some((href) => /^https?:\/\//iu.test(String(href)));
}

export function containsWarning(text = '') {
  return WARNING_PATTERNS.some((pattern) => pattern.test(String(text)));
}
