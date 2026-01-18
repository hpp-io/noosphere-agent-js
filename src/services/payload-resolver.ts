/**
 * PayloadResolver - Hybrid Input/Output Handler
 *
 * This module wraps @noosphere/payload and adds agent-specific functionality:
 * - S3/R2 storage support
 * - Environment variable configuration
 * - Legacy compatibility with @noosphere/agent-core
 */

import { ethers } from 'ethers';
import axios from 'axios';
import { PayloadUtils, PayloadData, InputType } from '@noosphere/agent-core';
import {
  PayloadResolver as BasePayloadResolver,
  IpfsStorage,
  S3Storage,
  DataUriStorage,
  HttpStorage,
  type PayloadResolverConfig as BaseConfig,
  type IpfsConfig,
  type S3Config,
  computeContentHash,
  verifyContentHash,
  createDataUriPayload,
  detectPayloadType,
  PayloadType,
} from '@noosphere/payload';
import { logger } from '../../lib/logger';

// Size threshold for auto-upload to external storage (1KB default)
const DEFAULT_UPLOAD_THRESHOLD = 1024;

/**
 * Storage provider interface for external content (legacy compatibility)
 */
export interface StorageProvider {
  upload(content: string | Buffer): Promise<string>; // Returns URI
  download(uri: string): Promise<string | Buffer>;
}

/**
 * IPFS storage provider using Pinata or local node
 * Wraps @noosphere/payload IpfsStorage with axios for Node.js compatibility
 */
export class IpfsStorageProvider implements StorageProvider {
  private storage: IpfsStorage;
  private gateway: string;
  private apiUrl: string;
  private apiKey?: string;
  private apiSecret?: string;
  private isLocalNode: boolean;

  constructor(options: IpfsConfig = {}) {
    this.apiUrl = options.apiUrl || process.env.IPFS_API_URL || 'http://localhost:5001';
    this.apiKey = options.pinataApiKey || process.env.PINATA_API_KEY;
    this.apiSecret = options.pinataApiSecret || process.env.PINATA_API_SECRET;
    this.gateway = options.gateway || process.env.IPFS_GATEWAY || 'http://localhost:8080/ipfs/';
    this.isLocalNode = this.apiUrl.includes('localhost') || this.apiUrl.includes('127.0.0.1');

    this.storage = new IpfsStorage({
      gateway: this.gateway,
      pinataApiKey: this.apiKey,
      pinataApiSecret: this.apiSecret,
      apiUrl: this.apiUrl,
    });
  }

  async upload(content: string | Buffer): Promise<string> {
    const data = typeof content === 'string' ? content : content.toString('utf-8');

    try {
      if (this.isLocalNode) {
        // Local IPFS node - use axios for better Node.js compatibility
        const FormData = (await import('form-data')).default;
        const formData = new FormData();
        formData.append('file', Buffer.from(data, 'utf-8'), { filename: 'data.json' });

        const response = await axios.post(
          `${this.apiUrl}/api/v0/add`,
          formData,
          {
            headers: formData.getHeaders(),
            timeout: 30000,
          }
        );

        logger.info(`Uploaded to local IPFS: ${response.data.Hash}`);
        return `ipfs://${response.data.Hash}`;
      } else {
        // Use @noosphere/payload IpfsStorage for Pinata
        const result = await this.storage.upload(data);
        logger.info(`Uploaded to Pinata: ${result.uri}`);
        return result.uri;
      }
    } catch (error) {
      logger.error('Failed to upload to IPFS:', error);
      throw new Error(`IPFS upload failed: ${(error as Error).message}`);
    }
  }

  async download(uri: string): Promise<string> {
    try {
      return await this.storage.download(uri);
    } catch (error) {
      logger.error(`Failed to download from ${uri}:`, error);
      throw new Error(`IPFS download failed: ${(error as Error).message}`);
    }
  }
}

/**
 * HTTPS storage provider for web-accessible content
 */
export class HttpsStorageProvider implements StorageProvider {
  private storage: HttpStorage;

  constructor() {
    this.storage = new HttpStorage();
  }

  async upload(_content: string | Buffer): Promise<string> {
    throw new Error('HTTPS upload not supported - use a dedicated storage service');
  }

  async download(uri: string): Promise<string> {
    try {
      // Use axios for better Node.js compatibility
      const response = await axios.get(uri, { timeout: 30000 });
      return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    } catch (error) {
      logger.error(`Failed to download from ${uri}:`, error);
      throw new Error(`HTTPS download failed: ${(error as Error).message}`);
    }
  }
}

/**
 * Data URI handler (base64 encoded content)
 */
