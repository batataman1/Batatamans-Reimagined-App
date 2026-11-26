// Talks to the GitHub REST API (Git Data endpoints) for the private data repo.
// The token is only ever sent to api.github.com.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(kind, message, status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export function createClient({ owner, repo, token, branch = 'main' }) {
  const R = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const B = encodeURIComponent(branch);

  async function req(method, path, body) {
    let res;
    try {
      res = await fetch(API + path, {
        method,
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError('network', "Couldn't reach GitHub. Check your internet connection and try again.");
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* no body */ }
    throw classify(res, detail);
  }

  return {
    owner, repo, branch,
    getRepo: () => req('GET', R),
    async getHead() {
      try {
        const ref = await req('GET', `${R}/git/ref/heads/${B}`);
        return ref.object.sha;
      } catch (e) {
        if (e.status === 409) {
          throw new GitHubError('empty', 'The data repo is empty. Open it on GitHub, add a README file, then try again.', 409);
        }
        throw e;
      }
    },
    getCommit: sha => req('GET', `${R}/git/commits/${sha}`),
    getTree: sha => req('GET', `${R}/git/trees/${sha}?recursive=1`),
    getBlob: sha => req('GET', `${R}/git/blobs/${sha}`),
    createBlob: base64 => req('POST', `${R}/git/blobs`, { content: base64, encoding: 'base64' }),
    createTree: (baseTree, tree) => req('POST', `${R}/git/trees`, { base_tree: baseTree, tree }),
    createCommit: (message, tree, parents) => req('POST', `${R}/git/commits`, { message, tree, parents }),
    updateRef: sha => req('PATCH', `${R}/git/refs/heads/${B}`, { sha, force: false }),
  };
}

function classify(res, detail) {
  const s = res.status;
  if (s === 401) {
    return new GitHubError('auth',
      'GitHub rejected the token. It may have expired or been deleted. Create a new token and paste it in Settings → Sync.', s);
  }
  if (s === 429 || (s === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
    return new GitHubError('ratelimit', 'GitHub is limiting requests right now. Wait a few minutes and try again.', s);
  }
  if (s === 403) {
    return new GitHubError('forbidden',
      "The token isn't allowed to do this. Check that it includes the data repo with Contents set to Read and write.", s);
  }
  if (s === 404) {
    return new GitHubError('notfound',
      "GitHub couldn't find the repo. Check the owner and repo name, and that the token includes this repo.", s);
  }
  return new GitHubError(s === 422 ? 'rejected' : 'other', `GitHub returned an error (${s}). ${detail}`.trim(), s);
}

/** Check read and write access. Returns { branch, isPrivate, fullName }. */
export async function testConnection({ owner, repo, token }) {
  const probe = createClient({ owner, repo, token });
  const info = await probe.getRepo();
  const gh = createClient({ owner, repo, token, branch: info.default_branch || 'main' });
  await gh.getHead();
  // Writing a tiny unused blob proves the token can write, without changing any files.
  await gh.createBlob(btoa('connection test'));
  return { branch: info.default_branch || 'main', isPrivate: !!info.private, fullName: info.full_name };
}
