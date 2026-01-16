export { AgentInstance } from './agent-instance';
export { AgentManager, getAgentManager } from './agent-manager';

// Re-export SDK PayloadResolver and storage (preferred)
export {
  PayloadResolver,
  PayloadScheme,
  IpfsStorage,
  DataUriStorage,
  HttpStorage,
} from '@noosphere/agent-core';
export type {
  PayloadResolverConfig,
  ResolvedPayload,
  IPayloadStorage,
  StorageConfig,
  UploadResult,
  IpfsStorageConfig,
} from '@noosphere/agent-core';

// Legacy local exports (deprecated - use SDK versions above)
export {
  PayloadResolver as LegacyPayloadResolver,
  getPayloadResolver,
  IpfsStorageProvider,
  HttpsStorageProvider,
  DataUriProvider,
} from './payload-resolver';
export type {
  StorageProvider,
  PayloadResolverConfig as LegacyPayloadResolverConfig,
  HybridInput,
} from './payload-resolver';