export class DataUriProvider implements StorageProvider {
  private storage: DataUriStorage;

  constructor() {
    this.storage = new DataUriStorage();
  }

  async upload(content: string | Buffer): Promise<string> {
    const data = typeof content === 'string' ? content : content.toString('utf-8');
    const result = await this.storage.upload(data);
    return result.uri;
  }

  async download(uri: string): Promise<string> {
    return this.storage.download(uri);
  }
}

/**
 * PayloadResolver configuration
 */
export interface PayloadResolverConfig {
  uploadThreshold?: number; // Size in bytes to trigger auto-upload
  defaultStorage?: 'ipfs' | 's3' | 'data'; // Default storage for large outputs
  ipfs?: IpfsConfig;
  s3?: S3Config;
}

/**
 * Hybrid input type that can be raw, URI, or PayloadData
 */
export type HybridInput =
  | string // Raw data or URI string
  | PayloadData // PayloadData structure
  | { type: 'raw'; data: string }
  | { type: 'uri'; uri: string }
  | { type: 'payload'; payload: PayloadData };

/**
 * PayloadResolver - Main class for handling hybrid inputs/outputs
 */
export class PayloadResolver {
  private ipfsProvider: IpfsStorageProvider;
  private httpsProvider: HttpsStorageProvider;
  private dataUriProvider: DataUriProvider;
  private s3Storage?: S3Storage;
  private uploadThreshold: number;
  private defaultStorage: 'ipfs' | 's3' | 'data';

  constructor(config: PayloadResolverConfig = {}) {
    this.ipfsProvider = new IpfsStorageProvider(config.ipfs);
    this.httpsProvider = new HttpsStorageProvider();
    this.dataUriProvider = new DataUriProvider();
    this.uploadThreshold = config.uploadThreshold || DEFAULT_UPLOAD_THRESHOLD;
    this.defaultStorage = config.defaultStorage || 'ipfs';

    // Initialize S3 storage if configured
    if (config.s3) {
      this.s3Storage = new S3Storage(config.s3);
    }
  }

  /**
   * Detect input type from hybrid input
   */
  detectInputType(input: HybridInput): InputType {
    if (typeof input === 'string') {
      // Check if it's a URI
      if (this.isUri(input)) {
        return InputType.URI_STRING;
      }
      return InputType.RAW_DATA;
    }

    if (typeof input === 'object') {
      if ('contentHash' in input && 'uri' in input) {
        return InputType.PAYLOAD_DATA;
      }
      if ('type' in input) {
        switch (input.type) {
          case 'raw':
            return InputType.RAW_DATA;
          case 'uri':
            return InputType.URI_STRING;
          case 'payload':
            return InputType.PAYLOAD_DATA;
        }
      }
    }

    return InputType.RAW_DATA;
  }

  /**
   * Check if string is a URI
   */
  private isUri(str: string): boolean {
    return (
      str.startsWith('ipfs://') ||
      str.startsWith('https://') ||
      str.startsWith('http://') ||
      str.startsWith('data:')
    );
  }

  /**
   * Resolve input to actual content
   * Handles all input types: raw, URI, PayloadData
   */
  async resolveInput(input: HybridInput): Promise<{ content: string; payload: PayloadData }> {
    const inputType = this.detectInputType(input);

    switch (inputType) {
      case InputType.RAW_DATA: {
        const content = typeof input === 'string' ? input : (input as { data: string }).data;
        return {
          content,
          payload: PayloadUtils.fromInlineData(content),
        };
      }

      case InputType.URI_STRING: {
        const uri = typeof input === 'string' ? input : (input as { uri: string }).uri;
        const content = await this.downloadFromUri(uri);
        return {
          content,
          payload: PayloadUtils.fromExternalUri(content, uri),
        };
      }

      case InputType.PAYLOAD_DATA: {
        const payloadData = 'contentHash' in (input as any)
          ? (input as PayloadData)
          : (input as { payload: PayloadData }).payload;

        // If URI is empty, it's inline data - we can't recover the content
        if (!payloadData.uri) {
          return {
            content: '',
            payload: payloadData,
          };
        }

        // Download content from URI
        const content = await this.downloadFromUri(payloadData.uri);

        // Verify content hash matches
        if (!PayloadUtils.verifyContent(payloadData, content)) {
          throw new Error('Content hash mismatch - data may be corrupted');
        }

        return { content, payload: payloadData };
      }

      default:
        throw new Error(`Unknown input type: ${inputType}`);
    }
  }

  /**
   * Decode hex-encoded URI to plain string
   */
  private decodeHexUri(uri: string): string {
    if (uri.startsWith('0x')) {
      try {
        return ethers.toUtf8String(uri);
      } catch {
        return uri;
      }
    }
    return uri;
  }

