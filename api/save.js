// Vercel serverless function: securely commits the app's data to data.json
// in the GitHub repo. The GitHub token lives only in Vercel's environment
// variables (server-side) — it is never exposed to the browser.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER || 'earthyfables';
  const repo = process.env.GITHUB_REPO || 'finfables';
  const path = 'data.json';

  if (!token) {
    return res.status(500).json({
      error: 'Server not configured: missing GITHUB_TOKEN environment variable in Vercel project settings.'
    });
  }

  try {
    const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const headers = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json'
    };

    // Get the current file's sha (required by GitHub to update an existing file)
    let sha;
    const getResp = await fetch(apiBase, { headers });
    if (getResp.ok) {
      const getData = await getResp.json();
      sha = getData.sha;
    } else if (getResp.status !== 404) {
      const errBody = await getResp.text();
      return res.status(502).json({ error: `GitHub read failed: ${errBody}` });
    }

    const dataToSave = req.body;
    if (!dataToSave || typeof dataToSave !== 'object') {
      return res.status(400).json({ error: 'Request body must be the JSON data object to save.' });
    }

    const content = Buffer.from(JSON.stringify(dataToSave, null, 2)).toString('base64');

    const putResp = await fetch(apiBase, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Update data.json via app Save button',
        content,
        sha,
        branch: 'main'
      })
    });

    const putData = await putResp.json();
    if (!putResp.ok) {
      return res.status(502).json({ error: putData.message || 'GitHub write failed' });
    }

    return res.status(200).json({ ok: true, commitUrl: putData.commit?.html_url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
