/**
 * PayloadResolver - Hybrid Input/Output Handler
 *
 * Resolves inputs from various sources:
 * - Raw data (inline)
 * - URI references (ipfs://, https://, ar://, data:)
 * - PayloadData structures (contentHash + uri)
 *
 * Encodes outputs as PayloadData:
 * - Small outputs: inline (empty URI)
 * - Large outputs: upload to IPFS and reference
 */

import { ethers } from 'ethers';
import axios from 'axios';
import { PayloadUtils, PayloadData, InputType } from '@noosphere/agent-core';
import { logger } from '../../lib/logger';

// Size threshold for auto-upload to external storage (1KB default)
const DEFAULT_UPLOAD_THRESHOLD = 1024;

/**
 * Storage provider interface for external content
 */
export interface StorageProvider {
  upload(content: string | Buffer): Promise<string>; // Returns URI
  download(uri: string): Promise<string | Buffer>;
}

/**
 * IPFS storage provider using Pinata or local node
 */
export class IpfsStorageProvider implements StorageProvider {
  private apiUrl: string;
  private apiKey?: string;
  private apiSecret?: string;
  private gateway: string;
  private isLocalNode: boolean;

  constructor(options: {
    apiUrl?: string;
    apiKey?: string;
    apiSecret?: string;
    gateway?: string;
  } = {}) {
    this.apiUrl = options.apiUrl || process.env.IPFS_API_URL || 'http://localhost:5001';
    this.apiKey = options.apiKey || process.env.PINATA_API_KEY;
    this.apiSecret = options.apiSecret || process.env.PINATA_API_SECRET;
    this.gateway = options.gateway || process.env.IPFS_GATEWAY || 'http://localhost:8080/ipfs';

    // Detect if using local IPFS node
    this.isLocalNode = this.apiUrl.includes('localhost') || this.apiUrl.includes('127.0.0.1');
  }

  async upload(content: string | Buffer): Promise<string> {
    const data = typeof content === 'string' ? content : content.toString('utf-8');

    try {
      if (this.isLocalNode) {
        // Local IPFS node - use /api/v0/add
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
        // Pinata API
        if (!this.apiKey || !this.apiSecret) {
          throw new Error('IPFS storage not configured: missing Pinata API keys');
        }

        const response = await axios.post(
          `${this.apiUrl}/pinning/pinJSONToIPFS`,
          { pinataContent: data },
          {
            headers: {
              'Content-Type': 'application/json',
              pinata_api_key: this.apiKey,
              pinata_secret_api_key: this.apiSecret,
            },
          }
        );

        return `ipfs://${response.data.IpfsHash}`;
      }
    } catch (error) {
      logger.error('Failed to upload to IPFS:', error);
      throw new Error(`IPFS upload failed: ${(error as Error).message}`);
    }
  }

