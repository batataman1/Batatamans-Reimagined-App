// In-memory fake of the GitHub Git Data API, enough for the app's Push/Pull.
import crypto from 'node:crypto';

export function createMockGitHub({ owner = 'batataman1', repo = 'Batatamans-Reimagined-App-Data', token = 'github_pat_test', isPrivate = true } = {}) {
  const blobs = new Map();   // sha -> Buffer
  const trees = new Map();   // sha -> Map(path -> blobSha)
  const commits = new Map(); // sha -> { tree, parents, message }
  let head = null;
  const state = { raceNext: false, log: [] };

  const blobSha = buf => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
  const treeSha = map => crypto.createHash('sha1').update('tree' + JSON.stringify([...map].sort())).digest('hex');
  const commitSha = c => crypto.createHash('sha1').update('commit' + JSON.stringify(c) + Math.random()).digest('hex');

  function addBlob(buf) { const s = blobSha(buf); blobs.set(s, buf); return s; }
  function addTree(map) { const s = treeSha(map); trees.set(s, new Map(map)); return s; }
  function addCommit(c) { const s = commitSha(c); commits.set(s, c); return s; }

  // Initial README commit, like a repo created with "Add README".
  head = addCommit({ tree: addTree(new Map([['README.md', addBlob(Buffer.from('# Data\n'))]])), parents: [], message: 'Initial commit' });

  const R = `/repos/${owner}/${repo}`;
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, accept, x-github-api-version',
    'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
    'access-control-expose-headers': 'x-ratelimit-remaining',
  };
  const json = (status, body) => ({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  function handle(method, url, headers, bodyText) {
    const u = new URL(url);
    const p = u.pathname;
    if (method === 'OPTIONS') return { status: 204, headers: cors, body: '' };
    state.log.push(`${method} ${p}`);
    if ((headers.authorization || '') !== `Bearer ${token}`) return json(401, { message: 'Bad credentials' });
    if (!p.startsWith(R)) return json(404, { message: 'Not Found' });
    const rest = p.slice(R.length);
    const body = bodyText ? JSON.parse(bodyText) : null;
    let m;
    if (method === 'GET' && rest === '') return json(200, { full_name: `${owner}/${repo}`, private: isPrivate, default_branch: 'main' });
    if (method === 'GET' && rest === '/git/ref/heads/main') return json(200, { object: { sha: head, type: 'commit' } });
    if (method === 'GET' && (m = rest.match(/^\/git\/commits\/(\w+)$/))) {
      const c = commits.get(m[1]); if (!c) return json(404, { message: 'Not Found' });
      return json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map(s => ({ sha: s })), message: c.message });
    }
    if (method === 'GET' && (m = rest.match(/^\/git\/trees\/(\w+)$/))) {
      const t = trees.get(m[1]); if (!t) return json(404, { message: 'Not Found' });
      return json(200, { sha: m[1], truncated: false, tree: [...t].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha })) });
    }
    if (method === 'GET' && (m = rest.match(/^\/git\/blobs\/(\w+)$/))) {
      const b = blobs.get(m[1]); if (!b) return json(404, { message: 'Not Found' });
      const b64 = b.toString('base64').replace(/(.{60})/g, '$1\n'); // GitHub wraps base64 lines
      return json(200, { sha: m[1], content: b64, encoding: 'base64', size: b.length });
    }
    if (method === 'POST' && rest === '/git/blobs') {
      return json(201, { sha: addBlob(Buffer.from(body.content, 'base64')) });
    }
    if (method === 'POST' && rest === '/git/trees') {
      const base = trees.get(body.base_tree); if (!base) return json(422, { message: 'base_tree not found' });
      const next = new Map(base);
      for (const e of body.tree) {
        if (e.sha === null) { if (!next.has(e.path)) return json(422, { message: `GitRPC::BadObjectState ${e.path}` }); next.delete(e.path); }
        else { if (!blobs.has(e.sha)) return json(422, { message: 'blob missing' }); next.set(e.path, e.sha); }
      }
      return json(201, { sha: addTree(next) });
    }
    if (method === 'POST' && rest === '/git/commits') {
      return json(201, { sha: addCommit({ tree: body.tree, parents: body.parents, message: body.message }) });
    }
    if (method === 'PATCH' && rest === '/git/refs/heads/main') {
      const c = commits.get(body.sha);
      if (state.raceNext) {
        state.raceNext = false;
        // Simulate another device pushing first.
        const t = new Map(trees.get(commits.get(head).tree));
        t.set('data/ideas/race-idea.json', addBlob(Buffer.from(JSON.stringify({ id: 'race-idea', collection: 'ideas', updated: new Date().toISOString(), data: { title: 'Race idea' } }))));
        head = addCommit({ tree: addTree(t), parents: [head], message: 'Other device' });
      }
      if (!c || body.force || !c.parents.includes(head)) return json(422, { message: 'Update is not a fast forward' });
      head = body.sha;
      return json(200, { object: { sha: head } });
    }
    return json(404, { message: `Unhandled ${method} ${rest}` });
  }

  return {
    handle, state,
    files() {
      const t = trees.get(commits.get(head).tree);
      return Object.fromEntries([...t].map(([path, sha]) => [path, blobs.get(sha).toString('utf8')]));
    },
    commitMessages() {
      const out = []; let s = head;
      while (s) { const c = commits.get(s); out.push(c.message); s = c.parents[0]; }
      return out;
    },
    // Simulate another device pushing a file directly.
    pushDirect(path, content, message = 'Other device') {
      const t = new Map(trees.get(commits.get(head).tree));
      t.set(path, addBlob(Buffer.from(content)));
      head = addCommit({ tree: addTree(t), parents: [head], message });
    },
  };
}
