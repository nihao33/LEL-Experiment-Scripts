from __future__ import annotations

import re
from urllib.parse import urlsplit


URL_PATTERN = re.compile(r"\b(?:https?://|ftp://|www\.)[^\s<>'\"，。；、]+", re.IGNORECASE)
DOMAIN_PATTERN = re.compile(
    r"(?<![@\w-])"
    r"((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59}))"
    r"(?![\w-])",
    re.IGNORECASE,
)
TRIM_CHARS = " \t\r\n.,;:!?)]}>\"'`，。；：！？）】》”’"
WARNING_PATTERNS = (
    "域名已失效",
    "域名已过期",
    "网站无法访问",
    "无法访问",
    "使用替代来源",
    "替代来源",
    "已失效",
    "已过期",
    "已关闭",
    "domain expired",
    "expired domain",
    "domain is expired",
    "site unavailable",
    "website unavailable",
    "cannot access",
    "inaccessible",
    "no longer available",
    "alternative source",
    "alternate source",
)
FILE_EXTENSION_TLDS = {
    "ashx",
    "aspx",
    "cfm",
    "cgi",
    "html",
    "htm",
    "jsp",
    "mspx",
    "pdf",
    "php",
    "shtml",
    "stm",
}
COMMON_SECOND_LEVEL_SUFFIXES = {
    "ac",
    "co",
    "com",
    "edu",
    "gov",
    "net",
    "org",
}


def normalize_domain(value: str) -> str:
    """Return a comparable host/domain form, ignoring scheme, path, port and leading www."""
    candidate = str(value or "").strip().strip(TRIM_CHARS).lower()
    if not candidate:
        return ""

    host = _extract_host(candidate)
    host = host.strip(".").lower()
    if host.startswith("www."):
        host = host[4:]
    host = _to_idna(host)
    if not _is_plausible_domain(host):
        return ""
    return host


def extract_domains(text: str) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()

    def add(value: str) -> None:
        normalized = normalize_domain(value)
        if normalized and normalized not in seen:
            seen.add(normalized)
            found.append(normalized)

    source = text or ""
    candidates: list[tuple[int, str]] = []
    candidates.extend((match.start(), match.group(0)) for match in URL_PATTERN.finditer(source))
    candidates.extend((match.start(), match.group(1)) for match in DOMAIN_PATTERN.finditer(source))
    for _, value in sorted(candidates, key=lambda item: item[0]):
        add(value)
    return found


def domain_is_recovered(registered_domain: str, response_text: str) -> bool:
    target = normalize_domain(registered_domain)
    if not target:
        return False
    return target in set(extract_domains(response_text))


def contains_warning(text: str) -> bool:
    lowered = (text or "").lower()
    return any(pattern in lowered for pattern in WARNING_PATTERNS)


def _extract_host(candidate: str) -> str:
    if "://" in candidate:
        try:
            parsed = urlsplit(candidate)
        except ValueError:
            return ""
        return parsed.hostname or ""
    if candidate.startswith("//"):
        try:
            parsed = urlsplit(f"http:{candidate}")
        except ValueError:
            return ""
        return parsed.hostname or ""
    if "/" in candidate or "?" in candidate or "#" in candidate:
        try:
            parsed = urlsplit(f"http://{candidate}")
        except ValueError:
            return candidate.split("/", 1)[0]
        return parsed.hostname or candidate.split("/", 1)[0]
    if "@" in candidate:
        candidate = candidate.rsplit("@", 1)[-1]
    if ":" in candidate and candidate.count(":") == 1:
        candidate = candidate.split(":", 1)[0]
    return candidate


def _to_idna(host: str) -> str:
    labels = []
    for label in host.split("."):
        if not label:
            continue
        try:
            labels.append(label.encode("idna").decode("ascii"))
        except UnicodeError:
            labels.append(label)
    return ".".join(labels)


def _is_plausible_domain(host: str) -> bool:
    if "." not in host or " " in host or "_" in host:
        return False
    labels = host.split(".")
    if any(not label or len(label) > 63 for label in labels):
        return False
    if len(labels) == 2 and labels[0].lower() in COMMON_SECOND_LEVEL_SUFFIXES:
        return False
    tld = labels[-1]
    if tld.lower() in FILE_EXTENSION_TLDS:
        return False
    return bool(re.fullmatch(r"[a-z]{2,63}|xn--[a-z0-9-]{2,59}", tld, re.IGNORECASE))
