/**
 * Hosts `WebFetch` may read without asking, ported from Claude Code's
 * PREAPPROVED_HOSTS. An entry is either a bare hostname (exact match) or a
 * hostname with a path prefix, which must match on a path-segment boundary:
 * `github.com/anthropics` covers `/anthropics/claude-code` and not
 * `/anthropics-evil`.
 *
 * This list is a *fetch* allowlist only. Nothing else in the harness inherits
 * it, and a host that is absent is not distrusted — it just prompts.
 */
export const PREAPPROVED_HOSTS: readonly string[] = [
  // Anthropic
  'platform.claude.com',
  'code.claude.com',
  'modelcontextprotocol.io',
  'github.com/anthropics',
  'agentskills.io',
  // Language documentation
  'docs.python.org',
  'en.cppreference.com',
  'docs.oracle.com',
  'learn.microsoft.com',
  'developer.mozilla.org',
  'go.dev',
  'pkg.go.dev',
  'www.php.net',
  'docs.swift.org',
  'kotlinlang.org',
  'ruby-doc.org',
  'doc.rust-lang.org',
  'www.typescriptlang.org',
  // Web / JS frameworks
  'react.dev',
  'angular.io',
  'vuejs.org',
  'nextjs.org',
  'expressjs.com',
  'nodejs.org',
  'bun.sh',
  'jquery.com',
  'getbootstrap.com',
  'tailwindcss.com',
  'd3js.org',
  'threejs.org',
  'redux.js.org',
  'webpack.js.org',
  'jestjs.io',
  'reactrouter.com',
  // Python frameworks
  'docs.djangoproject.com',
  'flask.palletsprojects.com',
  'fastapi.tiangolo.com',
  'pandas.pydata.org',
  'numpy.org',
  'www.tensorflow.org',
  'pytorch.org',
  'scikit-learn.org',
  'matplotlib.org',
  'requests.readthedocs.io',
  'jupyter.org',
  // PHP
  'laravel.com',
  'symfony.com',
  'wordpress.org',
  // Java
  'docs.spring.io',
  'hibernate.org',
  'tomcat.apache.org',
  'gradle.org',
  'maven.apache.org',
  // .NET
  'asp.net',
  'dotnet.microsoft.com',
  'nuget.org',
  'blazor.net',
  // Mobile
  'reactnative.dev',
  'docs.flutter.dev',
  'developer.apple.com',
  'developer.android.com',
  // Data science / ML
  'keras.io',
  'spark.apache.org',
  'huggingface.co',
  'www.kaggle.com',
  // Databases
  'www.mongodb.com',
  'redis.io',
  'www.postgresql.org',
  'dev.mysql.com',
  'www.sqlite.org',
  'graphql.org',
  'prisma.io',
  // Cloud / DevOps
  'docs.aws.amazon.com',
  'cloud.google.com',
  'kubernetes.io',
  'www.docker.com',
  'www.terraform.io',
  'www.ansible.com',
  'vercel.com/docs',
  'docs.netlify.com',
  'devcenter.heroku.com',
  // Testing / monitoring
  'cypress.io',
  'selenium.dev',
  // Game development
  'docs.unity.com',
  'docs.unrealengine.com',
  // Other
  'git-scm.com',
  'nginx.org',
  'httpd.apache.org',
]

const PREAPPROVED = PREAPPROVED_HOSTS.map((entry) => {
  const slash = entry.indexOf('/')
  return slash === -1
    ? { host: entry.toLowerCase(), pathPrefix: undefined }
    : { host: entry.slice(0, slash).toLowerCase(), pathPrefix: entry.slice(slash) }
})

/** The hostname of a URL, lowercased, or undefined when it does not parse. */
export function urlHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * Whether `url` is on the preapproved list. `http:` counts: `WebFetch` upgrades
 * it to `https:` before the request, so judging the pre-upgrade spelling would
 * prompt for a URL that is about to become an approved one.
 */
export function isPreapprovedUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (parsed.username || parsed.password) return false

  const host = parsed.hostname.toLowerCase()
  return PREAPPROVED.some((entry) => {
    if (entry.host !== host) return false
    if (entry.pathPrefix === undefined) return true
    return parsed.pathname === entry.pathPrefix || parsed.pathname.startsWith(`${entry.pathPrefix}/`)
  })
}

/**
 * Match a `WebFetch(domain:...)` rule's content against a URL. `example.com`
 * is exact; `*.example.com` also covers its subdomains.
 */
export function matchesDomainRule(pattern: string, url: string): boolean {
  const host = urlHostname(url)
  if (host === undefined) return false
  const domain = pattern.trim().toLowerCase()
  if (!domain) return false
  if (domain.startsWith('*.')) {
    const suffix = domain.slice(1)
    return host === domain.slice(2) || host.endsWith(suffix)
  }
  return host === domain
}
