const API = 'https://api.github.com'
export const GIST_FILENAME = 'kiro-pool.json'

async function ghFetch(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

export async function getGistContent(token: string, gistId: string): Promise<string | null> {
  const data = await ghFetch(token, `/gists/${gistId}`, { method: 'GET' })
  const file = data.files?.[GIST_FILENAME]
  if (!file) return null
  if (file.truncated && file.raw_url) {
    const res = await fetch(file.raw_url)
    if (!res.ok) throw new Error(`Failed to fetch raw gist: ${res.status}`)
    return res.text()
  }
  return file.content ?? null
}

export async function createGist(token: string, content: string): Promise<string> {
  const data = await ghFetch(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: 'opencode-kiro-auth account pool (private — do not share)',
      public: false,
      files: { [GIST_FILENAME]: { content } }
    })
  })
  return data.id as string
}

export async function updateGist(token: string, gistId: string, content: string): Promise<void> {
  await ghFetch(token, `/gists/${gistId}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [GIST_FILENAME]: { content } } })
  })
}