  /**
   * Download content from URI
   */
  private async downloadFromUri(uri: string): Promise<string> {
    // Decode hex-encoded URI if needed
    const decodedUri = this.decodeHexUri(uri);

    if (decodedUri.startsWith('ipfs://')) {
      return this.ipfsProvider.download(decodedUri);
    }

    if (decodedUri.startsWith('https://') || decodedUri.startsWith('http://')) {
      return this.httpsProvider.download(decodedUri);
    }

    if (decodedUri.startsWith('data:')) {
      return this.dataUriProvider.download(decodedUri);
    }

    throw new Error(`Unsupported URI scheme: ${uri}`);
  }

  /**
   * Encode output as PayloadData
   * Automatically uploads to external storage if content exceeds threshold
   */
  async encodeOutput(
    content: string,
    options: { forceUpload?: boolean; storage?: 'ipfs' | 's3' | 'data' } = {}
  ): Promise<PayloadData> {
    const contentSize = Buffer.byteLength(content, 'utf-8');
    const shouldUpload = options.forceUpload || contentSize > this.uploadThreshold;
    const storage = options.storage || this.defaultStorage;

    console.log(`  📦 PayloadResolver.encodeOutput: size=${contentSize}, threshold=${this.uploadThreshold}, shouldUpload=${shouldUpload}`);

    if (!shouldUpload || storage === 'data') {
      console.log(`  📦 Using inline data URI`);
      return PayloadUtils.fromInlineData(content);
    }

    console.log(`  📦 Uploading to ${storage}...`);

    try {
      let uri: string;

      if (storage === 's3' && this.s3Storage) {
        const result = await this.s3Storage.upload(content);
        uri = result.uri;
        console.log(`  ✅ Uploaded ${contentSize} bytes to S3: ${uri}`);
        logger.info(`Uploaded ${contentSize} bytes to S3: ${uri}`);
      } else if (storage === 'ipfs') {
        uri = await this.ipfsProvider.upload(content);
        console.log(`  ✅ Uploaded ${contentSize} bytes to IPFS: ${uri}`);
        logger.info(`Uploaded ${contentSize} bytes to IPFS: ${uri}`);
      } else {
        uri = await this.dataUriProvider.upload(content);
        console.log(`  ✅ Encoded ${contentSize} bytes as data URI`);
        logger.info(`Encoded ${contentSize} bytes as data URI`);
      }

      return PayloadUtils.fromExternalUri(content, uri);
    } catch (error) {
      console.log(`  ❌ External storage failed: ${(error as Error).message}`);
      logger.warn(`External storage failed, using inline: ${(error as Error).message}`);
      return PayloadUtils.fromInlineData(content);
    }
  }

  /**
   * Create empty PayloadData (for no-proof scenarios)
   */
  createEmpty(): PayloadData {
    return PayloadUtils.empty();
  }

  /**
   * Verify content matches PayloadData hash
   */
  verifyContent(payload: PayloadData, content: string): boolean {
    return PayloadUtils.verifyContent(payload, content);
  }

  /**
   * Serialize PayloadData for database storage
   */
  serializePayload(payload: PayloadData): string {
    return JSON.stringify({
      contentHash: payload.contentHash,
      uri: payload.uri,
    });
  }

  /**
   * Deserialize PayloadData from database storage
   */
  deserializePayload(serialized: string): PayloadData {
    try {
      const parsed = JSON.parse(serialized);
      return {
        contentHash: parsed.contentHash,
        uri: parsed.uri || '',
      };
    } catch {
      return PayloadUtils.fromInlineData(serialized);
    }
  }

  /**
   * Check if IPFS storage is configured
   */
  isIpfsConfigured(): boolean {
    const apiUrl = process.env.IPFS_API_URL || 'http://localhost:5001';
    const isLocalNode = apiUrl.includes('localhost') || apiUrl.includes('127.0.0.1');
    if (isLocalNode) return true;
    return !!(process.env.PINATA_API_KEY && process.env.PINATA_API_SECRET);
  }
}

// Re-export from @noosphere/payload for convenience
export {
  computeContentHash,
  verifyContentHash,
  createDataUriPayload,
  detectPayloadType,
  PayloadType,
} from '@noosphere/payload';

// Export singleton instance with default config
let defaultResolver: PayloadResolver | null = null;

export function getPayloadResolver(config?: PayloadResolverConfig): PayloadResolver {
  if (!defaultResolver || config) {
    defaultResolver = new PayloadResolver(config);
  }
  return defaultResolver;
}
