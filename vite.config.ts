import { defineConfig } from 'vite'

const repoName = 'network-viz'
const isGitHubPages = process.env.GITHUB_PAGES === 'true'

export default defineConfig({
  base: isGitHubPages ? `/${repoName}/` : '/',
})
