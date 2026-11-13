import { CoreError } from '@one/core';

/** 密钥库或队列拒绝写入。消息里不带密钥。 */
export class IntegrationStoreError extends CoreError {
  constructor(code: 'INTEGRATION_SECRET' | 'INTEGRATION_QUEUE', message: string) {
    super(code, message);
  }
}
