import type { AuthOAuthResult } from '@opencode-ai/plugin'
import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import { createDeterministicAccountId } from '../../plugin/accounts.js'
import { refreshAccessToken } from '../../plugin/token.js'
import type { ManagedAccount } from '../../plugin/types.js'
import { fetchUsageLimits } from '../../plugin/usage.js'

export class TokenAuthMethod {
  constructor(
    private repository: AccountRepository,
    private accountManager: any
  ) {}

  async authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult> {
    const rawToken = inputs?.refresh_token?.trim()
    if (!rawToken) {
      return {
        url: '',
        instructions: 'No refresh token provided.',
        method: 'auto',
        callback: async () => ({ type: 'failed' })
      }
    }

    try {
      const finalToken = rawToken.includes('|') ? rawToken : `${rawToken}|desktop`

      const dummyAuth = {
        refresh: finalToken,
        access: '',
        expires: 0,
        authMethod: 'desktop' as const,
        region: 'us-east-1' as const
      }

      const freshAuth = await refreshAccessToken(dummyAuth as any)
      const usage = await fetchUsageLimits(freshAuth as any)

      const email = usage.email || `token-import-${Date.now().toString().slice(-6)}@kiro.local`
      const id = createDeterministicAccountId(email, 'desktop')

      const acc: ManagedAccount = {
        id,
        email,
        authMethod: 'desktop',
        region: 'us-east-1',
        refreshToken: freshAuth.refresh,
        accessToken: freshAuth.access,
        expiresAt: freshAuth.expires,
        rateLimitResetTime: 0,
        isHealthy: true,
        failCount: 0,
        usedCount: usage.usedCount,
        limitCount: usage.limitCount
      }

      await this.repository.save(acc)
      this.accountManager?.addAccount?.(acc)

      return {
        url: '',
        instructions: `Success! Added account: ${email}`,
        method: 'auto',
        callback: async () => ({ type: 'success', key: 'kiro-managed' })
      }
    } catch (e: any) {
      return {
        url: '',
        instructions: `Failed to add account: ${e.message}`,
        method: 'auto',
        callback: async () => ({ type: 'failed' })
      }
    }
  }
}
