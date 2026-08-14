import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import { createDeterministicAccountId } from '../../plugin/accounts.js'
import * as logger from '../../plugin/logger.js'
import { refreshAccessToken } from '../../plugin/token.js'
import type { ManagedAccount } from '../../plugin/types.js'
import { fetchUsageLimits } from '../../plugin/usage.js'

export class TokenAuthMethod {
  constructor(
    private repository: AccountRepository,
    private accountManager: any
  ) {}

  async authorize(
    inputs?: Record<string, string>
  ): Promise<{ type: 'success'; key: string } | { type: 'failed' }> {
    const rawToken = inputs?.refresh_token?.trim()
    if (!rawToken) {
      logger.error('No refresh token provided')
      return { type: 'failed' }
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

      logger.log(`Successfully added account via refresh token: ${email}`)
      return { type: 'success', key: freshAuth.access }
    } catch (e: any) {
      logger.error('Token verification failed', { error: e.message })
      return { type: 'failed' }
    }
  }
}
