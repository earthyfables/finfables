// Vercel serverless function: stores the monthly Actuals source files (compressed CSVs)
// as separate files in the GitHub repo, under actuals/<channel>/<YYYY-MM>/<file>.
//
// Why not inside data.json? data.json is posted whole on every save and a serverless
// request body is limited to ~4.5 MB; raw monthly CSVs (3 MB+) would break saving.
// The GitHub token lives only in server-side environment variables (same as save.js).
//
// POST { action: 'put' | 'get' | 'delete', path, contentBase64? }
const PATH_RE = /^(actuals\/[a-z0-9_-]{1,40}\/\d{4}-(0[1-9]|1[0-2])\/[A-Za-z0-9_.-]{1,80}|actuals\/actuals\.json)$/;
const MAX_B64_CHARS = 3500000; // keeps the request comfortably under the platform body limit

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER || 'earthyfables';
  const repo = process.env.GITHUB_REPO || 'finfables';
  if (!token) {
    return res.status(500).json({ error: 'Server not configured: missing GITHUB_TOKEN environment variable in Vercel project settings.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { action, path, contentBase64 } = body;
  if (!['put', 'get', 'delete'].includes(action)) {
    return res.status(400).json({ error: 'action must be put, get or delete.' });
  }
  if (typeof path !== 'string' || !PATH_RE.test(path) || path.includes('..')) {
    return res.status(400).json({ error: 'Invalid path. Expected actuals/<channel>/<YYYY-MM>/<file> or actuals/actuals.json.' });
  }

  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' };

  async function currentSha() {
    const r = await fetch(`${api}?ref=main`, { headers });
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error(`GitHub read failed (${r.status}): ${await r.text()}`);
    return (await r.json()).sha;
  }

  try {
    if (action === 'get') {
      const r = await fetch(`${api}?ref=main`, { headers: { ...headers, Accept: 'application/vnd.github.raw+json' } });
      if (r.status === 404) return res.status(404).json({ error: 'File not found' });
      if (!r.ok) return res.status(502).json({ error: `GitHub read failed (${r.status})` });
      const buf = Buffer.from(await r.arrayBuffer());
      return res.status(200).json({ ok: true, contentBase64: buf.toString('base64'), size: buf.length });
    }

    if (action === 'put') {
      if (typeof contentBase64 !== 'string' || !contentBase64.length) {
        return res.status(400).json({ error: 'contentBase64 is required for put.' });
      }
      if (contentBase64.length > MAX_B64_CHARS) {
        return res.status(413).json({ error: 'File is too large to store even after compression.' });
      }
      let lastErr = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const sha = await currentSha();
        const r = await fetch(api, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: `Store actuals file ${path}`, content: contentBase64, sha, branch: 'main' })
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok) return res.status(200).json({ ok: true, path, commitUrl: j.commit && j.commit.html_url });
        lastErr = j.message || `GitHub write failed (${r.status})`;
        // 409/422 = another commit landed between reading the sha and writing (e.g. the data auto-save) — retry.
        if (r.status !== 409 && r.status !== 422) break;
        await new Promise(ok => setTimeout(ok, 400 * (attempt + 1)));
      }
      return res.status(502).json({ error: lastErr });
    }

    // delete
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const sha = await currentSha();
      if (!sha) return res.status(404).json({ error: 'File not found' });
      const r = await fetch(api, {
        method: 'DELETE',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Remove actuals file ${path}`, sha, branch: 'main' })
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return res.status(200).json({ ok: true, path });
      lastErr = j.message || `GitHub delete failed (${r.status})`;
      if (r.status !== 409 && r.status !== 422) break;
      await new Promise(ok => setTimeout(ok, 400 * (attempt + 1)));
    }
    return res.status(502).json({ error: lastErr });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