  async download(uri: string): Promise<string> {
    // Convert IPFS URI to gateway URL
    let gatewayUrl: string;

    if (uri.startsWith('ipfs://')) {
      const cid = uri.replace('ipfs://', '');
      gatewayUrl = `${this.gateway}/${cid}`;
    } else {
      gatewayUrl = uri;
    }

    try {
      const response = await axios.get(gatewayUrl, { timeout: 30000 });
      return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
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
  async upload(_content: string | Buffer): Promise<string> {
    throw new Error('HTTPS upload not supported - use a dedicated storage service');
  }

  async download(uri: string): Promise<string> {
    try {
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
  async upload(content: string | Buffer): Promise<string> {
    const data = typeof content === 'string' ? content : content.toString('utf-8');
    const base64 = Buffer.from(data).toString('base64');
    return `data:application/json;base64,${base64}`;
  }

  async download(uri: string): Promise<string> {
    if (!uri.startsWith('data:')) {
      throw new Error('Invalid data URI');
    }

    const match = uri.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      throw new Error('Invalid data URI format');
    }

    return Buffer.from(match[2], 'base64').toString('utf-8');
  }
}

/**
 * PayloadResolver configuration
 */
export interface PayloadResolverConfig {
  uploadThreshold?: number; // Size in bytes to trigger auto-upload
  defaultStorage?: 'ipfs' | 'data'; // Default storage for large outputs
  ipfs?: {
    apiUrl?: string;
    apiKey?: string;
    apiSecret?: string;
    gateway?: string;
  };
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
  private uploadThreshold: number;
  private defaultStorage: 'ipfs' | 'data';

  constructor(config: PayloadResolverConfig = {}) {
    this.ipfsProvider = new IpfsStorageProvider(config.ipfs);
    this.httpsProvider = new HttpsStorageProvider();
    this.dataUriProvider = new DataUriProvider();
    this.uploadThreshold = config.uploadThreshold || DEFAULT_UPLOAD_THRESHOLD;
    this.defaultStorage = config.defaultStorage || 'ipfs';
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
      str.startsWith('ar://') ||
      str.startsWith('data:') ||
      str.startsWith('chain://')
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
        // This case should be handled by the caller providing the content separately
        if (!payloadData.uri) {
          return {
            content: '', // Content not available for inline PayloadData without original
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
        // Not a valid hex string, return as-is
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

    if (decodedUri.startsWith('ar://')) {
      // Arweave gateway
      const txId = decodedUri.replace('ar://', '');
      const gateway = process.env.ARWEAVE_GATEWAY || 'https://arweave.net';
      return this.httpsProvider.download(`${gateway}/${txId}`);
    }

    throw new Error(`Unsupported URI scheme: ${uri}`);
  }

  /**
   * Encode output as PayloadData
   * Automatically uploads to external storage if content exceeds threshold
   */
  async encodeOutput(
    content: string,
    options: { forceUpload?: boolean; storage?: 'ipfs' | 'data' } = {}
  ): Promise<PayloadData> {
    const contentSize = Buffer.byteLength(content, 'utf-8');
    const shouldUpload = options.forceUpload || contentSize > this.uploadThreshold;

    console.log(`  📦 PayloadResolver.encodeOutput: size=${contentSize}, threshold=${this.uploadThreshold}, shouldUpload=${shouldUpload}`);

    if (!shouldUpload) {
      // Inline storage - just compute hash
      console.log(`  📦 Using inline data: URI (size <= threshold)`);
      return PayloadUtils.fromInlineData(content);
    }

    // Upload to external storage
    const storage = options.storage || this.defaultStorage;
    let uri: string;

    console.log(`  📦 Uploading to ${storage}...`);

    try {
      if (storage === 'ipfs') {
        uri = await this.ipfsProvider.upload(content);
        console.log(`  ✅ Uploaded ${contentSize} bytes to IPFS: ${uri}`);
        logger.info(`Uploaded ${contentSize} bytes to IPFS: ${uri}`);
      } else {
        uri = await this.dataUriProvider.upload(content);
        console.log(`  ✅ Encoded ${contentSize} bytes as data URI`);
        logger.info(`Encoded ${contentSize} bytes as data URI`);
      }
    } catch (error) {
      // Fallback to inline if upload fails
      console.log(`  ❌ External storage failed: ${(error as Error).message}`);
      logger.warn(`External storage failed, using inline: ${(error as Error).message}`);
      return PayloadUtils.fromInlineData(content);
    }

    return PayloadUtils.fromExternalUri(content, uri);
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
      // Legacy format - treat as raw content hash
      return PayloadUtils.fromInlineData(serialized);
    }
  }

  /**
   * Check if IPFS storage is configured
   */
  isIpfsConfigured(): boolean {
    const apiUrl = process.env.IPFS_API_URL || 'http://localhost:5001';
    const isLocalNode = apiUrl.includes('localhost') || apiUrl.includes('127.0.0.1');
    // Local node doesn't need API keys
    if (isLocalNode) return true;
    // Pinata needs API keys
    return !!(process.env.PINATA_API_KEY && process.env.PINATA_API_SECRET);
  }
}

// Export singleton instance with default config
let defaultResolver: PayloadResolver | null = null;

export function getPayloadResolver(config?: PayloadResolverConfig): PayloadResolver {
  if (!defaultResolver || config) {
    defaultResolver = new PayloadResolver(config);
  }
  return defaultResolver;
}
