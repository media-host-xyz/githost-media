require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app = express();

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = process.env.GITHUB_OWNER;
const REPO  = process.env.GITHUB_REPO || 'githost-media';
const PORT  = process.env.PORT        || 3000;

// ── startup checks ──
if (!TOKEN || TOKEN === 'your_personal_access_token_here') {
  console.error('\n❌  GITHUB_TOKEN is not set in your .env file\n');
  process.exit(1);
}
if (!OWNER || OWNER === 'your_github_username_here') {
  console.error('\n❌  GITHUB_OWNER is not set in your .env file\n');
  process.exit(1);
}

// ── static frontend — always resolved from this file's directory ──
app.use(express.static(path.join(__dirname, 'public')));

// ── raw body parser for uploads ──
app.use('/api/upload', express.raw({ type: '*/*', limit: '150mb' }));

let cachedReleaseId = null;

const GH_HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
};

// ── ensure repo exists ──
async function ensureRepo() {
  const check = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, { headers: GH_HEADERS });
  if (check.ok) {
    console.log(`📦  Repo "${OWNER}/${REPO}" found.`);
    return;
  }

  console.log(`📦  Repo not found — creating "${OWNER}/${REPO}"...`);
  const create = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: REPO,
      description: 'GitHost media storage',
      private: false,
      auto_init: true
    })
  });

  if (!create.ok) {
    const e = await create.json().catch(() => ({}));
    throw new Error('Could not create repo: ' + (e.message || create.status));
  }

  // GitHub needs a moment to finish initialising after auto_init
  console.log('⏳  Waiting for repo to initialise...');
  await new Promise(r => setTimeout(r, 3000));
  console.log('✅  Repo ready.');
}

// ── ensure a release exists ──
async function ensureRelease() {
  const listRes  = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, { headers: GH_HEADERS });
  const releases = await listRes.json();

  if (Array.isArray(releases) && releases.length > 0) {
    console.log(`📎  Using existing release id: ${releases[0].id}`);
    return releases[0].id;
  }

  // get the SHA of the default branch so we can tag it
  console.log('🔍  Getting default branch SHA...');
  const repoRes  = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, { headers: GH_HEADERS });
  const repoData = await repoRes.json();
  const branch   = repoData.default_branch || 'main';

  const branchRes  = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/branches/${branch}`, { headers: GH_HEADERS });
  const branchData = await branchRes.json();
  const sha        = branchData?.commit?.sha;

  if (!sha) throw new Error(`Could not get SHA for branch "${branch}". Make sure the repo has at least one commit.`);

  // create a lightweight tag
  console.log(`🏷   Creating tag v1 at ${sha.slice(0, 7)}...`);
  await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'refs/tags/v1', sha })
  });
  // ignore tag errors — may already exist

  // create the release
  console.log('🚀  Creating release...');
  const createRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    headers: { ...GH_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: 'v1', name: 'media', body: 'GitHost media storage — do not delete' })
  });

  if (!createRes.ok) {
    const e = await createRes.json().catch(() => ({}));
    throw new Error('Could not create release: ' + (e.message || JSON.stringify(e)));
  }

  const release = await createRes.json();
  console.log(`✅  Release created. id: ${release.id}`);
  return release.id;
}

async function getReleaseId() {
  if (cachedReleaseId) return cachedReleaseId;
  await ensureRepo();
  cachedReleaseId = await ensureRelease();
  return cachedReleaseId;
}

// ── upload endpoint ──
app.post('/api/upload', async (req, res) => {
  const fileName = decodeURIComponent(req.headers['x-file-name'] || 'upload');
  const fileType = req.headers['x-file-type'] || 'application/octet-stream';
  const body     = req.body;

  if (!body || body.length === 0) {
    return res.status(400).json({ error: 'Empty file received.' });
  }

  const mb = (body.length / 1024 / 1024).toFixed(2);
  console.log(`\n⬆   Uploading: ${fileName} (${mb} MB)`);

  try {
    const releaseId = await getReleaseId();

    const safeName = fileName
      .replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9._-]/g, '');

    const uploadRes = await fetch(
      `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(safeName)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': fileType,
          'Content-Length': String(body.length)
        },
        body
      }
    );

    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      console.error('GitHub error:', JSON.stringify(err));
      throw new Error(err.message || `GitHub returned HTTP ${uploadRes.status}`);
    }

    const asset = await uploadRes.json();
    console.log(`✅  ${asset.browser_download_url}\n`);
    return res.json({ url: asset.browser_download_url, name: asset.name, size: asset.size });

  } catch (e) {
    console.error('❌  Upload failed:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── catch-all → index.html ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀  GitHost running → http://localhost:${PORT}`);
  console.log(`    Owner : ${OWNER}`);
  console.log(`    Repo  : ${REPO}`);
  console.log(`    Token : ${TOKEN.slice(0, 8)}...\n`);
});